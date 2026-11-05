"""Project-local notification history; no conversation bodies or credentials."""
from __future__ import annotations

from contextlib import contextmanager
import json
import math
from pathlib import Path
import re
import sqlite3
import time

LIMIT = 1000


def notice(value):
    if not isinstance(value, dict):
        raise ValueError('通知格式无效')
    ident, message, tone, at = (value.get(k) for k in ('id', 'message', 'tone', 'at'))
    if (not isinstance(ident, str) or not 0 < len(ident) <= 1000
            or not isinstance(message, str) or not 0 < len(message) <= 600
            or tone not in ('info', 'success', 'error') or type(at) not in (int, float)
            or not math.isfinite(at) or not 0 < at <= time.time() * 1000 + 300000):
        raise ValueError('通知字段无效')
    result = dict(id=ident, message=message, tone=tone, at=at, read=value.get('read') is True)
    target = value.get('target')
    if isinstance(target, dict):
        page = target.get('page')
        if page == 'chat' and isinstance(target.get('sessionId'), str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,120}', target['sessionId']):
            result['target'] = dict(page=page, sessionId=target['sessionId'])
            if target.get('tool') in ('image', 'publish'):
                result['target']['tool'] = target['tool']
            if isinstance(target.get('receiptId'), str) and re.fullmatch(r'[a-f0-9]{32}', target['receiptId']):
                result['target']['receiptId'] = target['receiptId']
        elif page in ('image', 'outputs', 'publish', 'publish-receipts'):
            result['target'] = dict(page=page)
            if page == 'publish-receipts' and isinstance(target.get('receiptId'), str) and re.fullmatch(r'[a-f0-9]{32}', target['receiptId']):
                result['target']['receiptId'] = target['receiptId']
            if page == 'image' and target.get('medium') in ('image', 'video'):
                result['target']['medium'] = target['medium']
            if page == 'outputs':
                if target.get('filter') in ('all', 'image', 'video'):
                    result['target']['filter'] = target['filter']
                path = target.get('path')
                if (isinstance(path, str) and len(path) <= 4096
                        and not any(ord(c) < 32 or c in '\\:' or ord(c) == 127 for c in path)
                        and all(p not in ('', '.', '..') for p in path.split('/'))):
                    result['target']['path'] = path
    return result


def session_from_chat_notice(ident):
    """Recover the conversation identity from legacy completion notice IDs."""
    if not isinstance(ident, str) or not ident.startswith('chat:'):
        return None
    session_id = ident[5:].split(':', 1)[0]
    return session_id if re.fullmatch(r'[A-Za-z0-9_.-]{1,120}', session_id) else None


def chat_notice_titles(outputs: Path, sessions):
    """Read existing title metadata only; never load conversation messages."""
    path = Path(outputs).resolve() / '_automation' / 'tasks.sqlite3'
    if not path.is_file():
        return {}
    titles = {}
    try:
        with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=1) as db:
            db.execute('PRAGMA query_only=ON')
            tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            wanted = list(dict.fromkeys(sessions))[:1000]
            for start in range(0, len(wanted), 200):
                batch = wanted[start:start + 200]
                marks = ','.join('?' for _ in batch)
                deleted = f' AND id NOT IN (SELECT id FROM deleted_sessions)' if 'deleted_sessions' in tables else ''
                for table in ('conversation_snapshots', 'sessions'):
                    if table not in tables:
                        continue
                    rows = db.execute(f"SELECT id,json_extract(data,'$.title') FROM {table} WHERE id IN ({marks})" + deleted, batch)
                    for ident, title in rows:
                        if ident in titles or not isinstance(title, str):
                            continue
                        title = re.sub(r'\s+', ' ', title).strip()
                        if title and title not in {'对话', '新对话'}:
                            titles[ident] = title[:80]
    except (OSError, sqlite3.Error, ValueError):
        pass
    return titles


class NotificationStore:
    def __init__(self, outputs: Path):
        self.outputs = Path(outputs)
        self.path = outputs / '_notifications' / 'history.sqlite3'

    @contextmanager
    def database(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=15)
        try:
            with db:
                db.execute('CREATE TABLE IF NOT EXISTS notices (id TEXT PRIMARY KEY, at REAL, payload TEXT)')
                # Tombstones prevent cleared events from reappearing on reconnect.
                db.execute('CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, at REAL)')
                db.execute('CREATE TABLE IF NOT EXISTS deleted_sessions (id TEXT PRIMARY KEY, at REAL)')
                yield db
        finally:
            db.close()

    def list(self):
        with self.database() as db:
            rows = [json.loads(row[0]) for row in db.execute('SELECT payload FROM notices ORDER BY at DESC, id DESC LIMIT ?', (LIMIT,))]
            seen = [r[0] for r in db.execute('SELECT id FROM seen ORDER BY at DESC LIMIT 10000')]
        identities = {row['id']: session_from_chat_notice(row['id']) for row in rows}
        titles = chat_notice_titles(self.outputs, [sid for sid in identities.values() if sid])
        for row in rows:
            sid = identities[row['id']]
            # Keep customized non-completion notices untouched. Projection also
            # repairs old generic notices without changing ids, read state or time.
            outcome = row['id'].rsplit(':', 1)[-1]
            if sid and outcome in {'已完成', '失败', '已停止'}:
                subject = titles.get(sid)
                if subject:
                    row['message'] = f'{subject} · {outcome}'
                elif row['message'] == f'对话 · {outcome}':
                    row['message'] = f'对话 {sid[-6:]} · {outcome}'
        return dict(notices=rows, seen=seen, limit=LIMIT)

    def add(self, values):
        rows = [notice(value) for value in values]
        with self.database() as db, db:
            for row in rows:
                target = row.get('target', {})
                session_id = target.get('sessionId') if target.get('page') == 'chat' else session_from_chat_notice(row['id'])
                if session_id and db.execute(
                        'SELECT 1 FROM deleted_sessions WHERE id=?', (session_id,)).fetchone():
                    db.execute('INSERT OR IGNORE INTO seen VALUES (?,?)', (row['id'], row['at']))
                    continue
                if db.execute('INSERT OR IGNORE INTO seen VALUES (?,?)', (row['id'], row['at'])).rowcount:
                    db.execute('INSERT INTO notices VALUES (?,?,?)', (row['id'], row['at'], json.dumps(row, ensure_ascii=False)))
            db.execute('DELETE FROM notices WHERE id NOT IN (SELECT id FROM notices ORDER BY at DESC,id DESC LIMIT ?)', (LIMIT,))
            db.execute('DELETE FROM seen WHERE id NOT IN (SELECT id FROM seen ORDER BY at DESC LIMIT 10000)')

    def read(self, ident=None):
        with self.database() as db, db:
            rows = db.execute('SELECT id,payload FROM notices' + (' WHERE id=?' if ident else ''), (ident,) if ident else ()).fetchall()
            for key, payload in rows:
                row = json.loads(payload)
                row['read'] = True
                db.execute('UPDATE notices SET payload=? WHERE id=?', (json.dumps(row, ensure_ascii=False), key))

    def remove(self, ids):
        """Delete specific notices. Tombstones keep stale clients from reviving them."""
        wanted = [i for i in (ids or []) if isinstance(i, str) and 0 < len(i) <= 1000]
        if not wanted:
            return 0
        with self.database() as db, db:
            marks = ','.join('?' * len(wanted))
            removed = db.execute(f'DELETE FROM notices WHERE id IN ({marks})', wanted).rowcount
            for ident in wanted:
                db.execute('INSERT OR IGNORE INTO seen VALUES (?,?)', (ident, time.time() * 1000))
            return removed

    def clear(self):
        with self.database() as db, db:
            db.execute('DELETE FROM notices')

    def remove_session(self, session_id):
        """A deleted conversation cannot receive late or replayed notifications."""
        if not isinstance(session_id, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,120}', session_id):
            raise ValueError('会话标识无效')
        with self.database() as db, db:
            db.execute('INSERT OR IGNORE INTO deleted_sessions VALUES (?,?)', (session_id, time.time() * 1000))
            ids = []
            for ident, payload in db.execute('SELECT id,payload FROM notices'):
                target = json.loads(payload).get('target', {})
                if ((target.get('page') == 'chat' and target.get('sessionId') == session_id)
                        or session_from_chat_notice(ident) == session_id):
                    ids.append(ident)
            for ident in ids:
                db.execute('DELETE FROM notices WHERE id=?', (ident,))
                db.execute('INSERT OR IGNORE INTO seen VALUES (?,?)', (ident, time.time() * 1000))
            return len(ids)


def chat_finished(outputs: Path, sid: str, tid: str, *, failed=False, stopped=False):
    outcome = '失败' if failed else '已停止' if stopped else '已完成'
    title = chat_notice_titles(outputs, [sid]).get(sid, f'对话 {sid[-6:]}')
    NotificationStore(outputs).add([dict(id=f'chat:{sid}:{tid}:{outcome}', message=f'{title} · {outcome}',
        tone='error' if failed else 'info' if stopped else 'success', at=int(time.time() * 1000),
        target=dict(page='chat', sessionId=sid))])
