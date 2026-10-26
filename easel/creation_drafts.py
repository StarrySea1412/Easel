"""Versioned assistant-prepared publishing drafts; never submits a publication."""
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import time
import uuid
import os
import tempfile

from .artifacts import file_path, scope

PLATFORMS = {'xiaohongshu', 'douyin', 'kuaishou', 'weixin-channels', 'zhihu', 'bilibili', 'wechat-oa'}
MEDIA_EXTS = {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.mov', '.webm', '.mkv'}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def media_hash(path, destination=None):
    before = path.stat()
    result = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            result.update(block)
            if destination is not None:
                destination.write(block)
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError('素材正在变化，请保存完成后重试')
    return {'sha256': result.hexdigest(), 'size': after.st_size}
PREPARE_TOOL = {
    'type': 'function', 'name': 'easel_prepare_publish',
    'description': 'Prepare an editable publishing draft in this chat auxiliary panel. Never publishes, schedules or checks accounts. User reviews the draft and confirms through the publishing UI. Reuse the same requestId for retries; local media must already exist.',
    'inputSchema': {'type': 'object', 'additionalProperties': False, 'required': ['requestId', 'body'],
        'properties': {
            'requestId': {'type': 'string', 'pattern': '^[A-Za-z0-9_.-]{1,120}$'},
            'title': {'type': 'string', 'maxLength': 200},
            'body': {'type': 'string', 'minLength': 1, 'maxLength': 30000},
            'tags': {'type': 'string', 'maxLength': 1000},
            'platforms': {'type': 'array', 'maxItems': 7, 'items': {'type': 'string', 'enum': sorted(PLATFORMS)}},
            'media': {'type': 'array', 'maxItems': 18, 'items': {'type': 'string', 'maxLength': 4096}},
            'analysisBindingId': {'type': 'string', 'description': 'Optional saved analysis from this session; pins its account, materials and result version.'},
        }}}


class CreationDrafts:
    def __init__(self, outputs):
        self.root = Path(outputs).resolve()
        self.path = self.root / '_artifacts' / 'creation-drafts.sqlite3'

    @contextmanager
    def db(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            db.execute('CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY, session TEXT, turn TEXT, request TEXT, fingerprint TEXT, created REAL, data TEXT, UNIQUE(session, request))')
            db.execute('CREATE TABLE IF NOT EXISTS acceptances(id TEXT PRIMARY KEY, session TEXT, request TEXT, fingerprint TEXT, data TEXT, UNIQUE(session, request))')
            with db:
                yield db
        finally:
            db.close()

    def prepare(self, session, turn, payload):
        scope(session); scope(turn)
        self.require_session(session)
        if not isinstance(payload, dict) or set(payload) - {'requestId', 'title', 'body', 'tags', 'platforms', 'media', 'analysisBindingId'}:
            raise ValueError('发布草稿参数无效')
        request = payload.get('requestId')
        if not isinstance(request, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,120}', request):
            raise ValueError('必须提供固定 requestId')
        draft = {}
        for field, limit in [('title', 200), ('body', 30000), ('tags', 1000)]:
            value = payload.get(field, '')
            if not isinstance(value, str) or len(value) > limit:
                raise ValueError('草稿文本超出限制')
            draft[field] = value.strip()
        if not draft['body']:
            raise ValueError('发布正文不能为空')
        platforms, media = payload.get('platforms', []), payload.get('media', [])
        if not isinstance(platforms, list) or len(platforms) > 7 or any(not isinstance(x, str) or x not in PLATFORMS for x in platforms):
            raise ValueError('发布平台无效')
        if not isinstance(media, list) or len(media) > 18 or any(not isinstance(x, str) or len(x) > 4096 for x in media):
            raise ValueError('媒体列表无效')
        draft.update(platforms=list(dict.fromkeys(platforms)), overrides={}, media=[])
        for value in media:
            path, relative = file_path(self.root, value)
            if not path.is_file() or path.suffix.lower() not in MEDIA_EXTS:
                raise ValueError('素材必须是已有的本机图片或视频')
            if relative not in draft['media']:
                draft['media'].append(relative)
        binding = payload.get('analysisBindingId', '')
        if not isinstance(binding, str) or len(binding) > 200:
            raise ValueError('分析来源标识无效')
        from .writing_handoffs import WritingHandoffs
        writing_source = WritingHandoffs(self.root).analysis(session, binding)
        if writing_source:
            binding = writing_source['bindingId']
        fingerprint = digest(draft) if not binding else digest([draft, binding])
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            old = db.execute('SELECT * FROM drafts WHERE session=? AND request=?', (session, request)).fetchone()
            if old:
                if old['fingerprint'] != fingerprint:
                    raise ValueError('同一 requestId 已用于其他内容，请核对已有草稿')
                return json.loads(old['data'])
            value = {'id': uuid.uuid4().hex, 'sessionId': session, 'turnId': turn, 'requestId': request,
                     'createdAt': time.time(), 'state': 'prepared', 'draft': draft, 'schemaVersion': 2,
                     'mediaVersions': self.media_versions(draft['media']),
                     'analysis': self.analysis(session, binding) if binding else None}
            db.execute('INSERT INTO drafts VALUES(?,?,?,?,?,?,?)',
                       (value['id'], session, turn, request, fingerprint, value['createdAt'], json.dumps(value, ensure_ascii=False)))
        return value

    def require_session(self, session):
        from .task_store import TaskStore
        scope(session)
        TaskStore(self.root).require_session(session)

    def analysis(self, session, binding):
        from .memory_sources import analysis_source
        from .writing_handoffs import WritingHandoffs
        writing_source = WritingHandoffs(self.root).analysis(session, binding)
        source = writing_source or analysis_source(self.root, binding)
        if source['sessionId'] != session and not writing_source:
            raise ValueError('分析来源不属于当前对话')
        self.require_session(source['sessionId'])
        return {key: value for key, value in source.items() if key not in {'markdown', 'limitation'}}

    def media_versions(self, media, *, seal=False):
        versions = []
        directory = self.path.parent / 'publish-media'
        for value in media:
            path, relative = file_path(self.root, value)
            if path.suffix.lower() not in MEDIA_EXTS:
                raise ValueError('素材必须是已有的本机图片或视频')
            if seal:
                directory.mkdir(parents=True, exist_ok=True)
                # Copy and hash the same stream; a publisher reads these fixed bytes.
                fd, name = tempfile.mkstemp(dir=directory, suffix='.tmp')
                temporary = Path(name)
                try:
                    with os.fdopen(fd, 'wb') as handle:
                        version = media_hash(path, handle)
                    target = directory / (version['sha256'] + path.suffix.lower())
                    os.replace(temporary, target)
                finally:
                    temporary.unlink(missing_ok=True)
            else:
                version = media_hash(path)
            versions.append({'path': relative, **version})
        return versions

    def checked(self, session, ident):
        self.require_session(session)
        with self.db() as db:
            row = db.execute('SELECT data FROM drafts WHERE session=? AND id=?', (session, ident)).fetchone()
        if not row:
            raise LookupError('准备草稿不存在')
        item = json.loads(row['data'])
        if item.get('schemaVersion') != 2:
            raise ValueError('旧草稿未固定素材版本，请重新准备')
        if item['mediaVersions'] != self.media_versions(item['draft']['media']):
            raise ValueError('草稿素材已变化，请重新准备')
        if item.get('analysis') and self.analysis(session, item['analysis']['bindingId']) != item['analysis']:
            raise ValueError('原分析已变化，请重新准备')
        return item

    def accept(self, session, ident, request, platform, payload, account_identity=''):
        """Seal an explicitly confirmed, editable draft. Does not publish."""
        self.require_session(session)
        if not isinstance(request, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,120}', request) or not isinstance(platform, str) or platform not in PLATFORMS:
            raise ValueError('确认稿标识或平台无效')
        if not isinstance(payload, dict) or set(payload) - {'title', 'body', 'tags', 'media', 'persona'}:
            raise ValueError('确认稿参数无效')
        normalized = {}
        for field, limit in [('title', 1000), ('body', 100000), ('tags', 2000), ('persona', 200)]:
            value = payload.get(field, '')
            if not isinstance(value, str) or len(value) > limit:
                raise ValueError('确认稿文本超出限制')
            normalized[field] = value
        if not normalized['title'].strip() and not normalized['body'].strip():
            raise ValueError('确认稿不能为空')
        media = payload.get('media', [])
        if not isinstance(media, list) or len(media) > 18 or any(not isinstance(x, str) for x in media):
            raise ValueError('确认稿素材无效')
        normalized['media'] = [file_path(self.root, value)[1] for value in media]
        if not isinstance(account_identity, str) or len(account_identity) > 200:
            raise ValueError('账号版本无效')
        fingerprint = digest([ident, platform, normalized, account_identity])
        with self.db() as db:
            old = db.execute('SELECT fingerprint,data FROM acceptances WHERE session=? AND request=?', (session, request)).fetchone()
            if old:
                if old['fingerprint'] != fingerprint:
                    raise ValueError('本次确认已用于其他内容，请重新确认')
                return json.loads(old['data'])
        original = self.checked(session, ident)
        versions = self.media_versions(normalized['media'], seal=True)
        # File I/O and source reads do not hold a draft database write transaction.
        self.checked(session, ident)
        comparable = {key: original['draft'][key] for key in ('title', 'body', 'tags', 'media')}
        item = {'id': uuid.uuid4().hex, 'sessionId': session, 'preparationId': ident,
                'sourceTurnId': original['turnId'], 'platform': platform, 'createdAt': time.time(),
                'payload': normalized, 'payloadHash': digest(normalized), 'mediaVersions': versions,
                'analysis': original.get('analysis'), 'accountIdentity': account_identity,
                'edited': any(normalized[key] != value for key, value in comparable.items())}
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            old = db.execute('SELECT fingerprint,data FROM acceptances WHERE session=? AND request=?', (session, request)).fetchone()
            if old:
                if old['fingerprint'] != fingerprint:
                    raise ValueError('本次确认已用于其他内容，请重新确认')
                return json.loads(old['data'])
            db.execute('INSERT INTO acceptances VALUES(?,?,?,?,?)', (item['id'], session, request, fingerprint, json.dumps(item, ensure_ascii=False)))
        return item

    def verify_acceptance(self, session, ident, platform, payload, account_identity=''):
        self.require_session(session)
        with self.db() as db:
            row = db.execute('SELECT data FROM acceptances WHERE session=? AND id=?', (session, ident)).fetchone()
        if not row:
            raise LookupError('确认稿不存在，请重新确认')
        item = json.loads(row['data'])
        if item['platform'] != platform or item['payloadHash'] != digest(payload) or item['accountIdentity'] != account_identity:
            raise ValueError('内容、画像或账号已变化，请重新确认')
        self.checked(session, item['preparationId'])
        if item['mediaVersions'] != self.media_versions(payload['media']):
            raise ValueError('确认稿素材已变化，请重新确认')
        sealed = []
        for version in item['mediaVersions']:
            path = self.path.parent / 'publish-media' / (version['sha256'] + Path(version['path']).suffix.lower())
            if media_hash(path) != {key: version[key] for key in ('sha256', 'size')}:
                raise ValueError('确认稿素材副本不可用，请重新确认')
            sealed.append(path)
        provenance = {key: item[key] for key in ('preparationId', 'sourceTurnId', 'payloadHash', 'mediaVersions', 'analysis', 'accountIdentity', 'edited')}
        provenance.update(acceptanceId=item['id'], persona=item['payload']['persona'])
        return provenance, sealed

    def list(self, session):
        scope(session)
        with self.db() as db:
            return [json.loads(row['data']) for row in db.execute('SELECT data FROM drafts WHERE session=? ORDER BY created DESC LIMIT 30', (session,))]
