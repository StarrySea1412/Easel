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


@pytest.mark.parametrize('raw', [DIAGNOSTIC, 'Error: ' + DIAGNOSTIC + '.',
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
    assert '8192' not in error['message'] and 'PRIVATE' not in json.dumps(error)
    journal = FailureEvents(tmp_path)
    journal.record_chat(turn_id='old-turn', error={'code': 'agent_execution_failed',
        'detail': DIAGNOSTIC + '\napi_key=PRIVATE'})
    row, = journal.recent()
    assert row['code'] == error['code'] and row['stage'] == 'model_response'
    assert 'PRIVATE' not in journal.path.read_text()
    assert json.dumps(events) == original, 'classification must preserve the original tool receipt'
    successful = observed_failure([{'message': {'role': 'assistant', 'stopReason': 'stop',
        'content': [{'type': 'text', 'text': DIAGNOSTIC}]}}])
    assert successful['code'] == 'agent_execution_failed'


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
