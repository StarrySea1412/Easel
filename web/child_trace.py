"""Bounded, read-only child transcript source for JSONL and current SQLite stores."""
import json
import sqlite3

from fastapi import HTTPException
from easel import session_trace
import agent_office as office


def source(root, key, warnings, max_bytes):
    database = session_trace.database_path(root)
    if database.is_file():
        return _sqlite(database, key, warnings, max_bytes)
    index_path = root / 'sessions.json'
    index_revision = office._marker_revision(index_path)
    index = office._read_json(index_path, root, warnings) or {}
    entry = index.get(key)
    if not isinstance(entry, dict) or not office.SAFE_ID.fullmatch(str(entry.get('sessionId', ''))):
        return None
    path = root / f'{entry["sessionId"]}.jsonl'
    if path.is_symlink() or path.resolve().parent != root.resolve():
        raise HTTPException(409, '子任务记录路径不可核验')
    revision = office._marker_revision(path)
    if revision is None:
        return None
    rows = []
    try:
        with path.open('rb') as stream:
            remaining = min(revision[2], max_bytes)
            if revision[2] > max_bytes:
                warnings.add('子任务记录超过读取上限，当前操作可能不完整。')
            while remaining > 0:
                line = stream.readline(min(remaining, office.MAX_LINE_BYTES + 1))
                remaining -= len(line)
                if not line:
                    break
                if len(line) > office.MAX_LINE_BYTES:
                    warnings.add('子任务单条记录超过读取上限，当前操作可能不完整。')
                    break
                if not line.endswith(b'\n'):
                    break
                try:
                    rows.append(json.loads(line))
                except (ValueError, RecursionError):
                    warnings.add('部分子任务记录不可读，已跳过。')
    except OSError:
        return None

    def unchanged():
        after = office._marker_revision(path)
        return (after is not None and after[:2] == revision[:2] and after[2] >= revision[2]
                and (after[2] != revision[2] or after == revision)
                and office._marker_revision(index_path) == index_revision)
    return entry, rows, unchanged


def _sqlite(path, key, warnings, max_bytes):
    revision = office._marker_revision(path)
    try:
        with session_trace._reader(path) as db:
            # Exact child key only; never enumerate other session bodies.
            node = db.execute('SELECT current_session_id,entry_json,entry_valid,spawned_by,parent_session_key FROM session_nodes WHERE session_key=?', (key,)).fetchone()
            if not node or not node[2] or not office.SAFE_ID.fullmatch(str(node[0])):
                return None
            ident = node[0]
            entry = json.loads(node[1])
            if not isinstance(entry, dict) or entry.get('sessionId') not in (None, ident):
                raise HTTPException(409, '子任务会话索引不可核验')
            entry['sessionId'] = ident
            parents = {value for value in (entry.get('spawnedBy'), node[3], node[4]) if value}
            if len(parents) > 1:
                raise HTTPException(409, '子任务归属记录不一致')
            entry['spawnedBy'] = next(iter(parents), None)
            generation = session_trace._generation(db, ident)
            rows, remaining = [], max_bytes
            for count, (raw, compressed, size) in enumerate(db.execute(
                    'SELECT event_json,event_zstd,event_utf8_bytes FROM transcript_events WHERE session_id=? ORDER BY seq LIMIT ?',
                    (ident, session_trace.MAX_ROWS + 1))):
                if count >= session_trace.MAX_ROWS or remaining <= 0:
                    warnings.add('子任务记录超过读取上限，当前操作可能不完整。'); break
                if not isinstance(size, int) or size <= 0 or size > session_trace.MAX_EVENT or size > remaining:
                    warnings.add('部分子任务记录超过读取上限，当前操作可能不完整。'); continue
                remaining -= size
                try:
                    if raw is None and compressed is not None:
                        import zstandard
                        frame_size = zstandard.frame_content_size(compressed)
                        if frame_size not in (zstandard.CONTENTSIZE_UNKNOWN, zstandard.CONTENTSIZE_ERROR) and frame_size > session_trace.MAX_EVENT:
                            warnings.add('子任务压缩记录超过解码上限。'); continue
                        raw = zstandard.ZstdDecompressor().decompress(compressed, max_output_size=session_trace.MAX_EVENT)
                    if raw is not None and len(raw if isinstance(raw, bytes) else raw.encode('utf-8')) <= session_trace.MAX_EVENT:
                        rows.append(json.loads(raw))
                except Exception:
                    warnings.add('部分子任务记录不可读，已跳过。')
    except (OSError, ValueError, sqlite3.Error):
        warnings.add('子任务 SQLite 记录暂不可读。')
        return None

    def unchanged():
        after = office._marker_revision(path)
        if not after or not revision or after[:2] != revision[:2]:
            return False
        try:
            with session_trace._reader(path) as db:
                current = db.execute('SELECT current_session_id,entry_json,entry_valid,spawned_by,parent_session_key FROM session_nodes WHERE session_key=?', (key,)).fetchone()
                return current == node and session_trace._generation(db, ident) == generation
        except (OSError, ValueError, sqlite3.Error):
            return False
    return entry, rows, unchanged
