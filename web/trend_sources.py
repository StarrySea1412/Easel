"""Public trend feeds with isolated failures and explicit cache provenance.

No cookies, account sessions, anti-bot workarounds or synthetic fallback items.
"""
from __future__ import annotations

import asyncio
import copy
import json
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
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


SOURCES = {
    'weibo': (xxapi('weibohot'), sixty('weibo')),
    'douyin': (xxapi('douyinhot'), sixty('douyin')),
    'zhihu': (sixty('zhihu'),),
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
_LOCKS = {platform: threading.Lock() for platform in SOURCES}


class SourceError(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
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
        if isinstance(value, (int, float)) and value > 0:
            return int(value)
        return int(parsedate_to_datetime(str(value)).timestamp()) if value else None
    except (ValueError, TypeError, OverflowError):
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
        if source.format == 'hn':
            rows = payload.get('hits') if isinstance(payload, dict) else None
        elif source.format == 'v2ex':
            rows = payload
        else:
            if not isinstance(payload, dict):
                raise SourceError('invalid_response', '热榜响应格式已变化。')
            if payload.get('code') not in (None, 0, 200, '200'):
                message = str(payload.get('message') or payload.get('msg') or '')
                if 'key' in message.lower() or '密钥' in message or '鉴权' in message:
                    raise SourceError('authentication', '来源要求 API 密钥，当前没有可用的公开授权。')
                raise SourceError('upstream_error', '来源接口报错，暂时没有返回热榜。')
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
        if not url and source.format == 'hn' and str(row.get('objectID', '')).isdigit():
            url = f"https://news.ycombinator.com/item?id={row['objectID']}"
        is_search = False
        if not url:
            url = _search_url(platform, title)
            is_search = bool(url)
        hot = str(row.get('hot') or row.get('hot_value') or row.get('num') or '')
        if source.format == 'v2ex' and isinstance(row.get('replies'), int):
            hot = f"{row['replies']} 条回复"
        elif source.format == 'hn' and isinstance(row.get('points'), int):
            hot = f"{row['points']} 分"
        items.append({'title': title, 'hot': hot, 'url': url, 'linkKind': 'search' if is_search else 'article',
                      'publishedAt': _timestamp(row.get('publishedAt') or row.get('created') or row.get('created_at_i'))})
    if not items:
        raise SourceError('empty', '来源本次没有返回可用条目。')
    return items[:100], updated


def _download(url: str) -> bytes:
    request = urllib.request.Request(url, headers={'User-Agent': 'Easel/1.0 (public feeds)', 'Accept': 'application/json, application/rss+xml, text/xml'})
    try:
        with urllib.request.urlopen(request, timeout=6) as response:
            raw = response.read(2_000_001)
            if len(raw) > 2_000_000:
                raise SourceError('invalid_response', '来源响应过大，暂时无法读取。')
            return raw
    except urllib.error.HTTPError as exc:
        if exc.code == 429:
            raise SourceError('rate_limited', '来源请求限流（HTTP 429），请稍后重试。') from None
        if exc.code in (401, 403):
            raise SourceError('access_denied', f'来源拒绝公开访问（HTTP {exc.code}），可能需要授权或站点验证。') from None
        if exc.code == 404:
            raise SourceError('not_found', '来源接口已失效或地址已变更（HTTP 404）。') from None
        raise SourceError('http_error', f'来源服务异常（HTTP {exc.code}）。') from None
    except (TimeoutError, socket.timeout):
        raise SourceError('timeout', '来源响应超时，请稍后重试。') from None
    except (urllib.error.URLError, OSError):
        raise SourceError('network', '无法连接来源，请检查网络后重试。') from None


def _fetch(platform: str, refresh: bool = False) -> dict:
    with _LOCKS[platform]:
        now = time.time()
        last = _LAST.get(platform)
        cached = _CACHE.get(platform)
        if last and now - last[0] < RETRY_SECONDS:
            result = copy.deepcopy(last[1])
            if result['status'] == 'fresh':
                result['status'] = 'cached'
            return result
        if cached and not refresh and now - cached['fetchedAt'] < CACHE_SECONDS:
            if last and last[1]['status'] == 'stale':
                return copy.deepcopy(last[1])
            result = copy.deepcopy(cached)
            result['status'] = 'cached'
            return result
        attempts = []
        for source in SOURCES[platform]:
            try:
                items, source_updated = parse(source, _download(source.url), platform)
                result = {'platform': platform, 'label': LABELS[platform], 'items': items, 'status': 'fresh',
                          'fetchedAt': int(time.time()), 'checkedAt': int(time.time()), 'sourceUpdatedAt': source_updated,
                          'source': {'name': source.name, 'url': source.url, 'kind': source.kind},
                          'error': None, 'attempts': attempts}
                _CACHE[platform] = copy.deepcopy(result)
                _LAST[platform] = (time.time(), copy.deepcopy(result))
                return result
            except SourceError as exc:
                attempts.append({'source': source.name, 'code': exc.code, 'message': str(exc)})
            except Exception:
                attempts.append({'source': source.name, 'code': 'invalid_response', 'message': '来源返回内容无法解析，请稍后重试。'})
        error = {key: attempts[-1][key] for key in ('code', 'message')}
        if cached and now - cached['fetchedAt'] < MAX_STALE_SECONDS:
            result = copy.deepcopy(cached)
            result.update(status='stale', checkedAt=int(time.time()), error=error, attempts=attempts)
        else:
            source = SOURCES[platform][0]
            result = {'platform': platform, 'label': LABELS[platform], 'items': [], 'status': 'error',
                      'fetchedAt': None, 'checkedAt': int(time.time()), 'sourceUpdatedAt': None,
                      'source': {'name': source.name, 'url': source.url, 'kind': source.kind}, 'error': error, 'attempts': attempts}
        _LAST[platform] = (time.time(), copy.deepcopy(result))
        return result


async def fetch_trends(platforms: str, limit: int = 12, refresh: bool = False) -> dict:
    selected = list(dict.fromkeys(p.strip() for p in platforms.split(',') if p.strip() in SOURCES))
    groups = await asyncio.gather(*(asyncio.to_thread(_fetch, platform, refresh) for platform in selected))
    count = max(1, min(limit, 30))
    groups = [{**group, 'items': group['items'][:count]} for group in groups]
    return {'trends': groups, 'updated': max((group['fetchedAt'] or 0 for group in groups), default=0)}
