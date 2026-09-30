"""Persistent usage ledger for this Easel project's own OpenClaw chat sessions.

Only transcript files mapped from this project's web session markers are read.
The ledger stores identifiers, models and usage numbers, never message content.
Unknown token counts/costs stay null; cached/reasoning tokens are subsets, not
added to totals a second time. Re-reading/rotating transcripts is idempotent.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone
from contextlib import contextmanager
from pathlib import Path

_LOCK = threading.RLock()
_SESSION_NS = uuid.UUID('6ba7b810-9dad-11d1-80b4-00c04fd430c8')
_SAFE_ID = re.compile(r'^[A-Za-z0-9_.-]{1,120}$')
TOKEN_FIELDS = ('inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
                'reasoningTokens', 'totalTokens')
FIELDS = (*TOKEN_FIELDS, 'recordedCostUsd')


@contextmanager
def _database(path: Path):
    connection = sqlite3.connect(path, timeout=15)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def _number(value: object, integer: bool = True) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value < 0 or (integer and int(value) != value):
        return None
    return int(value) if integer else float(value)


def _pick(data: dict, *keys: str) -> int | None:
    return next((value for key in keys if (value := _number(data.get(key))) is not None), None)


def normalize_usage(usage: object) -> dict:
    """Normalize Pi/OpenClaw, OpenAI Chat/Responses and Anthropic usage shapes."""
    data = usage if isinstance(usage, dict) else {}
    input_details = data.get('prompt_tokens_details') or data.get('input_tokens_details') or {}
    output_details = data.get('completion_tokens_details') or data.get('output_tokens_details') or {}
    input_details = input_details if isinstance(input_details, dict) else {}
    output_details = output_details if isinstance(output_details, dict) else {}
    cache_read = _pick(data, 'cacheRead', 'cache_read_input_tokens')
    if cache_read is None:
        cache_read = _pick(input_details, 'cached_tokens')
    cache_write = _pick(data, 'cacheWrite', 'cache_creation_input_tokens')
    input_tokens = _pick(data, 'input', 'input_tokens', 'prompt_tokens')
    output_tokens = _pick(data, 'output', 'output_tokens', 'completion_tokens')
    # Pi and Anthropic report uncached input separately; OpenAI already includes it.
    if input_tokens is not None and ('input' in data or 'cache_read_input_tokens' in data
                                     or 'cache_creation_input_tokens' in data):
        input_tokens += (cache_read or 0) + (cache_write or 0)
    total = _pick(data, 'totalTokens', 'total_tokens')
    if total is None and input_tokens is not None and output_tokens is not None:
        total = input_tokens + output_tokens
    reasoning = _pick(data, 'reasoning', 'reasoning_tokens')
    if reasoning is None:
        reasoning = _pick(output_details, 'reasoning_tokens')
    # OpenClaw/Pi's cost.total is USD, but may be computed using configured prices.
    # Preserve that provenance instead of claiming it is a provider invoice.
    cost = data.get('cost')
    cost_usd = _number(cost.get('total'), integer=False) if isinstance(cost, dict) else None
    return dict(zip(FIELDS, (input_tokens, output_tokens, cache_read, cache_write,
                            reasoning, total, cost_usd)))


def summarize(calls: list[dict]) -> dict:
    counts = {field: sum(call.get(field) is not None for call in calls) for field in FIELDS}
    result = {field: sum(call[field] for call in calls if call.get(field) is not None)
              if counts[field] else None for field in FIELDS}
    result.update(calls=len(calls), reportedCalls=sum(any(call.get(field) is not None
                  for field in TOKEN_FIELDS) for call in calls), coverage=counts)
    result['missingCalls'] = result['calls'] - result['reportedCalls']
    return result


def _hash(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     default=str).encode('utf-8')).hexdigest()


def _read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _timestamp(value: object) -> str:
    try:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return datetime.fromtimestamp(value / 1000 if value > 1e11 else value, timezone.utc).isoformat()
        if isinstance(value, str) and value:
            parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
            return parsed.replace(tzinfo=parsed.tzinfo or timezone.utc).astimezone(timezone.utc).isoformat()
    except (ValueError, OverflowError, OSError):
        pass
    return ''


def _transcript_calls(path: Path, session_id: str) -> tuple[list[dict], int]:
    calls: dict[str, dict] = {}
    seen: set[str] = set()
    turn = 'unattributed'
    turn_index = 0
    malformed = 0
    with path.open(encoding='utf-8') as stream:
        for line_number, line in enumerate(stream, 1):
            try:
                event = json.loads(line)
            except (ValueError, UnicodeError):
                malformed += 1
                continue
            if not isinstance(event, dict):
                continue
            message = event.get('message')
            if not isinstance(message, dict) or message.get('role') not in ('user', 'assistant'):
                continue
            # IDs remain stable when a transcript is copied or compacted.
            event_id = str(event.get('id') or message.get('id') or _hash(event))
            if message['role'] == 'user':
                if event_id in seen:
                    continue
                seen.add(event_id)
                turn = event_id
                turn_index += 1
                continue
            values = normalize_usage(message.get('usage'))
            call = {
                'id': _hash([session_id, event_id]), 'sessionId': session_id,
                'turnId': _hash([session_id, turn]), 'turnIndex': turn_index,
                'timestamp': _timestamp(message.get('timestamp') or event.get('timestamp')),
                'model': str(message.get('model') or '未上报')[:160],
                'provider': str(message.get('provider') or '未上报')[:100],
                'line': line_number, **values,
            }
            if event_id in calls:
                previous = calls[event_id]
                call['turnId'], call['turnIndex'] = previous['turnId'], previous['turnIndex']
                for field in FIELDS:
                    if call[field] is None:
                        call[field] = previous[field]
            calls[event_id] = call
    return list(calls.values()), malformed


def _sources(sessions_dir: Path, known_ids: set[str]) -> dict[Path, str]:
    """Resolve only known Easel web IDs, never arbitrary index files/paths."""
    index = _read_json(sessions_dir / 'sessions.json')
    result: dict[Path, str] = {}
    root = sessions_dir.resolve()
    for session_id in sorted(known_ids):
        for key in (session_id, f'web:{session_id}'):
            transcript_ids = {str(uuid.uuid5(_SESSION_NS, key))}
            entry = index.get(f'agent:main:{key}') or index.get(key)
            if isinstance(entry, dict) and isinstance(entry.get('sessionId'), str):
                transcript_ids.add(entry['sessionId'])
            for transcript_id in transcript_ids:
                if not _SAFE_ID.fullmatch(transcript_id):
                    continue
                path = sessions_dir / f'{transcript_id}.jsonl'
                if path.is_file() and path.resolve().parent == root:
                    result[path] = session_id
    return result


def collect_usage(project_root: Path, state_dir: Path, web_sessions_dir: Path,
                  session_id: str = '', limit: int = 60, offset: int = 0) -> dict:
    """Refresh an idempotent disk ledger and return project/session/turn totals."""
    if session_id and not _SAFE_ID.fullmatch(session_id):
        raise ValueError('会话标识无效')
    project_root, state_dir = project_root.resolve(), state_dir.resolve()
    scope = _hash([str(project_root), str(state_dir)])[:16]
    ledger_dir = web_sessions_dir.parent / '_usage'
    ledger_dir.mkdir(parents=True, exist_ok=True)
    sessions_dir = state_dir / 'agents' / 'main' / 'sessions'
    issues: list[str] = []
    with _LOCK, _database(ledger_dir / f'{scope}.sqlite3') as db:
        db.execute('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY)')
        db.execute('CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, payload TEXT NOT NULL)')
        db.execute('CREATE TABLE IF NOT EXISTS sources (path TEXT PRIMARY KEY, signature TEXT, malformed INTEGER)')
        known = {row[0] for row in db.execute('SELECT id FROM sessions')}
        if web_sessions_dir.is_dir():
            for path in web_sessions_dir.glob('web_*.json'):
                value = path.stem[4:]
                if _SAFE_ID.fullmatch(value) and path.resolve().parent == web_sessions_dir.resolve():
                    known.add(value)
        db.executemany('INSERT OR IGNORE INTO sessions VALUES (?)', [(value,) for value in known])
        sources = _sources(sessions_dir, known)
        for path, web_id in sources.items():
            try:
                stat = path.stat()
                signature = f'{stat.st_mtime_ns}:{stat.st_size}'
                previous = db.execute('SELECT signature, malformed FROM sources WHERE path=?', (str(path),)).fetchone()
                if previous and previous[0] == signature:
                    if previous[1]:
                        issues.append('部分记录尚未写完或格式不可读，已跳过；刷新后重试。')
                    continue
                calls, malformed = _transcript_calls(path, web_id)
                for call in calls:
                    existing = db.execute('SELECT payload FROM calls WHERE id=?', (call['id'],)).fetchone()
                    if existing:
                        old = json.loads(existing[0])
                        # A copied/compacted record without usage cannot erase reported data.
                        for field in FIELDS:
                            if call[field] is None:
                                call[field] = old.get(field)
                        if call['turnIndex'] == 0:
                            call['turnId'], call['turnIndex'] = old['turnId'], old['turnIndex']
                    db.execute('INSERT OR REPLACE INTO calls VALUES (?,?)', (call['id'], json.dumps(call)))
                db.execute('INSERT OR REPLACE INTO sources VALUES (?,?,?)', (str(path), signature, malformed))
                if malformed:
                    issues.append('部分记录尚未写完或格式不可读，已跳过；刷新后重试。')
            except (OSError, UnicodeError):
                issues.append('部分会话记录无法读取；已有统计已保留。')
        all_calls = [json.loads(row[0]) for row in db.execute('SELECT payload FROM calls')]
        source_count = db.execute('SELECT COUNT(*) FROM sources').fetchone()[0]
    current = [call for call in all_calls if call['sessionId'] == session_id]
    rounds: dict[str, list[dict]] = {}
    for call in current:
        rounds.setdefault(call['turnId'], []).append(call)
    turns = []
    for turn_id, calls in rounds.items():
        calls.sort(key=lambda call: (call['timestamp'], call['line']))
        turns.append({'id': turn_id, 'timestamp': calls[0]['timestamp'],
                      'unattributed': calls[0]['turnIndex'] == 0,
                      'summary': summarize(calls), 'calls': calls})
    turns.sort(key=lambda turn: (turn['timestamp'], turn['calls'][0]['turnIndex']))
    for index, turn in enumerate(turns, 1):
        turn['number'] = index
    turns.reverse()
    sessions: dict[str, list[dict]] = {}
    for call in all_calls:
        sessions.setdefault(call['sessionId'], []).append(call)
    by_session = [{'sessionId': key, 'summary': summarize(calls),
                   'lastAt': max((call['timestamp'] for call in calls), default='')}
                  for key, calls in sessions.items()]
    by_session.sort(key=lambda item: item['lastAt'], reverse=True)
    return {
        'sessionId': session_id, 'session': summarize(current), 'project': summarize(all_calls),
        'turns': turns[offset:offset + limit], 'turnCount': len(turns), 'offset': offset, 'limit': limit,
        'sessions': by_session[:100], 'sessionCount': len(by_session),
        'sourceCount': source_count, 'updatedAt': int(time.time()), 'issues': sorted(set(issues)),
        'scope': '本 Easel 项目已创建的 Web 对话；仅读取其专用 OpenClaw profile，已累计记录在删除会话后仍保留。',
        'note': '输入含缓存；缓存和推理为子项，不重复加入总量。未上报字段显示为未上报，汇总只累计已知值。',
        'costNote': '费用来自 OpenClaw usage.cost 记录，可能按网关配置价格估算；非账单金额，缺少价格时不自行估价。',
    }
