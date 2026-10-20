"""Visual summaries preserve the ledger's scope, missing values and privacy."""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from usage_dashboard import dashboard
from usage_stats import summarize

NOW = datetime(2026, 10, 20, 2, tzinfo=timezone.utc)


def call(key, stamp, total=None, **extra):
    return {'id': key, 'sessionId': 's1', 'timestamp': stamp, 'provider': 'openai',
            'model': 'same-model', 'totalTokens': total, 'recordedCostUsd': None, **extra}


def test_days_use_beijing_midnight_and_do_not_lose_all_project_scope():
    rows = [call('a', '2026-10-19T15:59:59Z', 10), call('b', '2026-10-19T16:00:00Z', 20),
            call('old', '2025-01-01T00:00:00Z', 900)]
    data = dashboard(rows, summarize, NOW)
    assert len(data['days']) == 30
    assert data['days'][-2]['date'] == '2026-10-19'
    assert data['days'][-2]['summary']['totalTokens'] == 10
    assert data['days'][-1]['summary']['totalTokens'] == 20
    assert data['models'][0]['summary']['totalTokens'] == 930
    assert data['timezone'] == 'Asia/Shanghai'


def test_missing_cost_and_tokens_remain_unknown_while_zero_is_a_recorded_value():
    data = dashboard([call('missing', '2026-10-18T01:00:00Z'),
                      call('zero', '2026-10-19T01:00:00Z', 0, recordedCostUsd=0)], summarize, NOW)
    missing, zero, empty = [row['summary'] for row in data['days'][-3:]]
    assert missing['calls'] == 1 and missing['totalTokens'] is None
    assert missing['recordedCostUsd'] is None and missing['coverage']['recordedCostUsd'] == 0
    assert zero['totalTokens'] == 0 and zero['recordedCostUsd'] == 0
    assert zero['coverage']['recordedCostUsd'] == 1
    assert empty['calls'] == 0


def test_unknown_future_dates_are_excluded_from_charts_without_removing_totals():
    data = dashboard([call('bad', '', 5), call('future', '2099-01-01T00:00:00Z', 6)], summarize, NOW)
    assert data['undatedCalls'] == 1 and data['futureCalls'] == 1
    assert data['recent'] == []
    assert sum(row['summary']['calls'] for row in data['days']) == 0
    assert data['models'][0]['summary']['totalTokens'] == 11


def test_recent_records_are_sorted_bounded_and_never_expose_message_or_credentials():
    rows = [call(str(i), f'2026-10-20T01:{i:02d}:00Z', i,
                 content='PRIVATE CONTENT', apiKey='PRIVATE SECRET', baseUrl='PRIVATE URL') for i in range(25)]
    data = dashboard(rows, summarize, NOW)
    assert len(data['recent']) == 20 and data['recent'][0]['id'] == '24'
    assert data['recent'][-1]['id'] == '5'
    assert 'PRIVATE' not in json.dumps(data)


def test_same_provider_model_on_distinct_channels_is_never_merged_and_ranking_is_bounded():
    rows = [call(str(i), '2026-10-20T01:00:00Z', i, channelId=f'ch_{i}', channelName=f'渠道{i}') for i in range(10)]
    data = dashboard(rows, summarize, NOW)
    assert len(data['models']) == 8 and data['modelCount'] == 10
    assert data['models'][0]['channelId'] == 'ch_9'
    assert data['models'][0]['summary']['calls'] == 1
