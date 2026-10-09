"""CC Switch-compatible accounting over normalized, cache-inclusive input.

No price guessing, character-to-token conversion, or provider invoice claims.
"""
from decimal import Decimal, InvalidOperation

RATE_FIELDS = ('input', 'output', 'cacheRead', 'cacheWrite')


def decimal(value):
    if isinstance(value, bool):
        return None
    try:
        result = Decimal(str(value))
        return result if result.is_finite() and 0 <= result <= Decimal('1000000') else None
    except (InvalidOperation, ValueError):
        return None


def validate_price(value):
    if not isinstance(value, dict) or value.get('currency') != 'USD':
        raise ValueError('价格币种须为 USD，单位为每百万 Token')
    result = {'currency': 'USD'}
    for key in (*RATE_FIELDS, 'multiplier'):
        number = decimal(value.get(key))
        if number is None:
            raise ValueError('各项价格及倍率须为非负有限数值')
        result[key] = str(number)
    source = value.get('source')
    if not isinstance(source, str) or not source.strip() or len(source) > 100:
        raise ValueError('请填写价格来源，最多 100 字')
    result['source'] = source.strip()
    return result


def calculate_cost(call, price):
    try:
        price = validate_price(price)
    except ValueError:
        return None
    fields = ('inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens')
    counts = [call.get(key) for key in fields]
    # Missing cache buckets cannot silently become zero; the caller must know
    # the provider's actual cache counts before applying a split price.
    if any(isinstance(n, bool) or not isinstance(n, int) or n < 0 for n in counts):
        return None
    fresh = counts[0] - counts[2] - counts[3]
    if fresh < 0:
        return None
    counts[0] = fresh
    parts = {key: Decimal(n) * Decimal(price[key]) / 1_000_000
             for key, n in zip(RATE_FIELDS, counts)}
    total = sum(parts.values()) * Decimal(price['multiplier'])
    return {'totalUsd': str(total), 'partsUsd': {k: str(v) for k, v in parts.items()},
            'freshInputTokens': fresh, 'pricing': price}


def speed(output_tokens, duration_ms, first_token_ms=None):
    def valid(value):
        return isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0 and value < float('inf')
    if not valid(output_tokens) or not valid(duration_ms):
        return None, None
    if valid(first_token_ms):
        generation = duration_ms - first_token_ms
        if output_tokens >= 100 and generation >= 100:
            return round(output_tokens * 1000 / generation, 3), 'stream'
    elif first_token_ms is None and output_tokens >= 200 and duration_ms >= 1000:
        return round(output_tokens * 1000 / duration_ms, 3), 'estimated'
    return None, None
