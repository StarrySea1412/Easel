"""Trend parser/cache/network-isolation tests; all HTTP responses are substitutes."""
import asyncio
import json
import sys
import threading
import urllib.error
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import trend_sources as trends


@pytest.fixture(autouse=True)
def clean_cache():
    trends._CACHE.clear()
    trends._LAST.clear()
    yield
    trends._CACHE.clear()
    trends._LAST.clear()


def raw(value):
    return json.dumps(value).encode()


def test_bilibili_string_array_is_data_and_gets_an_explicit_search_link():
    items, updated = trends.parse(trends.SOURCES['bilibili'][0], raw({'code': 200, 'data': ['AI 开源', '新品发布']}), 'bilibili')
    assert len(items) == 2
    assert items[0]['title'] == 'AI 开源'
    assert items[0]['url'] == 'https://search.bilibili.com/all?keyword=AI%20%E5%BC%80%E6%BA%90'
    assert items[0]['linkKind'] == 'search'
    assert items[0]['hot'] == ''
    assert items[0]['publishedAt'] is None
    assert updated is None


def test_authentication_error_in_http_200_is_not_reported_as_an_empty_success():
    with pytest.raises(trends.SourceError) as caught:
        trends.parse(trends.SOURCES['zhihu'][0], raw({'code': -8, 'msg': '请携带Key', 'data': ''}), 'zhihu')
    assert caught.value.code == 'authentication'


def test_rss_preserves_source_and_item_publication_times():
    body = b'<rss><channel><pubDate>Wed, 30 Sep 2026 22:17:00 GMT</pubDate><item><title>New device</title><link>https://www.ithome.com/0/1/2.htm</link><pubDate>Wed, 30 Sep 2026 22:00:00 GMT</pubDate></item></channel></rss>'
    items, updated = trends.parse(trends.SOURCES['ithome'][0], body, 'ithome')
    assert updated - items[0]['publishedAt'] == 17 * 60
    assert items[0]['hot'] == ''
    assert items[0]['url'] == 'https://www.ithome.com/0/1/2.htm'


def test_community_feeds_use_real_reply_or_point_counts_and_safe_links():
    v2ex, _ = trends.parse(trends.SOURCES['v2ex'][0], raw([{'title': 'Question', 'replies': 0, 'url': 'https://www.v2ex.com/t/1', 'created': 1234}]), 'v2ex')
    assert v2ex[0]['hot'] == '0 条回复'
    assert v2ex[0]['publishedAt'] == 1234
    hn, _ = trends.parse(trends.SOURCES['hackernews'][0], raw({'hits': [{'title': 'Ask HN', 'points': 4, 'objectID': '42', 'url': 'javascript:alert(1)'}]}), 'hackernews')
    assert hn[0]['hot'] == '4 分'
    assert hn[0]['url'] == 'https://news.ycombinator.com/item?id=42'
    assert trends.safe_url('https://user:secret@example.test/path') == ''


@pytest.mark.parametrize(('status', 'code'), [(429, 'rate_limited'), (403, 'access_denied'), (404, 'not_found'), (503, 'http_error')])
def test_http_failures_retain_actionable_classification(monkeypatch, status, code):
    def failure(*args, **kwargs):
        raise urllib.error.HTTPError('https://source.test', status, 'failed', {}, None)
    monkeypatch.setattr(trends.urllib.request, 'urlopen', failure)
    with pytest.raises(trends.SourceError) as caught:
        trends._download('https://source.test')
    assert caught.value.code == code
    assert str(status) in str(caught.value)


def test_failed_refresh_keeps_original_timestamp_and_marks_data_stale(monkeypatch):
    clock = [1000]
    monkeypatch.setattr(trends.time, 'time', lambda: clock[0])
    monkeypatch.setattr(trends, '_download', lambda url: raw({'code': 200, 'data': [{'title': 'Earlier data', 'url': 'https://example.test'}]}))
    first = trends._fetch('weibo')
    assert first['status'] == 'fresh'
    clock[0] += 301
    def limited(url):
        raise trends.SourceError('rate_limited', '来源请求限流（HTTP 429），请稍后重试。')
    monkeypatch.setattr(trends, '_download', limited)
    stale = trends._fetch('weibo', refresh=True)
    assert stale['status'] == 'stale'
    assert stale['fetchedAt'] == 1000
    assert stale['checkedAt'] == 1301
    assert stale['items'] == first['items']
    assert stale['error']['code'] == 'rate_limited'
    assert len(stale['attempts']) == 2
    assert asyncio.run(trends.fetch_trends('weibo'))['updated'] == 1000
    clock[0] += trends.MAX_STALE_SECONDS
    expired = trends._fetch('weibo')
    assert expired['status'] == 'error'
    assert expired['items'] == []
    assert expired['fetchedAt'] is None


def test_refresh_honors_short_cooldown_and_returns_copy_of_cached_data(monkeypatch):
    clock = [1000]
    calls = []
    monkeypatch.setattr(trends.time, 'time', lambda: clock[0])
    def download(url):
        calls.append(url)
        return raw({'code': 200, 'data': [{'title': 'Original', 'url': 'https://example.test'}]})
    monkeypatch.setattr(trends, '_download', download)
    first = trends._fetch('weibo')
    first['items'].clear()
    second = trends._fetch('weibo', refresh=True)
    assert second['status'] == 'cached'
    assert len(second['items']) == 1
    assert len(calls) == 1
    clock[0] += 61
    assert trends._fetch('weibo', refresh=True)['status'] == 'fresh'
    assert len(calls) == 2


def test_normal_cache_read_cannot_hide_a_recent_failed_refresh(monkeypatch):
    clock = [1000]
    monkeypatch.setattr(trends.time, 'time', lambda: clock[0])
    monkeypatch.setattr(trends, '_download', lambda url: raw({'code': 200, 'data': ['Earlier data']}))
    trends._fetch('weibo')
    clock[0] += 61
    def failure(url):
        raise trends.SourceError('timeout', '来源响应超时')
    monkeypatch.setattr(trends, '_download', failure)
    assert trends._fetch('weibo', refresh=True)['status'] == 'stale'
    clock[0] += 61
    cached = trends._fetch('weibo')
    assert cached['status'] == 'stale'
    assert cached['fetchedAt'] == 1000
    assert cached['error']['code'] == 'timeout'


def test_no_cache_failure_stays_an_error_and_can_use_an_independent_backup(monkeypatch):
    def download(url):
        if 'xxapi' in url:
            raise trends.SourceError('timeout', '来源响应超时')
        return raw({'code': 200, 'data': [{'title': 'Backup', 'url': 'https://example.test'}]})
    monkeypatch.setattr(trends, '_download', download)
    group = trends._fetch('weibo')
    assert group['status'] == 'fresh'
    assert group['source']['name'] == '60s API'
    assert group['attempts'][0]['code'] == 'timeout'
    monkeypatch.setattr(trends, '_download', lambda url: b'<html>maintenance</html>')
    group = trends._fetch('zhihu')
    assert group['status'] == 'error'
    assert group['items'] == []
    assert group['error']['code'] == 'invalid_response'


def test_platform_requests_run_concurrently_and_preserve_selection_order(monkeypatch):
    barrier = threading.Barrier(3, timeout=3)
    def fetch(platform, refresh):
        barrier.wait()
        return {'platform': platform, 'items': [{'title': platform}] * 5, 'fetchedAt': 100}
    monkeypatch.setattr(trends, '_fetch', fetch)
    result = asyncio.run(trends.fetch_trends('weibo,zhihu,weibo,ithome,unknown', 2))
    assert [group['platform'] for group in result['trends']] == ['weibo', 'zhihu', 'ithome']
    assert all(len(group['items']) == 2 for group in result['trends'])
    assert result['updated'] == 100
