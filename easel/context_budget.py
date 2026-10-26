"""Local prompt estimates and operational admission, never native token usage.

External history, tool state and image tokens are not observable here. The
configured reserve is headroom, not a measurement of that hidden context.
"""
from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass

ESTIMATOR = 'unicode-weighted/1'
DEFAULT_PROMPT_BUDGET = 180_000
DEFAULT_FIXED_RESERVE = 16_000
MIN_PROMPT_BUDGET = 16_000
MAX_PROMPT_BUDGET = 10_000_000
DEFAULT_MEMORY_BUDGET = 4_000


def _bounded_int(value, default, *, minimum, maximum):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(parsed, maximum))


def prompt_budget():
    return _bounded_int(os.environ.get('EASEL_CHAT_PROMPT_BUDGET_TOKENS'),
                        DEFAULT_PROMPT_BUDGET, minimum=MIN_PROMPT_BUDGET, maximum=MAX_PROMPT_BUDGET)


def fixed_reserve():
    return _bounded_int(os.environ.get('EASEL_CHAT_PROMPT_RESERVE_TOKENS'),
                        DEFAULT_FIXED_RESERVE, minimum=0, maximum=MAX_PROMPT_BUDGET // 2)


def memory_budget():
    return _bounded_int(os.environ.get('EASEL_MEMORY_BUDGET_TOKENS'),
                        DEFAULT_MEMORY_BUDGET, minimum=0, maximum=100_000)


def estimate_tokens(text: str) -> int:
    """ASCII: four chars/unit; other Unicode: two UTF-8 bytes/unit.

    This deliberately reproducible heuristic is not a tokenizer or upper bound.
    """
    if not isinstance(text, str) or not text:
        return 0
    return math.ceil(sum(1 if ord(char) < 128 else 2 * len(char.encode('utf-8', errors='replace'))
                         for char in text) / 4)


def serialized(value, *, compact=False):
    return json.dumps(value, ensure_ascii=False, **({'separators': (',', ':')} if compact else {}))


def experience_reference(context):
    """The exact optional model reference; diagnostics never feed themselves."""
    if not context or not context.get('entries'):
        return None
    return {'source': 'profile-experience', 'profileId': context['profileId'],
            'revision': context['revision'], 'entries': context['entries']}


@dataclass(frozen=True)
class PromptAdmission:
    estimated_prompt_tokens: int
    budget_tokens: int
    reserve_tokens: int
    remaining_tokens: int
    admitted: bool

    @property
    def reason(self):
        return 'ok' if self.admitted else 'context_budget'

    def public(self):
        return {'estimatedPromptTokens': self.estimated_prompt_tokens,
                'budgetTokens': self.budget_tokens, 'reserveTokens': self.reserve_tokens,
                'remainingTokens': self.remaining_tokens, 'admitted': self.admitted,
                'reason': self.reason, 'estimator': ESTIMATOR,
                'scope': 'local-assembled-input', 'nativeContextMeasured': False}


def admit(text, *, budget=None, reserve=None):
    budget_tokens = budget if isinstance(budget, int) and budget > 0 else prompt_budget()
    reserve_tokens = reserve if isinstance(reserve, int) and reserve >= 0 else fixed_reserve()
    estimated = estimate_tokens(text) + reserve_tokens
    remaining = budget_tokens - estimated
    return PromptAdmission(estimated, budget_tokens, reserve_tokens, remaining, remaining >= 0)


class ContextBudgetError(ValueError):
    def __init__(self, admission):
        self.admission = admission
        super().__init__('本轮组装内容超过本地估算预算，未提交模型请求；请缩小材料或新建对话后分批继续。')

    def public(self):
        return {'code': 'chat_context_budget', 'category': 'context_budget',
                'retryable': True, 'message': str(self), **self.admission.public()}


def require_admitted(text):
    result = admit(text)
    if not result.admitted:
        raise ContextBudgetError(result)
    return result
