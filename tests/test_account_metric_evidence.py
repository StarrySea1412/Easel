import copy
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'web'), str(ROOT / 'skills/shared/scripts')]
from account_stats import douyin_account_metrics, lines_of
from account_metric_evidence import sanitize_metrics, verified_douyin_metrics
from account_analytics_snapshots import AnalyticsSnapshots


def page(metrics):
    return lines_of('数据中心\n统计周期：2026.10.14-2026.10.20（每天12点更新）\n最新作品\n播放量\n97\n账号总览\n近期作品\n直播数据\n时间\n近7日\n'
                    + metrics + '\n互动管理\n收入变现\n近7日\n热门课程\n抖音精选优质内容指南\n播放量\n211.88万')


def test_account_overview_does_not_read_course_or_latest_work_views():
    metrics, source = douyin_account_metrics(page('播放量\n播放量\n1294\n较前7日+65\n主页访问量\n30\n较前7日+15'))
    assert metrics == [{'label': '播放量', 'value': '1294', 'vs': '+65'},
                       {'label': '主页访问量', 'value': '30', 'vs': '+15'}]
    assert verified_douyin_metrics(source)
    assert source['from'] == '2026-10-14' and source['to'] == '2026-10-20'


@pytest.mark.parametrize('body', ['', '播放量\n加载中', '作品评论\n3'])
def test_missing_account_views_never_fall_through_to_course(body):
    metrics, _ = douyin_account_metrics(page(body))
    assert not any(metric['label'] == '播放量' for metric in metrics)


@pytest.mark.parametrize('replacement', ['近30日', '较前7日', '近7日数据仅供参考'])
def test_period_requires_exact_selected_seven_day_label(replacement):
    assert douyin_account_metrics([replacement if line == '近7日' else line for line in page('播放量\n9')]) == ([], None)


@pytest.mark.parametrize('period', ['2026.10.01-2026.10.20', '2026.02.30-2026.03.08', '未提供'])
def test_no_metrics_without_valid_actual_seven_day_dates(period):
    assert douyin_account_metrics([f'统计周期：{period}' if line.startswith('统计周期') else line for line in page('播放量\n9')]) == ([], None)


def test_real_zero_is_preserved():
    metrics, source = douyin_account_metrics(page('播放量\n0\n较前7日0'))
    assert metrics == [{'label': '播放量', 'value': '0', 'vs': ''}]
    assert verified_douyin_metrics(source)


def test_obsolete_snapshot_keeps_identity_and_works_but_removes_unverified_metrics(tmp_path):
    data = {'platform': 'douyin', 'loggedIn': True, 'nickname': 'Owner', 'followers': 105,
            'notes': [{'title': 'Own work'}], 'metrics': [{'label': '播放量', 'value': '211.88万'}],
            'analysis': {'metrics': [{'label': '播放量', 'value': '211.88万'}]}}
    before = copy.deepcopy(data)
    store = AnalyticsSnapshots(tmp_path)
    store.save('douyin', 'owner', data)
    restored = store.get('douyin', 'owner')
    assert restored['metrics'] == restored['analysis']['metrics'] == []
    assert restored['metricsNeedsRefresh'] is True
    assert restored['notes'] == data['notes'] and restored['followers'] == 105
    assert data == before
    assert sanitize_metrics('zhihu', data) is data


def test_verified_snapshot_retains_metrics(tmp_path):
    metrics, source = douyin_account_metrics(page('播放量\n1294'))
    data = {'platform': 'douyin', 'loggedIn': True, 'metrics': metrics, 'metrics_source': source}
    store = AnalyticsSnapshots(tmp_path)
    store.save('douyin', 'owner', data)
    assert store.get('douyin', 'owner') == data
