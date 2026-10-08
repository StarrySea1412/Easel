"""Per-turn model routing with fake transports and isolated approval/config files."""
import asyncio
import io
import json
from pathlib import Path
import sqlite3
import sys
from types import SimpleNamespace
import urllib.error

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from easel.gateway_auth import GatewayCredentials

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import app as web
import office_controls as controls
import skill_audit


class ReadGateway:
    server_version = '2026.9.2'
    methods = {'agent', 'sessions.list'}
    granted_scopes = {'operator.admin'}

    def __init__(self):
        self.calls = []
        self.rows = []
        self.closed = False

    def connect(self):
        pass

    def _rpc(self, method, params):
        assert method == 'sessions.list', 'a capability probe must not execute or mutate'
        self.calls.append((method, params))
        return {'sessions': self.rows}

    def close(self):
        self.closed = True


@pytest.fixture
def sandbox(tmp_path, monkeypatch):
    state = tmp_path / 'state'
    state.mkdir()
    config = state / 'openclaw.json'
    config.write_text(json.dumps({'models': {'providers': {'relay': {
        'apiKey': 'PRIVATE_KEY', 'baseUrl': 'https://PRIVATE_URL.invalid',
        'models': [{'id': 'model-a'}, {'id': 'model-b'}]}}}}))
    client = ReadGateway()
    probes, requests, releases = [], [], []
    fixture = SimpleNamespace(path=tmp_path, config=config, client=client, probes=probes,
                              requests=requests, releases=releases, transport='http', status=200,
                              before_lock=None, connected=None, response_release=None)

    class Lock:
        def __init__(self, key):
            pass

        def acquire(self, timeout):
            if fixture.before_lock:
                fixture.before_lock()
            return True

        def release(self):
            releases.append(True)

    monkeypatch.setattr(web, 'openclaw_state_dir', lambda: state)
    monkeypatch.setattr(web, 'gateway_credentials', lambda: GatewayCredentials('token', token='PRIVATE_TOKEN'))
    monkeypatch.setattr(web, 'SESSIONS_DIR', tmp_path / 'sessions')
    monkeypatch.setattr(web, 'OUTPUTS_DIR', tmp_path / 'outputs')
    monkeypatch.setattr(web, 'OPENCLAW_SESSIONS_DIR', tmp_path / 'transcripts')
    monkeypatch.setattr(web, 'DEBUG_DIR', tmp_path / 'debug')
    monkeypatch.setattr(web, 'SHARED_RAW_STREAM', tmp_path / 'absent-raw.jsonl')
    monkeypatch.setattr(web, '_CrossProcLock', Lock)
    monkeypatch.setattr(web, '_session_lock', lambda key: asyncio.Lock())
    monkeypatch.setattr(web, '_chat_message', lambda req: req.message)
    monkeypatch.setattr(web, '_selected_skill_specs', lambda req: {})
    monkeypatch.setattr(web, '_heal_openclaw_session', lambda key: None)
    monkeypatch.setattr(web, '_resolve_transport', lambda key: fixture.transport)
    monkeypatch.setattr(web, 'openclaw_base_cmd', lambda: ['fake-cli'])
    monkeypatch.setattr(web, '_proxy_env', lambda: {})
    monkeypatch.setattr(web, 'question_bridge_supported', None)
    monkeypatch.setattr(web, 'GatewayClient', None)
    monkeypatch.setattr(web, '_notify_email_web_turn', None)
    monkeypatch.setattr(skill_audit, 'begin', lambda *args: None)
    monkeypatch.setattr(controls, '_model_probe_client', lambda *args: client)
    monkeypatch.setattr(controls, '_cli_override_version', lambda app: '2026.9.2')
    monkeypatch.setattr(controls, '_probe_http_override', lambda *args: probes.append(args[3]))

    class Response:
        def __init__(self, run_id):
            self.run_id = run_id
            self.status_code = fixture.status

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def aread(self):
            return b'unauthorized PRIVATE_TOKEN'

        async def aiter_lines(self):
            if fixture.connected:
                fixture.connected.set()
                await fixture.response_release.wait()
            yield 'data: ' + json.dumps({'id': self.run_id, 'choices': [{'delta': {'content': 'synthetic reply'}}]})
            yield 'data: [DONE]'

    class HttpClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        def stream(self, method, url, **kwargs):
            requests.append(kwargs)
            return Response(f'chatcmpl_model_{len(requests)}')

    import httpx
    monkeypatch.setattr(httpx, 'AsyncClient', HttpClient)
    monkeypatch.setattr(web.subprocess, 'Popen', lambda *a, **kw: pytest.fail('unexpected CLI dispatch'))
    return fixture


async def collect_turn(model_ref='relay/model-b', turn='model-turn'):
    response = await web.api_chat_stream(web.ChatRequest(message='synthetic request', sessionId='model-session',
                                                        turnId=turn, modelRef=model_ref))
    async def collect():
        return [event async for event in response.body_iterator]
    events = await asyncio.wait_for(collect(), 5)
    return events, await web.api_chat_last('model-session', turn)


def test_model_listing_works_before_first_turn_without_execution_or_secret_leaks(sandbox):
    client = TestClient(web.app, base_url='http://127.0.0.1:7860', client=('127.0.0.1', 51234))
    response = client.get('/api/agent-office/models')
    result = response.json()
    assert response.status_code == 200 and result['available'] and result['scope'] == 'next_turn'
    assert result['currentModelRef'] is None and result['gatewayVersion'] == '2026.9.2'
    assert [option['id'] for option in result['options']] == ['relay/model-a', 'relay/model-b']
    assert sandbox.probes == [None] and not sandbox.requests and not sandbox.client.calls
    assert not list(sandbox.path.rglob('*.transport')) and 'PRIVATE_' not in json.dumps(result)
    assert client.get('/api/agent-office/models', params={'sessionId': '../foreign'}).status_code == 400


@pytest.mark.parametrize('version', [None, '2026.6.11', '2026.9.4', 'PRIVATE_TOKEN https://private.invalid'])
def test_unverified_running_gateway_cannot_inherit_installed_version_or_probe_http(sandbox, version):
    sandbox.client.server_version = version
    result = controls.turn_model_capability(web)
    assert not result['available'] and result['scope'] == 'unavailable'
    assert result['options'] and not sandbox.probes and sandbox.client.closed
    assert 'PRIVATE_' not in json.dumps(result)


def test_listing_uses_only_verified_session_override_not_last_runtime_model(sandbox):
    row = {'key': 'agent:main:model-session', 'sessionId': web._openclaw_session_id('model-session'),
           'modelProvider': 'relay', 'model': 'model-b'}
    sandbox.client.rows = [row]
    assert controls.turn_model_capability(web, 'model-session')['currentModelRef'] is None
    row.update(providerOverride='relay', modelOverride='model-a')
    assert controls.turn_model_capability(web, 'model-session')['currentModelRef'] == 'relay/model-a'
    row['sessionId'] = 'replaced-session'
    assert controls.turn_model_capability(web, 'model-session')['currentModelRef'] is None


@pytest.mark.parametrize('ref', ['model-b', 'foreign/model-b', 'relay/model-b\r\nInjected: yes', ' relay/model-b'])
def test_invalid_model_rejected_before_supervisor_or_transport(sandbox, ref):
    with pytest.raises(HTTPException) as exc:
        asyncio.run(collect_turn(ref))
    assert exc.value.status_code == 400 and exc.value.detail['code'] == 'chat_model_not_configured'
    assert not sandbox.requests and not sandbox.probes and not sandbox.releases


def test_nonstream_rejects_explicit_model_instead_of_ignoring_it(sandbox, monkeypatch):
    monkeypatch.setattr(web, 'run_agent_sync', lambda *args: pytest.fail('must not execute'))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(web.api_chat(web.ChatRequest(message='test', modelRef='relay/model-b')))
    assert exc.value.status_code == 400 and exc.value.detail['code'] == 'chat_model_requires_stream'


@pytest.mark.parametrize('transport', ['http', 'cli'])
def test_explicit_model_reaches_existing_transport_and_recoverable_receipts(sandbox, monkeypatch, transport):
    sandbox.transport = transport
    commands = []
    class Process:
        def __init__(self, command, **kwargs):
            commands.append(command)
            self.stdout = io.StringIO('synthetic CLI reply\n')

        def poll(self):
            return 0
    if transport == 'cli':
        monkeypatch.setattr(web.subprocess, 'Popen', Process)
    events, saved = asyncio.run(collect_turn())
    selections = [json.loads(event['data']) for event in events if event['event'] == 'model_selection']
    replay = web._read_job_events('model-turn')
    assert selections == [{'requestedModelRef': 'relay/model-b'}]
    assert [event['data'] for event in replay if event['event'] == 'model_selection'] == selections
    assert saved['requestedModelRef'] == 'relay/model-b' and 'effectiveModelRef' not in saved
    assert saved['status'] == 'done' and events[-1]['event'] == replay[-1]['event'] == 'done'
    assert 'PRIVATE_' not in json.dumps(saved) + json.dumps(events)
    if transport == 'http':
        assert len(sandbox.requests) == 1
        request = sandbox.requests[0]
        assert request['headers']['x-openclaw-model'] == 'relay/model-b'
        assert request['json']['model'] == 'openclaw/default'
        assert sandbox.probes == ['relay/model-b', 'relay/model-b']
        assert saved['gateway_run_id'] == 'chatcmpl_model_1'
    else:
        assert len(commands) == 1 and commands[0][-2:] == ['--model', 'relay/model-b']
        assert not sandbox.requests and not sandbox.probes


def test_unspecified_model_keeps_original_transport_without_capability_checks(sandbox, monkeypatch):
    monkeypatch.setattr(controls, 'require_model_override', lambda *a, **kw: pytest.fail('unrequested capability check'))
    events, saved = asyncio.run(collect_turn(None))
    assert saved['requestedModelRef'] is None and 'x-openclaw-model' not in sandbox.requests[0]['headers']
    assert not [event for event in events if event['event'] == 'model_selection']


@pytest.mark.parametrize('change', ['configuration', 'gateway-version', 'approval'])
def test_revalidation_after_lock_prevents_execution_and_retains_request(sandbox, monkeypatch, change):
    def revoke():
        if change == 'configuration':
            sandbox.config.write_text('{}')
        elif change == 'gateway-version':
            sandbox.client.server_version = '2026.6.11'
        else:
            monkeypatch.setattr(controls, '_model_probe_client', lambda *a: (_ for _ in ()).throw(HTTPException(503, 'approval revoked')))
    sandbox.before_lock = revoke
    monkeypatch.setattr(web, '_heal_openclaw_session', lambda *a: pytest.fail('must not modify transcript after denial'))
    events, saved = asyncio.run(collect_turn())
    assert not sandbox.requests and saved['requestedModelRef'] == 'relay/model-b'
    assert not saved['clean_end'] and saved['error']['code'].startswith('chat_model_')
    assert events[-1]['event'] == 'done' and sandbox.releases == [True]
    assert [json.loads(e['data']) for e in events if e['event'] == 'error'] == [saved['error']]


def test_gateway_rejection_never_reposts_without_model_or_switches_transport(sandbox):
    sandbox.status = 403
    events, saved = asyncio.run(collect_turn())
    assert len(sandbox.requests) == 1 and sandbox.requests[0]['headers']['x-openclaw-model'] == 'relay/model-b'
    assert saved['requestedModelRef'] == 'relay/model-b' and saved['error']['code'] == 'gateway_auth_rejected'
    assert not saved['clean_end'] and 'PRIVATE_' not in json.dumps(events)


def test_disconnected_client_keeps_selection_and_next_turn_gets_new_run(sandbox):
    async def exercise():
        sandbox.connected, sandbox.response_release = asyncio.Event(), asyncio.Event()
        response = await web.api_chat_stream(web.ChatRequest(message='test', sessionId='model-session',
            turnId='first-turn', modelRef='relay/model-b'))
        await anext(response.body_iterator)
        await asyncio.wait_for(sandbox.connected.wait(), 5)
        await response.body_iterator.aclose()
        sandbox.response_release.set()
        await asyncio.wait_for(asyncio.gather(*list(web._BG_TASKS)), 5)
        first = await web.api_chat_last('model-session', 'first-turn')
        sandbox.connected = None
        _, second = await collect_turn('relay/model-a', 'second-turn')
        assert first['requestedModelRef'] == 'relay/model-b' and second['requestedModelRef'] == 'relay/model-a'
        assert first['gateway_run_id'] != second['gateway_run_id']
        assert first['turn_id'] != second['turn_id'] and len(sandbox.requests) == 2
        assert web._read_job_events('first-turn')[-1]['event'] == 'done'
    asyncio.run(exercise())


@pytest.mark.parametrize('transport,identity,approved,allowed', [
    ('http', ('cli', 'cli'), ['operator.read'], True),
    ('cli', ('gateway-client', 'backend'), ['operator.admin'], True),
    ('cli', ('cli', 'cli'), ['operator.admin'], False),
    ('cli', ('gateway-client', 'backend'), ['operator.read', 'operator.write'], False),
])
def test_model_probe_uses_only_already_approved_identity(tmp_path, monkeypatch, transport, identity, approved, allowed):
    database = tmp_path / 'paired.sqlite'
    with sqlite3.connect(database) as db:
        db.execute('CREATE TABLE device_pairing_paired(device_id TEXT, public_key TEXT, approved_scopes_json TEXT, '
                   'scopes_json TEXT, role TEXT, roles_json TEXT, client_id TEXT, client_mode TEXT)')
        db.execute('INSERT INTO device_pairing_paired VALUES(?,?,?,?,?,?,?,?)',
                   ('existing-device', 'public', json.dumps(approved), None, 'operator', '[]', *identity))
    original = database.read_bytes()
    monkeypatch.setattr(controls.gateway, 'PROFILE_DB', database)
    monkeypatch.setattr(controls.gateway, '_load_device', lambda: {'device_id': 'existing-device', 'public_key': 'public'})
    connected = []
    def factory(**kwargs):
        connected.append(kwargs)
        return ReadGateway()
    monkeypatch.setattr(controls.gateway, 'GatewayClient', factory)
    credentials = GatewayCredentials('token', token='synthetic-shared-secret')
    if allowed:
        controls._model_probe_client(transport, credentials).close()
        assert connected[0]['client_id'] == identity[0] and connected[0]['client_mode'] == identity[1]
        assert connected[0]['scopes'] == (['operator.admin'] if transport == 'cli' else ['operator.read'])
    else:
        with pytest.raises(HTTPException):
            controls._model_probe_client(transport, credentials)
        assert not connected
    assert database.read_bytes() == original


@pytest.mark.parametrize('model_ref,code,message,allowed', [
    (None, 400, 'Invalid `x-openclaw-model`.', True),
    ('relay/model-b', 400, 'Missing user message in `messages`.', True),
    ('relay/model-b', 400, "Model 'relay/model-b' is not allowed for agent 'main'.", False),
    ('relay/model-b', 403, 'Missing scope: operator.admin', False),
    ('relay/model-b', 400, 'unrelated malformed request PRIVATE_TOKEN', False),
])
def test_http_override_probe_requires_exact_authorization_validation_receipt(monkeypatch, model_ref, code, message, allowed):
    requests = []
    def open_request(request, timeout):
        requests.append(request)
        assert json.loads(request.data) == {'model': 'openclaw/default', 'messages': []}
        assert request.get_header('X-openclaw-model') == (model_ref or '/')
        assert request.get_header('Authorization') == 'Bearer synthetic-token'
        raise urllib.error.HTTPError('http://127.0.0.1/fixture', code, 'fixture', {},
                                     io.BytesIO(json.dumps({'error': {'message': message}}).encode()))
    monkeypatch.setattr(controls.urllib.request, 'build_opener', lambda *a: SimpleNamespace(open=open_request))
    credentials = GatewayCredentials('token', token='synthetic-token')
    if allowed:
        controls._probe_http_override(web, 'model-session', credentials, model_ref)
    else:
        with pytest.raises(HTTPException) as exc:
            controls._probe_http_override(web, 'model-session', credentials, model_ref)
        assert 'PRIVATE_' not in str(exc.value.detail)
    assert len(requests) == 1


def test_installed_cli_version_is_read_from_actual_command_without_launch(tmp_path, monkeypatch):
    entry = tmp_path / 'openclaw.mjs'
    entry.write_text('// fixture, never execute')
    package = tmp_path / 'package.json'
    package.write_text(json.dumps({'name': 'openclaw', 'version': '2026.9.2'}))
    monkeypatch.setattr(web, 'openclaw_base_cmd', lambda: ['node', str(entry)])
    monkeypatch.setattr(web.subprocess, 'run', lambda *a, **kw: pytest.fail('no CLI version invocation'))
    assert controls._cli_override_version(web) == '2026.9.2'
    package.write_text(json.dumps({'name': 'openclaw', 'version': '2026.6.11'}))
    assert controls._cli_override_version(web) is None
