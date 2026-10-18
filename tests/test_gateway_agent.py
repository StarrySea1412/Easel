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


def test_native_preserves_structured_output_limit_reason():
    class Client:
        def _rpc(self, method, params, **kw):
            kw['on_accepted']({'runId': 'length-run', 'status': 'accepted'})
            return {'status': 'ok', 'result': {
                'payloads': [{'text': '部分回复', 'finish_reason': 'length'}],
                'incomplete_details': {'reason': 'max_output_tokens'},
            }}
        def close(self): pass
    proc = GatewayAgentProc(Client(), Client, {'idempotencyKey': 'length-turn',
        'agentId': 'main', 'sessionKey': 'agent:main:chat'}, 10)
    assert proc.wait(1) == 0 and proc.stop_reason == 'max_tokens'


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


def test_confirmed_abort_releases_receiver_even_when_final_never_arrives():
    started, closed = threading.Event(), threading.Event()
    calls, accepted = [], []
    class Client:
        def __init__(self, receiver=False): self.receiver = receiver
        def _rpc(self, method, params, **kwargs):
            calls.append(method)
            if method == 'agent':
                kwargs['on_accepted']({'runId': 'exact'})
                started.set()
                assert closed.wait(2)
                raise OSError('receiver closed after confirmed abort')
            return {'ok': True, 'aborted': True, 'runIds': ['exact']}
        def close(self):
            if self.receiver: closed.set()
    proc = GatewayAgentProc(Client(True), Client, {'idempotencyKey': 'turn', 'agentId': 'main',
        'sessionKey': 'agent:main:own'}, 100, on_accepted=accepted.append)
    assert started.wait(1) and accepted == ['exact']
    proc.terminate()
    assert proc.wait(1) == 1 and not proc.clean_end
    assert calls == ['agent', 'chat.abort']


def test_stop_before_acceptance_waits_for_accepted_identity_before_abort():
    dispatch, accept, ended = threading.Event(), threading.Event(), threading.Event()
    calls = []
    class Client:
        def _rpc(self, method, params, **kwargs):
            calls.append((method, params))
            if method == 'agent':
                dispatch.set()
                assert accept.wait(2)
                kwargs['on_accepted']({'runId': 'accepted-later'})
                return {'status': 'error'}
            return {'ok': True, 'aborted': True, 'runIds': ['accepted-later']}
        def close(self): pass
    proc = GatewayAgentProc(Client(), Client, {'idempotencyKey': 'early', 'agentId': 'main',
        'sessionKey': 'agent:main:own'}, 10)
    assert dispatch.wait(1)
    proc.terminate()
    assert [method for method, _ in calls] == ['agent'] and proc.poll() is None
    accept.set()
    assert proc.wait(1) == 1
    assert calls[-1][0] == 'chat.abort' and calls[-1][1]['runId'] == 'accepted-later'


def test_compaction_events_are_forwarded_only_for_own_run_and_safe_lifecycle():
    class Client:
        def _rpc(self, method, params, **kw):
            kw['on_accepted']({'runId': 'own'})
            for payload in [
                {'runId': 'foreign', 'stream': 'compaction', 'data': {'phase': 'start'}},
                {'runId': 'own', 'sessionKey': 'foreign-session', 'stream': 'compaction', 'data': {'phase': 'start'}},
                {'runId': 'own', 'stream': 'assistant', 'data': {'phase': 'start'}},
                {'runId': 'own', 'stream': 'compaction', 'data': {'phase': 'start', 'reason': 'PRIVATE'}},
                {'runId': 'own', 'stream': 'compaction', 'data': {'phase': 'end', 'completed': False, 'outcome': 'failed', 'reason': 'PRIVATE'}},
                {'runId': 'own', 'stream': 'compaction', 'data': {'phase': 'end', 'completed': True, 'outcome': 'completed'}},
            ]:
                kw['on_event']({'type': 'event', 'event': 'agent', 'payload': payload})
            return {'status': 'ok', 'result': {'payloads': [{'text': '正文'}]}}
        def close(self): pass
    seen=[]
    proc=GatewayAgentProc(Client(),Client,{'idempotencyKey':'id','sessionKey':'own-session','agentId':'main'},10,on_compaction=seen.append)
    assert proc.wait(1)==0
    assert seen==[{'phase':'start'},{'phase':'end','outcome':'failed'},{'phase':'end','outcome':'completed'}]
    assert ''.join(proc.stdout)=='正文\n'


def test_rpc_delivers_events_without_confusing_them_with_final_response(monkeypatch):
    monkeypatch.setitem(__import__('sys').modules, 'websocket', SimpleNamespace())
    frames=iter([
      {'type':'event','event':'agent','payload':{'stream':'compaction','data':{'phase':'start'}}},
      {'id':'1','ok':True,'payload':{'status':'ok'}},
    ])
    client=GatewayClient();client.ws=SimpleNamespace(send=lambda _:None,recv=lambda:json.dumps(next(frames)),settimeout=lambda _:None)
    events=[]
    assert client._rpc('agent',{},on_event=events.append)=={'status':'ok'}
    assert len(events)==1 and events[0]['payload']['stream']=='compaction'
