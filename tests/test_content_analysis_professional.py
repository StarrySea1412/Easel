"""R42 deterministic professional reports; isolated data, no platform/model access."""
import asyncio
import copy
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from content_analysis import ADVANCED_METRICS, PLATFORMS, Store, markdown
from content_analysis_routes import create_router


def item(ident, tags=None, **changes):
    result = {'id': ident, 'title': f'实际作品 {ident}', 'body': '说明实际问题和步骤。', 'format': 'video',
              'tags': tags or [], 'comments': [], 'publishedAt': '2026-10-01T00:00:00Z',
              'snapshotAt': '2026-10-08T00:00:00Z', 'period': 'lifetime', 'paid': False,
              'metrics': {'views': 100, 'likes': 2, 'comments': 3, 'collects': 4, 'shares': 1}}
    result.update(changes)
    return result


def payload(contents, platform='xiaohongshu', account='a'):
    return {'platform': platform, 'accountId': account, 'name': '同名账号', 'contents': contents}


def group():
    return [item('a', ['实际标签']), item('b', ['实际标签'], metrics={'views': 900, 'likes': 2, 'comments': 3, 'collects': 4, 'shares': 1}), item('c'), item('d')]


@pytest.mark.parametrize('platform', PLATFORMS)
def test_scope_isolates_platform_and_same_name_accounts(tmp_path, platform):
    store = Store(tmp_path)
    report = store.ingest(payload(group(), platform))
    store.ingest(payload([item('private', ['其他'])], platform, 'b'))
    assert report['professional']['scope'] == {'platform': platform, 'accountId': 'a'}
    assert report['professional']['topics'][0]['evidenceIds'] == ['a', 'b']
    assert 'private' not in json.dumps(report['professional'])


@pytest.mark.parametrize('key', ADVANCED_METRICS)
@pytest.mark.parametrize('bad', [-1, True, '20%', '12秒', float('nan'), float('inf'), 10 ** 400])
def test_invalid_advanced_metric_is_atomic(tmp_path, key, bad):
    store = Store(tmp_path)
    with pytest.raises(ValueError):
        store.ingest(payload([item('ok'), item('bad', advancedMetrics={key: bad})]))
    assert store.accounts() == []


def test_advanced_snapshot_restart_and_material_edit(tmp_path):
    store = Store(tmp_path)
    content = item('a', advancedMetrics={'impressions': 500, 'averageWatchSeconds': 12.5, 'followersAttributed': 0})
    store.ingest(payload([content]))
    report = store.ingest(payload([content]))
    assert len(report['contents'][0]['snapshots']) == 1
    assert report['contents'][0]['advancedMetrics']['averageWatchSeconds'] == 12.5
    edited = store.ingest(payload([{'id': 'a', 'body': '改后的正文'}]))['contents'][0]
    assert edited['advancedMetrics']['impressions'] == 500
    assert len(edited['snapshots']) == 1
    assert Store(tmp_path).report('xiaohongshu', 'a')['contents'][0]['advancedMetrics']['followersAttributed'] == 0


def test_new_timestamp_does_not_mix_old_advanced_metrics(tmp_path):
    store = Store(tmp_path)
    store.ingest(payload([item('a', advancedMetrics={'impressions': 500})]))
    current = store.ingest(payload([item('a', snapshotAt='2026-10-09T00:00:00Z')]))['contents'][0]
    assert all(value is None for value in current['advancedMetrics'].values())
    assert current['snapshots'][0]['advancedMetrics']['impressions'] == 500


def test_same_observation_can_merge_complementary_metric_blocks(tmp_path):
    store = Store(tmp_path)
    store.ingest(payload([item('a')]))
    report = store.ingest(payload([{'id': 'a', 'snapshotAt': '2026-10-08T00:00:00Z', 'period': 'lifetime', 'paid': False,
                                    'advancedMetrics': {'impressions': 500}}]))
    assert report['contents'][0]['metrics']['views'] == 100
    assert report['contents'][0]['advancedMetrics']['impressions'] == 500


def test_old_records_and_snapshots_without_advanced_fields_remain_readable(tmp_path):
    store = Store(tmp_path)
    store.ingest(payload([item('a')]))
    with store.connect() as db:
        raw = json.loads(db.execute('SELECT data FROM contents').fetchone()[0])
        raw.pop('advancedMetrics')
        db.execute('UPDATE contents SET data=?', (json.dumps(raw),))
    content = Store(tmp_path).report('xiaohongshu', 'a')['contents'][0]
    assert content['advancedMetrics'] == dict.fromkeys(ADVANCED_METRICS)
    assert content['snapshots'][0]['advancedMetrics'] == dict.fromkeys(ADVANCED_METRICS)


@pytest.mark.parametrize('change,reason', [({'period': 'unknown'}, '窗口未知'), ({'format': 'unknown'}, '形式未知'),
    ({'paid': None}, '投放状态未知'), ({'publishedAt': None}, '发布时间'),
    ({'publishedAt': '2026-10-09T00:00:00Z'}, '早于发布时间')])
def test_unknown_conditions_excluded(tmp_path, change, reason):
    report = Store(tmp_path).ingest(payload([item('a', **change), item('b', **change)]))['professional']
    assert report['quality']['comparable'] == 0 and report['cohorts'] == []
    assert any(reason in text for record in report['quality']['excluded'] for text in record['reasons'])


def test_age_paid_and_period_do_not_mix(tmp_path):
    works = [item('a'), item('b', publishedAt='2026-09-30T00:00:00Z'), item('c', paid=True), item('d', period='7d')]
    report = Store(tmp_path).ingest(payload(works))['professional']
    assert report['cohorts'] == [] and report['quality']['comparable'] == 0


def test_timed_windows_require_identical_endpoint(tmp_path):
    report = Store(tmp_path).ingest(payload([item('a', period='7d'), item('b', period='7d', snapshotAt='2026-10-08T01:00:00Z')]))['professional']
    assert report['cohorts'] == []


def test_event_rate_uses_sum_numerator_over_sum_denominator(tmp_path):
    professional = Store(tmp_path).ingest(payload(group()))['professional']
    topic = professional['topics'][0]
    assert professional['quality']['comparable'] == 4
    assert topic['status'] == 'exploratory'
    assert topic['value'] == 2 and topic['baselineValue'] == 10
    assert topic['counterexampleIds'] == ['c', 'd']
    assert topic['sampleCount'] == 2 and topic['totalCount'] == 4 and topic['missingCount'] == 0
    assert '每百次观看互动事件' in topic['metricLabel'] and '一个变量' in topic['action']
    assert datetime.fromisoformat(topic['reviewAt']) > datetime.now(timezone.utc) + timedelta(days=6)


@pytest.mark.parametrize('metrics', [{'views': 0, 'likes': 0, 'comments': 0, 'collects': 0, 'shares': 0}, {'views': 100, 'likes': 1, 'comments': 1, 'collects': 1}])
def test_zero_denominator_or_missing_event_never_fabricates_rate(tmp_path, metrics):
    works = group()
    works[0]['metrics'] = metrics
    works[1]['metrics'] = metrics
    topic = Store(tmp_path).ingest(payload(works))['professional']['topics'][0]
    assert topic['value'] is None and topic['status'] == 'needs_data'


def test_tag_threshold_and_comments_are_only_topic_sources(tmp_path):
    works = [item('a', ['single'], comments=['如何选镜头？', '如何选镜头？']), item('b')]
    topics = Store(tmp_path).ingest(payload(works))['professional']['topics']
    assert len(topics) == 1 and topics[0]['kind'] == 'comment_question'
    assert topics[0]['label'] == '如何选镜头' and topics[0]['sampleCount'] == 1
    assert topics[0]['status'] == 'editorial' and topics[0]['value'] is None


def test_single_baseline_is_not_presented_as_comparison_value(tmp_path):
    topic = Store(tmp_path).ingest(payload(group()[:3]))['professional']['topics'][0]
    assert topic['value'] == 2 and topic['baselineValue'] is None and topic['status'] == 'needs_data'


def test_missing_video_length_disables_watch_capability(tmp_path):
    professional = Store(tmp_path).ingest(payload([item('a', advancedMetrics={'completions': 50, 'averageWatchSeconds': 20})]))['professional']
    watch = next(c for c in professional['capabilities'] if c['id'] == 'watch')
    assert watch['available'] == 0 and watch['status'] == 'needs_data'
    assert '优劣排名' in watch['limitation']


def test_large_finite_observations_do_not_export_infinite_aggregates(tmp_path):
    values = {'views': 1e308, 'likes': 1e308, 'comments': 1e308, 'collects': 1e308, 'shares': 1e308}
    report = Store(tmp_path).ingest(payload([item('a', ['标签'], metrics=values), item('b', ['标签'], metrics=values)]))
    assert report['overview']['totals']['views'] is None
    assert report['professional']['topics'][0]['value'] is None
    json.dumps(report, allow_nan=False)


def experiment(topic):
    return {'platform': 'xiaohongshu', 'accountId': 'a', 'title': '验证题材', 'hypothesis': topic['hypothesis'],
            'action': topic['action'], 'metric': 'collects', 'contentIds': topic['evidenceIds'],
            'evidence': {'scope': {'platform': 'xiaohongshu', 'accountId': 'a'}, 'topic': topic, 'capturedAt': '2020-01-01T00:00:00Z'}}


def test_experiment_freezes_server_topic_not_client_numbers(tmp_path):
    store = Store(tmp_path)
    topic = store.ingest(payload(group()))['professional']['topics'][0]
    forged = copy.deepcopy(topic)
    forged['value'] = 999999
    result = store.experiment(experiment(forged))
    assert result['evidence']['topic']['value'] == 2
    assert result['evidence']['capturedAt'] != '2020-01-01T00:00:00Z'
    store.ingest(payload([item('a', ['实际标签'], metrics={'views': 1000})]))
    assert store.report('xiaohongshu', 'a')['experiments'][0]['evidence']['topic']['value'] == 2
    with pytest.raises(ValueError, match='改变'):
        store.experiment(experiment(topic))


@pytest.mark.parametrize('mutation', [lambda d: d['evidence']['scope'].update(platform='douyin'), lambda d: d.update(contentIds=['a']), lambda d: d['evidence']['topic'].update(id='unknown')])
def test_experiment_rejects_cross_scope_unknown_or_partial_topic(tmp_path, mutation):
    store = Store(tmp_path)
    data = experiment(store.ingest(payload(group()))['professional']['topics'][0])
    mutation(data)
    with pytest.raises(ValueError):
        store.experiment(data)


def test_advanced_metric_experiment_and_export(tmp_path):
    store = Store(tmp_path)
    report = store.ingest(payload([item('a', advancedMetrics={'followersAttributed': 2})]))
    exp = store.experiment({'platform': 'xiaohongshu', 'accountId': 'a', 'title': '验证关注', 'hypothesis': '需要继续观察', 'action': '修改一个变量',
                            'metric': 'followersAttributed', 'contentIds': ['a']})
    assert exp['baseline'][0]['value'] == 2
    store.ingest(payload([item('a', snapshotAt='2026-10-09T00:00:00Z', advancedMetrics={'followersAttributed': 4})]))
    reviewed = store.experiment({'platform': 'xiaohongshu', 'accountId': 'a', 'status': 'reviewed'}, exp['id'])
    assert reviewed['reviews'][0]['observations'][0]['delta'] == 2
    document = markdown(report)
    assert '高级指标' in document and '可诊断问题与数据依据' in document and 'followersAttributed=2' in document


@pytest.mark.parametrize('key', ['averageWatchSeconds', 'durationSeconds'])
def test_measurement_metrics_are_never_cumulative_experiment_deltas(tmp_path, key):
    store = Store(tmp_path)
    store.ingest(payload([item('a', advancedMetrics={key: 20})]))
    exp = store.experiment({'platform': 'xiaohongshu', 'accountId': 'a', 'title': '验证观测', 'hypothesis': '需要继续观察', 'action': '修改一个变量',
                            'metric': key, 'contentIds': ['a']})
    store.ingest(payload([item('a', snapshotAt='2026-10-09T00:00:00Z', advancedMetrics={key: 30})]))
    observation = store.experiment({'platform': 'xiaohongshu', 'accountId': 'a', 'status': 'reviewed'}, exp['id'])['reviews'][0]['observations'][0]
    assert observation['value'] == 30 and observation['delta'] is None and observation['comparable'] is False


def test_integer_metric_totals_keep_precision(tmp_path):
    large = 9007199254740993
    report = Store(tmp_path).ingest(payload([item('a', metrics={'views': large}), item('b', metrics={'views': 1})]))
    assert report['overview']['totals']['views'] == large + 1


def test_http_template_report_and_export_contract(tmp_path):
    async def run():
        app = FastAPI()
        app.include_router(create_router(lambda: tmp_path, lambda p: None))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            template = (await client.get('/api/content-analysis/template?platform=douyin')).json()
            assert template['contents'][0]['advancedMetrics'] == dict.fromkeys(ADVANCED_METRICS)
            report = await client.post('/api/content-analysis/import', json=payload(group()))
            assert report.status_code == 200 and report.json()['professional']['scope']['platform'] == 'xiaohongshu'
            exported = (await client.get('/api/content-analysis/export?platform=xiaohongshu&accountId=a')).json()
            assert exported['professional']['topics'][0]['evidenceIds'] == ['a', 'b']
    asyncio.run(run())
