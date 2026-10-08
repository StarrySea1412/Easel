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
def clean_cache(monkeypatch):
    monkeypatch.setitem(trends.SOURCES, 'zhihu', (trends.sixty('zhihu'),))
    trends._CACHE.clear()
    trends._LAST.clear()
    trends._SOURCE_COOLDOWNS.clear()
    yield
    trends._CACHE.clear()
    trends._LAST.clear()
    trends._SOURCE_COOLDOWNS.clear()


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


def test_zhihu_sixty_fields_retain_heat_and_normalize_question_milliseconds():
    items, updated = trends.parse(trends.SOURCES['zhihu'][0], raw({'code': 200, 'data': [{
        'title': '有公开依据的讨论问题', 'hot_value_desc': '123 万热度',
        'link': 'https://www.zhihu.com/question/123',
        'created_at': 1791417858000, 'created': '2026/10/08 08:04:18',
    }]}), 'zhihu')
    assert items[0]['hot'] == '123 万热度'
    assert items[0]['url'] == 'https://www.zhihu.com/question/123'
    assert items[0]['createdAt'] == 1791417858
    assert items[0]['publishedAt'] is None
    assert updated is None, 'question creation does not establish the ranking update time'


def test_zero_heat_is_not_a_missing_metric_and_timezone_free_dates_stay_unknown():
    items, _ = trends.parse(trends.SOURCES['zhihu'][0], raw({'data': [{
        'title': '真实零值', 'hot_value': 0, 'created': '2026-10-08T08:00:00',
    }]}), 'zhihu')
    assert items[0]['hot'] == '0'
    assert items[0]['createdAt'] is None
    assert items[0]['publishedAt'] is None
    assert trends._timestamp('2026-10-08T00:00:00Z') == 1791417600
    assert trends._timestamp(True) is None
    assert trends._timestamp(float('inf')) is None


def test_zhihu_backup_is_opt_in_and_accepts_a_configured_self_hosted_endpoint(monkeypatch):
    monkeypatch.delenv('EASEL_ZHIHU_DAILYHOT_URL', raising=False)
    assert trends._zhihu_sources() == (trends.sixty('zhihu'),)
    monkeypatch.setenv('EASEL_ZHIHU_DAILYHOT_URL', 'http://127.0.0.1:6688/zhihu')
    sources = trends._zhihu_sources()
    assert sources[0] == trends.sixty('zhihu')
    assert sources[1].url == 'http://127.0.0.1:6688/zhihu'
    assert sources[1].format == 'dailyhot-go'


@pytest.mark.parametrize('endpoint', [
    'https://user:secret@source.test/zhihu', 'https://source.test/zhihu?key=secret',
    'https://source.test/zhihu#secret', 'ftp://source.test/zhihu', 'https://source.test:bad/zhihu',
])
def test_zhihu_backup_rejects_invalid_or_credential_bearing_config_without_logging_values(monkeypatch, caplog, endpoint):
    monkeypatch.setenv('EASEL_ZHIHU_DAILYHOT_URL', endpoint)
    assert trends._zhihu_sources() == (trends.sixty('zhihu'),)
    assert 'EASEL_ZHIHU_DAILYHOT_URL' in caplog.text
    assert endpoint not in caplog.text
    assert 'secret' not in caplog.text


def dailyhot_payload():
    return {'code': 200, 'name': 'zhihu', 'type': '热榜', 'fromCache': True,
            'updateTime': '2026-10-08T12:29:11+08:00', 'data': [{
                'title': '备用实例提供的问题', 'url': 'https://www.zhihu.com/question/123',
                'hot': 56560000, 'timestamp': 1791417858000,
            }]}


def test_dailyhot_backup_preserves_question_time_but_not_a_false_board_update():
    source = trends.Source('Configured', 'https://source.test/zhihu', 'dailyhot-go')
    body = raw(dailyhot_payload())
    items, updated = trends.parse(source, body, 'zhihu')
    assert items[0]['hot'] == '56560000'
    assert items[0]['createdAt'] == 1791417858
    assert items[0]['publishedAt'] is None
    assert updated is None, 'the response clock does not establish the board age'
    details = trends._source_details(source, body)
    assert details['reportedFromCache'] is True
    assert details['responseGeneratedAt'] == 1791433751
    payload = dailyhot_payload()
    payload.update(fromCache='true', updateTime='2026-10-08T12:29:11')
    unknown = trends._source_details(source, raw(payload))
    assert unknown['reportedFromCache'] is None
    assert unknown['responseGeneratedAt'] is None


def test_dailyhot_backup_cannot_substitute_search_terms_or_another_platform():
    source = trends.Source('Configured', 'https://source.test/zhihu', 'dailyhot-go')
    for changed in ({'type': '热搜'}, {'name': 'baidu'}):
        with pytest.raises(trends.SourceError) as caught:
            trends.parse(source, raw({**dailyhot_payload(), **changed}), 'zhihu')
        assert caught.value.code == 'invalid_response'
    payload = dailyhot_payload()
    payload['data'][0]['url'] = 'https://www.zhihu.com/search?q=keyword'
    with pytest.raises(trends.SourceError) as caught:
        trends.parse(source, raw(payload), 'zhihu')
    assert caught.value.code == 'empty'


def test_configured_zhihu_backup_runs_only_after_primary_failure_and_retains_provenance(monkeypatch):
    monkeypatch.setenv('EASEL_ZHIHU_DAILYHOT_URL', 'https://source.test/zhihu')
    monkeypatch.setitem(trends.SOURCES, 'zhihu', trends._zhihu_sources())
    clock, calls = [1791433800], []
    monkeypatch.setattr(trends.time, 'time', lambda: clock[0])
    def healthy(url):
        calls.append(url)
        return raw({'code': 200, 'data': [{'title': '主来源问题'}]})
    monkeypatch.setattr(trends, '_download', healthy)
    primary = trends._fetch('zhihu')
    assert primary['source']['name'] == '60s API'
    assert calls == [trends.sixty('zhihu').url]
    clock[0] += 301
    def fallback(url):
        calls.append(url)
        if url == trends.sixty('zhihu').url:
            raise trends.SourceError('rate_limited', '来源请求限流（HTTP 429）', retry_at=clock[0] + 600)
        return raw(dailyhot_payload())
    monkeypatch.setattr(trends, '_download', fallback)
    recovered = trends._fetch('zhihu', refresh=True)
    assert recovered['status'] == 'fresh'
    assert recovered['source']['url'] == 'https://source.test/zhihu'
    assert recovered['source']['reportedFromCache'] is True
    assert recovered['sourceUpdatedAt'] is None
    assert recovered['attempts'][0]['url'] == trends.sixty('zhihu').url
    assert recovered['attempts'][0]['checkedAt'] == clock[0]
    assert recovered['attempts'][0]['code'] == 'rate_limited'
    assert calls[-2:] == [trends.sixty('zhihu').url, 'https://source.test/zhihu']


def test_rate_limit_in_http_200_business_payload_is_not_a_generic_parse_failure():
    with pytest.raises(trends.SourceError) as caught:
        trends.parse(trends.SOURCES['zhihu'][0], raw({'code': 429, 'message': 'Too many requests'}), 'zhihu')
    assert caught.value.code == 'rate_limited'


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


@pytest.mark.parametrize(('header', 'deadline'), [('180', 1180), ('Thu, 01 Jan 1970 00:20:00 GMT', 1200), ('invalid', None), ('-1', None)])
@pytest.mark.parametrize('status', [429, 503])
def test_http_retry_after_accepts_seconds_or_dates_and_ignores_invalid_values(monkeypatch, header, deadline, status):
    monkeypatch.setattr(trends.time, 'time', lambda: 1000)
    def failure(*args, **kwargs):
        raise urllib.error.HTTPError('https://source.test', status, 'failed', {'Retry-After': header}, None)
    monkeypatch.setattr(trends.urllib.request, 'urlopen', failure)
    with pytest.raises(trends.SourceError) as caught:
        trends._download('https://source.test')
    assert caught.value.retry_at == deadline


def test_manual_refresh_respects_retry_after_and_retains_the_original_failure(monkeypatch):
    clock, calls = [1000], []
    monkeypatch.setattr(trends.time, 'time', lambda: clock[0])
    def download(url):
        calls.append(url)
        raise trends.SourceError('rate_limited', '来源请求限流（HTTP 429）', retry_at=1300)
    monkeypatch.setattr(trends, '_download', download)
    first = trends._fetch('zhihu')
    assert first['nextRetryAt'] == 1300
    clock[0] = 1120
    reused = trends._fetch('zhihu', refresh=True)
    assert len(calls) == 1
    assert reused['status'] == 'error'
    assert reused['checkedAt'] == 1000
    assert reused['fetchedAt'] is None
    assert reused['error'] == first['error']
    clock[0] = 1301
    trends._fetch('zhihu', refresh=True)
    assert len(calls) == 2


def test_independent_fallback_does_not_cancel_a_limited_sources_retry_after(monkeypatch):
    clock, calls = [1000], []
    monkeypatch.setattr(trends.time, 'time', lambda: clock[0])
    def download(url):
        calls.append(url)
        if 'xxapi' in url:
            raise trends.SourceError('rate_limited', '来源请求限流（HTTP 429）', retry_at=1600)
        return raw({'code': 200, 'data': [{'title': '备用公开来源实际返回的内容'}]})
    monkeypatch.setattr(trends, '_download', download)
    first = trends._fetch('weibo')
    assert first['status'] == 'fresh'
    assert first['source']['name'] == '60s API'
    clock[0] = 1301
    refreshed = trends._fetch('weibo', refresh=True)
    assert sum('xxapi' in url for url in calls) == 1
    assert refreshed['status'] == 'fresh'
    assert refreshed['attempts'][0]['reused'] is True
    assert refreshed['attempts'][0]['retryAt'] == 1600
    assert refreshed['attempts'][0]['checkedAt'] == 1000
    clock[0] = 1601
    trends._fetch('weibo', refresh=True)
    assert sum('xxapi' in url for url in calls) == 2


def test_long_retry_after_never_extends_the_stale_data_lifetime(monkeypatch):
    clock = [1000]
    monkeypatch.setattr(trends.time, 'time', lambda: clock[0])
    monkeypatch.setattr(trends, '_download', lambda url: raw({'data': [{'title': '曾真实获取的榜单'}]}))
    trends._fetch('zhihu')
    clock[0] += 301
    def failure(url):
        raise trends.SourceError('rate_limited', '来源请求限流（HTTP 429）', retry_at=200000)
    monkeypatch.setattr(trends, '_download', failure)
    stale = trends._fetch('zhihu', refresh=True)
    assert stale['status'] == 'stale'
    assert stale['fetchedAt'] == 1000
    clock[0] = 1000 + trends.MAX_STALE_SECONDS
    expired = trends._fetch('zhihu', refresh=True)
    assert expired['status'] == 'error'
    assert expired['items'] == []
    assert expired['fetchedAt'] is None
    assert expired['checkedAt'] == 1301
    assert expired['error']['code'] == 'rate_limited'
    assert expired['nextRetryAt'] == 200000


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
