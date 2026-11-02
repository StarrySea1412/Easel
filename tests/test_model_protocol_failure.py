"""Classify an observed adapter rejection without replaying provider work."""
import json

import pytest

from easel.chat_continuation import continuation_reason
from easel.gateway_agent import GatewayAgentProc
from easel.gateway_auth import gateway_error
from easel.gateway_questions import GatewayQuestionError
from tests.test_chat_continuation import make_client
from web.chat_failure import observed_failure
from web.failure_events import FailureEvents


DIAGNOSTIC = 'Provider returned an incomplete or malformed tool call'


@pytest.mark.parametrize('raw,status', [('524 status code (no body)', None),
    ('Error: 524 status code (no body)', None), ('', 524), ('Easel request recovery exhausted', None)])
def test_provider_timeout_has_its_own_safe_classification(raw, status):
    result = gateway_error(raw, status=status)
    assert result['code'] == 'model_provider_timeout' and result['category'] == 'timeout'
    assert '未完成' in result['message'] and '保留' in result['message']
    event = {'message': {'role': 'assistant', 'stopReason': 'error',
                        'errorMessage': raw, 'usage': {'output': 0}}}
    if raw:
        assert observed_failure([event])['code'] == 'model_provider_timeout'


@pytest.mark.parametrize('raw', ['用户问：524 status code (no body)', '524 is quoted',
    '示例 Easel request recovery exhausted'])
def test_quoted_timeout_is_not_promoted(raw):
    assert gateway_error(raw)['code'] == 'agent_execution_failed'


@pytest.mark.parametrize('raw', [DIAGNOSTIC, 'Easel tool call recovery exhausted', 'Error: ' + DIAGNOSTIC + '.',
    DIAGNOSTIC + '\napi_key=PRIVATE_PRIVATE_VALUE tool_arguments=PRIVATE_PROMPT'])
def test_explicit_adapter_rejection_is_specific_and_safe(raw):
    error = gateway_error(raw, include_detail=True)
    assert error['code'] == 'model_tool_call_invalid'
    assert error['category'] == 'execution' and error['retryable'] is False
    assert '未派发该调用' in error['message'] and '不会自动重发' in error['message']
    assert 'PRIVATE' not in json.dumps(error)
    assert '截断' not in error['message']


@pytest.mark.parametrize('raw', ['例如：' + DIAGNOSTIC, '> ' + DIAGNOSTIC,
    '```\n' + DIAGNOSTIC + '\n```', '    ' + DIAGNOSTIC,
    DIAGNOSTIC + ' is a quotation', 'malformed JSON', 'tool call failed'])
def test_unrelated_text_is_not_promoted_to_a_protocol_rejection(raw):
    assert gateway_error(raw)['code'] == 'agent_execution_failed'


def test_failed_assistant_metadata_and_history_share_the_safe_classification(tmp_path):
    prior = {'message': {'role': 'assistant', 'stopReason': 'toolUse',
        'content': [{'type': 'toolCall', 'id': 'already-executed', 'name': 'exec'}]}}
    receipt = {'message': {'role': 'toolResult', 'toolCallId': 'already-executed',
        'content': [{'type': 'text', 'text': 'PRIVATE_RESULT'}], 'isError': False}}
    failure = {'message': {'role': 'assistant', 'stopReason': 'error',
        'errorMessage': DIAGNOSTIC, 'provider': 'fixture', 'model': 'deepseek-fixture',
        'usage': {'output': 8192}}}
    events = [prior, receipt, failure]
    original = json.dumps(events)
    error = observed_failure(events)
    assert error['code'] == 'model_tool_call_invalid' and error['stage'] == 'model_response'
    assert error['modelRef'] == 'fixture/deepseek-fixture'
    assert error['outputTokens'] == 8192 and 'providerFinishReason' not in error
    assert '8192' not in error['message'] and 'PRIVATE' not in json.dumps(error)
    journal = FailureEvents(tmp_path)
    journal.record_chat(turn_id='old-turn', error={'code': 'agent_execution_failed',
        'detail': DIAGNOSTIC + '\napi_key=PRIVATE', 'outputTokens': error['outputTokens']})
    row, = journal.recent()
    assert row['code'] == error['code'] and row['stage'] == 'model_response'
    assert row['outputTokens'] == 8192
    assert 'PRIVATE' not in journal.path.read_text()
    assert json.dumps(events) == original, 'classification must preserve the original tool receipt'
    successful = observed_failure([{'message': {'role': 'assistant', 'stopReason': 'stop',
        'content': [{'type': 'text', 'text': DIAGNOSTIC}]}}])
    assert successful['code'] == 'agent_execution_failed'


def test_protocol_failure_keeps_only_bounded_provider_finish_metadata():
    event = {'message': {'role': 'assistant', 'stopReason': 'error',
        'errorMessage': DIAGNOSTIC, 'finish_reason': 'length',
        'usage': {'output_tokens': 16384}}}
    result = observed_failure([event])
    assert result['providerFinishReason'] == 'length'
    assert result['outputTokens'] == 16384


def test_native_adapter_failure_does_not_dispatch_an_automatic_continuation():
    error = GatewayQuestionError(DIAGNOSTIC)
    error.rpc_response = True
    calls = []
    client_type = make_client([error], calls)
    proc = GatewayAgentProc(client_type(), client_type,
        {'idempotencyKey': 'protocol-turn', 'agentId': 'main',
         'sessionKey': 'fixture-session', 'message': 'SYNTHETIC TASK'},
        30, continuation=continuation_reason)
    assert proc.wait(5) == 1
    assert proc.continuations == 0
    assert len([value for method, value in calls if method == 'agent']) == 1
