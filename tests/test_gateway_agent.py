import json
import threading
from types import SimpleNamespace

import pytest

from easel.gateway_agent import GatewayAgentProc
from easel.gateway_questions import GatewayClient, GatewayQuestionError


def test_rpc_waits_for_final_and_preserves_rejection(monkeypatch):
    monkeypatch.setitem(__import__('sys').modules, 'websocket', SimpleNamespace())
    frames = iter([
        {'id': '1', 'ok': True, 'payload': {'status': 'accepted', 'runId': 'exact'}},
        {'event': 'agent', 'payload': {'runId': 'foreign'}},
        {'id': '1', 'ok': False, 'payload': {'status': 'error'},
         'error': {'message': 'upstream rejected model', 'code': 'UNAVAILABLE'}},
    ])
    sent, accepted, timeouts = [], [], []
    client = GatewayClient()
    client.ws = SimpleNamespace(send=lambda x: sent.append(json.loads(x)),
        recv=lambda: json.dumps(next(frames)), settimeout=timeouts.append)
    with pytest.raises(GatewayQuestionError, match='upstream rejected model') as error:
        client._rpc('agent', {'message': 'test'}, expect_final=True, on_accepted=accepted.append)
    assert len(sent) == 1 and accepted == [{'status': 'accepted', 'runId': 'exact'}]
    assert error.value.rpc_response and error.value.response_payload == {'status': 'error'}
    assert timeouts


def test_native_preserves_request_and_final_text():
    calls = []
    class Client:
        def _rpc(self, method, params, **kw):
            calls.append((method, params, kw))
            kw['on_accepted']({'runId': 'exact-run', 'status': 'accepted'})
            return {'status': 'ok', 'result': {'payloads': [{'text': '真实回复'}]}}
        def close(self): pass
    params = {'idempotencyKey': 'unique-turn', 'agentId': 'main', 'sessionKey': 'agent:main:chat',
              'sessionId': 'runtime-id', 'message': '用户提示', 'model': 'relay/model', 'thinking': 'off'}
    proc = GatewayAgentProc(Client(), Client, params, 10)
    assert proc.wait(1) == 0 and ''.join(proc.stdout) == '真实回复\n'
    assert calls[0][0:2] == ('agent', params) and calls[0][2]['expect_final']
    assert proc._office_run_id == 'exact-run' and proc.clean_end


def test_stop_targets_accepted_run_and_waits_for_terminal():
    started, release = threading.Event(), threading.Event()
    calls = []
    class Client:
        def _rpc(self, method, params, **kw):
            calls.append((method, params))
            if method == 'agent':
                kw['on_accepted']({'runId': 'accepted-run'})
                started.set()
                release.wait(2)
                return {'status': 'error', 'summary': 'cancelled'}
            assert method == 'chat.abort' and params['runId'] == 'accepted-run'
            return {'aborted': True, 'runIds': ['accepted-run']}
        def close(self): pass
    proc = GatewayAgentProc(Client(), Client, {'idempotencyKey': 'turn', 'agentId': 'main',
        'sessionKey': 'agent:main:chat'}, 10)
    assert started.wait(1)
    proc.terminate()
    assert proc.poll() is None
    release.set()
    assert proc.wait(1) == 1 and not proc.clean_end
    assert len([x for x in calls if x[0] == 'agent']) == 1


def test_disconnect_reconciles_without_resending_prompt():
    calls = []
    class Client:
        def _rpc(self, method, params, **kw):
            calls.append(method)
            if method == 'agent':
                kw['on_accepted']({'runId': 'accepted-run'})
                raise OSError('connection reset')
            return {'aborted': True, 'runIds': ['accepted-run']}
        def close(self): pass
    proc = GatewayAgentProc(Client(), Client, {'idempotencyKey': 'turn', 'agentId': 'main',
        'sessionKey': 'agent:main:chat'}, 10)
    assert proc.wait(1) == 1 and 'connection reset' in proc.error_text
    assert calls == ['agent', 'chat.abort']
