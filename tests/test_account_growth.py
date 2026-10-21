"""Account growth uses persisted, identity-scoped evidence; no live platform calls."""
import asyncio
import json
import sqlite3
import sys
from pathlib import Path

sys.path[:0] = [str(Path(__file__).resolve().parents[1] / 'web')]
from account_analytics_snapshots import AnalyticsSnapshots

NOW = 1800000000
DAY = 86400


def sample(ts=NOW, account='owner', **metrics):
    return {'platform': 'douyin', 'accountId': account, 'loggedIn': True,
            'fetched_at': ts, 'followers': 100, 'likes': 200, 'posts': 10,
            'notes': [], **metrics}


def test_five_windows_have_distinct_real_baselines_and_survive_restart(tmp_path):
    store = AnalyticsSnapshots(tmp_path)
    for days, followers in [(365, 10), (30, 20), (7, 30), (1, 40), (.01, 50)]:
        store.save('douyin', 'identity', sample(NOW - days * DAY, followers=followers))
    result = store.save('douyin', 'identity', sample())
    assert [result['growth'][w]['followers'] for w in ('last', 'day', 'week', 'month', 'year')] == [50, 60, 70, 80, 90]
    assert result['growth']['week']['baseline_at'] == NOW - 7 * DAY
    assert result['growth']['week']['current_at'] == NOW
    assert AnalyticsSnapshots(tmp_path).get('douyin', 'identity') == result


def test_new_identity_account_and_platform_never_share_growth(tmp_path):
    store = AnalyticsSnapshots(tmp_path)
    store.save('douyin', 'identity', sample(NOW - DAY))
    for platform, identity, account in [('douyin', 'other', 'owner'),
                                         ('douyin', 'identity', 'other'), ('zhihu', 'identity', 'owner')]:
        result = store.save(platform, identity, sample(account=account))
        assert all(value is None for value in result['growth'].values())


def test_no_baseline_is_missing_not_zero_and_repeated_timestamp_is_not_last(tmp_path):
    store = AnalyticsSnapshots(tmp_path)
    first = store.save('douyin', 'identity', sample())
    assert all(value is None for value in first['growth'].values())
    assert store.save('douyin', 'identity', sample())['growth'] == first['growth']
    later = store.save('douyin', 'identity', sample(NOW + 1))
    assert later['growth']['last']['followers'] == 0
    assert later['growth']['day'] is None


def test_existing_scoped_snapshot_becomes_baseline_on_next_collection(tmp_path):
    store = AnalyticsSnapshots(tmp_path)
    with sqlite3.connect(store.path) as db:
        db.execute('INSERT INTO snapshots VALUES(?,?,?)',
                   ('douyin', 'identity', json.dumps(sample(NOW - DAY, followers=80))))
    result = store.save('douyin', 'identity', sample())
    assert result['growth']['day']['followers'] == 20
    corrected = store.save('douyin', 'identity', sample(followers=105))
    assert corrected['growth']['last']['baseline_at'] == NOW - DAY
    assert store.save('douyin', 'identity', sample(NOW + 1))['growth']['last']['followers'] == -5


def test_missing_metrics_zero_and_decrease_are_distinct(tmp_path):
    store = AnalyticsSnapshots(tmp_path)
    store.save('douyin', 'identity', sample(NOW - DAY, posts=None))
    result = store.save('douyin', 'identity', sample(followers=90, likes=200))
    assert result['growth']['day']['followers'] == -10
    assert result['growth']['day']['likes'] == 0
    assert result['growth']['day']['posts'] is None


def test_ancient_and_future_records_are_not_nearby_periods(tmp_path):
    store = AnalyticsSnapshots(tmp_path)
    store.save('douyin', 'identity', sample(NOW - 370 * DAY))
    store.save('douyin', 'identity', sample(NOW + DAY))
    result = store.save('douyin', 'identity', sample())
    assert result['growth']['last']['since_days'] == 370
    assert result['growth']['year']['since_days'] == 370
    assert all(result['growth'][w] is None for w in ('day', 'week', 'month'))


def test_legacy_platform_growth_and_unverified_account_are_not_used(tmp_path):
    store = AnalyticsSnapshots(tmp_path)
    data = sample(account='', growth={'day': {'followers': 999}})
    result = store.save('douyin', 'identity', data)
    assert all(value is None for value in result['growth'].values())
    assert data['growth']['day']['followers'] == 999, 'caller payload is not mutated'
    result = store.save('douyin', 'identity', sample(NOW + DAY))
    assert all(value is None for value in result['growth'].values())


def test_failed_capture_keeps_last_success_and_does_not_create_baseline(tmp_path):
    store = AnalyticsSnapshots(tmp_path)
    store.save('douyin', 'identity', sample())
    for bad in [sample(NOW + 1, loggedIn=False), sample(NOW + 1, error='failed')]:
        store.save('douyin', 'identity', bad)
    assert store.get('douyin', 'identity')['fetched_at'] == NOW
    assert store.save('douyin', 'identity', sample(NOW + 2))['growth']['last']['baseline_at'] == NOW


def test_collection_and_snapshot_api_return_same_scoped_growth(tmp_path, monkeypatch):
    import app as web
    monkeypatch.setattr(web, 'OUTPUTS_DIR', tmp_path)
    monkeypatch.setattr(web, '_account_identity_key', lambda _: 'identity')
    monkeypatch.setattr(web, '_content_analysis_session_generation', lambda _: 'generation')
    AnalyticsSnapshots(tmp_path / '_analytics').save('douyin', 'identity', sample(NOW - DAY, followers=80))

    async def capture(_):
        return sample()

    monkeypatch.setattr(web, '_capture_account_analytics', capture)

    async def exercise():
        result = await web.api_analytics('douyin')
        assert result['growth']['day']['followers'] == 20
        assert (await web.api_analytics_snapshot('douyin'))['data']['growth'] == result['growth']

    asyncio.run(exercise())
