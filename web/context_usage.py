"""Read numeric context snapshots only; never return prompts or tool definitions."""
from __future__ import annotations

import json
import math
import re
from pathlib import Path

SAFE_ID = re.compile(r'[A-Za-z0-9_.-]{1,120}\Z')
CATEGORIES = [('messages', '消息'), ('system_tools', '系统工具'), ('mcp_tools', 'MCP 工具'),
              ('system_prompt', '系统提示词'), ('skills', '技能'), ('other', '其它')]


def number(value):
    return value if type(value) is int and 0 <= value <= 10**12 else None


def mapping(value):
    return value if isinstance(value, dict) else {}


def read_json(path: Path):
    if not path.exists():
        return {}
    if path.is_symlink() or path.stat().st_size > 8 * 1024 * 1024:
        raise OSError('Context metadata cannot be read safely')
    try:
        return mapping(json.loads(path.read_text(encoding='utf-8-sig')))
    except (ValueError, UnicodeError) as exc:
        raise OSError('Context metadata is unreadable') from exc


def breakdown(report, used):
    empty = [dict(key=key, label=label, tokens=None, percent=None) for key, label in CATEGORIES]
    if not report or used is None or report.get('source') != 'run':
        return empty, 'unavailable'
    system = mapping(report.get('systemPrompt'))
    skills = mapping(report.get('skills'))
    tools = mapping(report.get('tools'))
    values = [number(system.get('chars')), number(system.get('projectContextChars')),
              number(skills.get('promptChars')), number(tools.get('listChars')), number(tools.get('schemaChars'))]
    entries = tools.get('entries')
    if None in values or not isinstance(entries, list):
        return empty, 'unavailable'
    system_chars, project_chars, skill_chars, list_chars, schema_chars = values
    mcp_chars = 0
    for entry in entries:
        if not isinstance(entry, dict) or number(entry.get('schemaChars')) is None:
            return empty, 'unavailable'
        if str(entry.get('name', '')).startswith(('mcp__', 'mcp_')):
            mcp_chars += entry['schemaChars']
    if mcp_chars > schema_chars or skill_chars + list_chars + project_chars > system_chars:
        return empty, 'inconsistent'
    chars = [schema_chars - mcp_chars + list_chars, mcp_chars,
             system_chars - skill_chars - list_chars - project_chars, skill_chars, project_chars]
    overhead = [math.ceil(value / 4) for value in chars]
    if sum(overhead) > used:
        return empty, 'inconsistent'
    tokens = [used - sum(overhead), *overhead]
    return [dict(key=key, label=label, tokens=value,
                 percent=round(value / used * 100, 2) if used else 0)
            for (key, label), value in zip(CATEGORIES, tokens)], 'estimated'


def collect_context(state_dir: Path, web_sessions_dir: Path, session_id: str,
                    model_ref: str = '', usage_reader=None):
    if not SAFE_ID.fullmatch(session_id) or len(model_ref) > 300 or any(ord(c) < 32 for c in model_ref):
        raise ValueError('Invalid session/model identity')
    config = read_json(state_dir / 'openclaw.json')
    defaults = mapping(mapping(config.get('agents')).get('defaults'))
    providers = mapping(mapping(config.get('models')).get('providers'))
    # Read a runtime entry only for a session belonging to this project's web UI.
    marker = web_sessions_dir / f'web_{session_id}.json'
    entry = {}
    if marker.is_file() and not marker.is_symlink():
        index = read_json(state_dir / 'agents/main/sessions/sessions.json')
        for key in (f'agent:main:web:{session_id}', f'agent:main:{session_id}', f'web:{session_id}', session_id):
            if isinstance(index.get(key), dict):
                entry = index[key]
                break
    report = mapping(entry.get('systemPromptReport'))
    provider = str(entry.get('modelProvider') or report.get('provider') or '')
    model = str(entry.get('model') or report.get('model') or '')
    observed_ref = f'{provider}/{model}' if provider and model else ''
    used = number(entry.get('totalTokens'))
    source = 'runtime' if used is not None else 'unavailable'
    updated = number(entry.get('updatedAt'))
    stale = entry.get('totalTokensFresh') is not True
    if used is None and usage_reader:
        usage = usage_reader()
        calls = [call for turn in usage.get('turns', []) for call in turn.get('calls', [])]
        latest = max(calls, key=lambda call: call.get('timestamp') or '', default={})
        used = number(latest.get('inputTokens'))
        if used is not None:
            provider, model = str(latest.get('provider') or ''), str(latest.get('model') or '')
            observed_ref = f'{provider}/{model}' if provider and model else ''
            source, updated, stale = 'last_request', latest.get('timestamp'), True
    default_model = defaults.get('model')
    default_ref = default_model if isinstance(default_model, str) else mapping(default_model).get('primary')
    selected_ref = model_ref or default_ref or observed_ref or ''
    pkey, _, model_id = selected_ref.partition('/')
    models = mapping(providers.get(pkey)).get('models', [])
    selected = next((item for item in models if isinstance(item, dict) and item.get('id') == model_id), {}) if isinstance(models, list) else {}
    capacity = number(selected.get('contextWindow'))
    capacity_source = 'model_config' if capacity else 'unavailable'
    mismatch = bool(used is not None and selected_ref and selected_ref != observed_ref)
    if capacity is None and not mismatch:
        capacity = number(entry.get('contextTokens')) or number(defaults.get('contextTokens'))
        capacity_source = 'runtime' if capacity else 'unavailable'
    if mismatch:
        used, source = None, 'model_changed'
    if source != 'runtime' or report.get('model') != model or report.get('provider') != provider:
        report = {}
    parts, status = breakdown(report, used)
    return dict(sessionId=session_id, modelRef=selected_ref, observedModelRef=observed_ref,
                capacity=capacity or None, capacitySource=capacity_source, usedTokens=used,
                usageSource=source, updatedAt=updated, stale=stale, breakdown=parts, breakdownStatus=status,
                note='占用来自最近一次运行时或请求输入快照，包含缓存；不是累计消耗，也不包含尚未提交的草稿。',
                breakdownNote='分类按运行时字符数÷4估算；消息为扣除已知开销后的余量（含工具回执/附件），其它含工作区注入。MCP仅按明确名称识别。')
