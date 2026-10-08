"""Isolated transcript/config fixtures and gateway receipts; no real model calls."""
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import time
from types import SimpleNamespace
import uuid

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import office_controls as controls

CHILD = 'agent:main:subagent:child1'
AGENT = 'subagent:' + hashlib.sha256(CHILD.encode()).hexdigest()[:20]
RUN = 'run-child1'


class FakeGateway:
    methods = {'sessions.list', 'sessions.patch', 'sessions.abort'}
    granted_scopes = set(controls.SCOPES)

    def __init__(self):
        self.calls = []
        self.row = {'key': CHILD, 'sessionId': 'runtime-child', 'spawnedBy': 'agent:main:chat',
                    'status': 'running', 'lastRunId': RUN, 'modelProvider': 'relay', 'model': 'model-a'}
        self.receipt = None
        self.on_list = None
        self.closed = False

    def _rpc(self, method, params):
        self.calls.append((method, params))
        if method == 'sessions.list':
            if self.on_list:
                self.on_list()
            return {'sessions': [self.row]}
        if isinstance(self.receipt, Exception):
            raise self.receipt
        if self.receipt is not None:
            return self.receipt
        if method == 'sessions.abort':
            return {'ok': True, 'status': 'aborted', 'abortedRunId': params['runId']}
        return {'ok': True, 'key': params['key'], 'entry': {'sessionId': self.row['sessionId']},
                'resolved': {'modelProvider': 'relay', 'model': 'model-b'}}

    def close(self):
        self.closed = True


@pytest.fixture
def sandbox(tmp_path, monkeypatch):
    monkeypatch.setattr(controls, '_STOP_RECEIPTS', controls.OrderedDict())
    sessions, outputs, transcripts, state = [tmp_path / n for n in ('sessions', 'outputs', 'transcripts', 'state')]
    for directory in (sessions, outputs, transcripts, state):
        directory.mkdir()
    marker = sessions / 'web_chat.json'
    marker.write_text(json.dumps({'turn_id': 'turn1', 'status': 'running'}))
    trace = transcripts / 'parent.jsonl'
    events = [
        {'timestamp': time.time(), 'message': {'role': 'assistant', 'content': [
            {'type': 'toolCall', 'id': 'spawn', 'name': 'sessions_spawn', 'arguments': {'task': 'test'}}]}},
        {'timestamp': time.time(), 'message': {'role': 'toolResult', 'toolCallId': 'spawn', 'isError': False,
            'content': [{'type': 'text', 'text': json.dumps({'status': 'accepted', 'childSessionKey': CHILD, 'runId': RUN})}]}}
    ]
    trace.write_text(''.join(json.dumps(event) + '\n' for event in events), encoding='utf-8')
    (transcripts / 'sessions.json').write_text(json.dumps({'agent:main:chat': {'sessionId': 'parent'}}))
    audit = outputs / '_skill_audits' / hashlib.sha256(b'chat').hexdigest()[:24] / 'turn1.json'
    audit.parent.mkdir(parents=True)
    audit.write_text(json.dumps({'sessionId': 'chat', 'turnId': 'turn1', 'status': 'running',
        'started': time.time() - 30, '_sources': {str(trace): {'offset': 0, 'digest': hashlib.sha256(b'').hexdigest()}}}))
    (state / 'openclaw.json').write_text(json.dumps({'models': {'providers': {'relay': {
        'apiKey': 'PRIVATE_CONFIG_KEY', 'baseUrl': 'https://PRIVATE_URL.invalid',
        'models': [{'id': 'model-a'}, {'id': 'model-b'}, {'id': 'model-b'}]}}}}))
    proc = SimpleNamespace(poll=lambda: None, _office_run_id='root-run')
    web = SimpleNamespace(SESSIONS_DIR=sessions, OUTPUTS_DIR=outputs, OPENCLAW_SESSIONS_DIR=transcripts,
                          _RUNNING_CHAT={'chat': proc}, _ACTIVE_SKILL_TURNS={'chat': 'turn1'},
                          _STOPPED_CHAT=set(), openclaw_state_dir=lambda: state)
    client = FakeGateway()
    monkeypatch.setattr(controls, '_new_client', lambda: client)
    return SimpleNamespace(web=web, client=client, marker=marker, trace=trace, events=events, state=state, audit=audit)


def run(sandbox, action='controls', agent=AGENT, turn='turn1', model=None):
    return controls.operate(sandbox.web, 'chat', turn, agent, action, model)


def test_controls_expose_configured_ids_and_disable_running_model_changes(sandbox):
    result = run(sandbox)
    assert result['stop'] == {'available': True, 'scope': 'agent',
        'runId': RUN,
        'reason': '停止该 Agent 及其派生任务，不停止父级或兄弟 Agent。'}
    assert not result['model']['available']
    assert '停止' in result['model']['reason']
    assert [row['id'] for row in result['model']['options']] == ['relay/model-a', 'relay/model-b']
    assert 'PRIVATE_' not in json.dumps(result)
    assert sandbox.client.closed


def test_child_stop_uses_exact_run_and_never_stops_parent(sandbox):
    proc = sandbox.web._RUNNING_CHAT['chat']
    result = run(sandbox, 'stop')
    assert result['confirmed'] and result['scope'] == 'agent'
    assert sandbox.client.calls[-1] == ('sessions.abort', {'key': CHILD, 'runId': RUN})
    assert sandbox.web._RUNNING_CHAT['chat'] is proc and not sandbox.web._STOPPED_CHAT


@pytest.mark.parametrize('receipt', [None, {}, {'ok': True, 'status': 'no-active-run', 'abortedRunId': None},
    {'ok': True, 'status': 'aborted', 'abortedRunId': 'different-run'}])
def test_unmatched_stop_receipt_never_confirms(sandbox, receipt):
    sandbox.client.receipt = receipt if receipt is not None else []
    assert not run(sandbox, 'stop')['confirmed']


def test_stop_timeout_is_sanitized_and_never_changes_parent(sandbox):
    sandbox.client.receipt = TimeoutError('token=PRIVATE_RPC_SECRET')
    with pytest.raises(HTTPException) as exc:
        run(sandbox, 'stop')
    assert exc.value.status_code == 503 and 'PRIVATE_' not in str(exc.value.detail)
    assert not sandbox.web._STOPPED_CHAT


@pytest.mark.parametrize('turn,agent,status', [('old-turn', AGENT, 409), ('turn1', 'subagent:' + 'f' * 20, 404),
    ('turn1', 'root:foreign', 400), ('../foreign', AGENT, 400)])
def test_stale_and_foreign_identity_never_call_gateway(sandbox, turn, agent, status):
    with pytest.raises(HTTPException) as exc:
        run(sandbox, 'stop', agent=agent, turn=turn)
    assert exc.value.status_code == status and not sandbox.client.calls


def test_trace_boundary_rewrite_denies_child_control(sandbox):
    record = json.loads(sandbox.audit.read_text())
    record['_sources'][str(sandbox.trace)] = {'offset': 5, 'digest': 'not-original-prefix'}
    sandbox.audit.write_text(json.dumps(record))
    with pytest.raises(HTTPException) as exc:
        run(sandbox, 'stop')
    assert exc.value.status_code == 404 and not sandbox.client.calls


def test_gateway_foreign_parent_denies_control(sandbox):
    sandbox.client.row['spawnedBy'] = 'agent:main:foreign'
    with pytest.raises(HTTPException) as exc:
        run(sandbox, 'stop')
    assert exc.value.status_code == 409
    assert [method for method, _ in sandbox.client.calls] == ['sessions.list']


def test_midread_turn_change_denies_mutation(sandbox):
    sandbox.client.on_list = lambda: sandbox.web._ACTIVE_SKILL_TURNS.update(chat='new-turn')
    with pytest.raises(HTTPException) as exc:
        run(sandbox, 'stop')
    assert exc.value.status_code == 409
    assert [method for method, _ in sandbox.client.calls] == ['sessions.list']


def test_terminal_child_model_patches_exact_session_and_model(sandbox):
    sandbox.client.row.update(status='killed', lifecycleRevision='lifecycle1')
    result = run(sandbox, 'model', model='relay/model-b')
    assert result['applied'] and result['scope'] == 'subsequent_calls'
    assert sandbox.client.calls[-1] == ('sessions.patch', {'key': CHILD, 'model': 'relay/model-b',
        'expectedSessionId': 'runtime-child', 'expectedLifecycleRevision': 'lifecycle1'})
    assert not sandbox.web._STOPPED_CHAT


def test_model_unmatched_receipt_not_confirmed(sandbox):
    sandbox.client.row['status'] = 'done'
    sandbox.client.receipt = {'ok': True, 'key': CHILD, 'entry': {'sessionId': 'other-runtime'},
                              'resolved': {'modelProvider': 'relay', 'model': 'model-b'}}
    assert not run(sandbox, 'model', model='relay/model-b')['applied']


@pytest.mark.parametrize('state,last_run,model', [('running', RUN, 'relay/model-b'),
    ('unknown', RUN, 'relay/model-b'), ('done', 'other-run', 'relay/model-b'), ('done', RUN, 'foreign/model')])
def test_model_not_configured_active_unknown_or_different_run_denied(sandbox, state, last_run, model):
    sandbox.client.row.update(status=state, lastRunId=last_run)
    with pytest.raises(HTTPException):
        run(sandbox, 'model', model=model)
    assert all(method != 'sessions.patch' for method, _ in sandbox.client.calls)


def test_completed_parent_still_resolves_child_for_configuration(sandbox):
    sandbox.marker.write_text(json.dumps({'turn_id': 'turn1', 'status': 'done', 'clean_end': True}))
    sandbox.web._RUNNING_CHAT.clear()
    sandbox.web._ACTIVE_SKILL_TURNS.clear()
    sandbox.client.row['status'] = 'done'
    assert run(sandbox, 'model', model='relay/model-b')['applied']


def test_missing_run_receipt_keeps_stop_disabled(sandbox):
    receipt = json.loads(sandbox.events[1]['message']['content'][0]['text'])
    receipt.pop('runId')
    sandbox.events[1]['message']['content'][0]['text'] = json.dumps(receipt)
    sandbox.trace.write_text(''.join(json.dumps(e) + '\n' for e in sandbox.events), encoding='utf-8')
    assert not run(sandbox)['stop']['available']


def test_root_stop_explicitly_scoped_session(sandbox):
    sandbox.client.row.update(key='agent:main:chat', sessionId=str(uuid.uuid5(controls.office.SESSION_NS, 'chat')))
    result = run(sandbox, 'stop', agent='root:chat')
    assert result['confirmed'] and result['scope'] == 'session'
    assert sandbox.client.calls[-1] == ('sessions.abort', {'key': 'agent:main:chat', 'runId': 'root-run'})
    assert sandbox.web._STOPPED_CHAT == {'chat'}


def test_unsupported_gateway_exposes_no_mutation_capability(sandbox):
    sandbox.client.methods = {'sessions.list'}
    sandbox.client.row['status'] = 'done'
    result = run(sandbox)
    assert not result['model']['available'] and not result['stop']['available']


def test_new_client_requires_existing_pairing_without_connect(tmp_path, monkeypatch):
    # Exercise the real preflight instead of a live user device or gateway.
    monkeypatch.setattr(controls.gateway, '_load_device', lambda: {'device_id': 'device1', 'public_key': 'public'})
    monkeypatch.setattr(controls.gateway, 'PROFILE_DB', tmp_path / 'missing.sqlite')
    monkeypatch.setattr(controls.gateway, 'GatewayClient', lambda **kw: pytest.fail('must not connect or pair'))
    with pytest.raises(HTTPException) as exc:
        controls._new_client()
    assert exc.value.status_code == 503


def test_existing_pairing_connects_without_admin_scope(tmp_path, monkeypatch):
    db_path = tmp_path / 'gateway.sqlite'
    with sqlite3.connect(db_path) as db:
        db.execute('CREATE TABLE device_pairing_paired(device_id TEXT, public_key TEXT, approved_scopes_json TEXT, '
                   'scopes_json TEXT, role TEXT, roles_json TEXT, client_id TEXT, client_mode TEXT)')
        db.execute('INSERT INTO device_pairing_paired VALUES(?,?,?,?,?,?,?,?)',
                   ('device1', 'public', json.dumps(['operator.admin']), None, 'operator', '[]', 'cli', 'cli'))
    monkeypatch.setattr(controls.gateway, '_load_device', lambda: {'device_id': 'device1', 'public_key': 'public'})
    monkeypatch.setattr(controls.gateway, 'PROFILE_DB', db_path)
    fake = FakeGateway()
    fake.connect = lambda: None
    def client(**kwargs):
        assert kwargs == {'timeout': 3.0, 'scopes': ['operator.read', 'operator.write']}
        return fake
    monkeypatch.setattr(controls.gateway, 'GatewayClient', client)
    assert controls._new_client() is fake
    fake.granted_scopes = {'operator.admin', *controls.SCOPES}
    with pytest.raises(HTTPException):
        controls._new_client()
    assert fake.closed


def test_stop_snapshot_requires_same_current_run_and_gateway_terminal(sandbox):
    run(sandbox, 'stop')
    sandbox.client.row['status'] = 'killed'
    def snapshot():
        return controls.office.snapshot('chat', sandbox.web.SESSIONS_DIR,
            sandbox.web.OUTPUTS_DIR / '_skill_audits', sandbox.web.OPENCLAW_SESSIONS_DIR,
            live=True, active_turn_id='turn1')
    result = controls.confirmed_stop_snapshot(sandbox.web, snapshot())
    assert result['agents'][1]['status'] == 'stopped'
    assert '网关已确认' in result['agents'][1]['evidence']
    sandbox.client.row['lastRunId'] = 'new-run'
    assert controls.confirmed_stop_snapshot(sandbox.web, snapshot())['agents'][1]['status'] == 'unknown'
    sandbox.client.row.update(lastRunId=RUN, status='running')
    assert controls.confirmed_stop_snapshot(sandbox.web, snapshot())['agents'][1]['status'] == 'unknown'
    sandbox.client.row.update(status='killed', spawnedBy='agent:main:foreign')
    assert controls.confirmed_stop_snapshot(sandbox.web, snapshot())['agents'][1]['status'] == 'unknown'
    sandbox.client.row.update(spawnedBy='agent:main:chat', sessionId='replacement-session')
    assert controls.confirmed_stop_snapshot(sandbox.web, snapshot())['agents'][1]['status'] == 'unknown'


def test_old_turn_and_missing_gateway_never_overlay_stop(sandbox, monkeypatch):
    run(sandbox, 'stop')
    sandbox.client.row['status'] = 'killed'
    snapshot = {'sessionId': 'chat', 'turnId': 'new-turn', 'agents': [{'id': AGENT, 'role': 'subagent', 'status': 'running'}]}
    assert controls.confirmed_stop_snapshot(sandbox.web, snapshot)['agents'][0]['status'] == 'running'
    snapshot['turnId'] = 'turn1'
    monkeypatch.setattr(controls, '_new_client', lambda: (_ for _ in ()).throw(TimeoutError()))
    assert controls.confirmed_stop_snapshot(sandbox.web, snapshot)['agents'][0]['status'] == 'running'


def test_receipt_cache_is_bounded(sandbox, monkeypatch):
    monkeypatch.setattr(controls, 'MAX_STOP_RECEIPTS', 2)
    target = controls.resolve_target(sandbox.web, 'chat', 'turn1', AGENT)
    for index in range(3):
        target.identity = {**target.identity, 'turnId': f'turn{index}'}
        controls._remember_stop(target)
    assert len(controls._STOP_RECEIPTS) == 2
    assert ('chat', 'turn0', AGENT) not in controls._STOP_RECEIPTS


def test_root_stop_without_local_process_cannot_leave_stop_flag(sandbox):
    sandbox.marker.write_text(json.dumps({'turn_id': 'turn1', 'status': 'done', 'gateway_run_id': 'root-run'}))
    sandbox.web._RUNNING_CHAT.clear()
    sandbox.web._ACTIVE_SKILL_TURNS.clear()
    sandbox.client.row.update(key='agent:main:chat', sessionId=str(uuid.uuid5(controls.office.SESSION_NS, 'chat')))
    assert run(sandbox, 'stop', agent='root:chat')['confirmed']
    assert not sandbox.web._STOPPED_CHAT


def test_stop_expected_run_rejects_stale_ui_before_gateway_mutation(sandbox):
    with pytest.raises(HTTPException) as exc:
        controls.operate(sandbox.web, 'chat', 'turn1', AGENT, 'stop', expected_run_id='previous-run')
    assert exc.value.status_code == 409 and not sandbox.client.calls
    result = controls.operate(sandbox.web, 'chat', 'turn1', AGENT, 'stop', expected_run_id=RUN)
    assert result['confirmed'] and result['runId'] == RUN


def test_child_new_gateway_run_cannot_inherit_old_spawn_receipt(sandbox):
    sandbox.client.row['lastRunId'] = 'new-child-run'
    capability = run(sandbox)['stop']
    assert not capability['available'] and capability['runId'] is None
    with pytest.raises(HTTPException):
        controls.operate(sandbox.web, 'chat', 'turn1', AGENT, 'stop', expected_run_id=RUN)
    assert all(method != 'sessions.abort' for method, _ in sandbox.client.calls)


def test_http_routes_match_frontend_contract_and_reject_old_turn(sandbox, monkeypatch):
    from fastapi.testclient import TestClient
    import app as web
    for name in ('SESSIONS_DIR', 'OUTPUTS_DIR', 'OPENCLAW_SESSIONS_DIR', '_RUNNING_CHAT',
                 '_ACTIVE_SKILL_TURNS', '_STOPPED_CHAT', 'openclaw_state_dir'):
        monkeypatch.setattr(web, name, getattr(sandbox.web, name))
    client = TestClient(web.app, base_url='http://127.0.0.1:7860', client=('127.0.0.1', 51234))
    identity = {'sessionId': 'chat', 'turnId': 'turn1', 'agentId': AGENT}
    response = client.get('/api/agent-office/controls', params=identity)
    assert response.status_code == 200 and response.json()['stop']['scope'] == 'agent'
    response = client.post('/api/agent-office/stop', json=identity)
    assert response.status_code == 200 and response.json()['confirmed'] is True
    sandbox.client.row['status'] = 'killed'
    response = client.get('/api/agent-office', params={'sessionId': 'chat'})
    assert response.status_code == 200 and response.json()['agents'][1]['status'] == 'stopped'
    response = client.post('/api/agent-office/model', json={**identity, 'modelRef': 'relay/model-b'})
    assert response.status_code == 200 and response.json()['scope'] == 'subsequent_calls'
    assert response.json()['applied'] is True
    response = client.post('/api/agent-office/stop', json={**identity, 'turnId': 'old-turn'})
    assert response.status_code == 409


def test_gateway_handshake_requests_only_explicit_scopes(monkeypatch):
    frames = []
    incoming = iter([
        {'event': 'connect.challenge', 'payload': {'nonce': 'fixture-nonce', 'ts': 123}},
        {'id': '1', 'ok': True, 'payload': {'server': {'version': '2026.9.2'},
                                          'features': {'methods': ['sessions.list', 'sessions.abort']},
                                          'auth': {'scopes': controls.SCOPES}}},
    ])
    socket = SimpleNamespace(recv=lambda: json.dumps(next(incoming)), send=lambda frame: frames.append(json.loads(frame)), close=lambda: None)
    monkeypatch.setattr(controls.gateway, '_load_device', lambda: {'device_id': 'fixture', 'token': '', 'public_key': 'public'})
    monkeypatch.setattr(controls.gateway, '_sign', lambda payload: 'synthetic-signature')
    monkeypatch.setitem(sys.modules, 'websocket', SimpleNamespace(create_connection=lambda *a, **kw: socket))
    client = controls.gateway.GatewayClient(timeout=1, scopes=controls.SCOPES)
    client.connect()
    assert frames[0]['params']['scopes'] == ['operator.read', 'operator.write']
    assert client.granted_scopes == set(controls.SCOPES)
    assert client.methods == {'sessions.list', 'sessions.abort'}
    assert client.server_version == '2026.9.2'
    client.close()


def test_backend_probe_handshake_signs_exact_identity_and_existing_shared_auth(monkeypatch):
    frames, signatures = [], []
    incoming = iter([
        {'event': 'connect.challenge', 'payload': {'nonce': 'fixture-nonce', 'ts': 123}},
        {'id': '1', 'ok': True, 'payload': {'server': {'version': 'PRIVATE_SECRET'},
            'features': {'methods': ['agent']}, 'auth': {'scopes': ['operator.admin']}}},
    ])
    socket = SimpleNamespace(recv=lambda: json.dumps(next(incoming)), send=lambda frame: frames.append(json.loads(frame)), close=lambda: None)
    monkeypatch.setattr(controls.gateway, '_load_device', lambda: {'device_id': 'fixture', 'token': 'device-token', 'public_key': 'public'})
    monkeypatch.setattr(controls.gateway, '_sign', lambda payload: signatures.append(payload) or 'synthetic-signature')
    monkeypatch.setitem(sys.modules, 'websocket', SimpleNamespace(create_connection=lambda *a, **kw: socket))
    client = controls.gateway.GatewayClient(timeout=1, scopes=['operator.admin'], client_id='gateway-client',
        client_mode='backend', auth={'token': 'shared-token'})
    client.connect()
    params = frames[0]['params']
    assert params['client']['id'] == 'gateway-client' and params['client']['mode'] == 'backend'
    assert params['auth'] == {'token': 'shared-token'} and params['scopes'] == ['operator.admin']
    assert signatures == ['v2|fixture|gateway-client|backend|operator|operator.admin|123|shared-token|fixture-nonce']
    assert client.server_version is None
    client.close()
