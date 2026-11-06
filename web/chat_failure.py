"""Explain observed model failures using only bounded assistant metadata."""
from __future__ import annotations

import re
import time
from easel.gateway_auth import gateway_error

LABEL = re.compile(r'^[A-Za-z0-9_.:/+-]{1,300}$')
OUTPUT_LIMIT_REASONS = frozenset({'length', 'max_tokens', 'max_output_tokens', 'model_length'})
FAILED_REASONS = frozenset({'error', 'aborted'})


def observed_failure(events, native_error='', channels=None):
    from easel.chat_continuation import NO_PROGRESS_ERROR, DEADLINE_ERROR
    # Host decisions describe the whole continuation chain. An older provider
    # length receipt must not hide why the host actually stopped that chain.
    if native_error in (NO_PROGRESS_ERROR, DEADLINE_ERROR):
        no_progress = native_error == NO_PROGRESS_ERROR
        return {'code': 'continuation_no_progress' if no_progress else 'continuation_deadline',
                'category': 'execution', 'retryable': False, 'stage': 'agent_execution',
                'message': ('自动接续重复了已有内容，未观察到新的文本进展，已停止继续请求并保留输出。请核对未完成项后调整任务。'
                            if no_progress else
                            '自动接续已用完本轮总等待时间，未再发送下一次请求，已有输出已保留。请核对当前进度后再继续。')}
    failed = []
    for event in events:
        message = event.get('message') if isinstance(event, dict) else None
        if not isinstance(message, dict) or message.get('role') != 'assistant':
            continue
        stop_reason = message.get('stopReason', message.get('stop_reason'))
        finish_reason = message.get('finishReason', message.get('finish_reason'))
        limit_reason = next((value for value in (stop_reason, finish_reason)
                             if isinstance(value, str) and value in OUTPUT_LIMIT_REASONS), None)
        if limit_reason is not None:
            failed.append((limit_reason, message))
            continue
        if stop_reason not in FAILED_REASONS:
            continue
        raw = message.get('errorMessage')
        if isinstance(raw, str) and raw.strip():
            failed.append((raw, message))
    raw, message = failed[-1] if failed else (native_error, {})
    stop_reason = message.get('stopReason', message.get('stop_reason'))
    finish_reason = message.get('finishReason', message.get('finish_reason'))
    if raw in OUTPUT_LIMIT_REASONS:
        result = {
            'code': 'model_output_limit',
            'category': 'execution',
            'retryable': False,
            'message': '模型回复达到单轮输出上限。本轮未完整完成，已保留收到的内容；启用自动继续时会在确认安全后有限接续。若仍未完成，请从当前进度手动继续，不要重发原操作。',
        }
    else:
        result = gateway_error(raw, include_detail=True)
    provider, model = message.get('provider'), message.get('model')
    if isinstance(provider, str) and LABEL.fullmatch(provider):
        result['channel'] = provider
        snapshot = (channels or {}).get(provider, {})
        if snapshot.get('channelEndpoint'):
            result['channelEndpoint'] = snapshot['channelEndpoint']
    if isinstance(model, str) and LABEL.fullmatch(model):
        result['modelRef'] = f'{provider}/{model}' if result.get('channel') else model
    usage = message.get('usage')
    if isinstance(usage, dict):
        output_tokens = next((usage.get(key) for key in ('output', 'output_tokens', 'completion_tokens')
                              if type(usage.get(key)) is int and 0 <= usage[key] <= 10_000_000), None)
        if output_tokens is not None:
            result['outputTokens'] = output_tokens
    provider_finish = raw if raw in OUTPUT_LIMIT_REASONS else finish_reason
    if isinstance(provider_finish, str) and re.fullmatch(r'[A-Za-z0-9_.+-]{1,64}', provider_finish):
        result['providerFinishReason'] = provider_finish
    result['stage'] = 'model_response' if failed else 'agent_execution'
    return result


def turn_failure(sessions_dir, context, native_error=''):
    if context is None:
        return observed_failure([], native_error)
    import skill_audit
    record = {**context['record'], 'status': 'interrupted', 'finished': time.time()}
    try:
        events = skill_audit._turn_events(sessions_dir, {**context, 'record': record})
    except (OSError, ValueError):
        events = []
    return observed_failure(events, native_error, record.get('_usageChannels'))


def recover_failure(sessions_dir, audit):
    from easel.session_trace import read_events
    events = read_events(sessions_dir, audit['sessionId'], audit, finished=audit.get('finished'), warnings=set())
    result = observed_failure(events, 'aborted', audit.get('_usageChannels'))
    return result if result.get('stage') == 'model_response' else None
