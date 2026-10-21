"""Versioned assistant-prepared publishing drafts; never submits a publication."""
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import time
import uuid

from .artifacts import file_path, scope

PLATFORMS = {'xiaohongshu', 'douyin', 'kuaishou', 'weixin-channels', 'zhihu', 'bilibili', 'wechat-oa'}
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
            with db:
                yield db
        finally:
            db.close()

    def prepare(self, session, turn, payload):
        scope(session); scope(turn)
        if not isinstance(payload, dict) or set(payload) - {'requestId', 'title', 'body', 'tags', 'platforms', 'media'}:
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
            if not path.is_file() or path.suffix.lower() not in {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.mov', '.webm', '.mkv'}:
                raise ValueError('素材必须是已有的本机图片或视频')
            if relative not in draft['media']:
                draft['media'].append(relative)
        fingerprint = hashlib.sha256(json.dumps(draft, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            old = db.execute('SELECT * FROM drafts WHERE session=? AND request=?', (session, request)).fetchone()
            if old:
                if old['fingerprint'] != fingerprint:
                    raise ValueError('同一 requestId 已用于其他内容，请核对已有草稿')
                return json.loads(old['data'])
            value = {'id': uuid.uuid4().hex, 'sessionId': session, 'turnId': turn, 'requestId': request,
                     'createdAt': time.time(), 'state': 'prepared', 'draft': draft}
            db.execute('INSERT INTO drafts VALUES(?,?,?,?,?,?,?)',
                       (value['id'], session, turn, request, fingerprint, value['createdAt'], json.dumps(value, ensure_ascii=False)))
        return value

    def list(self, session):
        scope(session)
        with self.db() as db:
            return [json.loads(row['data']) for row in db.execute('SELECT data FROM drafts WHERE session=? ORDER BY created DESC LIMIT 30', (session,))]
