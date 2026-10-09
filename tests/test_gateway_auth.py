"""Gateway auth discovery and classified failures using synthetic secrets only."""
import asyncio
import io
import json
import sqlite3
import subprocess
import sys
from pathlib import Path
import urllib.error

import pytest

from easel.gateway_auth import GatewayCredentials, gateway_error, redact_gateway_text, resolve_credentials
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import app as web
import skill_audit


def config(root, auth):
    (root / 'openclaw.json').write_text(json.dumps({'gateway': {'mode': 'local', 'auth': auth}}), encoding='utf-8')


def test_missing_qa_config_does_not_invent_gateway_or_device_credentials(tmp_path):
    credentials = resolve_credentials({}, tmp_path)
    assert credentials.public() == {'mode': '', 'hasToken': False, 'hasPassword': False, 'source': 'unconfigured'}
    assert credentials.headers() == {} and credentials.environment({}) == {}
    assert not (tmp_path / 'openclaw.json').exists()


@pytest.mark.parametrize('mode', ['token', 'none'])
def test_installed_config_token_is_passed_even_when_existing_mode_is_none(tmp_path, mode):
    config(tmp_path, {'mode': mode, 'token': 'configured-test-token'})
    credentials = resolve_credentials({'OPENCLAW_GATEWAY_TOKEN': 'stale-env-token'}, tmp_path)
    assert credentials.headers() == {'Authorization': 'Bearer configured-test-token'}
    env = credentials.environment({'KEEP': 'value'})
    assert env['OPENCLAW_GATEWAY_TOKEN'] == 'configured-test-token' and env['KEEP'] == 'value'
    assert 'configured-test-token' not in repr(credentials)
    assert 'stale-env-token' not in json.dumps(credentials.public())


def test_password_and_env_secret_references(tmp_path):
    config(tmp_path, {'mode': 'password', 'password': {'source': 'env', 'id': 'LOCAL_TEST_SECRET'}})
    credentials = resolve_credentials({'LOCAL_TEST_SECRET': 'synthetic-password'}, tmp_path)
    assert credentials.headers() == {'Authorization': 'Bearer synthetic-password'}
    assert credentials.environment({}) == {'OPENCLAW_GATEWAY_PASSWORD': 'synthetic-password'}
    config(tmp_path, {'token': '${LOCAL_TEST_SECRET}'})
    assert resolve_credentials({'LOCAL_TEST_SECRET': 'synthetic-token'}, tmp_path).token == 'synthetic-token'


def test_exact_gateway_store_ref_reads_only_active_team_entry(tmp_path):
    config(tmp_path, {'mode': 'token', 'token': {'source': 'store', 'provider': 'default', 'id': 'OPENCLAW_GATEWAY_TOKEN'}})
    (tmp_path / 'state').mkdir()
    database = tmp_path / 'state' / 'openclaw.sqlite'
    with sqlite3.connect(database) as db:
        db.execute('CREATE TABLE secret_store_entries(scope_kind TEXT,scope_id TEXT,name TEXT,value TEXT,deleted_at_ms INTEGER)')
        db.executemany('INSERT INTO secret_store_entries VALUES(?,?,?,?,?)', [
            ('team', '', 'OPENCLAW_GATEWAY_TOKEN', 'stored-gateway-token', None),
            ('team', '', 'MODEL_API_KEY', 'unrelated-model-secret', None),
            ('agent', 'other', 'OPENCLAW_GATEWAY_TOKEN', 'other-scope-token', None),
        ])
    assert resolve_credentials({}, tmp_path).token == 'stored-gateway-token'
    with sqlite3.connect(database) as db:
        db.execute("UPDATE secret_store_entries SET deleted_at_ms=1 WHERE scope_kind='team' AND name='OPENCLAW_GATEWAY_TOKEN'")
    assert resolve_credentials({}, tmp_path).token == ''
    config(tmp_path, {})
    assert resolve_credentials({}, tmp_path).token == ''


def test_references_never_execute_command_or_read_arbitrary_files(tmp_path):
    config(tmp_path, {'token': {'source': 'exec', 'id': 'token-command'}})
    assert resolve_credentials({}, tmp_path).token == ''
    config(tmp_path, {'token': {'source': 'file', 'id': 'private-file'}})
    assert resolve_credentials({}, tmp_path).token == ''


def test_unavailable_explicit_ref_cannot_reuse_stale_inherited_credentials(tmp_path):
    config(tmp_path, {'mode': 'token', 'token': '${MISSING_GATEWAY_SECRET}'})
    credentials = resolve_credentials({'OPENCLAW_GATEWAY_TOKEN': 'stale-token'}, tmp_path)
    assert credentials.headers() == {}
    assert credentials.environment({'OPENCLAW_GATEWAY_TOKEN': 'stale-token',
                                    'OPENCLAW_GATEWAY_PASSWORD': 'stale-password', 'KEEP': 'yes'}) == {'KEEP': 'yes'}


@pytest.mark.parametrize('raw,status,code', [
    ('gateway agent requires credentials before opening a websocket; pair this device', None, 'gateway_auth_missing'),
    ('GATEWAY_SECRET_REF_UNAVAILABLE', None, 'gateway_auth_missing'),
    ('NOT_PAIRED device pairing required', None, 'gateway_pairing_required'),
    ('unauthorized token mismatch', None, 'gateway_auth_rejected'),
    ('private response', 401, 'gateway_auth_rejected'),
    ('private response', 403, 'gateway_auth_rejected'),
    ('TimeoutError', None, 'gateway_timeout'),
    ('ECONNREFUSED', None, 'gateway_connection_failed'),
    ('[WinError 10054] 远程主机强迫关闭了一个现有的连接。', None, 'gateway_connection_failed'),
    ('[WinError 10061] connection refused', None, 'gateway_connection_failed'),
    ('exit code 1', None, 'agent_execution_failed'),
])
def test_failures_classified_without_guessing_or_repeating_sensitive_details(raw, status, code):
    result = gateway_error(raw + ' secret=SYNTHETIC_SECRET', status=status)
    assert result['code'] == code
    assert 'SYNTHETIC_SECRET' not in json.dumps(result)
    assert '负载' not in result['message']
    if code.startswith('gateway_auth') or code == 'gateway_pairing_required':
        assert result['category'] == 'authentication' and result['retryable'] is False


def test_gateway_log_redaction_removes_resolved_and_bearer_values():
    credentials = GatewayCredentials('token', token='unique-secret')
    result = redact_gateway_text('failed unique-secret Authorization: Bearer other-secret --password=third-secret', credentials)
    assert all(secret not in result for secret in ('unique-secret', 'other-secret', 'third-secret'))


def test_unsupported_thinking_preserves_only_actionable_runtime_fields():
    result = gateway_error('Thinking level "ultra" is not supported for relay/grok-4.7. Use one of: off. api_key=PRIVATE')
    assert result['code'] == 'thinking_level_unsupported'
    assert result['supportedThinkingLevels'] == ['off']
    assert result['modelRef'] == 'relay/grok-4.7'
    assert result['category'] == 'configuration' and result['retryable'] is False
    assert 'ultra' in result['message'] and 'PRIVATE' not in json.dumps(result)


def test_gateway_log_redacts_json_and_quoted_secret_values():
    raw = '''{"token": "private-token", "password": "private phrase", "api_key": "private-key"} --password 'other phrase' '''
    result = redact_gateway_text(raw, GatewayCredentials())
    assert all(secret not in result for secret in ('private-token', 'private phrase', 'private-key', 'other phrase'))


def test_empty_http_probe_authenticates_without_sending_a_user_message(monkeypatch):
    monkeypatch.setattr(web, 'gateway_credentials', lambda: GatewayCredentials('token', token='probe-only-secret'))
    monkeypatch.setattr(web, '_HTTP_READY_CACHE', {'at': -1e9, 'ok': False})
    def request(req, timeout):
        assert req.data == b'{}'
        assert req.get_header('Authorization') == 'Bearer probe-only-secret'
        assert 'Authorization' not in req.headers  # auth is never forwarded on redirect.
        raise urllib.error.HTTPError(req.full_url, 400, 'missing messages', {}, None)
    monkeypatch.setattr(web.urllib.request, 'urlopen', request)
    assert web._gateway_http_ready(force=True)


def test_probe_cache_expires_on_auth_rotation_or_endpoint_change(monkeypatch):
    credentials = [GatewayCredentials('token', token='first-test-token')]
    endpoint = ['http://127.0.0.1:12345/v1/chat/completions']
    calls = []
    monkeypatch.setattr(web, 'gateway_credentials', lambda: credentials[0])
    monkeypatch.setattr(web, 'chat_completions_url', lambda: endpoint[0])
    monkeypatch.setattr(web, '_HTTP_READY_CACHE', {'at': -1e9, 'ok': False})
    def request(req, timeout):
        calls.append((req.full_url, req.get_header('Authorization')))
        raise urllib.error.HTTPError(req.full_url, 400, 'missing messages', {}, None)
    monkeypatch.setattr(web.urllib.request, 'urlopen', request)
    assert web._gateway_http_ready() and web._gateway_http_ready()
    assert len(calls) == 1
    credentials[0] = GatewayCredentials('token', token='rotated-test-token')
    assert web._gateway_http_ready()
    endpoint[0] = 'http://127.0.0.1:12346/v1/chat/completions'
    assert web._gateway_http_ready()
    assert len(calls) == 3 and calls[-1] == (endpoint[0], 'Bearer rotated-test-token')


def test_sync_auth_failure_passes_credentials_and_returns_only_safe_classified_message(monkeypatch):
    released = []
    class Lock:
        def __init__(self, key): assert key == 'synthetic-sync-session'
        def acquire(self, timeout): return True
        def release(self): released.append(True)
    def run(command, **kwargs):
        assert 'synthetic-sync-secret' not in command
        assert kwargs['env']['OPENCLAW_GATEWAY_TOKEN'] == 'synthetic-sync-secret'
        assert kwargs['env']['KEEP'] == 'value'
        return subprocess.CompletedProcess(command, 1, '',
            'gateway agent requires credentials before opening a websocket; pair this device; --token synthetic-sync-secret')
    monkeypatch.setattr(web, 'gateway_credentials', lambda: GatewayCredentials('token', token='synthetic-sync-secret'))
    monkeypatch.setattr(web, '_CrossProcLock', Lock)
    monkeypatch.setattr(web, '_heal_openclaw_session', lambda key: None)
    monkeypatch.setattr(web, '_openclaw_session_id', lambda key: 'synthetic-session-id')
    monkeypatch.setattr(web, 'openclaw_base_cmd', lambda: ['fake-cli'])
    monkeypatch.setattr(web, '_proxy_env', lambda: {'KEEP': 'value'})
    monkeypatch.setattr(web.subprocess, 'run', run)
    result = web.run_agent_sync('synthetic request', session_id='synthetic-sync-session')
    assert result == '❌ ' + gateway_error('GATEWAY_SECRET_REF_UNAVAILABLE')['message']
    assert 'synthetic-sync-secret' not in result and '（无输出）' not in result
    assert '超时' not in result and '负载' not in result
    assert released == [True]


def test_cli_auth_error_is_structured_retained_and_not_rendered_as_model_output(tmp_path, monkeypatch):
    class Process:
        def __init__(self, command, **kwargs):
            assert 'synthetic-turn-token' not in command
            assert kwargs['env']['OPENCLAW_GATEWAY_TOKEN'] == 'synthetic-turn-token'
            self.stdout = io.StringIO('gateway agent requires credentials before opening a websocket\nFix: pair this device\n--token synthetic-turn-token\n')
        def poll(self): return 1
    class Lock:
        def __init__(self, key): pass
        def acquire(self, timeout): return True
        def release(self): pass
    monkeypatch.setattr(web, 'gateway_credentials', lambda: GatewayCredentials('token', token='synthetic-turn-token'))
    monkeypatch.setattr(web, 'SESSIONS_DIR', tmp_path / 'sessions')
    monkeypatch.setattr(web, 'OUTPUTS_DIR', tmp_path / 'outputs')
    monkeypatch.setattr(web, 'DEBUG_DIR', tmp_path / 'debug')
    monkeypatch.setattr(web, 'SHARED_RAW_STREAM', tmp_path / 'absent-raw.jsonl')
    monkeypatch.setattr(web, '_CrossProcLock', Lock)
    monkeypatch.setattr(web, '_chat_message', lambda req: req.message)
    monkeypatch.setattr(web, '_selected_skill_specs', lambda req: {})
    monkeypatch.setattr(web, '_heal_openclaw_session', lambda key: None)
    monkeypatch.setattr(web, '_resolve_transport', lambda key: 'cli')
    monkeypatch.setattr(web, 'openclaw_base_cmd', lambda: ['fake-cli'])
    monkeypatch.setattr(web, '_proxy_env', lambda: {})
    monkeypatch.setattr(web, 'question_bridge_supported', None)
    monkeypatch.setattr(web, 'GatewayClient', None)
    monkeypatch.setattr(web, '_notify_email_web_turn', None)
    monkeypatch.setattr(web.subprocess, 'Popen', Process)
    monkeypatch.setattr(skill_audit, 'begin', lambda *args: None)
    async def exercise():
        monkeypatch.setattr(web, '_session_lock', lambda key: asyncio.Lock())
        response = await web.api_chat_stream(web.ChatRequest(message='synthetic request', sessionId='auth-test', turnId='auth-turn'))
        events = [event async for event in response.body_iterator]
        errors = [json.loads(e['data']) for e in events if e['event'] == 'error']
        assert len(errors) == 1 and errors[0]['code'] == 'gateway_auth_missing'
        assert not [e for e in events if e['event'] == 'token']
        saved = await web.api_chat_last('auth-test', 'auth-turn')
        assert saved['text'] == '' and saved['error'] == errors[0]
        assert 'synthetic-turn-token' not in json.dumps(events) + json.dumps(saved)
        assert 'synthetic-turn-token' not in (tmp_path / 'debug' / 'chat-stream.jsonl').read_text(encoding='utf-8')
    asyncio.run(exercise())


@pytest.fixture
def stream_sandbox(tmp_path, monkeypatch):
    class Lock:
        def __init__(self, key): pass
        def acquire(self, timeout): return True
        def release(self): pass
    monkeypatch.setattr(web, 'gateway_credentials', lambda: GatewayCredentials('token', token='synthetic-http-token'))
    monkeypatch.setattr(web, 'SESSIONS_DIR', tmp_path / 'sessions')
    monkeypatch.setattr(web, 'OUTPUTS_DIR', tmp_path / 'outputs')
    monkeypatch.setattr(web, 'DEBUG_DIR', tmp_path / 'debug')
    monkeypatch.setattr(web, 'SHARED_RAW_STREAM', tmp_path / 'absent-raw.jsonl')
    monkeypatch.setattr(web, '_CrossProcLock', Lock)
    monkeypatch.setattr(web, '_session_lock', lambda key: asyncio.Lock())
    monkeypatch.setattr(web, '_chat_message', lambda req: req.message)
    monkeypatch.setattr(web, '_selected_skill_specs', lambda req: {})
    monkeypatch.setattr(web, '_heal_openclaw_session', lambda key: None)
    monkeypatch.setattr(web, '_resolve_transport', lambda key: 'http')
    monkeypatch.setattr(web, 'openclaw_base_cmd', lambda: ['fake-cli'])
    monkeypatch.setattr(web, '_proxy_env', lambda: {})
    monkeypatch.setattr(web, 'question_bridge_supported', None)
    monkeypatch.setattr(web, 'GatewayClient', None)
    monkeypatch.setattr(web, '_notify_email_web_turn', None)
    monkeypatch.setattr(skill_audit, 'begin', lambda *args: None)
    return tmp_path


@pytest.mark.parametrize('case,code', [
    ('401', 'gateway_auth_rejected'),
    ('503', 'gateway_request_failed'),
    ('sse-error-object', 'gateway_auth_rejected'),
    ('sse-error-string', 'gateway_auth_rejected'),
    ('empty-eof', 'gateway_stream_interrupted'),
    ('partial-eof', 'gateway_stream_interrupted'),
    ('timeout', 'gateway_timeout'),
    ('complete', None),
    ('length', None),
    ('max_tokens', None),
])
def test_http_failures_preserve_text_order_and_recovery_error(stream_sandbox, monkeypatch, case, code):
    import httpx
    class Response:
        status_code = int(case) if case.isdigit() else 200
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def aread(self): return b'private upstream: synthetic-http-token'
        async def aiter_lines(self):
            if case == 'timeout':
                raise httpx.ReadTimeout('synthetic-http-token')
            if case in ('partial-eof', 'complete', 'length', 'max_tokens'):
                yield 'data: ' + json.dumps({'choices': [{'delta': {'content': '已收到的回答'}}]})
            if case.startswith('sse-error'):
                detail = 'unauthorized token=synthetic-http-token'
                yield 'data: ' + json.dumps({'error': {'message': detail} if case.endswith('object') else detail})
            if case in ('length', 'max_tokens'):
                yield 'data: ' + json.dumps({'choices': [{'delta': {}, 'finish_reason': case}]})
            if case in ('complete', 'length', 'max_tokens'):
                yield 'data: [DONE]'
    class Client:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        def stream(self, method, url, **kwargs):
            assert kwargs['headers']['Authorization'] == 'Bearer synthetic-http-token'
            return Response()
    monkeypatch.setattr(httpx, 'AsyncClient', Client)
    async def exercise():
        response = await web.api_chat_stream(web.ChatRequest(message='synthetic request', sessionId='http-test', turnId='http-turn'))
        async def collect(): return [event async for event in response.body_iterator]
        events = await asyncio.wait_for(collect(), 5)
        errors = [json.loads(e['data']) for e in events if e['event'] == 'error']
        saved = await web.api_chat_last('http-test', 'http-turn')
        replay = web._read_job_events('http-turn')
        assert saved['status'] == 'done' and events[-1]['event'] == replay[-1]['event'] == 'done'
        if case in ('length', 'max_tokens'):
            assert saved['text'].startswith('已收到的回答') and '被截断' in saved['text']
            assert saved['stop_reason'] == case
        else:
            assert saved['text'] == ('已收到的回答' if case in ('partial-eof', 'complete') else '')
        assert saved['clean_end'] is (case == 'complete')
        if code:
            assert len(errors) == 1 and errors[0]['code'] == code
            assert saved['error'] == errors[0]
            assert [e['data'] for e in replay if e['event'] == 'error'] == errors
            if case == 'partial-eof':
                kinds = [e['event'] for e in events]
                assert kinds.index('token') < kinds.index('error') < kinds.index('done')
        else:
            assert not errors and saved['error'] is None
        assert 'synthetic-http-token' not in json.dumps(events) + json.dumps(saved) + json.dumps(replay)
    asyncio.run(exercise())


@pytest.mark.parametrize('failure', ['command-discovery', 'spawn', 'transport-selection'])
def test_startup_failure_has_terminal_recoverable_error(stream_sandbox, monkeypatch, failure):
    def fail(*args, **kwargs): raise OSError('private failure synthetic-http-token')
    monkeypatch.setattr(web, '_resolve_transport', fail if failure == 'transport-selection' else lambda key: 'cli')
    monkeypatch.setattr(web, 'openclaw_base_cmd', fail if failure == 'command-discovery' else lambda: ['fake-cli'])
    monkeypatch.setattr(web.subprocess, 'Popen', fail)
    async def exercise():
        response = await web.api_chat_stream(web.ChatRequest(message='synthetic request', sessionId='startup-test', turnId='startup-turn'))
        async def collect(): return [event async for event in response.body_iterator]
        events = await asyncio.wait_for(collect(), 5)
        saved = await web.api_chat_last('startup-test', 'startup-turn')
        errors = [json.loads(e['data']) for e in events if e['event'] == 'error']
        assert events[-1]['event'] == 'done' and len(errors) == 1
        assert saved['status'] == 'done' and saved['error'] == errors[0] and not saved['clean_end']
        assert not saved['text']
        assert 'synthetic-http-token' not in json.dumps(events) + json.dumps(saved)
    asyncio.run(exercise())


def test_client_disconnect_keeps_http_failure_recoverable(stream_sandbox, monkeypatch):
    import httpx
    async def exercise():
        started, release = asyncio.Event(), asyncio.Event()
        class Response:
            status_code = 200
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def aiter_lines(self):
                started.set()
                await release.wait()
                yield 'data: ' + json.dumps({'error': 'unauthorized synthetic-http-token'})
        class Client:
            def __init__(self, *args, **kwargs): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            def stream(self, *args, **kwargs): return Response()
        monkeypatch.setattr(httpx, 'AsyncClient', Client)
        response = await web.api_chat_stream(web.ChatRequest(message='synthetic request', sessionId='disconnect-test', turnId='disconnect-turn'))
        await anext(response.body_iterator)
        await asyncio.wait_for(started.wait(), 5)
        await response.body_iterator.aclose()
        release.set()
        await asyncio.wait_for(asyncio.gather(*list(web._BG_TASKS)), 5)
        saved = await web.api_chat_last('disconnect-test', 'disconnect-turn')
        assert saved['status'] == 'done' and saved['error']['code'] == 'gateway_auth_rejected'
        assert not saved['clean_end'] and not saved['text']
        replay = web._read_job_events('disconnect-turn')
        assert replay[-1]['event'] == 'done'
        assert [e['data'] for e in replay if e['event'] == 'error'] == [saved['error']]
    asyncio.run(exercise())
