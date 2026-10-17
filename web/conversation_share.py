"""对话分享：完整快照 + 外部接管追加（回传）。

分享落盘在 `<data>/conversation-shares/<token>.json`（本体）与
`<token>.appends.jsonl`（接管方追加，逐条带来源与时间）。模块只读写该目录：
不触达会话库、网关状态、密钥或任何模型服务；token 为不可猜测随机串。
"""
from __future__ import annotations

import json
import re
import secrets
import threading
import time
import unicodedata
from pathlib import Path

from fastapi import APIRouter, HTTPException

MAX_MESSAGES = 2000
MAX_MESSAGE_CHARS = 100_000
MAX_TOTAL_CHARS = 4_000_000
MAX_APPENDS = 500
MAX_APPEND_MESSAGES = 200
MAX_TITLE_CHARS = 200
MAX_SOURCE_CHARS = 120
MAX_NOTE_CHARS = 2000
TOKEN = re.compile(r'[A-Za-z0-9_-]{20,64}\Z')
ROLES = {'user', 'assistant', 'system'}


def _text(value, limit: int, *, required: bool = False) -> str:
    if value is None:
        return '' if not required else (_ for _ in ()).throw(HTTPException(400, '缺少必填文本'))
    if not isinstance(value, str):
        raise HTTPException(400, '字段必须是文本')
    cleaned = ''.join(char for char in value if char in '\n\t' or not unicodedata.category(char).startswith('C'))
    if required and not cleaned.strip():
        raise HTTPException(400, '必填文本不能为空')
    return cleaned[:limit]


def _number(value, *, default=None):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else default


def _message(raw, *, allow_meta: bool) -> dict:
    if not isinstance(raw, dict):
        raise HTTPException(400, '消息必须是对象')
    role = raw.get('role')
    if role not in ROLES:
        raise HTTPException(400, '消息角色必须是 user/assistant/system')
    message = {'role': role, 'content': _text(raw.get('content'), MAX_MESSAGE_CHARS)}
    if allow_meta:
        at = _number(raw.get('at'))
        if at is not None:
            message['at'] = at
        for key in ('modelRef', 'turnId', 'name'):
            value = _text(raw.get(key), 200)
            if value:
                message[key] = value
    return message


def _messages(raw) -> list[dict]:
    if not isinstance(raw, list) or not raw:
        raise HTTPException(400, 'messages 必须是非空数组')
    if len(raw) > MAX_MESSAGES:
        raise HTTPException(400, f'最多分享 {MAX_MESSAGES} 条消息')
    messages = [_message(item, allow_meta=True) for item in raw]
    total = sum(len(item['content']) for item in messages)
    if total > MAX_TOTAL_CHARS:
        raise HTTPException(400, '分享内容过大，请精简后重试')
    return messages


def _clean_token(token: str) -> str:
    if not isinstance(token, str) or not TOKEN.fullmatch(token):
        raise HTTPException(400, '分享标识无效')
    return token


class ConversationShareStore:
    def __init__(self, root: Path):
        self.root = Path(root)
        self._lock = threading.Lock()

    # ---- 内部读写 ----
    def _share_path(self, token: str) -> Path:
        return self.root / f'{token}.json'

    def _appends_path(self, token: str) -> Path:
        return self.root / f'{token}.appends.jsonl'

    def _load(self, token: str) -> dict:
        path = self._share_path(token)
        if not path.is_file():
            raise HTTPException(404, '分享不存在或已删除')
        try:
            value = json.loads(path.read_text(encoding='utf-8'))
        except (ValueError, UnicodeDecodeError):
            raise HTTPException(500, '分享数据无法读取') from None
        if not isinstance(value, dict):
            raise HTTPException(500, '分享数据格式无效')
        return value

    def _appends(self, token: str) -> list[dict]:
        path = self._appends_path(token)
        if not path.is_file():
            return []
        entries = []
        for line in path.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except ValueError:
                continue
            if isinstance(item, dict) and item.get('appendId'):
                entries.append(item)
        return entries

    # ---- 对外操作 ----
    def create(self, payload) -> dict:
        if not isinstance(payload, dict):
            raise HTTPException(400, '请求体必须是对象')
        title = _text(payload.get('title'), MAX_TITLE_CHARS) or '未命名对话'
        session_id = _text(payload.get('sessionId'), 200, required=True)
        messages = _messages(payload.get('messages'))
        meta = payload.get('meta') if isinstance(payload.get('meta'), dict) else {}
        share = {
            'version': 1,
            'token': secrets.token_urlsafe(24),
            'title': title,
            'sessionId': session_id,
            'createdAt': time.time(),
            'meta': {
                'modelRef': _text(meta.get('modelRef'), 200),
                'engine': _text(meta.get('engine'), 40),
            },
            'messageCount': len(messages),
            'messages': messages,
        }
        with self._lock:
            self.root.mkdir(parents=True, exist_ok=True)
            self._share_path(share['token']).write_text(json.dumps(share, ensure_ascii=False, indent=1), encoding='utf-8')
        return {'token': share['token'], 'title': title, 'createdAt': share['createdAt'], 'messageCount': share['messageCount']}

    def read(self, token: str, after_index: int = 0) -> dict:
        token = _clean_token(token)
        if not isinstance(after_index, int) or after_index < 0:
            raise HTTPException(400, 'after 必须是非负整数')
        with self._lock:
            share = self._load(token)
            appends = self._appends(token)
        return {**share, 'appends': appends[after_index:], 'appendCount': len(appends)}

    def append(self, token: str, payload) -> dict:
        token = _clean_token(token)
        if not isinstance(payload, dict):
            raise HTTPException(400, '请求体必须是对象')
        source = payload.get('source') if isinstance(payload.get('source'), dict) else {}
        entry = {
            'appendId': secrets.token_urlsafe(12),
            'at': time.time(),
            'source': {
                'model': _text(source.get('model'), MAX_SOURCE_CHARS),
                'harness': _text(source.get('harness'), MAX_SOURCE_CHARS),
            },
            'note': _text(payload.get('note'), MAX_NOTE_CHARS),
            'messages': [_message(item, allow_meta=False) for item in (payload.get('messages') or [])][:MAX_APPEND_MESSAGES],
        }
        if not entry['messages']:
            raise HTTPException(400, 'append 必须携带至少一条消息')
        with self._lock:
            share = self._load(token)
            appends = self._appends(token)
            if len(appends) >= MAX_APPENDS:
                raise HTTPException(400, f'该分享的追加记录已达上限（{MAX_APPENDS} 条）')
            self.root.mkdir(parents=True, exist_ok=True)
            with self._appends_path(token).open('a', encoding='utf-8') as handle:
                handle.write(json.dumps(entry, ensure_ascii=False) + '\n')
        return {'token': token, 'appendId': entry['appendId'], 'at': entry['at'], 'total': len(appends) + 1, 'title': share['title']}

    def list(self, limit: int = 20) -> list[dict]:
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise HTTPException(400, 'limit 必须是 1–100 的整数')
        with self._lock:
            if not self.root.is_dir():
                return []
            items = []
            for path in self.root.glob('*.json'):
                if not TOKEN.fullmatch(path.stem):
                    continue
                try:
                    share = json.loads(path.read_text(encoding='utf-8'))
                except (ValueError, UnicodeDecodeError):
                    continue
                if not isinstance(share, dict) or not share.get('token'):
                    continue
                items.append({
                    'token': share['token'],
                    'title': share.get('title') or '未命名对话',
                    'sessionId': share.get('sessionId') or '',
                    'createdAt': _number(share.get('createdAt'), default=0),
                    'messageCount': _number(share.get('messageCount'), default=0),
                    'appendCount': len(self._appends(path.stem)),
                })
        items.sort(key=lambda item: item['createdAt'], reverse=True)
        return items[:limit]


def create_router(store: ConversationShareStore) -> APIRouter:
    router = APIRouter()

    @router.post('/api/conversation-shares')
    async def create(payload: dict):
        return store.create(payload)

    @router.get('/api/conversation-shares')
    async def list_shares(limit: int = 20):
        return {'shares': store.list(limit)}

    @router.get('/api/conversation-shares/{token}')
    async def read(token: str, after: int = 0):
        return store.read(token, after)

    @router.post('/api/conversation-shares/{token}/appends')
    async def append(token: str, payload: dict):
        return store.append(token, payload)

    return router
