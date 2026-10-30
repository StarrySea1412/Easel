import threading

import pytest

from easel.chat_continuation import continuation_reason, CONTINUE_MESSAGE
from easel.gateway_agent import GatewayAgentProc


def test_decisions_require_specific_recoverable_evidence():
    assert continuation_reason(error='LLM idle timeout (120s): no response') == 'model_idle_timeout'
    assert continuation_reason(stop_reason='max_tokens') == 'output_limit'
    assert continuation_reason(text='我会继续执行', plan=[{'status': 'pending'}]) == 'unfinished_plan'
    for error in ['timeout', 'HTTP 503', 'connection reset', '401 Unauthorized']:
        assert continuation_reason(error=error) is None
    for row in [{'status':'running'}, {'status':'denied'}, {'status':'stopped'}]:
        assert continuation_reason(error='LLM idle timeout (120s)', operations=[row]) is None
    for text in ['请确认是否继续？', '需要登录', '请提供材料']:
        assert continuation_reason(error='LLM idle timeout (120s)', text=text) is None
    assert continuation_reason(stop_reason='length', pending_question=True) is None
    assert continuation_reason(text='已完成') is None


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


@pytest.mark.parametrize('mode', ['idle', 'limit', 'meta', 'plan'])
def test_continues_in_same_session_without_replaying_original(mode):
    calls, continued = [], []
    first = error_response() if mode == 'idle' else {'status':'ok','result':{'payloads':[{'text':'我会继续执行'}], **({'stopReason':'length'} if mode=='limit' else {'meta': {'stopReason':'length', 'completion': {'finishReason':'length'}}} if mode=='meta' else {})}}
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


def test_repeated_idle_failure_stops_at_two_continuations():
    calls=[];Client=make_client([error_response(),error_response(),error_response()],calls)
    proc=GatewayAgentProc(Client(),Client,{'idempotencyKey':'turn','agentId':'main','sessionKey':'own','message':'original'},30,
                          continuation=continuation_reason)
    assert proc.wait(8)==1 and proc.continuations==2
    assert len([1 for method,_ in calls if method=='agent'])==3


def test_stop_during_backoff_prevents_next_dispatch():
    calls=[]; entered=threading.Event(); release=threading.Event()
    Client=make_client([error_response()],calls)
    def on_continue(*_): entered.set(); release.wait(2)
    proc=GatewayAgentProc(Client(),Client,{'idempotencyKey':'turn','agentId':'main','sessionKey':'own','message':'original'},30,
                          continuation=continuation_reason,on_continue=on_continue)
    assert entered.wait(1)
    proc.terminate(); release.set()
    assert proc.wait(2)==1 and not proc.clean_end
    assert len([1 for method,_ in calls if method=='agent'])==1


def test_disabled_or_uncertain_run_never_resubmits():
    calls=[];Client=make_client([error_response()],calls)
    proc=GatewayAgentProc(Client(),Client,{'idempotencyKey':'turn','agentId':'main','sessionKey':'own','message':'original'},30)
    assert proc.wait(2)==1
    assert len([1 for method,_ in calls if method=='agent'])==1

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
