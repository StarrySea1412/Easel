import sys
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'web'))
from chat_failure import observed_failure
from easel.gateway_auth import gateway_error


def event(error, provider='anthropic', model='kimi-k3'):
    return {'message':{'role':'assistant','provider':provider,'model':model,'stopReason':'error','errorMessage':error}}


def test_real_terminal_event_error_supersedes_generic_aborted():
    result=observed_failure([event('Anthropic stream ended before a terminal event')],'aborted',{'anthropic':{'channelEndpoint':'fixture.example'}})
    assert result['code']=='model_stream_interrupted'
    assert result['detail']=='Anthropic stream ended before a terminal event'
    assert result['modelRef']=='anthropic/kimi-k3' and result['channelEndpoint']=='fixture.example'
    assert '响应流' in result['message'] and result['stage']=='model_response'


def test_generic_aborted_does_not_invent_cause_or_user_stop():
    result=observed_failure([],'aborted')
    assert result['code']=='agent_request_aborted'
    assert '没有说明' in result['message'] and 'channel' not in result


def test_only_assistant_failure_metadata_can_supply_cause():
    user=event('timeout');user['message']['role']='user'
    normal=event('timeout');normal['message']['stopReason']='stop'
    assert observed_failure([user,normal],'aborted')['code']=='agent_request_aborted'


def test_last_real_failure_has_priority_and_secrets_are_redacted():
    result=observed_failure([event('timeout'),event('Anthropic stream ended before a terminal event api_key=PRIVATE_SECRET')],'aborted')
    assert result['code']=='model_stream_interrupted'
    assert 'PRIVATE_SECRET' not in str(result)


def test_rate_limits_and_unavailability_are_actionable():
    assert gateway_error('rate limit exceeded')['code']=='model_rate_limited'
    assert gateway_error('overloaded')['code']=='model_service_unavailable'
    assert gateway_error('timeout')['code']=='gateway_timeout'
