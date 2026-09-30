"""Read-only, session-scoped Agent identities backed by structured trace evidence.

Skills, assistant prose and a successful spawn request are not completed Agents.
Only parent-transcript tool calls with matching identity-bearing results create
child nodes. No child transcript, gateway request or model execution is needed.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import time
import uuid

from fastapi import HTTPException

SAFE_ID = re.compile(r'^[A-Za-z0-9_.-]{1,120}$')
IDENTITY = re.compile(r'^[A-Za-z0-9_.:@/-]{1,200}$')
SESSION_NS = uuid.UUID('6ba7b810-9dad-11d1-80b4-00c04fd430c8')
MAX_JSON_BYTES = 2 * 1024 * 1024
MAX_TRACE_BYTES = 8 * 1024 * 1024
MAX_LINE_BYTES = 256 * 1024
MAX_EVENTS = 10000
MAX_AGENTS = 32
MAX_PUBLIC_EVENTS = 40


def _read_json(path: Path, root: Path, warnings: set[str]) -> dict | None:
    try:
        if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
            warnings.add('部分记录路径不可信，已跳过。')
            return None
        if not path.is_file():
            return None
        with path.open('rb') as stream:
            data = stream.read(MAX_JSON_BYTES + 1)
        if len(data) > MAX_JSON_BYTES:
            warnings.add('部分记录超过读取上限，展示可能不完整。')
            return None
        value = json.loads(data)
        if isinstance(value, dict):
            return value
    except (OSError, ValueError, RecursionError):
        pass
    warnings.add('部分本机会话记录不可读，未据此推断 Agent 状态。')
    return None


def _safe_text(value: object, limit: int = 220) -> str:
    if not isinstance(value, str):
        return ''
    text = re.sub(r'(?i)(bearer\s+)\S+', r'\1[已隐藏]', value)
    text = re.sub(r'''(?ix)((?:token|password|api[_-]?key|secret)["']?\s*[=: ]\s*)
                      (?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)''', r'\1[已隐藏]', text)
    return ' '.join(''.join(char if char.isprintable() else ' ' for char in text).split())[:limit]


def _timestamp(value: object) -> float | None:
    try:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return (value / 1000 if value > 1e11 else float(value)) if math.isfinite(value) else None
        if isinstance(value, str):
            date = datetime.fromisoformat(value.replace('Z', '+00:00'))
            return date.timestamp() if date.tzinfo is not None else None
    except (ValueError, OSError, OverflowError):
        pass
    return None


def _audit_record(directory: Path, session: str, turn: str, warnings: set[str]) -> dict | None:
    parent = directory / hashlib.sha256(session.encode()).hexdigest()[:24]
    # Without a current turn marker, sampling historical audit files cannot
    # establish which task is active. Do not scan an unbounded history folder.
    if not turn:
        return None
    paths = [parent / f'{turn}.json']
    records = []
    for path in paths:
        value = _read_json(path, directory, warnings)
        if (value and value.get('sessionId') == session and isinstance(value.get('turnId'), str)
                and SAFE_ID.fullmatch(value['turnId']) and (not turn or value['turnId'] == turn)):
            records.append(value)
    return max(records, key=lambda record: _timestamp(record.get('started')) or 0, default=None)


def _transcript_paths(directory: Path, session: str, warnings: set[str]) -> list[Path]:
    index = _read_json(directory / 'sessions.json', directory, warnings) or {}
    identifiers = []
    for key in (session, f'web:{session}'):
        identifiers.append(str(uuid.uuid5(SESSION_NS, key)))
        entry = index.get(f'agent:main:{key}') or index.get(key)
        if isinstance(entry, dict) and isinstance(entry.get('sessionId'), str) and SAFE_ID.fullmatch(entry['sessionId']):
            identifiers.append(entry['sessionId'])
    # At most four exact current-session candidates, never a transcript glob.
    return [directory / f'{ident}.jsonl' for ident in dict.fromkeys(identifiers)]


def _events(directory: Path, session: str, audit: dict | None, live: bool,
            finished_at: float | None, warnings: set[str]) -> list[dict]:
    if not audit or not isinstance(audit.get('_sources'), dict) or (not live and finished_at is None):
        return []
    started = _timestamp(audit.get('started'))
    if started is None:
        return []
    sources = audit['_sources']
    remaining = MAX_TRACE_BYTES
    events = []
    for path in _transcript_paths(directory, session, warnings):
        try:
            if path.is_symlink() or path.resolve().parent != directory.resolve():
                warnings.add('部分记录路径不可信，已跳过。')
                continue
            if not path.is_file():
                continue
            previous = sources.get(str(path))
            known = str(path) in sources
            if known and (not isinstance(previous, dict) or not isinstance(previous.get('offset'), int)
                          or isinstance(previous['offset'], bool) or previous['offset'] < 0):
                continue
            offset = previous['offset'] if known else 0
            if offset > remaining:
                warnings.add('会话日志超过读取上限，子 Agent 身份可能未完整捕获。')
                continue
            with path.open('rb') as stream:
                prefix = stream.read(offset)
                remaining -= len(prefix)
                if known and (len(prefix) != offset or hashlib.sha256(prefix).hexdigest() != previous.get('digest')
                              or prefix and not prefix.endswith(b'\n')):
                    warnings.add('会话日志已变化，无法确认原轮次边界。')
                    continue
                while remaining > 0 and len(events) < MAX_EVENTS:
                    line = stream.readline(min(MAX_LINE_BYTES + 1, remaining + 1))
                    if not line:
                        break
                    remaining -= len(line)
                    if len(line) > MAX_LINE_BYTES or remaining < 0:
                        warnings.add('会话日志超过读取上限，子 Agent 身份可能未完整捕获。')
                        break
                    if not line.endswith(b'\n'):
                        break  # A writer's unfinished JSON line is not evidence.
                    try:
                        event = json.loads(line)
                    except (ValueError, RecursionError):
                        warnings.add('部分会话事件格式不可读，已跳过。')
                        continue
                    if not isinstance(event, dict):
                        continue
                    message = event.get('message')
                    event_session = event.get('sessionId') or (message.get('sessionId') if isinstance(message, dict) else None)
                    event_key = event.get('sessionKey') or (message.get('sessionKey') if isinstance(message, dict) else None)
                    if event_session is not None and event_session not in (session, f'web:{session}', path.stem):
                        continue
                    if event_key is not None and event_key not in (session, f'web:{session}', f'agent:main:{session}', f'agent:main:web:{session}'):
                        continue
                    stamp = _timestamp(event.get('timestamp') or (message.get('timestamp') if isinstance(message, dict) else None))
                    if stamp is not None and (stamp < started or stamp > time.time() + 1):
                        continue
                    # New/compacted files need timestamps. Completed turns also
                    # need a dated upper bound to exclude later same-session work.
                    if (not known or not live) and stamp is None:
                        continue
                    if not live and (finished_at is None or stamp > finished_at):
                        continue
                    events.append(event)
        except OSError:
            warnings.add('当前会话日志暂不可读，未据此推断子 Agent。')
    if remaining <= 0 or len(events) >= MAX_EVENTS:
        warnings.add('会话日志超过读取上限，子 Agent 身份可能未完整捕获。')
    return events


def _tool_calls(message: dict):
    blocks = message.get('content') if isinstance(message.get('content'), list) else []
    blocks = blocks + (message.get('tool_calls') if isinstance(message.get('tool_calls'), list) else [])
    for block in blocks:
        if not isinstance(block, dict) or block.get('type') not in ('toolCall', 'tool_use', 'function'):
            continue
        function = block.get('function') if isinstance(block.get('function'), dict) else block
        name = function.get('name')
        ident = block.get('id')
        if not isinstance(name, str) or not isinstance(ident, str):
            continue
        args = function.get('arguments', function.get('input', {}))
        if isinstance(args, str):
            try:
                args = json.loads(args) if len(args) <= MAX_LINE_BYTES else {}
            except (ValueError, RecursionError):
                args = {}
        yield ident, name.split('.')[-1], args if isinstance(args, dict) else {}


def _payloads(message: dict) -> list[dict]:
    result = [message['details']] if isinstance(message.get('details'), dict) else []
    content = message.get('content')
    if isinstance(content, dict):
        result.append(content)
    texts = [content] if isinstance(content, str) else [block.get('text') for block in content if isinstance(block, dict)] if isinstance(content, list) else []
    for text in texts:
        if not isinstance(text, str) or len(text) > MAX_LINE_BYTES:
            continue
        try:
            value = json.loads(text)
            if isinstance(value, dict):
                result.append(value)
        except (ValueError, RecursionError):
            continue
    return result


def _identities(value: dict, tool: str = '') -> list[str]:
    keys = ['childSessionKey', 'childSessionId', 'runId']
    if tool != 'sessions_spawn':
        keys += ['sessionKey', 'sessionId', 'agent_id', 'agentId', 'id']
    return [value[key] for key in keys if isinstance(value.get(key), str) and IDENTITY.fullmatch(value[key])]


def _child_agents(events: list[dict], root_id: str, warnings: set[str]) -> list[dict]:
    calls, children, identities = {}, {}, {}
    for event in events:
        message = event.get('message', event)
        if not isinstance(message, dict):
            continue
        if message.get('role') == 'assistant':
            for ident, tool, args in _tool_calls(message):
                if tool in ('sessions_spawn', 'spawn_agent', 'subagents', 'sessions_list'):
                    calls[ident] = (tool, args)
            continue
        if message.get('role') not in ('toolResult', 'tool', 'tool_result'):
            continue
        call_id = message.get('toolCallId') or message.get('tool_call_id') or message.get('tool_use_id')
        call = calls.get(call_id) if isinstance(call_id, str) else None
        if call is None or message.get('isError') is True:
            continue
        tool, args = call
        for payload in _payloads(message):
            if tool in ('sessions_spawn', 'spawn_agent'):
                raw_ids = _identities(payload, tool)
                status = payload.get('status')
                if (not raw_ids or payload.get('error') or status in ('error', 'failed', 'rejected', 'forbidden')
                        or not (status in ('accepted', 'ok', 'success', 'running', 'started', 'pending', 'queued', 'completed') or message.get('isError') is False)):
                    continue
                ident = next((identities[key] for key in raw_ids if key in identities), None)
                if ident is None:
                    if len(children) >= MAX_AGENTS - 1:
                        warnings.add('已达到 Agent 展示上限，部分身份未展示。')
                        continue
                    ident = 'subagent:' + hashlib.sha256(raw_ids[0].encode()).hexdigest()[:20]
                    children[ident] = {
                        'id': ident, 'parentId': root_id, 'role': 'subagent',
                        'name': _safe_text(args.get('label') or args.get('name'), 70) or f'子 Agent {len(children) + 1}',
                        'task': _safe_text(args.get('task') or args.get('prompt')),
                        'status': 'running' if status == 'running' else 'unknown',
                        'evidence': '当前会话的子 Agent 创建回执；后续状态未确认。',
                    }
                for key in raw_ids:
                    identities[key] = ident
            elif tool in ('subagents', 'sessions_list'):
                # Only update already-confirmed children; a list can contain
                # unrelated sessions, and must never introduce their identities.
                for field in ('active', 'recent', 'agents', 'sessions'):
                    items = payload.get(field)
                    if not isinstance(items, list):
                        continue
                    for item in items[:MAX_AGENTS * 2]:
                        if not isinstance(item, dict):
                            continue
                        ident = next((identities[key] for key in _identities(item) if key in identities), None)
                        if ident is None:
                            continue
                        reported = item.get('status') or item.get('state')
                        state = {'running': 'running', 'thinking': 'thinking', 'waiting': 'waiting',
                                 'pending': 'waiting', 'queued': 'waiting', 'completed': 'completed',
                                 'done': 'completed', 'failed': 'failed', 'error': 'failed',
                                 'stopped': 'stopped', 'cancelled': 'stopped', 'canceled': 'stopped'}.get(reported) if isinstance(reported, str) else None
                        if state:
                            children[ident].update(status=state, evidence='当前会话工具回执明确上报的子 Agent 最近状态。')
    return list(children.values())


def _public_events(events: list[dict], root_id: str, turn_id: str) -> list[dict]:
    """Expose names and return evidence only, never arguments or tool output.

    These tools belong to the parent transcript. A spawn tool is still a parent
    call; without a child trace we must not label it as the child's own work.
    """
    calls: dict[str, str] = {}
    records: dict[str, dict] = {}

    def add(call_id: str, kind: str, name: str, status: str, event: dict, message: dict):
        ident = hashlib.sha256(f'{root_id}\0{turn_id}\0{call_id}\0{kind}'.encode()).hexdigest()[:24]
        prefix = '调用工具' if kind == 'call' else '工具返回错误' if status == 'failed' else '工具返回'
        operation_id = hashlib.sha256(f'{root_id}\0{turn_id}\0{call_id}'.encode()).hexdigest()[:24]
        record = {'id': ident, 'agentId': root_id, 'kind': kind, 'title': f'{prefix}：{name}', 'status': status,
                  'toolName': name, 'operationId': operation_id}
        stamp = _timestamp(event.get('timestamp') or message.get('timestamp'))
        if stamp is not None:
            try:
                record['at'] = datetime.fromtimestamp(stamp, timezone.utc).isoformat()
            except (ValueError, OSError, OverflowError):
                pass
        # Copied/duplicate tool records have stable IDs, rather than looking
        # like fresh calls on every poll. The latest matching return is retained.
        records.pop(ident, None)
        records[ident] = record
        if len(records) > MAX_PUBLIC_EVENTS:
            records.pop(next(iter(records)))

    for event in events:
        message = event.get('message', event)
        if not isinstance(message, dict):
            continue
        if message.get('role') == 'assistant':
            for ident, tool, _ in _tool_calls(message):
                name = tool if re.fullmatch(r'[A-Za-z0-9_.:-]{1,100}', tool) else '未命名工具'
                calls[ident] = name
                add(ident, 'call', name, 'called', event, message)
        elif message.get('role') in ('toolResult', 'tool', 'tool_result'):
            ident = message.get('toolCallId') or message.get('tool_call_id') or message.get('tool_use_id')
            if isinstance(ident, str) and ident in calls:
                # A return is not proof of execution success. Only the explicit
                # tool error bit authorizes the failure label here.
                add(ident, 'result', calls[ident], 'failed' if message.get('isError') is True else 'returned', event, message)
    return list(records.values())


def _marker_revision(path: Path) -> tuple | None:
    try:
        stat = path.stat()
        return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns
    except OSError:
        return None


def updating_snapshot(session_id: str, turn_id: str = '') -> dict:
    """Discard all sampled evidence when its execution/marker changed mid-read."""
    return {
        'sessionId': session_id, 'turnId': turn_id or None, 'observedAt': datetime.now(timezone.utc).isoformat(),
        'source': 'local_session_state',
        'agents': [{'id': f'root:{session_id}', 'parentId': None, 'role': 'root', 'name': '主 Agent',
                    'task': '', 'status': 'unknown', 'evidence': '会话轮次正在更新，暂不展示未确认的执行状态。'}],
        'links': [], 'events': [],
        'coverage': {'subagents': 'not_observed', 'detail': '轮次边界暂未稳定，等待下一次读取确认。'},
        'warnings': ['会话轮次正在更新，本次未展示可能跨轮的调用记录。'],
    }


def snapshot(session_id: str, web_sessions: Path, audits: Path, transcripts: Path,
             *, live: bool = False, active_turn_id: str = '') -> dict:
    if not SAFE_ID.fullmatch(session_id):
        raise HTTPException(400, '无效的会话标识')
    warnings: set[str] = set()
    # Never use a truncated/sanitized filename which could collide with another
    # web session. Legacy identifiers longer than the filename limit stay unknown.
    marker_path = web_sessions / f'web_{session_id}.json'
    revision = _marker_revision(marker_path)
    marker = _read_json(marker_path, web_sessions, warnings) or {}
    turn_id = active_turn_id if SAFE_ID.fullmatch(active_turn_id) else marker.get('turn_id')
    turn_id = turn_id if isinstance(turn_id, str) and SAFE_ID.fullmatch(turn_id) else ''
    # A queued turn claims the marker before acquiring the execution lock. Keep
    # the active execution's identity, but do not combine its audit prefix with
    # another turn's marker or use an mtime from a replacement file as its end.
    if (marker and revision is None or _marker_revision(marker_path) != revision
            or turn_id and marker.get('turn_id') != turn_id):
        return updating_snapshot(session_id, turn_id)
    audit = _audit_record(audits, session_id, turn_id, warnings)
    turn_id = turn_id or (audit['turnId'] if audit else '')
    finished_at = revision[3] / 1e9 if revision and marker.get('status') == 'done' else None
    # A terminal marker already supplies an end boundary, even when the
    # supervisor's process registration has not been cleared yet.
    events = _events(transcripts, session_id, audit, live and marker.get('status') != 'done', finished_at, warnings)
    # The reader can overlap a terminal save, queueing, or the next execution.
    # Invalidate the whole sample even when a replacement repeats the turn ID.
    if _marker_revision(marker_path) != revision:
        return updating_snapshot(session_id, turn_id)
    state = 'unknown'
    evidence = '尚无可确认的当前会话执行状态。'
    if live:
        state, evidence = 'running', '当前会话的 Agent 执行进程仍在运行。'
        if events:
            message = events[-1].get('message', events[-1])
            blocks = message.get('content') if isinstance(message, dict) else None
            if isinstance(blocks, list) and blocks and isinstance(blocks[-1], dict) and blocks[-1].get('type') in ('thinking', 'reasoning'):
                state, evidence = 'thinking', '当前会话的运行进程与最近思考事件。'
    elif marker.get('status') == 'done':
        evidence = '当前会话最近轮次的已保存执行状态。'
        state = ('stopped' if marker.get('stop_reason') == 'user_stopped' else 'failed' if marker.get('error')
                 else 'completed' if marker.get('clean_end') is True else 'unknown')
    elif audit and audit.get('status') in ('completed', 'stopped', 'interrupted', 'failed'):
        state = {'completed': 'completed', 'stopped': 'stopped', 'interrupted': 'failed', 'failed': 'failed'}[audit['status']]
        evidence = '当前会话最近轮次的执行审计状态。'
    root_id = f'root:{session_id}'
    root = {'id': root_id, 'parentId': None, 'role': 'root', 'name': '主 Agent',
            'task': _safe_text(audit.get('_request')) if audit else '', 'status': state, 'evidence': evidence}
    children = _child_agents(events, root_id, warnings)
    return {
        'sessionId': session_id, 'turnId': turn_id or None, 'observedAt': datetime.now(timezone.utc).isoformat(),
        'source': 'local_session_trace' if events else 'local_session_state',
        'agents': [root, *children], 'links': [{'from': child['parentId'], 'to': child['id']} for child in children],
        'events': _public_events(events, root_id, turn_id),
        'coverage': {'subagents': 'observed' if children else 'not_observed',
                     'detail': '仅展示当前会话明确回执中的身份及最近状态，未读取子会话，不能保证完整拓扑。' if children
                     else '未捕获可核验的子 Agent 身份；技能调用和文字描述不代表独立 Agent。'},
        'warnings': sorted(warnings),
    }
