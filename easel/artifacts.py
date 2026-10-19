"""Durable, session-scoped file deliveries. Reading/refreshing never runs a model."""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
from html.parser import HTMLParser
from html import escape
import json
import mimetypes
from pathlib import Path
import re
import secrets
import sqlite3
import time
from urllib.parse import unquote, urlsplit, quote

SAFE_ID = re.compile(r'^[A-Za-z0-9_.-]{1,200}$')
MAX_FILE = 64 * 1024 * 1024
MAX_RELATED = 64
PRESENT_TOOL = {'type': 'function', 'name': 'easel_present',
                'description': 'Deliver existing files from the current workspace to this Easel chat. Does not generate files or call a model.',
                'inputSchema': {'type': 'object', 'properties': {'files': {'type': 'array', 'minItems': 1, 'maxItems': 16,
                  'items': {'type': 'object', 'properties': {'path': {'type': 'string'}, 'description': {'type': 'string'}},
                            'required': ['path'], 'additionalProperties': False}}}, 'required': ['files'], 'additionalProperties': False}}
CSS_URL = re.compile(r'''url\(\s*['"]?([^'"\s)]+)['"]?\s*\)|@import\s+['"]([^'"]+)['"]''', re.I)


def scope(value):
    if not isinstance(value, str) or not SAFE_ID.fullmatch(value):
        raise ValueError('无效的会话或轮次标识')
    return value


def private_output(root, path):
    """Keep internal delivery/job credentials out of legacy media/file routes."""
    relative = Path(path).resolve().relative_to(Path(root).resolve())
    return bool(relative.parts and relative.parts[0] in ('_artifacts', '_automation', '_browser'))


def file_path(root, value):
    root = Path(root).resolve()
    raw = str(value).replace('\\', '/')
    if raw.startswith('outputs/'):
        raw = raw[8:]
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = root / candidate
    lexical = candidate.absolute().relative_to(root)
    if not lexical.parts or any(part in ('.', '..') or part.startswith(('.', '_')) for part in lexical.parts):
        raise ValueError('产物不能引用系统、隐藏或上级路径')
    resolved = candidate.resolve()
    resolved.relative_to(root)
    if any(part.startswith(('.', '_')) for part in resolved.relative_to(root).parts):
        raise ValueError('产物不能引用系统路径')
    return candidate, lexical.as_posix()


def related_path(root, parent, value):
    value = value.strip()
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc or not parsed.path or parsed.path.startswith('/'):
        return None
    # Normalize trusted relative references, then apply the same root boundary.
    target = (Path(root) / Path(parent).parent / unquote(parsed.path)).resolve()
    return file_path(root, str(target))[1]


class References(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if not value:
                continue
            if key in ('src', 'poster') or (key == 'href' and tag == 'link'):
                self.urls.append(value)
            if key == 'style':
                self.urls.extend(a or b for a, b in CSS_URL.findall(value))
            if key == 'srcset':
                self.urls.extend(part.strip().split()[0] for part in value.split(',') if part.strip())


def inspect_file(root, relative):
    """Hash actual bytes plus HTML/CSS dependencies, rejecting unstable reads."""
    pending, visited, hashes, total = [relative], {}, [], 0
    while pending:
        rel = pending.pop(0)
        if rel in visited:
            continue
        if len(visited) >= MAX_RELATED:
            raise ValueError('关联文件超过预览上限')
        path, rel = file_path(root, rel)
        try:
            before = path.stat()
        except FileNotFoundError:
            if rel == relative:
                return {'status': 'missing', 'size': 0, 'version': 'missing', 'dependencies': []}
            visited[rel] = None
            hashes.append((rel, 'missing'))
            continue
        if not path.is_file() or before.st_size <= 0 or before.st_size > MAX_FILE:
            raise ValueError('文件为空、不是普通文件或超过64MiB')
        total += before.st_size
        if total > MAX_FILE:
            raise ValueError('文件及关联资源超过64MiB')
        digest = hashlib.sha256()
        text_bytes = bytearray()
        is_text = path.suffix.lower() in ('.html', '.htm', '.css')
        with path.open('rb') as stream:
            while chunk := stream.read(128 * 1024):
                if stream.tell() > MAX_FILE:
                    raise ValueError('文件仍在写入或超过上限')
                digest.update(chunk)
                if is_text:
                    text_bytes.extend(chunk)
        after = path.stat()
        if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
            raise ValueError('文件仍在写入，请稍后刷新')
        mime = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
        if path.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'):
            from PIL import Image
            with Image.open(path) as image:
                mime = Image.MIME.get(image.format, mime)
                image.verify()
        visited[rel] = {'size': before.st_size, 'mtime': before.st_mtime, 'mime': mime}
        hashes.append((rel, digest.hexdigest()))
        if is_text:
            text = text_bytes.decode('utf-8', errors='replace')
            refs = [a or b for a, b in CSS_URL.findall(text)]
            if path.suffix.lower() in ('.html', '.htm'):
                parser = References(); parser.feed(text); refs += parser.urls
            for url in refs:
                related = related_path(root, rel, url)
                if related and related not in visited:
                    pending.append(related)
    main = visited[relative]
    return {'status': 'ready', 'size': main['size'], 'updatedAt': main['mtime'], 'mimeType': main['mime'],
            'version': hashlib.sha256(json.dumps(sorted(hashes)).encode()).hexdigest(),
            'dependencies': sorted(key for key in visited if key != relative)}


class ArtifactStore:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.path = self.root / '_artifacts' / 'registry.sqlite3'

    @contextmanager
    def db(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            db.executescript('''
              CREATE TABLE IF NOT EXISTS turns(session TEXT, turn TEXT, ticket TEXT UNIQUE,
                created REAL, PRIMARY KEY(session,turn));
              CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, session TEXT, path TEXT,
                data TEXT, UNIQUE(session,path));
              CREATE TABLE IF NOT EXISTS deliveries(session TEXT, turn TEXT, artifact TEXT,
                source TEXT, call TEXT, created REAL, PRIMARY KEY(session,turn,artifact));
              CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,
                session TEXT, turn TEXT, kind TEXT, data TEXT);
              CREATE INDEX IF NOT EXISTS artifact_events_session ON events(session,seq);
            ''')
            with db:
                yield db
        finally:
            db.close()

    def bind(self, session, turn):
        scope(session); scope(turn)
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT ticket FROM turns WHERE session=? AND turn=?', (session, turn)).fetchone()
            if row:
                return row['ticket']
            ticket = secrets.token_hex(24)
            db.execute('INSERT INTO turns VALUES(?,?,?,?)', (session, turn, ticket, time.time()))
            return ticket

    def present_ticket(self, ticket, files, *, source='present', call=None, session=None):
        owner, turn = self.ticket_scope(ticket, session=session)
        return self.present(owner, turn, files, source=source, call=call)

    def ticket_scope(self, ticket, *, session=None):
        with self.db() as db:
            row = db.execute('SELECT session,turn FROM turns WHERE ticket=?', (ticket,)).fetchone()
        if not row or (session is not None and row['session'] != session):
            raise ValueError('交付凭据不匹配，请使用本轮提供的凭据')
        return row['session'], row['turn']

    def present(self, session, turn, files, *, source, call=None):
        scope(session); scope(turn)
        if not 1 <= len(files) <= 16:
            raise ValueError('每次交付1至16个文件')
        values = []
        for entry in files:
            path, rel = file_path(self.root, entry['path'])
            info = inspect_file(self.root, rel)
            if info['status'] != 'ready':
                raise ValueError('文件不存在，未交付')
            ident = hashlib.sha256(f'{session}\0{rel}'.encode()).hexdigest()[:32]
            values.append({'id': ident, 'sessionId': session, 'path': rel, 'name': path.name,
                           'mimeType': mimetypes.guess_type(path.name)[0] or 'application/octet-stream',
                           'description': str(entry.get('description', ''))[:300], **info})
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            for value in values:
                old = db.execute('SELECT data FROM artifacts WHERE id=?', (value['id'],)).fetchone()
                delivered = db.execute('SELECT 1 FROM deliveries WHERE session=? AND turn=? AND artifact=?',
                                       (session, turn, value['id'])).fetchone()
                previous = json.loads(old['data']) if old else {}
                unchanged = {k: v for k, v in previous.items() if k != 'revision'} == value
                value['revision'] = previous.get('revision', 0) + (0 if unchanged else 1)
                data = json.dumps(value, ensure_ascii=False)
                db.execute('INSERT INTO artifacts VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
                           (value['id'], session, value['path'], data))
                db.execute('INSERT OR IGNORE INTO deliveries VALUES(?,?,?,?,?,?)',
                           (session, turn, value['id'], source, call, time.time()))
                if not delivered or not unchanged:
                    self._event(db, session, turn, 'artifact.created' if not delivered else 'artifact.updated', value)
        return values

    @staticmethod
    def _event(db, session, turn, kind, value):
        db.execute('INSERT INTO events(session,turn,kind,data) VALUES(?,?,?,?)',
                   (session, turn, kind, json.dumps(value, ensure_ascii=False)))

    def get(self, session, ident):
        scope(session)
        with self.db() as db:
            row = db.execute('SELECT data FROM artifacts WHERE id=? AND session=?', (ident, session)).fetchone()
        if not row:
            raise FileNotFoundError('当前会话没有该产物')
        return json.loads(row['data'])

    def refresh(self, session, ident):
        old = self.get(session, ident)
        try:
            value = {**old, **inspect_file(self.root, old['path'])}
            value.pop('error', None)
        except (ValueError, OSError):
            value = {**old, 'status': 'failed', 'error': '文件不可读或仍在写入，请稍后刷新'}
        if value != old:
            with self.db() as db:
                db.execute('BEGIN IMMEDIATE')
                # An older read cannot overwrite a concurrent delivery.
                current = db.execute('SELECT data FROM artifacts WHERE id=? AND session=?', (ident, session)).fetchone()
                if current and json.loads(current['data']) == old:
                    value['revision'] = old.get('revision', 0) + 1
                    db.execute('UPDATE artifacts SET data=? WHERE id=?', (json.dumps(value, ensure_ascii=False), ident))
                    for row in db.execute('SELECT turn FROM deliveries WHERE session=? AND artifact=?', (session, ident)):
                        self._event(db, session, row['turn'], 'artifact.updated', value)
        return self.get(session, ident)

    def snapshot(self, session, *, after=0):
        scope(session)
        with self.db() as db:
            rows = db.execute('SELECT d.turn,d.source,d.call,a.data FROM deliveries d JOIN artifacts a ON a.id=d.artifact '
                              'WHERE d.session=? ORDER BY d.created LIMIT 1000', (session,)).fetchall()
            events = db.execute('SELECT seq,turn,kind,data FROM events WHERE session=? AND seq>? ORDER BY seq LIMIT 200',
                                (session, max(0, after))).fetchall()
            latest = db.execute('SELECT COALESCE(MAX(seq),0) FROM events WHERE session=?', (session,)).fetchone()[0]
            return {'sessionId': session, 'artifacts': [{**json.loads(r['data']), 'turnId': r['turn'],
                    'source': r['source'], 'toolCallId': r['call']} for r in rows],
                    'events': [{'id': r['seq'], 'turnId': r['turn'], 'type': r['kind'], 'artifact': json.loads(r['data'])} for r in events],
                    'cursor': events[-1]['seq'] if events else max(0, after), 'hasMore': bool(events and events[-1]['seq'] < latest)}


def preview_prefix(session, ident, version):
    return f'/api/chat/artifacts/{quote(session)}/{ident}/resource/{version}/'


def preview_html(store, value):
    """Version every local dependency. HTML runs only in an opaque sandbox frame."""
    path, _ = file_path(store.root, value['path'])
    content = path.read_text(encoding='utf-8')
    prefix = preview_prefix(value['sessionId'], value['id'], value['version'])
    allowed = {value['path'], *value['dependencies']}

    def url(raw, parent=value['path']):
        try:
            rel = related_path(store.root, parent, raw)
            if rel in allowed:
                suffix = '#' + urlsplit(raw).fragment if urlsplit(raw).fragment else ''
                return prefix + '/'.join(quote(part) for part in rel.split('/')) + suffix
        except ValueError:
            pass
        return raw

    def css(text):
        return CSS_URL.sub(lambda m: 'url("' + url(m[1]) + '")' if m[1] else '@import "' + url(m[2]) + '"', text)

    class Rewriter(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=False)
            self.result, self.style = [], False

        def handle_starttag(self, tag, attrs):
            if tag == 'base':
                return
            rewritten = []
            for key, val in attrs:
                if val is not None:
                    if key in ('src', 'href', 'poster'):
                        val = url(val)
                    elif key == 'style':
                        val = css(val)
                    elif key == 'srcset' and not val.startswith('data:'):
                        val = ', '.join(' '.join([url(parts[0]), *parts[1:]]) for part in val.split(',') if (parts := part.strip().split()))
                rewritten.append(key if val is None else f'{key}="{escape(val, quote=True)}"')
            self.result.append('<' + tag + (' ' if rewritten else '') + ' '.join(rewritten) + '>')
            if tag == 'style':
                self.style = True

        def handle_startendtag(self, tag, attrs):
            self.handle_starttag(tag, attrs)

        def handle_endtag(self, tag):
            if tag == 'style': self.style = False
            if tag != 'base': self.result.append('</' + tag + '>')

        def handle_data(self, data): self.result.append(css(data) if self.style else data)
        def handle_comment(self, data): self.result.append('<!--' + data + '-->')
        def handle_decl(self, decl): self.result.append('<!' + decl + '>')
        def handle_entityref(self, name): self.result.append('&' + name + ';')
        def handle_charref(self, name): self.result.append('&#' + name + ';')

    parser = Rewriter(); parser.feed(content); parser.close()
    return ''.join(parser.result)
