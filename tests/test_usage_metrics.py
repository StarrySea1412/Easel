import sys
from pathlib import Path
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from usage_metrics import calculate_cost, validate_price, speed


PRICE = {'currency': 'USD', 'input': '3', 'output': '15', 'cacheRead': '.3',
         'cacheWrite': '3.75', 'multiplier': '1.5', 'source': 'synthetic quote'}


def test_ccswitch_decimal_price_cache_semantics_multiplier_and_missing_fields():
    call = {'inputTokens': 1000, 'outputTokens': 500, 'cacheReadTokens': 200, 'cacheWriteTokens': 100}
    result = calculate_cost(call, PRICE)
    assert result['freshInputTokens'] == 700
    assert result['totalUsd'] == '0.0150525'
    assert result['partsUsd']['input'] == '0.0021'
    assert calculate_cost({**call, 'cacheReadTokens': None}, PRICE) is None
    assert calculate_cost({**call, 'cacheReadTokens': 1001}, PRICE) is None
    assert calculate_cost(call, {}) is None
    # Explicit free prices are valid; unknown prices do not become free.
    free = {**PRICE, **{key: '0' for key in ('input', 'output', 'cacheRead', 'cacheWrite')}}
    assert calculate_cost(call, free)['totalUsd'] == '0.0'
    for value in ('NaN', '-1', 'Infinity', True):
        with pytest.raises(ValueError): validate_price({**PRICE, 'input': value})


def test_ccswitch_speed_rejects_short_bursts_and_weights_generation_window():
    assert speed(300, 8000, 2000) == (50.0, 'stream')
    assert speed(99, 8000, 2000) == (None, None)
    assert speed(300, 2050, 2000) == (None, None)
    assert speed(300, 15000) == (20.0, 'estimated')
    assert speed(199, 15000) == (None, None)
    assert speed(500, 900) == (None, None)
    assert speed(500, 1000, 2000) == (None, None)
