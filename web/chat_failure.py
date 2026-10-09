"""Explain observed model failures using only bounded assistant metadata."""
from __future__ import annotations

import re
import time
from easel.gateway_auth import gateway_error

LABEL = re.compile(r'^[A-Za-z0-9_.:/+-]{1,300}$')


def observed_failure(events, native_error='', channels=None):
    failed = []
    for event in events:
        message = event.get('message') if isinstance(event, dict) else None
        if not isinstance(message, dict) or message.get('role') != 'assistant':
            continue
        if message.get('stopReason') not in ('error', 'aborted'):
            continue
        raw = message.get('errorMessage')
        if isinstance(raw, str) and raw.strip():
            failed.append((raw, message))
    raw, message = failed[-1] if failed else (native_error, {})
    result = gateway_error(raw, include_detail=True)
    provider, model = message.get('provider'), message.get('model')
    if isinstance(provider, str) and LABEL.fullmatch(provider):
        result['channel'] = provider
        snapshot = (channels or {}).get(provider, {})
        if snapshot.get('channelEndpoint'):
            result['channelEndpoint'] = snapshot['channelEndpoint']
    if isinstance(model, str) and LABEL.fullmatch(model):
        result['modelRef'] = f'{provider}/{model}' if result.get('channel') else model
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
