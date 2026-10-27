"""Interpret exact-run wait evidence without dispatching or guessing a reply.

OpenClaw's terminalReply is a producer-owned summary, capped at 4096 UTF-16
units. At that boundary it cannot stand in for a complete assistant response.
Older gateways may confirm settlement without providing reply evidence at all.
"""
from __future__ import annotations

import math


def wait_outcome(value, run_id, runtime_session_id):
    """Return settlement facts, or None when this is not an exact terminal.

    A matching legacy ok/error proves provider settlement only. Full recovery
    requires the producer's session-bound receipt AND a non-capped visible reply.
    No raw provider errors or route/configuration data leave this boundary.
    """
    if (not isinstance(value, dict) or value.get('runId') != run_id
            or value.get('status') not in ('ok', 'error')
            or value.get('pendingError') is True or value.get('yielded') is True):
        return None
    receipt = value.get('terminalReceipt')
    if isinstance(receipt, dict) and (receipt.get('runId', run_id) != run_id
            or (runtime_session_id is not None and receipt.get('sessionId', runtime_session_id) != runtime_session_id)):
        return None
    reason = value.get('stopReason')
    if reason is not None and (not isinstance(reason, str) or reason not in (
            'stop', 'end_turn', 'completed', 'length', 'max_tokens', 'max_output_tokens',
            'model_length', 'aborted', 'cancelled', 'canceled', 'content_filter', 'tool_use',
            'error', 'timeout', 'hard_timeout', 'superseded', 'gateway_restart')):
        reason = 'unknown'
    result = {'complete': False, 'text': None, 'stopReason': reason,
              'error': {'code': 'chat_supervisor_lost', 'category': 'connection', 'retryable': True,
                        'message': '后台已结束，已保留收到的内容；完整回复尚未核实，未自动重发。'}}
    if value['status'] == 'error' or value.get('livenessState') in ('blocked', 'abandoned'):
        result['error'] = {'code': 'model_run_failed', 'category': 'model', 'retryable': True,
                           'message': '原运行未正常完成，已保留收到的内容。'}
    if reason in ('length', 'max_tokens', 'max_output_tokens', 'model_length'):
        result['error'] = {'code': 'model_output_limit', 'category': 'model', 'retryable': True,
                           'message': '原运行达到输出上限，已保留部分回复。'}
    elif reason in ('aborted', 'cancelled', 'canceled', 'content_filter', 'tool_use', 'error'):
        result['error'] = {'code': 'model_run_incomplete', 'category': 'model', 'retryable': True,
                           'message': '原运行已结束，回复未完整完成。'}
    reply = value.get('terminalReply')
    ended = value.get('endedAt')
    if (not isinstance(runtime_session_id, str) or not runtime_session_id
            or not isinstance(receipt, dict) or receipt.get('runId') != run_id
            or receipt.get('sessionId') != runtime_session_id
            or not isinstance(receipt.get('turnId'), str) or not receipt['turnId']
            or receipt.get('terminalDisposition') != 'visible'
            or not isinstance(reply, dict) or reply.get('disposition') != 'visible'
            or type(ended) not in (int, float) or not math.isfinite(ended) or ended <= 0):
        return result
    text = reply.get('text')
    # Reserve the producer's truncation boundary; do not discard a longer raw
    # response in favour of an RPC summary or infer completeness from its prefix.
    if (not isinstance(text, str) or not text.strip() or len(text) >= 4095
            or len(text.encode('utf-16-le', errors='surrogatepass')) // 2 >= 4095):
        return result
    result['text'] = text
    result['complete'] = (value['status'] == 'ok' and reason in (None, 'stop', 'end_turn', 'completed')
                          and value.get('livenessState') not in ('blocked', 'abandoned'))
    if result['complete']:
        result['error'] = None
    return result
