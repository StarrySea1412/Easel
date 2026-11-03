import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from easel.chat_continuation import continuation_reason, confirmed_terminal_operations, CONTINUE_MESSAGE
from easel.gateway_agent import GatewayAgentProc


def test_decisions_require_specific_recoverable_evidence():
    assert continuation_reason(error='LLM idle timeout (120s): no response') == 'model_idle_timeout'
    assert continuation_reason(stop_reason='max_tokens') == 'output_limit'
    assert continuation_reason(stop_reason='model_length') == 'output_limit'
    assert continuation_reason(error='agent_execution_failed', stop_reason='length') == 'output_limit'
    assert continuation_reason(text='我会继续执行', plan=[{'status': 'pending'}]) == 'unfinished_plan'
    for error in ['timeout', 'HTTP 503', 'connection reset', '401 Unauthorized']:
        assert continuation_reason(error=error) is None
    for row in [{'status':'running'}, {'status':'unconfirmed'}, {'status':'denied'},
                {'status':'stopped'}, {'status':'pending'}, {'status':'unknown'}, {'status':'failed'}]:
        assert continuation_reason(error='LLM idle timeout (120s)', operations=[row]) is None
    assert continuation_reason(stop_reason='length', operations=[{'status':'completed'}]) is None
    for text in ['请确认是否继续？', '需要登录', '请提供材料']:
        assert continuation_reason(error='LLM idle timeout (120s)', text=text) is None
    assert continuation_reason(stop_reason='length', pending_question=True) is None
    assert continuation_reason(error='agent_execution_failed', stop_reason='length',
                               operations=[{'status':'running'}]) is None
    assert continuation_reason(text='已完成') is None


def test_auto_continue_requires_a_complete_transcript_receipt():
    assert confirmed_terminal_operations({'operations': []}) == []
    assert confirmed_terminal_operations({'operations': [{'status':'completed'}]}) == [{'status':'completed'}]
    assert confirmed_terminal_operations({'operations': [], 'warnings':['transcript unavailable']}) is None
    assert confirmed_terminal_operations({'operations':[{'status':'unconfirmed'}]}) is None
    assert confirmed_terminal_operations({'operations': None}) is None


def make_client(results, calls, *, wait_status='error', continued=None):
    class Client:
        def _rpc(self, method, params, **kw):
            calls.append((method, dict(params)))
            if method == 'agent.wait':
                return {'runId': next(value['idempotencyKey'] for kind,value in reversed(calls) if kind=='agent'), 'status': wait_status}
            if method == 'chat.abort':
                return {'aborted': True, 'runIds': [params['runId']]}
            kw['on_accepted']({'runId': params['idempotencyKey']})
            result = results.pop(0)
            if isinstance(result, Exception):
                raise result
            return result
        def close(self): pass
    return Client


def error_response():
    from easel.gateway_questions import GatewayQuestionError
    error = GatewayQuestionError('LLM idle timeout (120s): no response from model')
    error.rpc_response = True
    return error


@pytest.mark.parametrize('mode', ['idle', 'limit', 'meta', 'error_limit', 'error_limit_empty', 'plan'])
def test_continues_in_same_session_without_replaying_original(mode):
    calls, continued = [], []
    first = error_response() if mode == 'idle' else (
        {'status':'error', 'summary':'failed',
         'result':{'meta':{'stopReason':'length'},
                   'payloads':[] if mode == 'error_limit_empty' else [{'text':'已完成的部分'}]}}
        if mode in ('error_limit', 'error_limit_empty') else
        {'status':'ok','result':{'payloads':[{'text':'我会继续执行'}], **(
            {'stopReason':'length'} if mode=='limit' else
            {'meta': {'stopReason':'length', 'completion': {'finishReason':'length'}}} if mode=='meta' else {})}}
    )
    results=[first, {'status':'ok','result':{'payloads':[{'text':'实际交付完成'}]}}]
    Client=make_client(results,calls)
    params={'idempotencyKey':'turn','agentId':'main','sessionKey':'agent:main:own','model':'relay/model','message':'ORIGINAL TASK'}
    proc=GatewayAgentProc(Client(),Client,params,30,
        continuation=lambda **kw:continuation_reason(**kw,plan=[{'status':'pending'}] if mode=='plan' else []),
        on_continue=lambda *value:continued.append(value))
    assert proc.wait(5)==0
    agents=[value for method,value in calls if method=='agent']
    assert len(agents)==2 and agents[0]['message']=='ORIGINAL TASK' and agents[1]['message']==CONTINUE_MESSAGE
    assert agents[1]['sessionKey']==params['sessionKey'] and agents[1]['model']==params['model']
    assert agents[1]['idempotencyKey']=='turn:continue:1' and len(continued)==1 and proc.clean_end
    if mode == 'error_limit':
        assert '已完成的部分' in ''.join(proc.stdout)


@pytest.mark.parametrize('mode', ['rpc_error', 'receiver_drop'])
def test_exact_wait_receipt_recovers_length_after_gateway_error_or_disconnect(monkeypatch, mode):
    import easel.gateway_agent as gateway
    from easel.gateway_questions import GatewayQuestionError
    monkeypatch.setattr(gateway.time, 'sleep', lambda _: None)
    calls = []

    class Client:
        def _rpc(self, method, params, **kwargs):
            calls.append((method, dict(params)))
            if method == 'agent.wait':
                return {'runId': params['runId'], 'status': 'error', 'endedAt': 1,
                        'stopReason': 'length'}
            kwargs['on_accepted']({'runId': params['idempotencyKey']})
            if params['idempotencyKey'] == 'turn':
                if mode == 'rpc_error':
                    error = GatewayQuestionError('agent failed: failed')
                    error.rpc_response = True
                    error.response_payload = {'status': 'error'}
                    raise error
                raise OSError('receiver dropped after acceptance')
            return {'status':'ok','result':{'payloads':[{'text':'续接完成'}]}}

        def close(self):
            pass

    params = {'idempotencyKey':'turn','agentId':'main','sessionKey':'agent:main:own',
              'sessionId':'runtime-session','model':'relay/model','message':'ORIGINAL TASK'}
    proc = GatewayAgentProc(Client(), Client, params, 10, continuation=continuation_reason)
    assert proc.wait(6) == 0 and proc.clean_end
    agents = [value for method, value in calls if method == 'agent']
    assert len(agents) == 2
    assert agents[0]['message'] == 'ORIGINAL TASK'
    assert agents[1]['message'] == CONTINUE_MESSAGE
    assert agents[1]['idempotencyKey'] == 'turn:continue:1'


@pytest.mark.parametrize('mode', ['idle', 'output_limit'])
def test_repeated_failure_stops_at_two_continuations(mode):
    if mode == 'idle':
        results = [error_response(),error_response(),error_response()]
    else:
        results = [{'status':'error','summary':'failed',
            'result':{'meta':{'stopReason':'length'},'payloads':[]}} for _ in range(3)]
    calls=[];Client=make_client(results,calls)
    proc=GatewayAgentProc(Client(),Client,{'idempotencyKey':'turn','agentId':'main','sessionKey':'own','message':'original'},30,
                          continuation=continuation_reason)
    assert proc.wait(8)==1 and proc.continuations==2
    assert len([1 for method,_ in calls if method=='agent'])==3


def test_stop_during_backoff_prevents_next_dispatch():
    calls=[]; entered=threading.Event(); release=threading.Event()
    Client=make_client([{'status':'error','summary':'failed',
        'result':{'meta':{'stopReason':'length'},'payloads':[{'text':'partial'}]}}],calls)
    def on_continue(*_): entered.set(); release.wait(2)
    proc=GatewayAgentProc(Client(),Client,{'idempotencyKey':'turn','agentId':'main','sessionKey':'own','message':'original'},30,
                          continuation=continuation_reason,on_continue=on_continue)
    assert entered.wait(1)
    proc.terminate(); release.set()
    assert proc.wait(2)==1 and not proc.clean_end
    assert len([1 for method,_ in calls if method=='agent'])==1
    assert ''.join(proc.stdout) == 'partial\n'


@pytest.mark.parametrize('round_no', range(3))
def test_concurrent_text_only_output_limit_recovery_is_isolated(round_no):
    count = 16
    records = []
    for index in range(count):
        turn_id = f'stress-{round_no}-{index}'
        original = f'original task {turn_id}'
        calls = []

        def client_for(bound_turn_id, bound_calls):
            class Client:
                def _rpc(self, method, params, **kwargs):
                    bound_calls.append((method, dict(params)))
                    assert method == 'agent'
                    kwargs['on_accepted']({'runId': params['idempotencyKey']})
                    if params['idempotencyKey'] == bound_turn_id:
                        return {'status': 'error', 'summary': 'failed',
                                'result': {'payloads': [{'text': f'partial {bound_turn_id}'}]}}
                    return {'status': 'ok', 'result': {'payloads': [{'text': f'complete {bound_turn_id}'}]}}

                def close(self):
                    pass

            return Client

        Client = client_for(turn_id, calls)

        def decide(**values):
            candidate = dict(values)
            if candidate['continuation_index'] == 0:
                candidate['stop_reason'] = 'length'
            return continuation_reason(**candidate)

        params = {'idempotencyKey': turn_id, 'agentId': 'main',
                  'sessionKey': f'agent:main:{turn_id}', 'sessionId': f'session-{turn_id}',
                  'model': 'relay/model', 'message': original}
        proc = GatewayAgentProc(Client(), Client, params, 20, continuation=decide)
        records.append((turn_id, original, calls, proc))

    with ThreadPoolExecutor(max_workers=count) as pool:
        codes = list(pool.map(lambda row: row[3].wait(8), records))

    assert codes == [0] * count
    for turn_id, original, calls, proc in records:
        agents = [params for method, params in calls if method == 'agent']
        assert len(agents) == 2
        assert agents[0]['message'] == original
        assert agents[1]['message'] == CONTINUE_MESSAGE
        assert agents[1]['sessionKey'] == agents[0]['sessionKey']
        assert agents[1]['sessionId'] == agents[0]['sessionId']
        assert agents[1]['idempotencyKey'] == f'{turn_id}:continue:1'
        payloads = proc.result['result']['payloads']
        assert payloads == [{'text': f'partial {turn_id}'}, {'text': f'complete {turn_id}'}]
        assert ''.join(proc.stdout) == f'partial {turn_id}\ncomplete {turn_id}\n'


def test_disabled_or_uncertain_run_never_resubmits():
    calls=[];Client=make_client([error_response()],calls)
    proc=GatewayAgentProc(Client(),Client,{'idempotencyKey':'turn','agentId':'main','sessionKey':'own','message':'original'},30)
    assert proc.wait(2)==1
    assert len([1 for method,_ in calls if method=='agent'])==1

    calls=[];Client=make_client([{'status':'error','summary':'failed',
        'result':{'meta':{'stopReason':'length'},'payloads':[{'text':'partial'}]}}],calls)
    proc=GatewayAgentProc(Client(),Client,{'idempotencyKey':'turn','agentId':'main','sessionKey':'own','message':'original'},30,
        continuation=lambda **kw:continuation_reason(**kw,operations=[{'status':'running'}]))
    assert proc.wait(2)==1 and proc.continuations==0
    assert len([1 for method,_ in calls if method=='agent'])==1
    assert ''.join(proc.stdout) == 'partial\n'
    assert proc.result['result']['payloads']==[{'text':'partial'}]

    calls=[];Client=make_client([{'status':'error','summary':'failed',
        'result':{'meta':{'stopReason':'length'},'payloads':[{'text':'partial'}]}}],calls)
    proc=GatewayAgentProc(Client(),Client,{'idempotencyKey':'turn','agentId':'main','sessionKey':'own','message':'original'},30,
        continuation=lambda **kw:continuation_reason(**kw,operations=[{'status':'completed','name':'image.generate'}]))
    assert proc.wait(2)==1 and proc.continuations==0
    assert len([1 for method,_ in calls if method=='agent'])==1
    assert ''.join(proc.stdout) == 'partial\n'

    calls=[]; waiting=threading.Event()
    Base=make_client([error_response()],calls,wait_status='running')
    class Uncertain(Base):
        def _rpc(self, method, params, **kwargs):
            result=super()._rpc(method, params, **kwargs)
            if method=='agent.wait': waiting.set()
            return result
    proc=GatewayAgentProc(Uncertain(),Uncertain,{'idempotencyKey':'turn','agentId':'main','sessionKey':'own','message':'original'},30,
                          continuation=continuation_reason)
    assert waiting.wait(2) and proc.poll() is None
    assert len([1 for method,_ in calls if method=='agent'])==1
    proc.terminate()
    assert proc.wait(4)==1 and not proc.clean_end
    assert len([1 for method,_ in calls if method=='agent'])==1


def test_delayed_exact_completion_keeps_recovered_reply_without_resubmission():
    calls=[]
    Base=make_client([error_response()],calls,wait_status='running')
    class Recovered(Base):
        waits=0
        def _rpc(self, method, params, **kwargs):
            if method=='agent.wait':
                type(self).waits += 1
                if self.waits > 1:
                    calls.append((method,dict(params)))
                    return {'runId':'turn','status':'ok','endedAt':1,'stopReason':'stop',
                            'terminalReceipt':{'runId':'turn','sessionId':'runtime-session',
                                               'turnId':'original-turn','terminalDisposition':'visible'},
                            'terminalReply':{'disposition':'visible','text':'actual recovered reply'}}
            return super()._rpc(method,params,**kwargs)
    proc=GatewayAgentProc(Recovered(),Recovered,{'idempotencyKey':'turn','agentId':'main',
        'sessionKey':'own','sessionId':'runtime-session','message':'original'},30,
        continuation=continuation_reason)
    assert proc.wait(3)==0 and proc.clean_end and proc.error_text is None
    assert ''.join(proc.stdout)=='actual recovered reply\n'
    assert proc.continuations==0 and len([1 for method,_ in calls if method=='agent'])==1
