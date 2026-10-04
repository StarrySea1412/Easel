"""Conservative brand attribution from observed assistant metadata, never config.

A model label is a statement made by the execution channel, not independent
verification of a relay's underlying model. Unknown aliases stay unknown.
"""
from datetime import datetime, timezone
import math
import re


_LABEL = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$')
_FAMILIES = {
    'doubao': r'doubao(?:[-.]|$)',
    'deepseek': r'deepseek(?:[-.]|$)',
    'qwen': r'(?:qwen(?:[0-9]|[-.]|$)|qwq(?:[-.]|$))',
    'kimi': r'(?:kimi(?:[-.]|$)|moonshot(?:[-.]|$))',
    'glm': r'glm(?:[-.]|$)',
    'minimax': r'(?:minimax(?:[-.]|$)|abab[0-9])',
    'hunyuan': r'hunyuan(?:[-.]|$)',
    'spark': r'spark(?:[-.]|$)',
    'wenxin': r'ernie(?:[-.]|$)',
    'openai': r'(?:gpt-[0-9]|chatgpt-[0-9]|o[134](?:[-.]|$))',
    'claude': r'claude(?:[-.]|$)',
    'gemini': r'gemini(?:[-.]|$)',
    'grok': r'grok(?:[-.]|$)',
    'mistral': r'(?:mistral(?:[-.]|$)|mixtral(?:[-.]|$)|codestral(?:[-.]|$)|ministral(?:[-.]|$)|magistral(?:[-.]|$))',
}
_NAMESPACES = {'bytedance': 'doubao', 'deepseek': 'deepseek', 'qwen': 'qwen',
               'moonshotai': 'kimi', 'z-ai': 'glm', 'minimax': 'minimax',
               'tencent': 'hunyuan', 'iflytek': 'spark', 'baidu': 'wenxin',
               'openai': 'openai', 'anthropic': 'claude', 'google': 'gemini',
               'x-ai': 'grok', 'mistralai': 'mistral'}


def _label(value):
    return value if isinstance(value, str) and _LABEL.fullmatch(value) else None


def unknown_model():
    return {'provider': 'unknown', 'model': None, 'channel': None, 'source': 'unknown',
            'observedAt': None, 'evidence': '尚未观测到当前轮次的模型身份。'}


def model_provider(model):
    """Match explicit model families; arbitrary relay prefixes are not proof."""
    if not _label(model):
        return 'unknown'
    parts = model.lower().split('/')
    if len(parts) > 2:
        return 'unknown'
    family = next((key for key, pattern in _FAMILIES.items()
                   if re.match(pattern, parts[-1])), 'unknown')
    if len(parts) == 2 and _NAMESPACES.get(parts[0]) != family:
        return 'unknown'
    return family


def observation(metadata, timestamp):
    """The caller must establish assistant execution and session/turn bounds."""
    if not isinstance(metadata, dict):
        return unknown_model()
    try:
        if isinstance(timestamp, bool):
            raise ValueError()
        stamp = (datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
                 if isinstance(timestamp, str) else
                 datetime.fromtimestamp(timestamp / 1000 if timestamp > 1e11 else timestamp, timezone.utc))
        if stamp.tzinfo is None or not math.isfinite(stamp.timestamp()):
            raise ValueError()
    except (TypeError, ValueError, OverflowError, OSError):
        return unknown_model()
    model = _label(metadata.get('model'))
    if not model:
        return unknown_model()
    provider = model_provider(model)
    # provider is an OpenClaw channel key, which can be named "openai" while
    # routing DeepSeek. It never overrides the explicit model family.
    return {'provider': provider, 'model': model,
            'channel': _label(metadata.get('provider')), 'source': 'observed',
            'observedAt': stamp.astimezone(timezone.utc).isoformat(),
            'evidence': ('调用记录标识的模型品牌；中转底层模型未独立验证。' if provider != 'unknown'
                         else '已观测到模型记录，但型号别名无法确认厂商。')}


def latest_observation(events):
    observed = []
    for event in events:
        message = event.get('message', event)
        if not isinstance(message, dict) or message.get('role') != 'assistant':
            continue
        value = observation(message, event.get('timestamp') or message.get('timestamp'))
        if value['source'] == 'observed':
            observed.append(value)
    return max(observed, key=lambda item: item['observedAt'], default=None) or unknown_model()
