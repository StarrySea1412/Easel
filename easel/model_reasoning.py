"""Preserve explicit reasoning declarations without guessing from model names."""
from __future__ import annotations

EFFORTS = frozenset({'none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'adaptive'})


def capabilities(config: dict, codex_options: dict | None = None) -> dict:
    result = {}
    for model in config.get('models', []) if isinstance(config.get('models'), list) else []:
        if not isinstance(model, dict) or not isinstance(model.get('id'), str):
            continue
        entry = {}
        if isinstance(model.get('reasoning'), bool):
            entry['reasoning'] = model['reasoning']
        compat = model.get('compat')
        if isinstance(compat, dict):
            filtered = {}
            if isinstance(compat.get('supportsReasoningEffort'), bool):
                filtered['supportsReasoningEffort'] = compat['supportsReasoningEffort']
            if isinstance(compat.get('supportedReasoningEfforts'), list):
                efforts = list(dict.fromkeys(e for e in compat['supportedReasoningEfforts']
                                            if isinstance(e, str) and e in EFFORTS))
                if efforts:
                    filtered['supportedReasoningEfforts'] = efforts
            if filtered:
                entry['compat'] = filtered
        mapping = model.get('thinkingLevelMap')
        if isinstance(mapping, dict):
            allowed = {k: v for k, v in mapping.items() if k in EFFORTS
                       and (v is None or isinstance(v, str) and v in EFFORTS)}
            if allowed:
                entry['thinkingLevelMap'] = allowed
        if entry:
            result[model['id']] = entry
    # An explicitly saved nonzero effort declares this exact source model as reasoning.
    options = codex_options or {}
    model, effort = options.get('model'), options.get('model_reasoning_effort')
    if isinstance(model, str) and isinstance(effort, str) and effort in EFFORTS - {'none', 'off'}:
        result.setdefault(model, {}).setdefault('reasoning', True)
    return result
