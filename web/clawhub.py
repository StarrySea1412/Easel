"""Bounded, anonymous reads of the official ClawHub public skill catalog.

Registry descriptions are untrusted display data. This module never installs,
executes, downloads archives, or reads local OpenClaw/ClawHub credentials.
"""
from __future__ import annotations

import asyncio
from collections import OrderedDict
from datetime import datetime, timezone
import json
import math
import re
import time
import unicodedata
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, HTTPException, Response
from web.failure_events import annotate


ORIGIN = 'https://clawhub.ai'
MAX_QUERY_CHARS = 200
MAX_RESULTS = 20
MAX_RESPONSE_BYTES = 1024 * 1024
MAX_DESCRIPTION_CHARS = 20000
CACHE_SECONDS = 60
MAX_CACHE_ENTRIES = 64
REQUEST_SECONDS = 20
_SLUG = re.compile(r'[a-z0-9][a-z0-9-]{0,95}\Z')
_OWNER = re.compile(r'[a-z0-9][a-z0-9_.-]{0,99}\Z')


def _text(value, limit=2000):
    if not isinstance(value, str):
        return ''
    # Keep Markdown as plain text, but remove invalid Unicode/control characters.
    return ''.join(char for char in value[:limit]
                   if char in '\n\t' or not unicodedata.category(char).startswith('C'))


def _number(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if 0 <= value <= 2 ** 53 - 1 and math.isfinite(value):
            return value
    return None


def _identifier(value, pattern):
    return value if isinstance(value, str) and pattern.fullmatch(value) else None


def _owner(row):
    owner = row.get('owner') if isinstance(row.get('owner'), dict) else {}
    return _identifier(row.get('ownerHandle'), _OWNER) or _identifier(owner.get('handle'), _OWNER)


def _canonical(row, owner, slug):
    """Only expose the official skill-page route for the same registry identity."""
    expected = f'/{owner}/skills/{slug}'
    value = row.get('canonicalUrl')
    if isinstance(value, str):
        try:
            parsed = urlsplit(value)
        except ValueError:
            return ORIGIN + expected
        if (parsed.scheme in ('', 'https') and parsed.netloc in ('', 'clawhub.ai')
                and parsed.path == expected and not parsed.query and not parsed.fragment):
            return value if parsed.scheme else ORIGIN + value
    return ORIGIN + expected


_STAT_KEYS = ('downloads', 'stars', 'installs', 'versions', 'comments')


def _stats(stats):
    if not isinstance(stats, dict):
        return None
    return {key: _number(stats.get(key)) for key in _STAT_KEYS}


def _row_stats(row):
    """Search rows keep stats under native.skill; detail rows carry them directly."""
    stats = row.get('stats')
    if not isinstance(stats, dict):
        native = row.get('native')
        skill = native.get('skill') if isinstance(native, dict) else None
        stats = skill.get('stats') if isinstance(skill, dict) else None
    return _stats(stats)


def _summary(row, owner=None):
    if not isinstance(row, dict) or row.get('source') not in (None, 'clawhub'):
        return None
    slug = _identifier(row.get('slug'), _SLUG)
    owner = owner or _owner(row)
    if not slug or not owner:
        return None
    return {
        'id': f'clawhub:{owner}/{slug}',
        'source': 'clawhub',
        'slug': slug,
        'ownerHandle': owner,
        'displayName': _text(row.get('displayName'), 200) or slug,
        'summary': _text(row.get('summary')),
        'version': _text(row.get('version'), 128) or None,
        'updatedAt': _number(row.get('updatedAt')),
        'canonicalUrl': _canonical(row, owner, slug),
        # Public counters only (downloads/installs/stars/versions/comments).
        'stats': _row_stats(row),
        # Same names in Easel and ClawHub do not establish install provenance.
        'installationState': 'not_checked',
    }


def _search_result(payload, query, limit):
    rows = payload.get('results')
    if not isinstance(rows, list):
        raise HTTPException(502, 'ClawHub 返回的检索数据格式无效，请稍后重试')
    results, seen, omitted = [], set(), 0
    for row in rows[:MAX_RESULTS * 5]:
        item = _summary(row)
        if item is None:
            omitted += 1
            continue
        if item['id'] not in seen:
            seen.add(item['id'])
            results.append(item)
    return {'source': 'clawhub', 'query': query, 'results': results[:limit],
            'count': min(len(results), limit), 'limit': limit,
            'omittedCount': omitted + max(0, len(rows) - MAX_RESULTS * 5)}


def _string_list(value, limit=20):
    if not isinstance(value, list):
        return []
    return [_text(item, 120) for item in value[:limit] if isinstance(item, str)]


def _detail_result(payload, requested_owner, requested_slug):
    row = payload.get('skill')
    raw_owner = payload.get('owner')
    owner = _owner({'owner': raw_owner})
    if not isinstance(row, dict) or not owner:
        raise HTTPException(502, 'ClawHub 返回的技能详情缺少可核对的身份')
    if requested_owner and owner != requested_owner:
        raise HTTPException(502, 'ClawHub 返回的技能作者与所选结果不一致，请重新检索')
    if row.get('slug') != requested_slug:
        raise HTTPException(502, 'ClawHub 返回的技能与所选结果不一致，请重新检索')
    skill = _summary(row, owner)
    if skill is None:
        raise HTTPException(502, 'ClawHub 返回的技能详情格式无效')
    version = payload.get('latestVersion')
    latest = None
    if isinstance(version, dict) and isinstance(version.get('version'), str):
        latest = {'version': _text(version['version'], 128),
                  'createdAt': _number(version.get('createdAt')),
                  'changelog': _text(version.get('changelog'), 6000)}
    description = row.get('description')
    skill.update({
        'version': latest['version'] if latest else None,
        'description': _text(description, MAX_DESCRIPTION_CHARS),
        'descriptionTruncated': isinstance(description, str) and len(description) > MAX_DESCRIPTION_CHARS,
        'topics': _string_list(row.get('topics')),
        'createdAt': _number(row.get('createdAt')),
        'stats': _row_stats(row),
    })
    metadata = payload.get('metadata')
    metadata = {'os': _string_list(metadata.get('os')), 'systems': _string_list(metadata.get('systems'))} if isinstance(metadata, dict) else None
    moderation = payload.get('moderation')
    if isinstance(moderation, dict):
        moderation = {
            'isSuspicious': moderation.get('isSuspicious') if isinstance(moderation.get('isSuspicious'), bool) else None,
            'isMalwareBlocked': moderation.get('isMalwareBlocked') if isinstance(moderation.get('isMalwareBlocked'), bool) else None,
            'verdict': _text(moderation.get('verdict'), 100) or None,
            'summary': _text(moderation.get('summary')) or None,
        }
    else:
        moderation = None
    return {'source': 'clawhub', 'skill': skill,
            'owner': {'handle': owner, 'displayName': _text(raw_owner.get('displayName'), 200) or owner},
            'latestVersion': latest, 'metadata': metadata, 'moderation': moderation}


def _retry_delay(headers):
    for key in ('Retry-After', 'RateLimit-Reset', 'X-RateLimit-Reset'):
        value = headers.get(key, '')
        if not re.fullmatch(r'\d{1,12}', value):
            continue
        seconds = int(value)
        if key == 'X-RateLimit-Reset':
            seconds = math.ceil(seconds - time.time())
        return max(1, seconds)
    return 60


class ClawHubClient:
    def __init__(self, *, transport=None):
        self._transport = transport
        self._cache = OrderedDict()
        self._inflight = {}
        self._slots = asyncio.Semaphore(4)
        self._cooldown_until = 0.0

    def _check_cooldown(self):
        remaining = math.ceil(self._cooldown_until - time.monotonic())
        if remaining > 0:
            raise HTTPException(429, f'ClawHub 请求较多，请在 {remaining} 秒后重试',
                                headers={'Retry-After': str(remaining)})

    async def _read(self, path, params):
        async with self._slots:
            self._check_cooldown()
            # A new anonymous client cannot reuse caller cookies or auth. Disabling
            # environment trust also prevents .netrc credentials from being loaded.
            async with httpx.AsyncClient(
                transport=self._transport, trust_env=False, follow_redirects=False,
                timeout=httpx.Timeout(10, connect=5),
                headers={'Accept': 'application/json', 'User-Agent': 'Easel-ClawHub/1.0'},
            ) as client:
                async with client.stream('GET', ORIGIN + path, params=params) as response:
                    status = response.status_code
                    annotate(upstreamStatus=status,
                             upstreamType=response.headers.get('content-type', '').split(';')[0].strip())
                    if status == 429:
                        delay = _retry_delay(response.headers)
                        self._cooldown_until = max(self._cooldown_until, time.monotonic() + delay)
                        raise HTTPException(429, f'ClawHub 请求较多，请在 {delay} 秒后重试',
                                            headers={'Retry-After': str(delay)})
                    if status == 404 and path.startswith('/api/v1/skills/'):
                        raise HTTPException(404, 'ClawHub 中未找到这项公开技能，可能已下架或更名')
                    if status == 409:
                        raise HTTPException(409, '该技能名对应多个作者，请从检索结果重新选择')
                    if status != 200:
                        raise HTTPException(502, f'ClawHub 暂时无法提供公开数据（HTTP {status}），请稍后重试')
                    if response.headers.get('content-type', '').split(';')[0].strip().lower() != 'application/json':
                        raise HTTPException(502, 'ClawHub 未返回有效 JSON 数据，请稍后重试')
                    chunks, size = [], 0
                    async for chunk in response.aiter_bytes():
                        size += len(chunk)
                        if size > MAX_RESPONSE_BYTES:
                            raise HTTPException(502, 'ClawHub 返回的数据过大，请缩小检索范围')
                        chunks.append(chunk)
                    try:
                        value = json.loads(b''.join(chunks))
                    except (ValueError, UnicodeDecodeError, RecursionError):
                        raise HTTPException(502, 'ClawHub 返回的数据无法解析，请稍后重试') from None
                    if not isinstance(value, dict):
                        raise HTTPException(502, 'ClawHub 返回的数据格式无效，请稍后重试')
                    return value

    async def _load(self, key, path, params, normalize):
        try:
            try:
                payload = await asyncio.wait_for(self._read(path, params), REQUEST_SECONDS)
            except (asyncio.TimeoutError, httpx.TimeoutException):
                annotate(code='catalog_timeout')
                raise HTTPException(504, 'ClawHub 请求超时，请稍后重试') from None
            except httpx.RequestError:
                annotate(code='catalog_network')
                raise HTTPException(502, '暂时无法连接 ClawHub，请检查网络后重试') from None
            result = normalize(payload)
            result['fetchedAt'] = datetime.now(timezone.utc).isoformat()
            self._cache[key] = (time.monotonic() + CACHE_SECONDS, result)
            self._cache.move_to_end(key)
            while len(self._cache) > MAX_CACHE_ENTRIES:
                self._cache.popitem(last=False)
            return result
        finally:
            self._inflight.pop(key, None)

    async def _get(self, key, path, params, normalize):
        cached = self._cache.get(key)
        if cached and cached[0] > time.monotonic():
            self._cache.move_to_end(key)
            return {**cached[1], 'cacheHit': True}
        self._cache.pop(key, None)
        self._check_cooldown()
        task = self._inflight.get(key)
        if task is None:
            if len(self._inflight) >= 16:
                raise HTTPException(429, '技能检索正在处理，请稍后重试', headers={'Retry-After': '2'})
            task = asyncio.create_task(self._load(key, path, params, normalize))
            self._inflight[key] = task
            # If a browser leaves, another waiter may still need the request. Its
            # fixed deadline remains in force, and unattended errors are consumed.
            task.add_done_callback(lambda done: done.exception() if not done.cancelled() else None)
        result = await asyncio.shield(task)
        return {**result, 'cacheHit': False}

    async def search(self, query, limit=12):
        if not isinstance(query, str) or len(query) > MAX_QUERY_CHARS:
            raise HTTPException(400, f'检索词最多 {MAX_QUERY_CHARS} 字')
        if any(unicodedata.category(char).startswith('C') for char in query):
            raise HTTPException(400, '检索词不能包含控制字符')
        query = query.strip()
        if not query:
            raise HTTPException(400, '请输入要检索的技能或用途')
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_RESULTS:
            raise HTTPException(400, f'每次可检索 1–{MAX_RESULTS} 项技能')
        return await self._get(('search', query, limit), '/api/v1/search', {'q': query, 'limit': limit},
                               lambda data: _search_result(data, query, limit))

    async def detail(self, slug, owner=None):
        if not _identifier(slug, _SLUG):
            raise HTTPException(400, '技能标识无效，请从检索结果重新选择')
        if owner is not None and not _identifier(owner, _OWNER):
            raise HTTPException(400, '技能作者标识无效，请从检索结果重新选择')
        return await self._get(('detail', slug, owner), f'/api/v1/skills/{slug}',
                               {'ownerHandle': owner} if owner else {},
                               lambda data: _detail_result(data, owner, slug))


def create_router(client=None):
    service = client or ClawHubClient()
    router = APIRouter()

    @router.get('/api/clawhub/search')
    async def search(response: Response, q: str = '', limit: int = 12):
        annotate(operation='clawhub_search', stage='search')
        response.headers['Cache-Control'] = 'no-store'
        return await service.search(q, limit)

    @router.get('/api/clawhub/skills/{slug}')
    async def detail(slug: str, response: Response, owner: str | None = None):
        annotate(operation='clawhub_detail', stage='detail', slug=slug, owner=owner)
        response.headers['Cache-Control'] = 'no-store'
        return await service.detail(slug, owner)

    return router
