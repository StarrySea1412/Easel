import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from chat_budget import admit, estimate_tokens


def test_estimate_tokens_is_bounded_and_ceil_based():
    assert estimate_tokens('') == 0
    assert estimate_tokens('1234') == 1
    assert estimate_tokens('12345') == 2


def test_admission_reserves_runtime_envelope_before_provider_request():
    accepted = admit('x' * 400, budget=200, reserve=20)
    rejected = admit('x' * 800, budget=200, reserve=20)
    assert accepted.admitted and accepted.remaining_tokens == 80
    assert not rejected.admitted and rejected.reason == 'context_budget'
    assert rejected.public()['estimatedPromptTokens'] == 220


def test_environment_budget_is_bounded(monkeypatch):
    monkeypatch.setenv('EASEL_CHAT_PROMPT_BUDGET_TOKENS', '1')
    # The guard never accepts an unsafe zero-sized operational budget.
    assert admit('x' * 64).budget_tokens >= 16000
    monkeypatch.setenv('EASEL_CHAT_PROMPT_BUDGET_TOKENS', 'not-a-number')
    assert admit('x').budget_tokens == 180000
