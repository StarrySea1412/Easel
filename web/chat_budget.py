"""Conservative preflight for long chat prompts.

The provider's native context window is not always discoverable (138's model
catalog currently reports ``null`` for it).  This guard is therefore an
operational admission budget, not a claim about the model's official window.
It fails closed before a provider request when the local prompt is already too
large to leave room for OpenClaw's system/tool envelope.
"""
from __future__ import annotations

import math
import os
from dataclasses import dataclass


DEFAULT_PROMPT_BUDGET = 180_000
DEFAULT_FIXED_RESERVE = 16_000
MIN_PROMPT_BUDGET = 16_000
MAX_PROMPT_BUDGET = 10_000_000


def _bounded_int(value: str | None, default: int, *, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value or "")
    except (TypeError, ValueError):
        return default
    return max(minimum, min(parsed, maximum))


def prompt_budget() -> int:
    """Return the configured admission budget, never a provider capability."""
    return _bounded_int(os.environ.get("EASEL_CHAT_PROMPT_BUDGET_TOKENS"),
                        DEFAULT_PROMPT_BUDGET, minimum=MIN_PROMPT_BUDGET,
                        maximum=MAX_PROMPT_BUDGET)


def fixed_reserve() -> int:
    return _bounded_int(os.environ.get("EASEL_CHAT_PROMPT_RESERVE_TOKENS"),
                        DEFAULT_FIXED_RESERVE, minimum=0,
                        maximum=MAX_PROMPT_BUDGET // 2)


def estimate_tokens(text: str) -> int:
    """Use the same bounded four-characters-per-token estimate as the UI."""
    if not isinstance(text, str) or not text:
        return 0
    return max(1, math.ceil(len(text) / 4))


@dataclass(frozen=True)
class PromptAdmission:
    estimated_prompt_tokens: int
    budget_tokens: int
    reserve_tokens: int
    remaining_tokens: int
    admitted: bool

    @property
    def reason(self) -> str:
        if self.admitted:
            return "ok"
        return "context_budget"

    def public(self) -> dict[str, int | bool | str]:
        return {
            "estimatedPromptTokens": self.estimated_prompt_tokens,
            "budgetTokens": self.budget_tokens,
            "reserveTokens": self.reserve_tokens,
            "remainingTokens": self.remaining_tokens,
            "admitted": self.admitted,
            "reason": self.reason,
        }


def admit(text: str, *, budget: int | None = None, reserve: int | None = None) -> PromptAdmission:
    budget_tokens = budget if isinstance(budget, int) and budget > 0 else prompt_budget()
    reserve_tokens = reserve if isinstance(reserve, int) and reserve >= 0 else fixed_reserve()
    estimated = estimate_tokens(text) + reserve_tokens
    remaining = budget_tokens - estimated
    return PromptAdmission(estimated, budget_tokens, reserve_tokens, remaining,
                           remaining >= 0)


LONG_TASK_OUTPUT_RULE = (
    "〔长任务输出边界〕需要生成大量文字、代码、卡片或多个文件时，先分批写入 "
    "outputs/主题目录并逐批校验，再在聊天中给简短摘要和真实文件链接；每轮只完成一小批可验证步骤。"
    "接近单次输出上限时主动收尾并说明下一步，不要把完整长产物一次性塞进单条回复。"
)
