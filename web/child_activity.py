"""Read only a child transcript proven by this parent turn's spawn receipt."""
from datetime import datetime, timezone
import hashlib
import json
import re
import time

from fastapi import HTTPException
import agent_office as office
from easel.execution import begin, returned, page, public_text
from model_identity import latest_observation

MAX_BYTES = 2 * 1024 * 1024
MAX_OPERATIONS = 200
CHILD_KEY = re.compile(r'^agent:main:subagent:[A-Za-z0-9_.-]{1,120}$')


def snapshot(session, turn, agent, sessions, audits, transcripts, *, live=False,
             active_turn_id='', credentials=None):
    if (not office.SAFE_ID.fullmatch(session) or not office.SAFE_ID.fullmatch(turn)
            or not re.fullmatch(r'subagent:[a-f0-9]{20}', agent)):
        raise HTTPException(400, '无效的子智能体或对话标识')
    warnings = set()
    marker_path = sessions / f'web_{session}.json'
    marker_revision = office._marker_revision(marker_path)
    marker = office._read_json(marker_path, sessions, warnings) or {}
    audit = office._audit_record(audits, session, turn, warnings)
    if not audit:
        raise HTTPException(404, '没有该对话轮次的执行记录')
    audit_path = audits / hashlib.sha256(session.encode()).hexdigest()[:24] / f'{turn}.json'
    audit_revision = office._marker_revision(audit_path)
    parent_live = live and active_turn_id == turn and marker.get('turn_id') == turn and marker.get('status') != 'done'
    finished = office._timestamp(audit.get('finished'))
    if not parent_live and finished is None:
        if marker.get('turn_id') == turn and marker.get('status') == 'done' and marker_revision:
            finished = marker_revision[3] / 1e9
        elif audit.get('status') in ('completed', 'stopped', 'interrupted', 'failed') and audit_revision:
            finished = audit_revision[3] / 1e9
    events = office._events(transcripts, session, audit, parent_live, finished, warnings)
    bindings = {}
    children = office._child_agents(events, f'root:{session}', warnings, bindings=bindings)
    member = next((child for child in children if child['id'] == agent), None)
    if not member:
        raise HTTPException(404, '当前对话轮次没有该子智能体的归属记录')
    response = {'sessionId': session, 'turnId': turn, 'agentId': agent, 'operations': [],
                'progress': [], 'warnings': [], 'observedModel': member['observedModel'],
                'source': 'child_transcript', 'total': 0, 'nextBefore': None}

    def unavailable(reason):
        response['warnings'] = [reason, *sorted(warnings)]
        return response

    binding = bindings.get(agent, {})
    keys, runs, identifiers = (binding.get(field, set()) for field in ('keys', 'runs', 'sessions'))
    started = binding.get('started')
    if len(keys) != 1 or len(runs) != 1 or len(identifiers) > 1 or started is None:
        return unavailable('子任务尚未提供唯一的会话和运行标识，暂不能读取操作明细。')
    key, run = next(iter(keys)), next(iter(runs))
    if not CHILD_KEY.fullmatch(key) or not office.SAFE_ID.fullmatch(run):
        return unavailable('当前子任务的记录格式暂不支持操作明细。')
    from child_trace import source
    loaded = source(transcripts, key, warnings, MAX_BYTES)
    if loaded is None:
        return unavailable('子任务记录尚未落盘或暂不可读，稍后可重新读取。')
    entry, rows, unchanged = loaded
    child_session = entry['sessionId']
    if (identifiers and child_session not in identifiers
            or entry.get('spawnedBy') is not None and entry['spawnedBy'] not in (f'agent:main:{session}', f'agent:main:web:{session}')):
        raise HTTPException(409, '子任务归属已变化，未读取其他会话的操作')
    operations, progress, accepted, users = {}, [], [], 0
    # A child can outlive its parent; its own next activation bounds the read.
    upper = time.time() + 1
    for event in rows:
        if not isinstance(event, dict):
            continue
        message = event.get('message', event)
        if not isinstance(message, dict):
            continue
        at = office._timestamp(event.get('timestamp') or message.get('timestamp'))
        if at is None or not started <= at <= upper:
            continue
        if any(container.get(field) is not None and container[field] not in allowed
               for container in (event, message)
               for field, allowed in (('sessionId', (child_session,)), ('sessionKey', (key,)))):
            continue
        # A dated conflicting run is a boundary, not a record to skip
        # before accepting later untagged records from that next run.
        if any(container.get('runId') is not None and container['runId'] != run for container in (event, message)):
            break
        role = message.get('role')
        if role == 'user':
            users += 1
            if users > 1 or accepted:
                break
        accepted.append(event)
        if role == 'assistant':
            blocks = message.get('content')
            texts = [blocks] if isinstance(blocks, str) else [block.get('text', '') for block in blocks
                if isinstance(block, dict) and block.get('type') == 'text'] if isinstance(blocks, list) else []
            text = public_text('\n'.join(text for text in texts if isinstance(text, str)), credentials, 4000).strip()
            if text:
                progress.append(text)
                progress = progress[-20:]
            for call, name, args in office._tool_calls(message):
                if call in operations:
                    continue
                if len(operations) >= MAX_OPERATIONS:
                    warnings.add('仅展示该子任务前200次工具调用，记录可能不完整。')
                    break
                row = begin(session, f'{turn}:{agent}', call, name, args, at, credentials, source='child_transcript')
                # A trace is an observation, not proof that a process is
                # still running. Returned results will refine this state.
                row['status'] = 'unconfirmed'
                operations[call] = row
        elif role in ('toolResult', 'tool', 'tool_result'):
            call = message.get('toolCallId') or message.get('tool_call_id') or message.get('tool_use_id')
            row = operations.get(call) if isinstance(call, str) else None
            if row is not None:
                returned(row, message, at, credentials)
                if row['status'] == 'running':
                    row['status'] = 'unconfirmed'
    if (not unchanged()
            or office._marker_revision(marker_path) != marker_revision
            or office._marker_revision(audit_path) != audit_revision):
        raise HTTPException(409, '子任务记录正在变化，请重新读取')
    response.update(page(list(operations.values()), limit=100), progress=progress,
                    observedModel=latest_observation(accepted), warnings=sorted(warnings),
                    observedAt=datetime.now(timezone.utc).isoformat())
    if response['nextBefore'] is not None:
        response['warnings'].append('当前展示最近100次操作，较早操作未展开。')
    return response
