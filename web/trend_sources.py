"""Public trend feeds with isolated failures and explicit cache provenance.

No cookies, account sessions, anti-bot workarounds or synthetic fallback items.
"""
from __future__ import annotations

import asyncio
import copy
import json
import logging
import os
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime


@dataclass(frozen=True)
class Source:
    name: str
    url: str
    format: str = 'hot'
    kind: str = '第三方热榜'


def sixty(path: str) -> Source:
    return Source('60s API', f'https://60s.viki.moe/v2/{path}')


def xxapi(path: str) -> Source:
    return Source('xxapi', f'https://v2.xxapi.cn/api/{path}')


def _zhihu_sources() -> tuple[Source, ...]:
    # Public question ranking, also used by the 60s Zhihu adapter. Reading the
    # original feed avoids the community gateway's shared daily request quota.
    sources = (Source('知乎公开热榜', 'https://api.zhihu.com/topstory/hot-lists/total?limit=30', 'zhihu', '平台公开问题热榜'),
               sixty('zhihu'))
    configured = os.environ.get('EASEL_ZHIHU_DAILYHOT_URL', '').strip()
    if not configured:
        return sources
    try:
        url = urllib.parse.urlsplit(configured)
        valid = (url.scheme in ('https', 'http') and url.hostname and not url.username
                 and not url.password and not url.query and not url.fragment)
        url.port  # Validate an explicit port without logging a possibly sensitive URL.
    except ValueError:
        valid = False
    if not valid:
        logging.getLogger(__name__).warning(
            'EASEL_ZHIHU_DAILYHOT_URL 已忽略：需要不含凭据、查询参数或片段的 HTTP(S) 接口地址。')
        return sources
    # The documented public instance is a demo, not an enabled service dependency.
    return sources + (Source('DailyHotApi-Go（已配置实例）', configured, 'dailyhot-go', '第三方问题热榜'),)


SOURCES = {
    'weibo': (xxapi('weibohot'), sixty('weibo')),
    'douyin': (xxapi('douyinhot'), sixty('douyin')),
    'zhihu': _zhihu_sources(),
    'bilibili': (xxapi('bilibilihot'), sixty('bili')),
    'baidu': (xxapi('baiduhot'), sixty('baidu/hot')),
    'toutiao': (sixty('toutiao'),),
    'ithome': (Source('IT之家官方 RSS', 'https://www.ithome.com/rss/', 'rss', '最新科技资讯'),),
    'v2ex': (Source('V2EX 公开 API', 'https://www.v2ex.com/api/topics/hot.json', 'v2ex', '社区热门讨论'),),
    'hackernews': (Source('Hacker News / Algolia', 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30', 'hn', '英文科技首页'),),
}
LABELS = {'weibo': '微博', 'douyin': '抖音', 'zhihu': '知乎', 'bilibili': 'B站',
          'baidu': '百度', 'toutiao': '头条', 'ithome': 'IT之家', 'v2ex': 'V2EX', 'hackernews': 'Hacker News'}
CACHE_SECONDS = 300
RETRY_SECONDS = 60
MAX_STALE_SECONDS = 86400
_CACHE: dict[str, dict] = {}
_LAST: dict[str, tuple[float, dict]] = {}
_SOURCE_COOLDOWNS: dict[str, dict] = {}
_LOCKS = {platform: threading.Lock() for platform in SOURCES}


class SourceError(Exception):
    def __init__(self, code: str, message: str, *, retry_at: int | None = None):
        self.code = code
        self.retry_at = retry_at
        super().__init__(message)


def safe_url(value: object) -> str:
    if not isinstance(value, str):
        return ''
    try:
        url = urllib.parse.urlsplit(value)
        return value if url.scheme in ('https', 'http') and url.hostname and not url.username and not url.password else ''
    except ValueError:
        return ''


def _timestamp(value: object) -> int | None:
    try:
        if isinstance(value, bool) or not value:
            return None
        if isinstance(value, (int, float)):
            # 60s uses milliseconds for Zhihu question creation, unlike V2EX/HN.
            seconds = value / 1000 if value >= 100_000_000_000 else value
            datetime.fromtimestamp(seconds, timezone.utc)
            return int(seconds) if seconds > 0 else None
        try:
            parsed = parsedate_to_datetime(str(value))
        except (ValueError, TypeError):
            parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        # A source-local wall clock without an offset is not a known instant.
        return int(parsed.timestamp()) if parsed.tzinfo is not None else None
    except (ValueError, TypeError, OverflowError, OSError):
        return None


def _retry_at(value: str | None) -> int | None:
    if not value:
        return None
    try:
        now = time.time()
        value = value.strip()
        deadline = int(now) + int(value) if value.isdecimal() else _timestamp(value)
        if deadline is None or deadline <= now:
            return None
        datetime.fromtimestamp(deadline, timezone.utc)
        return deadline
    except (ValueError, TypeError, OverflowError, OSError):
        return None


def _search_url(platform: str, title: str) -> str:
    query = urllib.parse.quote(title)
    bases = {'bilibili': 'https://search.bilibili.com/all?keyword=', 'douyin': 'https://www.douyin.com/search/',
             'weibo': 'https://s.weibo.com/weibo?q=', 'baidu': 'https://www.baidu.com/s?wd='}
    return bases.get(platform, '') + query if platform in bases else ''


def _json(raw: bytes):
    try:
        return json.loads(raw)
    except (ValueError, UnicodeError):
        raise SourceError('invalid_response', '来源没有返回有效 JSON，可能正在维护。') from None


def parse(source: Source, raw: bytes, platform: str) -> tuple[list[dict], int | None]:
    """Normalize only data actually returned, retaining absent heat/time fields."""
    updated = None
    if source.format == 'rss':
        try:
            root = ET.fromstring(raw)
        except ET.ParseError:
            raise SourceError('invalid_response', 'RSS 内容格式已变化，暂时无法读取。') from None
        channel = root.find('channel')
        if channel is None:
            raise SourceError('invalid_response', '来源没有返回 RSS 频道。')
        updated = _timestamp(channel.findtext('lastBuildDate') or channel.findtext('pubDate'))
        rows = [{'title': row.findtext('title'), 'url': row.findtext('link'),
                 'publishedAt': _timestamp(row.findtext('pubDate'))} for row in channel.findall('item')]
    else:
        payload = _json(raw)
        if source.format == 'zhihu':
            if not isinstance(payload, dict) or payload.get('error'):
                raise SourceError('upstream_error', '知乎公开接口暂未返回问题热榜。')
            native_rows = payload.get('data')
            if not isinstance(native_rows, list):
                raise SourceError('invalid_response', '知乎公开热榜的数据结构已变化。')
            rows = []
            for row in native_rows:
                if not isinstance(row, dict) or row.get('type') != 'hot_list_feed':
                    continue
                target = row.get('target')
                if not isinstance(target, dict) or target.get('type') != 'question':
                    continue
                native_url = safe_url(target.get('url'))
                link = urllib.parse.urlsplit(native_url)
                question_id = link.path.removeprefix('/questions/')
                if (link.scheme != 'https' or link.hostname != 'api.zhihu.com' or link.port not in (None, 443)
                        or not link.path.startswith('/questions/') or not question_id.isdecimal()
                        or link.query or link.fragment):
                    continue
                rows.append({'title': target.get('title'), 'url': f'https://www.zhihu.com/question/{question_id}',
                             'hot': row.get('detail_text'), 'created': target.get('created')})
        elif source.format == 'hn':
            rows = payload.get('hits') if isinstance(payload, dict) else None
        elif source.format == 'v2ex':
            rows = payload
        else:
            if not isinstance(payload, dict):
                raise SourceError('invalid_response', '热榜响应格式已变化。')
            if payload.get('code') not in (None, 0, 200, '200'):
                if payload.get('code') in (429, '429'):
                    raise SourceError('rate_limited', '来源业务接口限流（code 429），请稍后重试。')
                message = str(payload.get('message') or payload.get('msg') or '')
                if 'key' in message.lower() or '密钥' in message or '鉴权' in message:
                    raise SourceError('authentication', '来源要求 API 密钥，当前没有可用的公开授权。')
                raise SourceError('upstream_error', '来源接口报错，暂时没有返回热榜。')
            if source.format == 'dailyhot-go' and (payload.get('name') != 'zhihu' or payload.get('type') != '热榜'):
                raise SourceError('invalid_response', '备用来源未标明知乎问题热榜，不能代替当前榜单。')
            rows = payload.get('data')
            if isinstance(rows, dict):
                rows = rows.get('data') or rows.get('list')
        if not isinstance(rows, list):
            raise SourceError('invalid_response', '来源的数据结构已变化，暂时无法读取榜单。')
    items = []
    for row in rows:
        if isinstance(row, str):
            row = {'title': row}
        if not isinstance(row, dict):
            continue
        title = row.get('title') or row.get('word') or row.get('name') or row.get('keyword')
        if not isinstance(title, str) or not title.strip():
            continue
        title = title.strip()
        url = safe_url(row.get('url') or row.get('link') or row.get('mobil_url'))
        if source.format == 'dailyhot-go':
            link = urllib.parse.urlsplit(url)
            if (link.hostname not in ('www.zhihu.com', 'zhihu.com') or not link.path.startswith('/question/')
                    or not link.path[len('/question/'):].rstrip('/').isdigit()):
                continue
        if not url and source.format == 'hn' and str(row.get('objectID', '')).isdigit():
            url = f"https://news.ycombinator.com/item?id={row['objectID']}"
        is_search = False
        if not url:
            url = _search_url(platform, title)
            is_search = bool(url)
        hot = str(next((row[key] for key in ('hot', 'hot_value_desc', 'hot_value', 'num')
                        if row.get(key) is not None and row[key] != ''), ''))
        if source.format == 'v2ex' and isinstance(row.get('replies'), int):
            hot = f"{row['replies']} 条回复"
        elif source.format == 'hn' and isinstance(row.get('points'), int):
            hot = f"{row['points']} 分"
        created_keys = ('timestamp',) if source.format == 'dailyhot-go' else ('created_at_i', 'created_at', 'created')
        created_at = next((stamp for key in created_keys
                           if (stamp := _timestamp(row.get(key))) is not None), None)
        published_at = _timestamp(row.get('publishedAt'))
        if platform != 'zhihu' and published_at is None:
            published_at = created_at
        item = {'title': title, 'hot': hot, 'url': url, 'linkKind': 'search' if is_search else 'article',
                'publishedAt': published_at}
        if platform == 'zhihu':
            item['createdAt'] = created_at  # Question creation, never ranking entry/update time.
        items.append(item)
    if not items:
        raise SourceError('empty', '来源本次没有返回可用条目。')
    return items[:100], updated


def _source_details(source: Source, raw: bytes) -> dict:
    details = {'name': source.name, 'url': source.url, 'kind': source.kind}
    if source.format == 'dailyhot-go':
        payload = _json(raw)
        # In the reviewed Go implementation, updateTime is time.Now(), while
        # fromCache is !noCache, not an observed cache hit. Neither dates the board.
        reported = payload.get('fromCache')
        details.update(reportedFromCache=reported if isinstance(reported, bool) else None,
                       responseGeneratedAt=_timestamp(payload.get('updateTime')))
    return details


def _download(url: str) -> bytes:
    request = urllib.request.Request(url, headers={'User-Agent': 'Easel/1.0 (public feeds)', 'Accept': 'application/json, application/rss+xml, text/xml'})
    try:
        with urllib.request.urlopen(request, timeout=6) as response:
            raw = response.read(2_000_001)
            if len(raw) > 2_000_000:
                raise SourceError('invalid_response', '来源响应过大，暂时无法读取。')
            return raw
    except urllib.error.HTTPError as exc:
        retry_at = _retry_at(exc.headers.get('Retry-After')) if exc.headers and exc.code in (429, 503) else None
        if exc.code == 429:
            raise SourceError('rate_limited', '来源请求限流（HTTP 429），请稍后重试。', retry_at=retry_at) from None
        if exc.code in (401, 403):
            raise SourceError('access_denied', f'来源拒绝公开访问（HTTP {exc.code}），可能需要授权或站点验证。') from None
        if exc.code == 404:
            raise SourceError('not_found', '来源接口已失效或地址已变更（HTTP 404）。') from None
        raise SourceError('http_error', f'来源服务异常（HTTP {exc.code}）。', retry_at=retry_at) from None
    except (TimeoutError, socket.timeout):
        raise SourceError('timeout', '来源响应超时，请稍后重试。') from None
    except (urllib.error.URLError, OSError):
        raise SourceError('network', '无法连接来源，请检查网络后重试。') from None


def _reuse_result(result: dict, now: float) -> dict:
    result = copy.deepcopy(result)
    if result['status'] == 'fresh':
        result['status'] = 'cached'
    elif result['status'] == 'stale' and now - result['fetchedAt'] >= MAX_STALE_SECONDS:
        result.update(status='error', items=[], fetchedAt=None, sourceUpdatedAt=None)
    return result


def _fetch(platform: str, refresh: bool = False) -> dict:
    with _LOCKS[platform]:
        now = time.time()
        last = _LAST.get(platform)
        cached = _CACHE.get(platform)
        if last and now < max(last[0] + RETRY_SECONDS, last[1].get('nextRetryAt', 0)):
            return _reuse_result(last[1], now)
        if cached and not refresh and now - cached['fetchedAt'] < CACHE_SECONDS:
            if last and last[1]['status'] == 'stale':
                return copy.deepcopy(last[1])
            result = copy.deepcopy(cached)
            result['status'] = 'cached'
            return result
        attempts = []
        for source in SOURCES[platform]:
            cooldown = _SOURCE_COOLDOWNS.get(source.url)
            if cooldown and time.time() < cooldown['retryAt']:
                attempts.append({**cooldown, 'reused': True})
                continue
            try:
                body = _download(source.url)
                items, source_updated = parse(source, body, platform)
                _SOURCE_COOLDOWNS.pop(source.url, None)
                result = {'platform': platform, 'label': LABELS[platform], 'items': items, 'status': 'fresh',
                          'fetchedAt': int(time.time()), 'checkedAt': int(time.time()), 'sourceUpdatedAt': source_updated,
                          'source': _source_details(source, body),
                          'error': None, 'attempts': attempts}
                _CACHE[platform] = copy.deepcopy(result)
                _LAST[platform] = (time.time(), copy.deepcopy(result))
                return result
            except SourceError as exc:
                attempt = {'source': source.name, 'url': source.url, 'checkedAt': int(time.time()),
                           'code': exc.code, 'message': str(exc)}
                _SOURCE_COOLDOWNS.pop(source.url, None)
                if exc.retry_at and exc.retry_at > time.time():
                    attempt.update(retryAt=exc.retry_at)
                    _SOURCE_COOLDOWNS[source.url] = copy.deepcopy(attempt)
                attempts.append(attempt)
            except Exception:
                attempts.append({'source': source.name, 'url': source.url, 'checkedAt': int(time.time()),
                                 'code': 'invalid_response', 'message': '来源返回内容无法解析，请稍后重试。'})
        error = {key: attempts[-1][key] for key in ('code', 'message')}
        if cached and now - cached['fetchedAt'] < MAX_STALE_SECONDS:
            result = copy.deepcopy(cached)
            result.update(status='stale', checkedAt=int(time.time()), error=error, attempts=attempts)
        else:
            source = SOURCES[platform][0]
            result = {'platform': platform, 'label': LABELS[platform], 'items': [], 'status': 'error',
                      'fetchedAt': None, 'checkedAt': int(time.time()), 'sourceUpdatedAt': None,
                      'source': {'name': source.name, 'url': source.url, 'kind': source.kind}, 'error': error, 'attempts': attempts}
        # Retry only when at least one source is eligible; successful fallbacks
        # still retain the failed source's cooldown on subsequent refreshes.
        checked = time.time()
        available = min(_SOURCE_COOLDOWNS.get(source.url, {}).get('retryAt', checked)
                        for source in SOURCES[platform])
        result['nextRetryAt'] = int(max(checked + RETRY_SECONDS, available))
        _LAST[platform] = (time.time(), copy.deepcopy(result))
        return result


async def fetch_trends(platforms: str, limit: int = 12, refresh: bool = False) -> dict:
    selected = list(dict.fromkeys(p.strip() for p in platforms.split(',') if p.strip() in SOURCES))
    groups = await asyncio.gather(*(asyncio.to_thread(_fetch, platform, refresh) for platform in selected))
    count = max(1, min(limit, 30))
    groups = [{**group, 'items': group['items'][:count]} for group in groups]
    return {'trends': groups, 'updated': max((group['fetchedAt'] or 0 for group in groups), default=0)}
