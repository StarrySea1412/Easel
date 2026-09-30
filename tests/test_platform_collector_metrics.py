"""Regression tests for missing versus zero platform metrics, with fake API payloads."""
import copy
import json
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'skills/shared/scripts'))
import bili_login as bili
import weixin_mp_stats as mp


def test_wechat_unknown_overview_is_not_zero():
    assert all(mp.EMPTY[key] is None for key in ('followers', 'likes', 'following', 'posts'))


def test_wechat_read_counts_do_not_become_likes_and_missing_counts_stay_unknown():
    result = copy.deepcopy(mp.EMPTY)
    mp._parse_publish(json.dumps({'publish_page': {'publish_list': [{'publish_info': {
        'appmsgex': [{'title': '阅读为零', 'read_num': 0}, {'title': '只提供阅读', 'read_num': 10}]
    }}]}}), result)
    assert result['likes'] is None and result['posts'] is None
    assert result['notes'][0]['metrics']['views'] == 0
    assert result['notes'][0]['metrics'].get('likes') is None
    assert '赞 0' not in result['notes'][0]['stat']
    assert result['notes'][1]['metrics']['views'] == 10
    assert all(metric['label'] != '累计阅读' for metric in result['metrics'])


def test_wechat_explicit_zero_counts_remain_zero():
    result = copy.deepcopy(mp.EMPTY)
    mp._parse_publish(json.dumps({'publish_page': {'total_count': 0, 'publish_count': 0, 'masssend_count': 0, 'publish_list': []}}), result)
    assert result['posts'] == 0
    assert len(result['metrics']) == 3
    assert all(metric['value'] == 0 for metric in result['metrics'])


def test_wechat_missing_trend_fields_do_not_produce_zero_traffic():
    result = copy.deepcopy(mp.EMPTY)
    mp._parse_analytics({'tendency': json.dumps({'all_article_stat_tendency': {'list': [{'date': '2026-09-30'}]}})}, result)
    assert result['metrics'] == []
    assert result['likes'] is None


def test_wechat_real_zero_trend_is_visible_without_claiming_unique_monthly_readers():
    result = copy.deepcopy(mp.EMPTY)
    mp._parse_analytics({'tendency': json.dumps({'all_article_stat_tendency': {'list': [{'read_uv': 0, 'share_uv': 0}]}})}, result)
    assert len(result['metrics']) == 2
    assert all(metric['value'] == 0 for metric in result['metrics'])
    assert all('近30天' not in metric['label'] for metric in result['metrics'])
    assert result['likes'] is None


def test_wechat_analytics_preserves_zero_and_missing_without_title_join():
    result = copy.deepcopy(mp.EMPTY)
    result['notes'] = [{'title': '同名', 'url': 'https://mp.weixin.qq.com/s/one',
                        'stat': '阅读 10', 'metrics': {'views': 10}}]
    mp._parse_analytics({'article_list': json.dumps({'article_list': [
        {'title': '同名', 'link': 'https://mp.weixin.qq.com/s/two'},
        {'title': '改名', 'link': 'https://mp.weixin.qq.com/s/one', 'total_read_uv': 0, 'read_num': 99}
    ]}), 'user': json.dumps({'cumulate_user': ''})}, result)
    note = result['notes'][0]
    assert note['stat'] == '阅读 10' and note['metrics'] == {'views': 10}
    assert note['analytics_evidence'][0]['metrics'] == {'views': 0}
    assert note['analytics_evidence'][0]['stat'] == '阅读 0'
    assert result['unmatched_article_evidence'][0]['stat'] == ''
    assert result['followers'] is None


def test_wechat_article_identity_ignores_session_query_and_requires_unique_match():
    base = 'https://mp.weixin.qq.com/s?__biz=test&mid=12&idx=1'
    assert mp._article_key({'url': base + '&token=private'}) == mp._article_key({'link': base})
    assert mp._article_key({'url': 'https://mp.weixin.qq.com/cgi-bin/home?token=private'}) == ''
    result = copy.deepcopy(mp.EMPTY)
    result['notes'] = [{'title': 'A', 'url': base}, {'title': 'B', 'url': base}]
    mp._parse_analytics({'article_list': json.dumps({'article_list': [
        {'title': 'A', 'link': base, 'read_num': 1}]})}, result)
    assert not any(note.get('analytics_evidence') for note in result['notes'])
    assert len(result['unmatched_article_evidence']) == 1


def test_wechat_sparse_dates_do_not_expand_week_or_claim_complete_totals():
    rows = [{'date': '2026-09-01', 'read_uv': 1000},
            {'date': '2026-09-24', 'read_uv': 0, 'share_uv': 2},
            {'date': '2026-09-30', 'read_uv': 10},
            {'read_uv': 900}]
    result = copy.deepcopy(mp.EMPTY)
    mp._parse_analytics({'tendency': json.dumps({'all_article_stat_tendency': {'list': rows}})}, result)
    window = result['period_windows']['week']
    assert window['actual_from'] == '2026-09-24'
    assert window['actual_to'] == '2026-09-30'
    assert window['observed_days'] == 2 and window['missing_days'] == 5
    assert window['undated_records'] == 1 and not window['calendar_complete']
    assert window['metric_coverage']['share_uv'] == {'known_records': 1, 'sample_records': 2, 'complete': False}
    assert result['metrics'][0]['value'] == 10


def test_wechat_duplicate_conflicts_and_scene_subsets_are_not_daily_totals():
    rows = [{'date': '2026-09-30', 'scene': 1, 'read_uv': 500},
            {'date': '2026-09-30', 'scene': 9999, 'read_uv': 10, 'share_uv': 0},
            {'date': '2026-09-30', 'scene': 9999, 'read_uv': 20, 'share_uv': 0}]
    daily = mp._daily_totals(rows)
    assert daily == [{'date': '2026-09-30', 'scene': 9999, 'read_uv': None, 'share_uv': 0}]
    assert mp._daily_totals([rows[0]]) == []
    assert rows[1]['read_uv'] == 10
    assert mp._tendency_metrics(daily, 1)[0]['label'] == '每日分享人数合计'


def test_wechat_unknown_dates_have_explicit_record_window():
    _, window = mp._tendency_window([{'date': 'unknown', 'read_uv': 0}], 7)
    assert window['kind'] == 'last_records_unknown_dates'
    assert window['actual_from'] is None and window['missing_days'] is None
    assert not window['calendar_complete']


def test_bilibili_missing_note_metrics_are_not_fabricated_as_zero(monkeypatch, capsys):
    monkeypatch.setattr(bili, '_load_cookie', lambda *_: ('test-cookie', 1))

    def api(url, *_):
        if url.endswith('/nav'):
            return {'data': {'isLogin': True, 'uname': '测试账号', 'mid': 1}}
        if '/archives?' in url:
            return {'data': {'archives': [
                {'archive': {'title': '未提供指标', 'bvid': 'BV1'}, 'stat': {}},
                {'archive': {'title': '真实零播放', 'bvid': 'BV2'}, 'stat': {'view': 0}},
            ]}}
        return {'data': {}}

    monkeypatch.setattr(bili, '_api', api)
    assert bili.cmd_stats(SimpleNamespace(cookie='unused')) == 0
    result = json.loads(capsys.readouterr().out)
    assert result['notes'][0]['stat'] == ''
    assert result['notes'][1]['metrics']['views'] == 0
    assert result['notes'][1]['metrics'].get('likes') is None
