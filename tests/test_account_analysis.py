"""Isolated evidence and route tests; no platform login or live network calls."""
import asyncio
import copy
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'web')]
import app as web
from account_analysis import PLATFORMS, build_analysis, safe_link


@pytest.mark.parametrize('platform', PLATFORMS)
def test_all_supported_platforms_keep_missing_values_and_zero_distinct(platform):
    report = build_analysis(platform, {'loggedIn': True, 'followers': 0, 'posts': None,
                                      'fetched_at': 1790724000, 'notes': [], 'metrics': []})
    fields = {item['key']: item['value'] for item in report['overview']}
    assert fields == {'followers': 0, 'likes': None, 'following': None, 'posts': None}
    assert report['coverage'] == {'notes': 0, 'numericMetrics': 1}
    assert report['fetchedAt'] == 1790724000
    assert report['status'] == 'partial'
    assert '没有作品' in ' '.join(report['missingFields'])
    assert report['source']['url'].startswith('https://')


def test_failed_login_never_presents_cached_numbers_or_advice():
    report = build_analysis('douyin', {'loggedIn': False, 'followers': 900, 'posts': 10,
        'metrics': [{'label': '作品评论', 'value': '12'}], 'notes': [{'title': 'previous account'}]})
    assert all(field['value'] is None for field in report['overview'])
    assert report['metrics'] == report['notes'] == report['suggestions'] == []
    assert report['status'] == 'logged_out'


def test_unreliable_period_and_growth_are_not_fabricated():
    report = build_analysis('kuaishou', {'loggedIn': True, 'metrics': [{'label': '评论量', 'value': '2', 'vs': '+1'}],
        'growth': {'day': {'followers': 888}}, 'fetched_at': 'invalid'})
    assert '未返回起止日期' in report['period']
    assert report['metrics'][0]['comparison'] == '+1'
    assert report['fetchedAt'] is None
    assert '888' not in json.dumps(report)
    assert any('2' in suggestion['reason'] for suggestion in report['suggestions'])


def test_iso_timestamp_and_platform_specific_link_label():
    report = build_analysis('wechat-oa', {'loggedIn': True, 'fetched_at': '2026-09-30T12:00:00+08:00'})
    assert isinstance(report['fetchedAt'], int)
    report = build_analysis('kuaishou', {'loggedIn': True, 'notes': [{
        'title': '示例作品', 'url': 'https://cp.kuaishou.com/article/manage/video', 'stat': '平台原始文字'}]})
    assert report['notes'][0]['linkLabel'] == '打开管理页'
    assert report['notes'][0]['stat'] == '平台原始文字'
    assert any('不能据此' in missing for missing in report['notes'][0]['missingFields'])


@pytest.mark.parametrize('url', ['javascript:alert(1)', 'https://bilibili.com.evil.test/video/1',
                                'https://user:pass@bilibili.com/video/1', 'http://www.bilibili.com/video/1'])
def test_external_or_unsafe_links_are_not_presented_as_evidence(url):
    assert safe_link(url, ('bilibili.com',)) == ''


def test_invalid_metric_values_are_missing_and_input_is_not_modified():
    raw = {'loggedIn': True, 'followers': True, 'likes': -1, 'posts': float('nan'),
           'metrics': [{'label': '播放', 'value': '未知'}, {'label': '收藏', 'value': '1.2万'}],
           'notes': [{'title': '作品', 'metrics': {'likes': 0}, 'url': 'https://www.bilibili.com/video/BV123'}]}
    before = copy.deepcopy(raw['notes'])
    report = build_analysis('bilibili', raw)
    assert all(field['value'] is None for field in report['overview'])
    assert report['metrics'] == [{'label': '收藏', 'value': '1.2万', 'comparison': ''}]
    assert report['notes'][0]['metrics'] == [{'label': '点赞', 'value': 0}]
    assert raw['notes'] == before


def test_quality_counts_content_evidence_without_promoting_partial_data_to_ready():
    report = build_analysis('bilibili', {'loggedIn': True, 'followers': 1, 'likes': 2,
        'following': 3, 'posts': 4, 'metrics': [{'label': '播放', 'value': 12}],
        'notes': [
            {'title': '零是真实数据', 'metrics': {'views': 0, 'likes': 0},
             'publish': '2026-09-29', 'url': 'https://www.bilibili.com/video/BV1'},
            {'title': '只有文字', 'stat': '播放 100', 'publish': '昨天',
             'url': 'https://member.bilibili.com/platform/upload-manager/article'},
            {'title': '缺失', 'metrics': {'views': float('nan'), 'likes': False}},
        ]})
    quality = report['quality']
    assert quality['returnedNotes'] == 3
    assert quality['notesWithMetrics'] == 1
    assert quality['structuredMetricValues'] == 2
    assert quality['notesMissingPublishTime'] == 2
    assert quality['notesMissingOriginalLink'] == 2
    assert quality['level'] == 'metrics_available'
    assert quality['canComparePerformance'] is False
    assert quality['periodKnown'] is False
    assert report['status'] == 'partial'


def test_quality_hides_logged_out_evidence_and_names_zhihu_native_metrics():
    raw = {'loggedIn': True, 'likes': 3, 'notes': [{'metrics': {'views': 10, 'likes': 0}}]}
    report = build_analysis('zhihu', raw)
    assert report['overview'][1]['label'] == '赞同'
    assert report['notes'][0]['metrics'] == [{'label': '阅读', 'value': 10}, {'label': '赞同', 'value': 0}]
    raw['loggedIn'] = False
    quality = build_analysis('zhihu', raw)['quality']
    assert quality['returnedNotes'] == quality['structuredMetricValues'] == 0
    assert quality['level'] == 'no_content'


def test_wechat_preserves_separate_article_sources_and_window_gaps():
    evidence = {'title': '文章', 'metrics': {'views': 7, 'shares': 0}}
    raw = {'loggedIn': True, 'notes': [{'title': '文章', 'metrics': {'views': 20},
                                      'analytics_evidence': [evidence]}],
           'unmatched_article_evidence': [evidence],
           'period_windows': {'week': {'actual_from': '2026-09-23', 'actual_to': '2026-09-29',
                                      'observed_days': 5, 'missing_days': 2, 'calendar_complete': False}}}
    report = build_analysis('wechat-oa', raw)
    assert report['notes'][0]['metrics'] == [{'label': '阅读', 'value': 20}]
    assert report['notes'][0]['analyticsEvidence'][0]['metrics'] == [
        {'label': '阅读人数', 'value': 7}, {'label': '分享人数', 'value': 0}]
    assert report['quality']['structuredMetricValues'] == 1
    assert report['periodWindows'][0]['missingDays'] == 2
    assert len(report['unmatchedEvidence']) == 1
    raw['loggedIn'] = False
    logged_out = build_analysis('wechat-oa', raw)
    assert logged_out['periodWindows'] == logged_out['unmatchedEvidence'] == []


def test_partial_metric_coverage_and_window_survive_presentation():
    report = build_analysis('wechat-oa', {'loggedIn': True, 'metrics': [{
        'label': '每日分享人数合计', 'value': 0,
        'coverage': {'known_records': 2, 'sample_records': 3, 'complete': False},
        'window': {'kind': 'rolling_observed_dates', 'actual_from': '2026-09-25',
                   'actual_to': '2026-09-29', 'missing_days': 4,
                   'aggregation': 'sum_daily_uv_not_period_unique'}}]})
    metric = report['metrics'][0]
    assert metric['value'] == '0'
    assert metric['coverage'] == {'knownRecords': 2, 'sampleRecords': 3, 'complete': False}
    assert metric['window']['missingDays'] == 4
    assert metric['window']['aggregation'] == 'sum_daily_uv_not_period_unique'
    assert '部分合计' in report['suggestions'][0]['reason']


def test_publish_sample_complete_is_not_account_complete_and_extras_use_uv():
    report = build_analysis('wechat-oa', {'loggedIn': True,
        'metrics': [{'label': '已获取列表阅读合计', 'value': 50,
                     'coverage': {'known_records': 2, 'sample_records': 2, 'complete': True},
                     'window': {'kind': 'returned_publish_records', 'account_complete': False}}],
        'notes': [{'title': '来自分析列表', 'source': 'appmsganalysis.article_list',
                   'metrics': {'views': 8, 'shares': 0}}]})
    assert report['metrics'][0]['coverage']['complete'] is True
    assert report['metrics'][0]['window']['accountComplete'] is False
    assert report['notes'][0]['metrics'] == [{'label': '阅读人数', 'value': 8}, {'label': '分享人数', 'value': 0}]
    assert any('文章分析列表' in field for field in report['notes'][0]['missingFields'])


@pytest.fixture
def api_stub(tmp_path, monkeypatch):
    monkeypatch.setattr(web, 'OUTPUTS_DIR', tmp_path / 'outputs')
    monkeypatch.setattr(web, '_proxy_env', lambda: {})
    calls = []

    def install(data, returncode=0):
        def run(cmd, **_):
            calls.append(cmd)
            return SimpleNamespace(stdout=json.dumps(data), stderr='', returncode=returncode)
        monkeypatch.setattr(web.subprocess, 'run', run)
    return install, calls


@pytest.mark.parametrize('platform', PLATFORMS)
def test_existing_collect_routes_return_platform_evidence(api_stub, platform):
    install, calls = api_stub
    install({'platform': platform, 'loggedIn': True, 'notes': [], 'followers': 15, 'fetched_at': 1790724000})
    result = asyncio.run(web.api_analytics(platform))
    assert result['analysis']['source']['label'] == PLATFORMS[platform][0]
    assert result['analysis']['coverage']['numericMetrics'] == 1
    assert len(calls) == 1
    assert ('bili_login.py' in calls[0][1] if platform == 'bilibili' else
            'weixin_mp_stats.py' in calls[0][1] if platform == 'wechat-oa' else
            calls[0][-1] == platform)


@pytest.mark.parametrize('data,code', [({'loggedIn': True, 'notes': [], 'error': 'private detail'}, 0),
    ({'loggedIn': True, 'notes': []}, 1), ({'loggedIn': True, 'notes': ['bad']}, 0), ({'notes': []}, 0)])
def test_partial_or_malformed_collection_is_not_reported_as_success(api_stub, data, code):
    api_stub[0](data, code)
    with pytest.raises(web.HTTPException) as error:
        asyncio.run(web.api_analytics('douyin'))
    assert error.value.status_code == 502
    assert 'private detail' not in error.value.detail
