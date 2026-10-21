import sys
from pathlib import Path
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from usage_stats import normalize_usage, summarize


def test_weighted_ratio_and_unknown_write_not_zero():
    rows = [normalize_usage({'prompt_tokens': 100, 'prompt_tokens_details': {'cached_tokens': 100}}),
            normalize_usage({'prompt_tokens': 900, 'prompt_tokens_details': {'cached_tokens': 0}})]
    result = summarize(rows)['cacheReuse']
    assert result['ratio'] == .1 and result['eligibleRecords'] == 2
    assert rows[0]['cacheWriteTokens'] is None


@pytest.mark.parametrize('raw,inputs,ratio', [
    ({'input': 10, 'cacheRead': 80, 'cacheWrite': 10}, 100, .8),
    ({'input_tokens': 10, 'cache_read_input_tokens': 80, 'cache_creation_input_tokens': 10}, 100, .8),
    ({'input_tokens': 100, 'input_tokens_details': {'cached_tokens': 80}}, 100, .8),
])
def test_protocols_do_not_double_count_input(raw, inputs, ratio):
    value = normalize_usage(raw)
    assert value['inputTokens'] == inputs
    assert summarize([value])['cacheReuse']['ratio'] == ratio


def test_missing_zero_and_invalid_are_distinct_with_event_unit():
    rows = [normalize_usage({'input': 10, 'cacheRead': 5}), normalize_usage({}),
            normalize_usage({'prompt_tokens': 0, 'prompt_tokens_details': {'cached_tokens': 0}}),
            normalize_usage({'prompt_tokens': 10, 'prompt_tokens_details': {'cached_tokens': 11}}),
            normalize_usage({'prompt_tokens': 10, 'prompt_tokens_details': {'cached_tokens': -1}}),
            normalize_usage({'prompt_tokens': 10, 'cacheRead': 8, 'cacheWrite': 3})]
    rows[0]['engine'] = 'codex'
    result = summarize(rows)['cacheReuse']
    assert result['ratio'] is None
    assert (result['missingRecords'], result['zeroInputRecords'], result['invalidRecords']) == (2, 1, 3)
    assert result['unit'] == 'usage_events'
