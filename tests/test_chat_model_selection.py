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
            self.acquired = False

        def acquire(self, timeout):
            if fixture.before_lock:
                fixture.before_lock()
            self.acquired = True
            return True

        def release(self):
            if self.acquired:
                releases.append(True)
                self.acquired = False

    monkeypatch.setattr(web, 'openclaw_state_dir', lambda: state)
    monkeypatch.setattr(web, 'gateway_credentials', lambda: GatewayCredentials('token', token='PRIVATE_TOKEN'))
    monkeypatch.setattr(web, 'SESSIONS_DIR', tmp_path / 'sessions')
    monkeypatch.setattr(web, 'OUTPUTS_DIR', tmp_path / 'outputs')
    monkeypatch.setattr(web, 'OPENCLAW_SESSIONS_DIR', tmp_path / 'transcripts')
    monkeypatch.setattr(web, 'DEBUG_DIR', tmp_path / 'debug')
    monkeypatch.setattr(web, 'SHARED_RAW_STREAM', tmp_path / 'absent-raw.jsonl')
    monkeypatch.setattr(web, '_CrossProcLock', Lock)
    monkeypatch.setattr(web, '_session_lock', lambda key: asyncio.Lock())
    provider_locks = {}
    fixture.provider_locks = provider_locks
    monkeypatch.setattr(web, '_provider_lock', lambda key: provider_locks.setdefault(key, asyncio.Lock()))
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


async def collect_turn(model_ref='relay/model-b', turn='model-turn', session='model-session'):
    response = await web.api_chat_stream(web.ChatRequest(message='synthetic request', sessionId=session,
                                                        turnId=turn, modelRef=model_ref))
    async def collect():
        return [event async for event in response.body_iterator]
    events = await asyncio.wait_for(collect(), 5)
    return events, await web.api_chat_last(session, turn)


def test_server_queue_stop_retains_running_lease_and_sends_no_model_request(sandbox, monkeypatch):
    from easel.runtime_limits import Pool
    async def exercise():
        pool = Pool('agent', 1)
        monkeypatch.setattr(web.app.state, 'server_pools', {'agent': pool}, raising=False)
        running = pool.acquire()
        response = await web.api_chat_stream(web.ChatRequest(message='not dispatched', sessionId='queued-server',
            turnId='queued-server-stop', modelRef='relay/model-b'))
        for _ in range(50):
            if pool.waiters:
                break
            await asyncio.sleep(0.01)
        assert len(pool.waiters) == 1 and not sandbox.requests
        result = await web.api_chat_stop(web.StopRequest(sessionId='queued-server', turnId='queued-server-stop'))
        events = [event async for event in response.body_iterator]
        await asyncio.sleep(0)
        assert result['stopped'] and json.loads(events[-1]['data'])['stopped'] is True
        assert any('尚未发送到模型' in str(event['data']) for event in events)
        assert pool.active == 1 and not pool.waiters and not sandbox.requests
        ledger = web.run_ledger.read(web._run_ledger_root(), 'queued-server-stop')
        assert ledger['status'] == 'stopped' and ledger['settled'] and ledger['resourceSettled']
        running.release()
    asyncio.run(exercise())


def test_server_queue_dispatches_once_after_running_task_releases(sandbox, monkeypatch):
    from easel.runtime_limits import Pool
    async def exercise():
        pool = Pool('agent', 1)
        monkeypatch.setattr(web.app.state, 'server_pools', {'agent': pool}, raising=False)
        running = pool.acquire()
        task = asyncio.create_task(collect_turn(session='queued-dispatch', turn='queued-dispatch-turn'))
        for _ in range(50):
            if pool.waiters:
                break
            await asyncio.sleep(0.01)
        assert len(pool.waiters) == 1 and not sandbox.requests
        running.release()
        events, last = await task
        await asyncio.sleep(0)
        assert len(sandbox.requests) == 1 and last['clean_end'] is True
        assert pool.active == 0 and not pool.waiters
    asyncio.run(exercise())


def test_browser_disconnect_keeps_the_same_queued_supervisor(sandbox, monkeypatch):
    from easel.runtime_limits import Pool
    async def exercise():
        pool = Pool('agent', 1)
        monkeypatch.setattr(web.app.state, 'server_pools', {'agent': pool}, raising=False)
        running = pool.acquire()
        response = await web.api_chat_stream(web.ChatRequest(message='dispatch only once', sessionId='queued-disconnect',
            turnId='queued-disconnect-turn', modelRef='relay/model-b'))
        for _ in range(50):
            if pool.waiters:
                break
            await asyncio.sleep(0.01)
        assert pool.waiters and not sandbox.requests
        await response.body_iterator.aclose()
        assert 'queued-disconnect-turn' in web._CHAT_JOBS
        running.release()
        for _ in range(200):
            if 'queued-disconnect-turn' not in web._CHAT_JOBS:
                break
            await asyncio.sleep(0.01)
        await asyncio.sleep(0)
        saved = await web.api_chat_last('queued-disconnect', 'queued-disconnect-turn')
        assert saved['clean_end'] and len(sandbox.requests) == 1
        assert pool.active == 0 and not pool.waiters
    asyncio.run(exercise())


def test_stop_while_waiting_for_session_lock_cancels_only_queued_job(sandbox, monkeypatch):
    async def exercise():
        lock = asyncio.Lock()
        await lock.acquire()
        monkeypatch.setattr(web, '_session_lock', lambda _: lock)
        old_process = object()
        monkeypatch.setitem(web._RUNNING_CHAT, 'model-session', old_process)
        monkeypatch.setitem(web._ACTIVE_SKILL_TURNS, 'model-session', 'older-turn')
        response = await web.api_chat_stream(web.ChatRequest(message='not dispatched', sessionId='model-session',
            turnId='queued-stop', modelRef='relay/model-b'))
        await asyncio.sleep(0)
        result = await web.api_chat_stop(web.StopRequest(sessionId='model-session', turnId='queued-stop'))
        events = [event async for event in response.body_iterator]
        assert result['stopped'] and json.loads(events[-1]['data'])['stopped'] is True
        assert web._RUNNING_CHAT['model-session'] is old_process
        assert web._ACTIVE_SKILL_TURNS['model-session'] == 'older-turn' and lock.locked()
        assert 'queued-stop' not in web._CHAT_JOBS and not sandbox.requests
    asyncio.run(exercise())


def test_model_listing_works_before_first_turn_without_execution_or_secret_leaks(sandbox):
    client = TestClient(web.app, base_url='http://127.0.0.1:7860', client=('127.0.0.1', 51234))
    response = client.get('/api/agent-office/models')
    result = response.json()
    assert response.status_code == 200 and result['available'] and result['scope'] == 'next_turn'
    assert result['currentModelRef'] is None and result['gatewayVersion'] is None
    assert [option['id'] for option in result['options']] == ['relay/model-a', 'relay/model-b']
    assert sandbox.probes == [None] and not sandbox.requests and not sandbox.client.calls
    assert not list(sandbox.path.rglob('*.transport')) and 'PRIVATE_' not in json.dumps(result)
    assert client.get('/api/agent-office/models', params={'sessionId': '../foreign'}).status_code == 400


@pytest.mark.parametrize('version', [None, '2026.6.11', '2026.9.4', '2026.9.7', '2026.9.6-custom',
                                     'PRIVATE_TOKEN https://private.invalid'])
def test_unverified_running_gateway_cannot_inherit_installed_version_or_probe_http(sandbox, version):
    sandbox.client.server_version = version
    result = controls.turn_model_capability(web)
    assert result['available'] and result['scope'] == 'next_turn'
    assert result['verificationState'] == 'verified'
    assert result['options'] and sandbox.probes == [None] and not sandbox.client.closed
    assert 'PRIVATE_' not in json.dumps(result)


@pytest.mark.parametrize('transport', ['http', 'cli'])
def test_audited_2026_9_6_still_requires_exact_transport_permission(sandbox, monkeypatch, transport):
    sandbox.client.server_version = '2026.9.6'
    sandbox.transport = transport
    monkeypatch.setattr(controls, '_cli_override_version', lambda app: '2026.9.6')
    result = controls.turn_model_capability(web)
    assert result['available'] and result['scope'] == 'next_turn'
    assert result['gatewayVersion'] == ('2026.9.6' if transport == 'cli' else None) and result['transport'] == transport
    assert sandbox.probes == ([None] if transport == 'http' else [])
    assert not sandbox.requests and not sandbox.client.calls
    assert sandbox.client.closed is (transport == 'cli')
    monkeypatch.setattr(controls, '_model_probe_client',
                        lambda *_args: (_ for _ in ()).throw(HTTPException(503, 'approval missing')))
    if transport == 'cli':
        assert not controls.turn_model_capability(web, transport='cli')['available']
    else:
        assert controls.turn_model_capability(web, transport='http')['available']
        assert sandbox.probes == [None, None]


def test_listing_uses_only_verified_session_override_not_last_runtime_model(sandbox):
    row = {'key': 'agent:main:model-session', 'sessionId': web._openclaw_session_id('model-session'),
           'modelProvider': 'relay', 'model': 'model-b'}
    sandbox.client.rows = [row]
    assert controls.turn_model_capability(web, 'model-session', transport='cli')['currentModelRef'] is None
    row.update(providerOverride='relay', modelOverride='model-a')
    assert controls.turn_model_capability(web, 'model-session', transport='cli')['currentModelRef'] == 'relay/model-a'
    row['sessionId'] = 'replaced-session'
    assert controls.turn_model_capability(web, 'model-session', transport='cli')['currentModelRef'] is None


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


def test_explicit_thinking_forces_cli_model_capability_before_and_after_lock(sandbox, monkeypatch):
    commands, transports = [], []
    original = controls.require_model_override
    def require(*args, **kwargs):
        transports.append(kwargs.get("transport"))
        return original(*args, **kwargs)
    class Process:
        def __init__(self, command, **kwargs):
            commands.append(command)
            self.stdout = io.StringIO("synthetic CLI reply\n")
        def poll(self): return 0
    monkeypatch.setattr(controls, "require_model_override", require)
    monkeypatch.setattr(web.subprocess, "Popen", Process)
    async def exercise():
        response = await web.api_chat_stream(web.ChatRequest(message="test", sessionId="model-session",
            turnId="thinking-turn", modelRef="relay/model-b", thinkingLevel="high"))
        events = [event async for event in response.body_iterator]
        return events, await web.api_chat_last("model-session", "thinking-turn")
    events, saved = asyncio.run(exercise())
    assert transports == ["cli", "cli"]
    assert len(commands) == 1 and commands[0][commands[0].index("--thinking") + 1] == "high"
    assert commands[0][commands[0].index("--model") + 1] == "relay/model-b"
    assert not sandbox.requests and not sandbox.probes
    assert saved["requestedThinkingLevel"] == "high" and events[-1]["event"] == "done"


@pytest.mark.parametrize('streamed', ['', 'reply native'])
def test_native_agent_delivers_selected_model_and_thinking_without_cli(sandbox, monkeypatch, streamed):
    calls = []
    class Client:
        def _rpc(self, method, params, **kwargs):
            calls.append((method, params))
            kwargs['on_accepted']({'runId': 'native-run'})
            if streamed:
                web.SHARED_RAW_STREAM.write_text(json.dumps({'runId': 'native-run',
                    'sessionId': params['sessionId'], 'event': 'assistant_text_stream',
                    'evtType': 'text_delta', 'delta': streamed}) + '\n', encoding='utf-8')
            return {'status': 'ok', 'result': {'payloads': [{'text': 'native reply'}]}}
        def close(self): pass
    monkeypatch.setattr(web, '_native_agent_client', lambda credentials: Client())
    async def exercise():
        response = await web.api_chat_stream(web.ChatRequest(message='test', sessionId='model-session',
            turnId='native-turn', modelRef='relay/model-b', thinkingLevel='off'))
        events = [event async for event in response.body_iterator]
        saved = await web.api_chat_last('model-session', 'native-turn')
        assert saved['text'] == 'native reply' and saved['clean_end'] and saved['error'] is None
        assert saved['gateway_run_id'] == 'native-run' and events[-1]['event'] == 'done'
        if streamed:
            assert [json.loads(e['data']) for e in events if e['event'] == 'text_snapshot'] == ['native reply']
            replay = await web.api_chat_job_stream('native-turn')
            replay_events = [event async for event in replay.body_iterator]
            assert [json.loads(e['data']) for e in replay_events if e['event'] == 'text_snapshot'] == ['native reply']
    asyncio.run(exercise())
    assert len(calls) == 1
    assert calls[0][1]['model'] == 'relay/model-b' and calls[0][1]['thinking'] == 'off'
    assert calls[0][1]['sessionId'] == web._openclaw_session_id('model-session')
    assert calls[0][1]['idempotencyKey'] == 'native-turn'


def test_auto_continuation_uses_native_and_keeps_receipts_locks_and_run_identity(sandbox, monkeypatch):
    from easel.chat_continuation import CONTINUE_MESSAGE
    from easel.execution_store import read_snapshot
    calls = []
    class Client:
        def _rpc(self, method, params, **kwargs):
            assert method == 'agent'
            calls.append(dict(params))
            run = params['idempotencyKey']
            kwargs['on_accepted']({'runId': run})
            assert not sandbox.releases, 'both locks must cover all continuation runs'
            for seq, phase in [(1, 'start'), (2, 'end')]:
                kwargs['on_event']({'event': 'agent', 'payload': {
                    'runId': run, 'sessionKey': params['sessionKey'], 'stream': 'tool', 'seq': seq,
                    'data': {'phase': phase, 'toolCallId': run+'-tool', 'name': 'exec',
                             'args': {'command': 'echo receipt'}, 'result': {'content': []}}}})
            return {'status': 'ok', 'result': {'payloads': [{'text': 'partial' if len(calls)==1 else 'completed'}],
                **({'stopReason': 'length'} if len(calls)==1 else {})}}
        def close(self): pass
    monkeypatch.setattr(web, '_native_agent_client', lambda credentials: Client())
    monkeypatch.setattr(controls, '_model_probe_client', lambda *args: Client())
    async def exercise():
        response = await web.api_chat_stream(web.ChatRequest(message='ORIGINAL', sessionId='auto-session',
            turnId='auto-turn', modelRef='relay/model-b', autoContinue=True))
        events = [event async for event in response.body_iterator]
        saved = await web.api_chat_last('auto-session', 'auto-turn')
        assert saved['clean_end'] and saved['error'] is None
        assert saved['text']=='partial\ncompleted' and saved['gateway_run_id']=='auto-turn:continue:1'
        assert any('自动继续 1/2' in event.get('data', '') for event in events)
        snapshot = read_snapshot(web.OUTPUTS_DIR, 'auto-session', 'auto-turn')
        assert len(snapshot['operations']) == 2
        assert events[-1]['event'] == 'done'
    asyncio.run(exercise())
    assert len(calls)==2 and not sandbox.requests
    assert calls[0]['message'].startswith('ORIGINAL\n') and calls[1]['message']==CONTINUE_MESSAGE
    assert calls[0]['sessionId']==calls[1]['sessionId']
    assert calls[1]['model']=='relay/model-b' and sandbox.releases==[True, True]


@pytest.mark.parametrize('change', ['configuration'])
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
    assert events[-1]['event'] == 'done' and sandbox.releases == [True, True]
    assert [json.loads(e['data']) for e in events if e['event'] == 'error'] == [saved['error']]


def test_gateway_rejection_never_reposts_without_model_or_switches_transport(sandbox):
    async def exercise():
        sandbox.status = 403
        events, saved = await collect_turn()
        assert not sandbox.provider_locks['relay'].locked()
        sandbox.status = 200
        _, next_saved = await collect_turn('relay/model-a', 'after-rejection', 'other-session')
        return events, saved, next_saved
    events, saved, next_saved = asyncio.run(exercise())
    assert len(sandbox.requests) == 2
    assert sandbox.requests[0]['headers']['x-openclaw-model'] == 'relay/model-b'
    assert sandbox.requests[1]['headers']['x-openclaw-model'] == 'relay/model-a'
    assert saved['requestedModelRef'] == 'relay/model-b' and saved['error']['code'] == 'gateway_auth_rejected'
    assert not saved['clean_end'] and 'PRIVATE_' not in json.dumps(events)
    assert next_saved['status'] == 'done' and next_saved['clean_end']
    assert len(sandbox.requests) == 2 and not sandbox.provider_locks['relay'].locked()


def test_same_provider_queues_other_sessions_and_queued_turn_can_be_cancelled(sandbox):
    async def drain(stream):
        return [event async for event in stream]

    async def exercise():
        sandbox.connected, sandbox.response_release = asyncio.Event(), asyncio.Event()
        first_response = await web.api_chat_stream(web.ChatRequest(message='first', sessionId='session-one',
            turnId='first-provider-turn', modelRef='relay/model-a'))
        first_task = asyncio.create_task(drain(first_response.body_iterator))
        await asyncio.wait_for(sandbox.connected.wait(), 5)

        second_response = await web.api_chat_stream(web.ChatRequest(message='second', sessionId='session-two',
            turnId='queued-provider-turn', modelRef='relay/model-b'))
        second_task = asyncio.create_task(drain(second_response.body_iterator))
        try:
            deadline = asyncio.get_running_loop().time() + 5
            while not any('渠道 relay 正在处理其他会话' in json.dumps(event['data'], ensure_ascii=False)
                          for event in web._read_job_events('queued-provider-turn')):
                if asyncio.get_running_loop().time() >= deadline:
                    pytest.fail('second turn never reported that it was queued')
                await asyncio.sleep(0.02)
            assert len(sandbox.requests) == 1
            stopped = await web.api_chat_stop(web.StopRequest(sessionId='session-two', turnId='queued-provider-turn'))
            assert stopped['stopped']
            second_events = await asyncio.wait_for(second_task, 5)
            sandbox.response_release.set()
            first_events = await asyncio.wait_for(first_task, 5)
        finally:
            sandbox.response_release.set()
            for task in (first_task, second_task):
                if not task.done():
                    await asyncio.gather(task, return_exceptions=True)

        saved = await web.api_chat_last('session-two', 'queued-provider-turn')
        assert len(sandbox.requests) == 1
        assert saved['stop_reason'] == 'user_stopped'
        assert not [row for row in web._chat_failure_events().recent() if row.get('turnId') == 'queued-provider-turn']
        assert second_events[-1]['event'] == first_events[-1]['event'] == 'done'
        assert not sandbox.provider_locks['relay'].locked()

    asyncio.run(exercise())


def test_different_providers_can_reach_model_at_the_same_time(sandbox):
    async def drain(stream):
        return [event async for event in stream]

    async def exercise():
        config = json.loads(sandbox.config.read_text(encoding='utf-8'))
        config['models']['providers']['other'] = {
            'apiKey': 'OTHER_PRIVATE_KEY', 'baseUrl': 'https://other.invalid',
            'models': [{'id': 'model-c'}],
        }
        sandbox.config.write_text(json.dumps(config), encoding='utf-8')
        sandbox.connected, sandbox.response_release = asyncio.Event(), asyncio.Event()
        first = await web.api_chat_stream(web.ChatRequest(message='first', sessionId='session-one',
            turnId='relay-turn', modelRef='relay/model-a'))
        first_task = asyncio.create_task(drain(first.body_iterator))
        await asyncio.wait_for(sandbox.connected.wait(), 5)
        second = await web.api_chat_stream(web.ChatRequest(message='second', sessionId='session-two',
            turnId='other-turn', modelRef='other/model-c'))
        second_task = asyncio.create_task(drain(second.body_iterator))
        try:
            deadline = asyncio.get_running_loop().time() + 5
            while len(sandbox.requests) < 2:
                if asyncio.get_running_loop().time() >= deadline:
                    pytest.fail('different provider was blocked by the relay provider lock')
                await asyncio.sleep(0.02)
            assert set(sandbox.provider_locks) == {'relay', 'other'}
            assert all(lock.locked() for lock in sandbox.provider_locks.values())
        finally:
            sandbox.response_release.set()
            await asyncio.gather(first_task, second_task, return_exceptions=True)
        assert len(sandbox.requests) == 2
        assert all(not lock.locked() for lock in sandbox.provider_locks.values())

    asyncio.run(exercise())


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


@pytest.mark.parametrize('transport,identity,approved,version,allowed', [
    ('http', ('cli', 'cli'), ['operator.read'], '2026.9.2', True),
    ('cli', ('gateway-client', 'backend'), ['operator.admin'], '2026.9.2', True),
    ('cli', ('cli', 'cli'), ['operator.admin'], '2026.9.2', False),
    ('cli', ('gateway-client', 'backend'), ['operator.read', 'operator.write'], '2026.9.2', False),
    ('cli', ('cli', 'cli'), ['operator.admin'], '2026.9.6', True),
    ('cli', ('cli', 'cli'), ['operator.read', 'operator.write'], '2026.9.6', False),
    ('cli', ('cli', 'cli'), ['operator.admin'], '2026.9.7', False),
])
def test_model_probe_uses_only_already_approved_identity(tmp_path, monkeypatch, transport, identity, approved, version, allowed):
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
        client = ReadGateway()
        client.server_version = version
        return client
    monkeypatch.setattr(controls.gateway, 'GatewayClient', factory)
    credentials = GatewayCredentials('token', token='synthetic-shared-secret')
    if allowed:
        controls._model_probe_client(transport, credentials).close()
        assert connected[0]['client_id'] == identity[0] and connected[0]['client_mode'] == identity[1]
        reuses_device = transport == 'cli' and identity == ('cli', 'cli')
        assert len(connected) == (2 if reuses_device else 1)
        assert connected[0]['scopes'] == (['operator.read'] if reuses_device or transport == 'http' else ['operator.admin'])
        assert connected[-1]['scopes'] == (['operator.admin'] if transport == 'cli' else ['operator.read'])
        if reuses_device:
            assert (connected[-1]['client_id'], connected[-1]['client_mode']) == ('gateway-client', 'backend')
    else:
        with pytest.raises(HTTPException):
            controls._model_probe_client(transport, credentials)
        discovery_only = transport == 'cli' and identity == ('cli', 'cli') and 'operator.admin' in approved
        assert len(connected) == (1 if discovery_only else 0)
        if discovery_only:
            assert connected[0]['scopes'] == ['operator.read']
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


@pytest.mark.parametrize('version', ['2026.9.2', '2026.9.6'])
def test_installed_cli_version_is_read_from_actual_command_without_launch(tmp_path, monkeypatch, version):
    entry = tmp_path / 'openclaw.mjs'
    entry.write_text('// fixture, never execute')
    package = tmp_path / 'package.json'
    package.write_text(json.dumps({'name': 'openclaw', 'version': version}))
    monkeypatch.setattr(web, 'openclaw_base_cmd', lambda: ['node', str(entry)])
    monkeypatch.setattr(web.subprocess, 'run', lambda *a, **kw: pytest.fail('no CLI version invocation'))
    assert controls._cli_override_version(web) == version
    package.write_text(json.dumps({'name': 'openclaw', 'version': '2026.6.11'}))
    assert controls._cli_override_version(web) is None


def test_unknown_capability_does_not_block_a_configured_explicit_model(sandbox, monkeypatch):
    monkeypatch.setattr(controls, 'turn_model_capability', lambda *args, **kwargs: {
        'available': False, 'scope': 'unavailable', 'options': [], 'reason': 'device approval missing'})
    result = controls.require_model_override(web, 'model-session', 'relay/model-b', transport='http')
    assert result['available'] is False



def test_explicitly_disabled_model_remains_rejected(sandbox):
    from model_preferences import path_for
    path_for(sandbox.config).write_text(json.dumps(['relay']))
    with pytest.raises(HTTPException) as exc:
        controls.require_model_override(web, 'model-session', 'relay/model-b', transport='http')
    assert exc.value.status_code == 400



@pytest.mark.parametrize('probe_error', ['approval missing', 'temporary probe failure'])
def test_unknown_probe_still_submits_selected_model_once(sandbox, monkeypatch, probe_error):
    monkeypatch.setattr(controls, '_probe_http_override',
                        lambda *a: (_ for _ in ()).throw(HTTPException(503, probe_error)))
    events, saved = asyncio.run(collect_turn())
    assert len(sandbox.requests) == 1
    assert sandbox.requests[0]['headers']['x-openclaw-model'] == 'relay/model-b'
    assert saved['requestedModelRef'] == 'relay/model-b' and saved['clean_end']
    assert events[-1]['event'] == 'done'
