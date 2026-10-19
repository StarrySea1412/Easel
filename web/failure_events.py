"""Bounded local failure receipts. Never collect bodies, credentials or error text."""
from __future__ import annotations

import asyncio
from contextvars import ContextVar
from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path
import re
import threading
import time
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict, Field, model_validator
from starlette.responses import JSONResponse

from easel.version import runtime_version

HEADER = 'X-Easel-Failure-Id'
MAX_BYTES = 512 * 1024
BACKUPS = 3
_context: ContextVar[dict | None] = ContextVar('easel_failure_context', default=None)
_TOKEN = re.compile(r'[A-Za-z0-9_.+-]{1,128}\Z')
_FIELDS = {'operation', 'stage', 'code', 'owner', 'slug', 'skillVersion',
           'upstreamStatus', 'upstreamType', 'exceptionType', 'relatedEventId', 'locations', 'platform', 'receiptId'}


def annotate(**values):
    context = _context.get()
    if context is not None:
        context.update({key: value for key, value in values.items() if key in _FIELDS})


def _safe(values):
    result = {}
    for key in _FIELDS:
        value = values.get(key)
        if key == 'locations' and isinstance(value, list):
            result[key] = [entry for entry in value[:5] if isinstance(entry, str)
                           and re.fullmatch(r'(?:web|easel|deployment)/[A-Za-z0-9_./-]+:[0-9]{1,7}', entry)]
        elif key == 'upstreamStatus':
            if type(value) is int and 100 <= value <= 599:
                result[key] = value
        elif key == 'upstreamType' and isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+', value):
            result[key] = value[:128]
        elif isinstance(value, str) and _TOKEN.fullmatch(value):
            result[key] = value
    return result


class FailureEvents:
    def __init__(self, data: Path, root: Path | None = None):
        self.directory = data / 'logs'
        self.path = self.directory / 'failure-events.jsonl'
        self.runtime = runtime_version(root)
        self.root = (root or Path(__file__).resolve().parents[1]).resolve()
        self.lock = threading.Lock()
        self.client_window = (0.0, 0)

    def record(self, *, source, route, method, status, duration, context):
        event_id = uuid4().hex
        event = {'id': event_id, 'at': datetime.now(timezone.utc).isoformat(),
                 'source': source, 'route': route, 'method': method, 'status': status,
                 'durationMs': max(0, min(round(duration), 86_400_000)),
                 **self.runtime, **_safe(context)}
        line = json.dumps(event, ensure_ascii=False, separators=(',', ':')).encode() + b'\n'
        try:
            with self.lock:
                self.directory.mkdir(parents=True, exist_ok=True)
                if self.path.exists() and self.path.stat().st_size + len(line) > MAX_BYTES:
                    for index in range(BACKUPS, 0, -1):
                        previous = self.path if index == 1 else self.path.with_suffix(f'.jsonl.{index - 1}')
                        if previous.exists():
                            previous.replace(self.path.with_suffix(f'.jsonl.{index}'))
                descriptor = os.open(self.path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
                with os.fdopen(descriptor, 'ab') as output:
                    output.write(line)
            return event_id
        except OSError:
            # No original exception text: it can contain credentials or private paths.
            logging.getLogger(__name__).warning('failure_event_write_failed id=%s', event_id)
            return None

    def recent(self, limit=50, event_id=None):
        result = []
        with self.lock:
            for path in [self.path] + [self.path.with_suffix(f'.jsonl.{i}') for i in range(1, BACKUPS + 1)]:
                try:
                    lines = path.read_bytes()[-MAX_BYTES:].splitlines()
                except FileNotFoundError:
                    continue
                for line in reversed(lines):
                    try:
                        item = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(item, dict) and (event_id is None or item.get('id') == event_id):
                        result.append(item)
                        if len(result) >= limit:
                            return result
        return result

    def admit_client(self):
        with self.lock:
            start, count = self.client_window
            if time.monotonic() - start >= 60:
                start, count = time.monotonic(), 0
            self.client_window = start, count + 1
            return count < 60

    def locations(self, exception):
        locations, frame = [], exception.__traceback__
        while frame is not None:
            try:
                filename = Path(frame.tb_frame.f_code.co_filename).resolve().relative_to(self.root).as_posix()
                if filename.split('/')[0] in {'web', 'easel', 'deployment'}:
                    locations.append(f'{filename}:{frame.tb_lineno}')
            except (OSError, ValueError):
                pass
            frame = frame.tb_next
        return locations[-5:]


class FailureEventMiddleware:
    def __init__(self, app, events: FailureEvents):
        self.app, self.events = app, events

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or not scope.get('path', '').startswith('/api/'):
            return await self.app(scope, receive, send)
        context = {}
        token = _context.set(context)
        started, sent, recorded = time.monotonic(), False, False

        async def receipt(status):
            nonlocal recorded
            recorded = True
            route = getattr(scope.get('route'), 'path', 'unmatched_api')
            return await asyncio.to_thread(self.events.record, source='server', route=route,
                method=scope['method'], status=status, duration=(time.monotonic() - started) * 1000,
                context={'code': f'http_{status}', **context})

        async def capture(message):
            nonlocal sent
            if message['type'] == 'http.response.start':
                sent = True
                if message['status'] >= 400:
                    event_id = await receipt(message['status'])
                    if event_id:
                        message = {**message, 'headers': [*message.get('headers', []),
                                   (HEADER.lower().encode(), event_id.encode())]}
            await send(message)

        try:
            await self.app(scope, receive, capture)
        except Exception as exc:
            annotate(code='unhandled_exception', exceptionType=type(exc).__name__, locations=self.events.locations(exc))
            event_id = None if recorded else await receipt(500)
            if sent:
                raise  # A started stream cannot be replaced with a JSON error.
            await JSONResponse({'detail': '服务暂时无法完成请求，请重试。'}, status_code=500,
                headers={HEADER: event_id} if event_id else {})(scope, receive, send)
        finally:
            _context.reset(token)


class ClientFailure(BaseModel):
    model_config = ConfigDict(extra='forbid')
    operation: Literal['clawhub_import', 'publish']
    stage: Literal['detail', 'import', 'catalog_refresh', 'catalog_verify', 'preflight', 'identity', 'submit', 'receipt']
    code: Literal['network', 'http_error', 'catalog_missing', 'unknown', 'login_required', 'media_required',
                  'video_required', 'identity_unverified', 'identity_changed', 'server_busy',
                  'receipt_missing', 'publish_failed', 'already_active']
    status: int | None = Field(default=None, ge=400, le=599)
    durationMs: int = Field(default=0, ge=0, le=86_400_000)
    owner: str | None = Field(default=None, pattern=r'^[a-z0-9][a-z0-9_.-]{0,99}$')
    slug: str | None = Field(default=None, pattern=r'^[a-z0-9][a-z0-9-]{0,95}$')
    skillVersion: str | None = Field(default=None, max_length=128, pattern=r'^[A-Za-z0-9][A-Za-z0-9._+-]*$')
    relatedEventId: str | None = Field(default=None, pattern=r'^[0-9a-f]{32}$')
    platform: Literal['xiaohongshu', 'douyin', 'kuaishou', 'weixin-channels', 'zhihu', 'bilibili', 'wechat-oa'] | None = None
    receiptId: str | None = Field(default=None, pattern=r'^[0-9a-f]{32}$')

    @model_validator(mode='after')
    def operation_fields(self):
        if self.operation == 'clawhub_import':
            if not self.slug or self.platform or self.receiptId or self.stage not in {'detail', 'import', 'catalog_refresh', 'catalog_verify'}:
                raise ValueError('ClawHub callback fields do not match the operation')
        elif (not self.platform or self.slug or self.owner or self.skillVersion
              or self.stage not in {'preflight', 'identity', 'submit', 'receipt'}):
            raise ValueError('Publish callback fields do not match the operation')
        return self


def create_router(events: FailureEvents):
    router = APIRouter()

    @router.get('/api/diagnostics/failures')
    async def recent(response: Response, limit: int = Query(default=50, ge=1, le=100),
                     eventId: str | None = Query(default=None, pattern=r'^[0-9a-f]{32}$')):
        response.headers['Cache-Control'] = 'no-store'
        try:
            return {'events': await asyncio.to_thread(events.recent, limit, eventId)}
        except OSError:
            raise HTTPException(503, '失败记录暂时无法读取') from None

    @router.post('/api/diagnostics/failures', status_code=201)
    async def report(body: ClientFailure):
        if not events.admit_client():
            raise HTTPException(429, '失败上报较多，请稍后重试', headers={'Retry-After': '60'})
        values = body.model_dump(exclude_none=True)
        event_id = await asyncio.to_thread(events.record, source='browser',
            route='clawhub_import_selection' if body.operation == 'clawhub_import' else 'publish_ui',
            method='CLIENT', status=body.status,
            duration=body.durationMs, context=values)
        if not event_id:
            raise HTTPException(503, '失败记录未能保存')
        return {'eventId': event_id}

    return router
