"""Scoped, versioned profile experience. Model-facing operations never accept entries.

This is an application boundary, not an OS sandbox: an unrestricted process
running as the service user can still change SQLite or impersonate local HTTP.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import tempfile
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from functools import wraps


class Conflict(ValueError):
    pass


def digest(value):
    raw = value if isinstance(value, str) else json.dumps(value, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat()


def linked(path):
    return path.is_symlink() or (hasattr(path, 'is_junction') and path.is_junction())


def terms(text):
    words = set(re.findall(r'[a-z0-9_]{2,}', text.lower()))
    for run in re.findall(r'[\u4e00-\u9fff]+', text):
        words.update(run[i:i + 2] for i in range(len(run) - 1))
    return words


def scope(value):
    if not isinstance(value, dict):
        raise ValueError('请选择经验适用范围')
    if value.get('kind') == 'profile':
        return {'kind': 'profile'}
    platform, account = value.get('platform'), value.get('accountId')
    if value.get('kind') != 'account' or not isinstance(platform, str) or not re.fullmatch(r'[a-z0-9-]{1,60}', platform):
        raise ValueError('平台范围无效')
    if not isinstance(account, str) or not account.strip() or len(account) > 160 or any(ord(c) < 32 for c in account):
        raise ValueError('请提供稳定账号ID，不能用显示昵称代替')
    return {'kind': 'account', 'platform': platform, 'accountId': account.strip()}


def text_value(value):
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= 12000:
        raise ValueError('经验正文须为1至12000字')
    if re.search(r'(?i)(?:api[_-]?key|authorization|cookie|password)\s*[:=]\s*\S{6,}', value):
        raise ValueError('请移除凭据、Cookie或密码后再保存')
    return value.strip()


def project_after(method):
    @wraps(method)
    def mutation(self, name, *args, **kwargs):
        result = method(self, name, *args, **kwargs)
        try:
            self._sync_projection(name)
        except OSError:
            pass  # DB revision remains ahead; state/context report failure and retry.
        return result
    return mutation


class MemoryStore:
    def __init__(self, root: Path, profiles: Path | None = None, source_resolver=None):
        self.root = Path(root).resolve()
        self.profiles = Path(profiles) if profiles is not None else self.root / 'profiles'
        if linked(self.profiles) or self.profiles.resolve().parent != self.root:
            raise ValueError('画像根目录路径无效')
        directory = self.root / 'memory'
        if linked(directory) or directory.resolve().parent != self.root:
            raise ValueError('记忆目录路径无效')
        directory.mkdir(parents=True, exist_ok=True)
        self.path = directory / 'profile-memory.sqlite3'
        if self.path.is_symlink():
            raise ValueError('记忆数据库路径无效')
        from easel.memory_sources import analysis_source
        self.resolve_source = source_resolver or (lambda binding: analysis_source(self.root / 'outputs', binding))
        with self.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,revision INTEGER NOT NULL DEFAULT 0,managed INTEGER NOT NULL DEFAULT 0,projected_hash TEXT,projected_revision INTEGER NOT NULL DEFAULT -1);
                CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,dedupe TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(profile_id,dedupe));
                CREATE TABLE IF NOT EXISTS revisions(entry_id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(entry_id,revision));
                CREATE TABLE IF NOT EXISTS legacy(profile_id TEXT PRIMARY KEY,hash TEXT NOT NULL,text TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS uses(profile_id TEXT NOT NULL,session_id TEXT NOT NULL,turn_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(profile_id,session_id,turn_id));
                CREATE TABLE IF NOT EXISTS tombstones(profile_id TEXT NOT NULL,dedupe TEXT NOT NULL,PRIMARY KEY(profile_id,dedupe));
            ''')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA secure_delete=ON')
        try:
            with db:
                yield db
        finally:
            db.close()

    def directory(self, name):
        from easel.persona import valid_persona_name
        if not valid_persona_name(name):
            raise LookupError('画像不存在')
        path = self.profiles / name
        if linked(path) or path.resolve().parent != self.profiles.resolve() or not path.is_dir():
            raise LookupError('画像不存在或路径无效')
        for filename in ('memory.md',):
            if (path / filename).is_symlink():
                raise ValueError('经验文件不能是符号链接')
        return path

    def _profile(self, db, name):
        self.directory(name)
        db.execute('INSERT OR IGNORE INTO profiles(id,name) VALUES(?,?)', (uuid.uuid4().hex, name))
        return dict(db.execute('SELECT * FROM profiles WHERE name=?', (name,)).fetchone())

    def _entry(self, db, profile, entry_id):
        row = db.execute('SELECT data FROM entries WHERE id=? AND profile_id=?', (entry_id, profile['id'])).fetchone()
        if not row:
            raise LookupError('经验条目不存在')
        return json.loads(row[0])

    def _save(self, db, entry):
        raw = json.dumps(entry, ensure_ascii=False)
        db.execute('UPDATE entries SET data=? WHERE id=?', (raw, entry['id']))
        db.execute('INSERT INTO revisions VALUES(?,?,?)', (entry['id'], entry['revision'], raw))
        db.execute('UPDATE profiles SET revision=revision+1 WHERE id=?', (entry['profileId'],))

    def _source(self, source, text, selected_scope):
        kind = source.get('type', 'manual') if isinstance(source, dict) else 'manual'
        if kind == 'analysis':
            if not self.resolve_source:
                raise ValueError('分析来源服务不可用')
            resolved = self.resolve_source(source.get('bindingId'))
            if text not in resolved.pop('markdown'):
                raise ValueError('请选择已保存分析结果中的原文结论')
            if selected_scope != scope({'kind': 'account', 'platform': resolved['platform'], 'accountId': resolved['accountId']}):
                raise ValueError('分析候选必须绑定原平台账号')
            return resolved
        if kind != 'manual':
            raise ValueError('来源类型无效')
        return {'type': 'manual', 'sourceHash': digest(text), 'capturedAt': None}

    def source_status(self, entry):
        source = entry['source']
        if source['type'] != 'analysis':
            return 'available'
        try:
            if not self.resolve_source:
                return 'unavailable'
            current = self.resolve_source(source['bindingId'])
            return 'available' if current['sourceHash'] == source['sourceHash'] else 'changed'
        except LookupError:
            return 'missing'
        except ValueError:
            return 'changed'
        except (OSError, sqlite3.Error):
            return 'unavailable'

    def _insert(self, db, profile, text, selected_scope, source, quality='hypothesis'):
        key = digest([text, selected_scope, source.get('sourceHash')])
        if db.execute('SELECT 1 FROM tombstones WHERE profile_id=? AND dedupe=?', (profile['id'], key)).fetchone():
            raise Conflict('该候选已永久删除；相同来源的晚到提案不会重新创建')
        old = db.execute('SELECT data FROM entries WHERE profile_id=? AND dedupe=?', (profile['id'], key)).fetchone()
        if old:
            return json.loads(old[0])  # Rejection cannot be resurrected by a late task.
        entry = {'id': uuid.uuid4().hex, 'profileId': profile['id'], 'text': text,
                 'scope': selected_scope, 'scopeHash': digest(selected_scope), 'contentHash': digest(text),
                 'source': source, 'quality': quality, 'status': 'pending', 'revision': 1,
                 'createdAt': now(), 'updatedAt': now(), 'confirmedAt': None, 'reviewAfter': None}
        db.execute('INSERT INTO entries VALUES(?,?,?,?)', (entry['id'], profile['id'], key, json.dumps(entry, ensure_ascii=False)))
        self._save(db, entry)
        return entry

    @project_after
    def propose(self, name, data):
        text, selected_scope = text_value(data.get('text')), scope(data.get('scope'))
        source = self._source(data.get('source'), text, selected_scope)
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            profile = self._profile(db, name)
            return self._insert(db, profile, text, selected_scope, source)

    def _projection(self, profile, entries):
        rows = [f'# 经验沉淀\n\n<!-- Easel managed profile={profile["id"]} revision={profile["revision"]}; edit through the memory service -->',
                '以下仅为当前画像的跨平台参考经验；账号经验须按平台与账号从服务读取。']
        for entry in entries:
            if entry['status'] == 'active' and entry['scope']['kind'] == 'profile':
                rows.append(f'## {entry["id"]} · v{entry["revision"]} · {entry["quality"]}\n\n{entry["text"]}')
        return '\n\n'.join(rows) + '\n'

    def _sync_projection(self, name):
        # Serialize file replacement with DB mutations across processes. A newer
        # revision can never be replaced by an older projection writer.
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            profile = self._profile(db, name)
            if not profile['managed']:
                return None
            path = self.directory(name) / 'memory.md'
            actual = path.read_text(encoding='utf-8') if path.exists() else ''
            if profile['projected_hash'] is not None and digest(actual) != profile['projected_hash']:
                return '外部修改了memory.md；已暂停经验注入，请先对照处理。'
            entries = [json.loads(row[0]) for row in db.execute('SELECT data FROM entries WHERE profile_id=? ORDER BY rowid', (profile['id'],))]
            content = self._projection(profile, entries)
            if actual != content:
                temporary = None
                try:
                    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as stream:
                        temporary = Path(stream.name)
                        stream.write(content)
                    temporary.replace(path)
                finally:
                    if temporary and temporary.exists():
                        temporary.unlink()
            db.execute('UPDATE profiles SET projected_hash=?,projected_revision=? WHERE id=?', (digest(content), profile['revision'], profile['id']))
        return None

    def state(self, name):
        warning = None
        try:
            warning = self._sync_projection(name)
        except OSError:
            warning = '经验已保存在数据库，但兼容文件写入失败；修复写入权限后刷新重试。'
        with self.connect() as db:
            profile = self._profile(db, name)
            entries = [json.loads(row[0]) for row in db.execute('SELECT data FROM entries WHERE profile_id=? ORDER BY rowid DESC', (profile['id'],))]
        for entry in entries:
            entry['sourceStatus'] = self.source_status(entry)
            entry['needsReview'] = entry['sourceStatus'] != 'available' or bool(entry['reviewAfter'] and entry['reviewAfter'] < now()[:10])
        path = self.directory(name) / 'memory.md'
        legacy = path.read_text(encoding='utf-8') if not profile['managed'] and path.exists() else ''
        return {'profileId': profile['id'], 'name': name, 'revision': profile['revision'], 'managed': bool(profile['managed']),
                'entries': entries, 'legacy': {'text': legacy, 'hash': digest(legacy)} if not profile['managed'] else None,
                'projectionReady': not warning, 'warning': warning}

    @project_after
    def import_legacy(self, name, data):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            profile = self._profile(db, name)
            if profile['managed']:
                return
            selected_scope = scope(data.get('scope'))
            path = self.directory(name) / 'memory.md'
            text = path.read_text(encoding='utf-8') if path.exists() else ''
            if data.get('hash') != digest(text) or data.get('profileRevision') != profile['revision']:
                raise Conflict('旧资料或画像版本已改变，请刷新导入预览')
            if len(text) > 12000:
                raise ValueError('旧资料超过12000字，请先备份并拆分整理后导入')
            if text.strip():
                text_value(text)
            db.execute('INSERT INTO legacy VALUES(?,?,?)', (profile['id'], digest(text), text))
            if text.strip():
                self._insert(db, profile, text.strip(), selected_scope, {'type': 'legacy', 'sourceHash': digest(text), 'capturedAt': None}, 'legacy-unverified')
            db.execute('UPDATE profiles SET managed=1,revision=revision+1,projected_hash=? WHERE id=?', (digest(text), profile['id']))

    @project_after
    def change(self, name, entry_id, action, data):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            profile = self._profile(db, name)
            entry = self._entry(db, profile, entry_id)
            if action == 'accept' and entry['status'] == 'active' and entry.get('acceptedFrom') == data.get('revision') and entry['contentHash'] == data.get('contentHash') and entry['scopeHash'] == data.get('scopeHash'):
                return entry
            if entry['revision'] != data.get('revision') or profile['revision'] != data.get('profileRevision'):
                raise Conflict('经验版本已改变；你的草稿保留，请刷新后对照')
            if action == 'delete':
                key = db.execute('SELECT dedupe FROM entries WHERE id=?', (entry_id,)).fetchone()[0]
                db.execute('INSERT OR IGNORE INTO tombstones VALUES(?,?)', (profile['id'], key))
                for row in db.execute('SELECT data FROM revisions WHERE entry_id=?', (entry_id,)).fetchall():
                    version = json.loads(row[0])
                    source_hash = digest(version['text']) if version['source']['type'] == 'manual' else version['source'].get('sourceHash')
                    db.execute('INSERT OR IGNORE INTO tombstones VALUES(?,?)', (profile['id'], digest([version['text'], version['scope'], source_hash])))
                db.execute('DELETE FROM revisions WHERE entry_id=?', (entry_id,))
                db.execute('DELETE FROM entries WHERE id=?', (entry_id,))
                if entry['source']['type'] == 'legacy':
                    db.execute('DELETE FROM legacy WHERE profile_id=?', (profile['id'],))
                db.execute('UPDATE profiles SET revision=revision+1 WHERE id=?', (profile['id'],))
                return None
            if action in ('accept', 'restore'):
                allowed = 'pending' if action == 'accept' else 'invalidated'
                if not profile['managed'] or entry['status'] != allowed:
                    raise Conflict('请先导入旧资料；只能确认待处理候选或恢复失效条目')
                if entry['contentHash'] != data.get('contentHash') or entry['scopeHash'] != data.get('scopeHash'):
                    raise Conflict('确认内容或适用范围已改变')
                if self.source_status(entry) != 'available':
                    raise Conflict('来源已更改或缺失，请重新提取候选')
                entry.update(status='active', confirmedAt=now(), acceptedFrom=entry['revision'])
            elif action == 'reject' and entry['status'] == 'pending':
                entry['status'] = 'rejected'
            elif action == 'invalidate' and entry['status'] == 'active':
                entry['status'] = 'invalidated'
            elif action == 'edit' and entry['status'] in ('pending', 'active', 'invalidated'):
                entry['text'] = text_value(data.get('text'))
                entry['contentHash'] = digest(entry['text'])
                entry['acceptedFrom'] = None
                entry['userEdited'] = True
                entry['quality'] = 'hypothesis' if entry['source']['type'] == 'analysis' else entry['quality']
                review = data.get('reviewAfter')
                if review is not None:
                    try:
                        datetime.strptime(review, '%Y-%m-%d')
                    except (ValueError, TypeError):
                        raise ValueError('复查日期无效') from None
                entry['reviewAfter'] = review
            else:
                raise ValueError('当前状态不能执行该操作')
            entry.update(revision=entry['revision'] + 1, updatedAt=now())
            self._save(db, entry)
            return entry

    def history(self, name, entry_id):
        with self.connect() as db:
            self._entry(db, self._profile(db, name), entry_id)
            return [json.loads(row[0]) for row in db.execute('SELECT data FROM revisions WHERE entry_id=? ORDER BY revision DESC', (entry_id,))]

    def legacy_snapshot(self, name):
        with self.connect() as db:
            profile = self._profile(db, name)
            row = db.execute('SELECT hash,text FROM legacy WHERE profile_id=?', (profile['id'],)).fetchone()
            return dict(row) if row else None

    def record_use(self, name, session_id, turn_id, context):
        with self.connect() as db:
            profile = self._profile(db, name)
            value = {'turnId': turn_id, 'profileId': profile['id'], 'profileRevision': context['revision'],
                     'at': now(), 'entries': [{'id': row['id'], 'revision': row['revision']} for row in context['entries']]}
            # Retries keep the original turn binding, never rewrite history.
            db.execute('INSERT OR IGNORE INTO uses VALUES(?,?,?,?)', (profile['id'], session_id, turn_id, json.dumps(value)))
            saved = json.loads(db.execute('SELECT data FROM uses WHERE profile_id=? AND session_id=? AND turn_id=?', (profile['id'], session_id, turn_id)).fetchone()[0])
            return saved['entries'] == value['entries']

    def usage(self, name, session_id):
        with self.connect() as db:
            profile = self._profile(db, name)
            return [json.loads(row[0]) for row in db.execute('SELECT data FROM uses WHERE profile_id=? AND session_id=? ORDER BY rowid DESC LIMIT 20', (profile['id'], session_id))]

    @project_after
    def reconcile(self, name, data):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            profile = self._profile(db, name)
            if not profile['managed'] or profile['revision'] != data.get('profileRevision'):
                raise Conflict('画像版本已改变，请刷新')
            path = self.directory(name) / 'memory.md'
            text = path.read_text(encoding='utf-8') if path.exists() else ''
            if digest(text) != data.get('hash'):
                raise Conflict('外部文件已改变，请重新预览')
            if text.strip():
                self._insert(db, profile, text_value(text), {'kind': 'profile'}, {'type': 'file-change', 'sourceHash': digest(text), 'capturedAt': None}, 'legacy-unverified')
            db.execute('UPDATE profiles SET projected_hash=? WHERE id=?', (digest(text), profile['id']))

    def context(self, name, query='', platform=None, account_id=None, budget=5000):
        state = self.state(name)
        if not state['managed'] or not state['projectionReady']:
            return {'entries': [], 'profileId': state['profileId'], 'revision': state['revision'], 'warning': state['warning']}
        words = terms(query)
        rows = []
        for entry in state['entries']:
            selected = entry['scope']
            if entry['status'] != 'active' or entry['sourceStatus'] != 'available':
                continue
            if selected['kind'] == 'account' and (selected['platform'] != platform or selected['accountId'] != account_id):
                continue
            score = len(words & terms(entry['text']))
            if query.strip() and not score:
                continue
            rows.append((score, entry))
        rows.sort(key=lambda item: (-item[0], item[1]['id']))
        selected, remaining = [], min(max(budget, 0), 12000)
        for _, entry in rows[:8]:
            if len(entry['text']) > remaining:
                continue
            selected.append(entry)
            remaining -= len(entry['text'])
        return {'entries': selected, 'profileId': state['profileId'], 'revision': state['revision'], 'warning': None}

    def purge_profile(self, name):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            profile = self._profile(db, name)
            db.execute('DELETE FROM revisions WHERE entry_id IN (SELECT id FROM entries WHERE profile_id=?)', (profile['id'],))
            db.execute('DELETE FROM entries WHERE profile_id=?', (profile['id'],))
            db.execute('DELETE FROM legacy WHERE profile_id=?', (profile['id'],))
            db.execute('DELETE FROM uses WHERE profile_id=?', (profile['id'],))
            db.execute('DELETE FROM tombstones WHERE profile_id=?', (profile['id'],))
            db.execute('DELETE FROM profiles WHERE id=?', (profile['id'],))
