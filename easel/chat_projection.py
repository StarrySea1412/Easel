"""Project explicit external deliveries from the exact runtime transcript.

Ordinary provider messages remain owned by the existing chat/run adapter. This
reader imports only gateway-injected assistant messages, never model/tool input.
"""
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import time
from urllib.parse import unquote, urlsplit
import uuid

from .artifacts import ArtifactStore, file_path, scope
from .execution import public_text
from . import session_trace as trace

LINK = re.compile(r'''(?:!?\[[^\]]*\]\()<?([^\s)>]+)>?\)''')


def local_reference(root, raw):
    parsed = urlsplit(raw)
    if parsed.scheme or parsed.netloc:
        return None  # Do not download or reinterpret a remote URL as local.
    if parsed.path.startswith('/api/media/'):
        raw = unquote(parsed.path[len('/api/media/'):])
    elif raw.startswith('outputs/'):
        raw = unquote(parsed.path[8:])
    elif raw.startswith('#/outputs/'):
        raw = unquote(raw[len('#/outputs/'):])
    else:
        return None
    return file_path(root, raw)[1]


def _events(sessions, session, warnings):
    path = trace.database_path(sessions)
    if path.is_file():
        remaining = trace.MAX_BYTES
        try:
            with trace._reader(path) as db:
                for ident in trace._ids(db, session):
                    for raw, compressed, size in db.execute('SELECT event_json,event_zstd,event_utf8_bytes FROM transcript_events WHERE session_id=? ORDER BY seq DESC LIMIT 2000', (ident,)):
                        if remaining <= 0:
                            warnings.add('后台回写读取达到上限，较早记录未全部展示。'); return
                        if not isinstance(size, int) or not 0 < size <= min(trace.MAX_EVENT, remaining):
                            continue
                        remaining -= size
                        try:
                            if raw is None and compressed is not None:
                                import zstandard
                                raw = zstandard.ZstdDecompressor().decompress(compressed, max_output_size=trace.MAX_EVENT)
                            if raw is not None:
                                yield json.loads(raw)
                        except Exception:
                            warnings.add('部分后台回写记录不可读。')
        except (OSError, ValueError, sqlite3.Error):
            warnings.add('后台会话暂不可读，已保留当前对话内容。')
        return
    # Old source installations used deterministic per-session JSONL files.
    for key in (session, f'web:{session}'):
        path = Path(sessions) / f'{uuid.uuid5(trace.NS, key)}.jsonl'
        if not path.is_file() or path.is_symlink():
            continue
        try:
            with path.open('rb') as stream:
                length = path.stat().st_size
                if length > trace.MAX_BYTES:
                    stream.seek(length - trace.MAX_BYTES); stream.readline()
                    warnings.add('旧会话仅展示末尾可读取的后台回写。')
                for line in stream:
                    if len(line) <= trace.MAX_EVENT:
                        try:
                            yield json.loads(line)
                        except (ValueError, TypeError):
                            continue
        except OSError:
            warnings.add('旧会话后台回写暂不可读。')


def project_injected(outputs, sessions, session, credentials=None):
    scope(session)
    store = ArtifactStore(outputs); result = {}; warnings = set()
    for event in _events(sessions, session, warnings):
        if not isinstance(event, dict):
            continue
        message = event.get('message')
        if not isinstance(message, dict) or message.get('role') != 'assistant' or message.get('model') != 'gateway-injected':
            continue
        if message.get('sessionKey') not in (None, session, f'agent:main:{session}', f'agent:main:web:{session}'):
            continue
        stamp = trace._stamp(event)
        if stamp is None or stamp > time.time() + 1:
            continue
        content = message.get('content')
        text = content if isinstance(content, str) else '\n'.join(part['text'] for part in content or [] if isinstance(part, dict) and part.get('type') == 'text' and isinstance(part.get('text'), str))
        if not text.strip():
            continue
        identity = str(event.get('id') or message.get('id') or json.dumps([stamp, text]))
        ident = hashlib.sha256(f'{session}\0{identity}'.encode()).hexdigest()[:32]
        turn = 'external-' + ident
        # Only paths explicitly delivered by this exact persisted event qualify.
        existing = {a['path'] for a in store.snapshot(session)['artifacts'] if a['turnId'] == turn}
        for raw in LINK.findall(text)[:40]:
            try:
                relative = local_reference(outputs, raw)
                if relative and relative not in existing:
                    store.present(session, turn, [{'path': relative}], source='gateway-injected', call=ident)
                    existing.add(relative)
            except (OSError, ValueError, sqlite3.Error):
                warnings.add('部分回写文件未在当前数据目录找到，未伪造产物。')
        result[ident] = {'id': ident, 'turnId': turn, 'role': 'assistant', 'content': public_text(text, credentials),
                         'timestamp': stamp, 'source': 'gateway-injected'}
    messages = sorted(result.values(), key=lambda m: (m['timestamp'], m['id']))[-100:]
    return {'messages': messages, 'warnings': sorted(warnings)}


def present_payloads(outputs, session, turn, payloads, call=None):
    """Only structured successful local media payloads; never scrape prose."""
    store = ArtifactStore(outputs); result = []
    for payload in payloads[:32] if isinstance(payloads, list) else []:
        if not isinstance(payload, dict) or payload.get('isError'):
            continue
        paths = payload.get('mediaUrls', [])
        paths = paths if isinstance(paths, list) else []
        if isinstance(payload.get('mediaUrl'), str):
            paths = [payload['mediaUrl'], *paths]
        for raw in paths[:16]:
            if not isinstance(raw, str):
                continue
            try:
                relative = local_reference(outputs, raw)
                if relative is None and (Path(raw).is_absolute() or not urlsplit(raw).scheme):
                    relative = file_path(outputs, raw)[1]
                if relative:
                    result += store.present(session, turn, [{'path': relative}], source='gateway-payload', call=call)
            except (ValueError, OSError):
                continue
    return result
