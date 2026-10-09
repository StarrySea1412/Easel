"""Read only one Easel session's OpenClaw SQLite transcript, with turn bounds.

Legacy JSONL readers remain responsible for JSONL. This adapter never exports
the database, mutates it, or scans unrelated session bodies.
"""
from __future__ import annotations
from contextlib import contextmanager
import json
from pathlib import Path
import re
import sqlite3
import time
import uuid
from datetime import datetime

SAFE = re.compile(r'^[A-Za-z0-9_.-]{1,120}$')
NS = uuid.UUID('6ba7b810-9dad-11d1-80b4-00c04fd430c8')
MAX_EVENT = 256 * 1024
MAX_BYTES = 8 * 1024 * 1024
MAX_ROWS = 10000


def database_path(sessions_dir: Path) -> Path:
    return sessions_dir.parent / 'agent' / 'openclaw-agent.sqlite'


@contextmanager
def _reader(path):
    if path.is_symlink() or path.parent.is_symlink():
        raise ValueError('Untrusted transcript path')
    db = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=1)
    try:
        db.execute('PRAGMA query_only=ON')
        db.execute('BEGIN')
        yield db
    finally:
        db.close()


def _ids(db, session):
    if not SAFE.fullmatch(session):
        raise ValueError('Invalid session')
    ids = [str(uuid.uuid5(NS, session)), str(uuid.uuid5(NS, f'web:{session}'))]
    for key in (f'agent:main:{session}', f'agent:main:web:{session}', session, f'web:{session}'):
        row = db.execute('SELECT current_session_id FROM session_nodes WHERE session_key=?', (key,)).fetchone()
        if row and isinstance(row[0], str) and SAFE.fullmatch(row[0]):
            ids.append(row[0])
    return list(dict.fromkeys(ids))


def _generation(db, ident):
    row = db.execute('SELECT generation FROM transcript_rewrite_watermarks WHERE session_id=?', (ident,)).fetchone()
    return row[0] if row else None


def capture(sessions_dir, session):
    path = database_path(sessions_dir)
    if not path.is_file():
        return None
    try:
        with _reader(path) as db:
            cursors = {}
            for ident in _ids(db, session):
                row = db.execute('SELECT seq,event_id FROM transcript_event_identities WHERE session_id=? ORDER BY seq DESC LIMIT 1', (ident,)).fetchone()
                cursors[ident] = {'seq': row[0] if row else -1, 'anchor': row[1] if row else None,
                                  'generation': _generation(db, ident)}
            return {'fileId': [path.stat().st_dev, path.stat().st_ino], 'cursors': cursors}
    except (OSError, sqlite3.Error, ValueError):
        # An unreadable existing DB is not a license to sample its full history.
        return {'unavailable': True}


def has_session(sessions_dir, session):
    checkpoint = capture(sessions_dir, session)
    return bool(checkpoint and any(cursor.get('seq', -1) >= 0 for cursor in checkpoint.get('cursors', {}).values()))


def _stamp(event):
    message = event.get('message')
    value = event.get('timestamp') or (message.get('timestamp') if isinstance(message, dict) else None)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value / 1000 if value > 1e11 else value
    if isinstance(value, str):
        try:
            date = datetime.fromisoformat(value.replace('Z', '+00:00'))
            return date.timestamp() if date.tzinfo else None
        except (ValueError, OverflowError):
            pass
    return None


def read_events(sessions_dir, session, audit, *, live=False, finished=None, warnings=None):
    warnings = warnings if warnings is not None else set()
    path = database_path(sessions_dir)
    if not path.is_file() or not isinstance(audit, dict):
        return []
    started = audit.get('started')
    if not isinstance(started, (int, float)) or (not live and finished is None):
        return []
    checkpoint = audit.get('_sqlite')
    cursors = checkpoint.get('cursors', {}) if isinstance(checkpoint, dict) else {}
    result, remaining = [], MAX_BYTES
    try:
        stat = path.stat()
        if isinstance(checkpoint, dict) and (checkpoint.get('unavailable') or checkpoint.get('fileId') != [stat.st_dev, stat.st_ino]):
            warnings.add('SQLite 会话边界不可确认，未展示其工具证据。')
            return []
        with _reader(path) as db:
            for ident in _ids(db, session):
                cursor = cursors.get(ident)
                after = -1
                if cursor:
                    after = cursor.get('seq', -1)
                    if not isinstance(after, int) or isinstance(after, bool) or after < -1:
                        continue
                    if _generation(db, ident) != cursor.get('generation'):
                        # OpenClaw creates a generation on the first append of
                        # a new session. An exact session header born after our
                        # checkpoint proves initialization, not imported history.
                        header_row = db.execute('SELECT event_json FROM transcript_events WHERE session_id=? AND seq=0', (ident,)).fetchone()
                        try:
                            header = json.loads(header_row[0]) if header_row and header_row[0] else {}
                        except (ValueError, TypeError):
                            header = {}
                        born = _stamp(header) if isinstance(header, dict) else None
                        initialized = (after == -1 and cursor.get('generation') is None and born is not None
                                       and started <= born <= time.time() + 1 and header.get('type') == 'session'
                                       and header.get('id') == ident)
                        if not initialized:
                            warnings.add('会话被重写，原轮次边界已失效。'); continue
                    if after >= 0:
                        anchor = db.execute('SELECT event_id FROM transcript_event_identities WHERE session_id=? AND seq=?', (ident, after)).fetchone()
                        if not anchor or anchor[0] != cursor.get('anchor'):
                            warnings.add('SQLite 会话锚点已变化，未合并旧轮次。'); continue
                rows = db.execute('SELECT event_json,event_zstd,event_utf8_bytes FROM transcript_events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?',
                                  (ident, after, MAX_ROWS + 1))
                for count, (raw, compressed, size) in enumerate(rows):
                    if count >= MAX_ROWS or remaining <= 0:
                        warnings.add('会话读取达到上限，工具记录可能不完整。'); break
                    if not isinstance(size, int) or size <= 0 or size > MAX_EVENT or size > remaining:
                        warnings.add('部分会话事件超过读取上限，已跳过。'); continue
                    remaining -= size
                    try:
                        if raw is None and compressed is not None:
                            import zstandard
                            content_size = zstandard.frame_content_size(compressed)
                            if content_size not in (zstandard.CONTENTSIZE_UNKNOWN, zstandard.CONTENTSIZE_ERROR) and content_size > MAX_EVENT:
                                warnings.add('压缩事件超过解码上限，已跳过。'); continue
                            raw = zstandard.ZstdDecompressor().decompress(compressed, max_output_size=MAX_EVENT)
                        if raw is None or len(raw if isinstance(raw, bytes) else raw.encode('utf-8')) > MAX_EVENT:
                            continue
                        event = json.loads(raw)
                    except Exception:
                        # Decoder errors are data failures; never leak private
                        # compressed input in diagnostics or retry a model call.
                        warnings.add('部分压缩会话事件不可读，工具记录可能不完整。')
                        continue
                    if not isinstance(event, dict):
                        continue
                    stamp = _stamp(event)
                    if stamp is None or stamp < started or stamp > time.time() + 1 or (finished is not None and stamp > finished):
                        continue
                    message = event.get('message')
                    containers = [event, message] if isinstance(message, dict) else [event]
                    wrong = False
                    for value in containers:
                        if value.get('sessionId') not in (None, session, f'web:{session}', ident): wrong = True
                        if value.get('sessionKey') not in (None, session, f'web:{session}', f'agent:main:{session}', f'agent:main:web:{session}'): wrong = True
                        for key in ('turnId', 'runId'):
                            if audit.get(key) is not None and value.get(key) not in (None, audit[key]): wrong = True
                    if not wrong:
                        result.append(event)
    except (OSError, sqlite3.Error, ValueError):
        warnings.add('SQLite 会话暂不可读，未据此推断执行成功。')
    return result
