"""Deterministic cinematic prompt normalization.

The vocabulary is intentionally small and editable. It captures the useful
shape of a cinematic brief without copying any third-party catalogue text.
"""
from __future__ import annotations

from typing import Any


FIELDS = (
    ("subject", "主体"),
    ("action", "动作"),
    ("shot", "景别"),
    ("movement", "运镜"),
    ("angle", "角度"),
    ("lens", "镜头"),
    ("lighting", "灯光"),
    ("composition", "构图"),
    ("color", "色彩"),
    ("time", "时间"),
    ("effects", "特效"),
    ("transition", "转场"),
    ("style", "风格"),
)
MAX_FIELD = 300


def _text(value: Any) -> str:
    if isinstance(value, str):
        return " ".join(value.strip().split())[:MAX_FIELD]
    if isinstance(value, (list, tuple)):
        return ", ".join(_text(item) for item in value if _text(item))[:MAX_FIELD]
    return ""


def normalize_cinematic_brief(value: Any) -> dict[str, str]:
    """Return only known, bounded fields so arbitrary workflow JSON is not
    copied into a provider prompt.
    """
    if not isinstance(value, dict):
        return {}
    return {key: text for key, _ in FIELDS if (text := _text(value.get(key)))}


def build_cinematic_prompt(prompt: str, brief: Any = None) -> str:
    """Compose a readable prompt while preserving the user's free-form text."""
    base = _text(prompt)
    fields = normalize_cinematic_brief(brief)
    parts = [base] if base else []
    for key, label in FIELDS:
        if key in fields:
            parts.append(f"{label}：{fields[key]}")
    return "；".join(parts)[:2000]

