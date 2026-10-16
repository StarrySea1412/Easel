"""Read numeric context snapshots only; never return prompts or tool definitions."""
from __future__ import annotations

import json
import math
import re
import sqlite3
from pathlib import Path
from model_metadata import context_reference

SAFE_ID = re.compile(r'[A-Za-z0-9_.-]{1,120}\Z')
CATEGORIES = [('messages', '消息'), ('system_tools', '系统工具'), ('mcp_tools', 'MCP 工具'),
              ('system_prompt', '系统提示词'), ('skills', '技能'), ('other', '其它')]


def number(value):
    return value if type(value) is int and 0 <= value <= 10**12 else None


def mapping(value):
    return value if isinstance(value, dict) else {}


def chars(value):
    # OpenClaw reports JavaScript string.length (UTF-16 units), including emoji.
    return len(value.encode('utf-16-le', errors='surrogatepass')) // 2


def read_json(path: Path):
    if not path.exists():
        return {}
    if path.is_symlink() or path.stat().st_size > 8 * 1024 * 1024:
        raise OSError('Context metadata cannot be read safely')
    try:
        return mapping(json.loads(path.read_text(encoding='utf-8-sig')))
    except (ValueError, UnicodeError) as exc:
        raise OSError('Context metadata is unreadable') from exc


def session_entry(state_dir, session_id):
    """SQLite is authoritative after migration; never read another chat's entry."""
    from easel.session_trace import database_path, _reader
    sessions = state_dir / 'agents/main/sessions'
    keys = (f'agent:main:web:{session_id}', f'agent:main:{session_id}', f'web:{session_id}', session_id)
    database = database_path(sessions)
    if database.is_file():
        with _reader(database) as db:
            for key in keys:
                row = db.execute('SELECT entry_json FROM session_nodes WHERE session_key=?', (key,)).fetchone()
                if row and isinstance(row[0], str) and len(row[0].encode('utf-8')) <= 8 * 1024 * 1024:
                    return mapping(json.loads(row[0])), 'sqlite'
        return {}, 'sqlite'
    index = read_json(sessions / 'sessions.json')
    return next((index[key] for key in keys if isinstance(index.get(key), dict)), {}), 'json'


def breakdown(report, used, skill_snapshot=None):
    parts = [dict(key=key, label=label, tokens=None, percent=None, chars=None, source='unavailable') for key, label in CATEGORIES]
    if report.get('source') != 'run':
        report = {}
    system = mapping(report.get('systemPrompt'))
    skills = mapping(report.get('skills'))
    tools = mapping(report.get('tools'))
    system_chars, project_chars, skill_chars, list_chars, schema_chars = [number(value) for value in (
        system.get('chars'), system.get('projectContextChars'), skills.get('promptChars'), tools.get('listChars'), tools.get('schemaChars'))]
    prompt = mapping(skill_snapshot).get('prompt')
    skill_source = 'runtime_report'
    if skill_chars is None and isinstance(prompt, str):
        skill_chars, skill_source = chars(prompt), 'session_skills'
    entries = tools.get('entries')
    mcp_chars = (sum(entry['schemaChars'] for entry in entries if str(entry.get('name', '')).startswith(('mcp__', 'mcp_')))
                 if isinstance(entries, list) and all(isinstance(entry, dict) and number(entry.get('schemaChars')) is not None for entry in entries) else None)
    inconsistent = False
    if mcp_chars is not None and schema_chars is not None and mcp_chars > schema_chars:
        mcp_chars, inconsistent = None, True
    base_chars = None
    if None not in (system_chars, project_chars, skill_chars, list_chars):
        base_chars = system_chars - project_chars - skill_chars - list_chars
        if base_chars < 0:
            base_chars, inconsistent = None, True
    category_chars = [schema_chars - mcp_chars + list_chars if None not in (schema_chars, mcp_chars, list_chars) else None,
                      mcp_chars, base_chars, skill_chars, project_chars]
    for part, value in zip(parts[1:], category_chars):
        if value is not None:
            part.update(chars=value, tokens=math.ceil(value / 4), source=skill_source if part['key'] == 'skills' else 'runtime_report')
    known = [part['tokens'] for part in parts[1:] if part['tokens'] is not None]
    if used is not None and sum(known) > used:
        inconsistent = True
    if not inconsistent and used is not None:
        for part in parts[1:]:
            if part['tokens'] is not None:
                part['percent'] = round(part['tokens'] / used * 100, 2) if used else 0
        if len(known) == 5:
            value = used - sum(known)
            parts[0].update(tokens=value, percent=round(value / used * 100, 2) if used else 0, source='residual')
    status = 'inconsistent' if inconsistent else 'estimated' if all(p['tokens'] is not None for p in parts) else 'partial' if known else 'unavailable'
    return parts, status


def collect_context(state_dir: Path, web_sessions_dir: Path, session_id: str,
                    model_ref: str = '', usage_reader=None, skills_dir: Path | None = None):
    if not SAFE_ID.fullmatch(session_id) or len(model_ref) > 300 or any(ord(c) < 32 for c in model_ref):
        raise ValueError('Invalid session/model identity')
    config = read_json(state_dir / 'openclaw.json')
    defaults = mapping(mapping(config.get('agents')).get('defaults'))
    providers = mapping(mapping(config.get('models')).get('providers'))
    # Read a runtime entry only for a session belonging to this project's web UI.
    marker = web_sessions_dir / f'web_{session_id}.json'
    entry = {}
    store = 'none'
    read_warning = ''
    if marker.is_file() and not marker.is_symlink():
        try:
            entry, store = session_entry(state_dir, session_id)
        except (sqlite3.Error, OSError, ValueError):
            read_warning = '会话元数据暂不可读；未使用其它会话的快照。'
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
    mismatch = bool(entry and selected_ref and selected_ref != observed_ref)
    reference = context_reference(model_id)
    configured_window = number(selected.get('contextWindow')) or None
    configured_limit = number(defaults.get('contextTokens')) or None
    recorded_limit = (number(entry.get('contextTokens')) or None) if not mismatch else None
    capacity = configured_window or (reference['tokens'] if reference else None)
    capacity_source = 'model_config' if configured_window else 'official_reference' if reference else 'unavailable'
    if configured_limit and (capacity is None or configured_limit < capacity):
        capacity, capacity_source = configured_limit, 'runtime_config'
    if capacity is None and recorded_limit:
        capacity, capacity_source = recorded_limit, 'session_snapshot'
    previous = dict(modelRef=observed_ref, usedTokens=used, updatedAt=updated) if mismatch and used is not None and observed_ref else None
    if mismatch and used is not None:
        used, source = None, 'model_changed'
    if mismatch or report.get('source') != 'run' or report.get('model') != model or report.get('provider') != provider:
        report = {}
    skill_snapshot = mapping(entry.get('skillsSnapshot'))
    # A last-request input count need not align with this prompt report. Retain
    # its characters, but reserve ratios/residuals for the runtime's own total.
    parts, status = breakdown(report, used if source == 'runtime' and report else None, skill_snapshot)
    skill_report = mapping(report.get('skills'))
    skill_chars = number(skill_report.get('promptChars'))
    if skill_chars is None and isinstance(skill_snapshot.get('prompt'), str):
        skill_chars = chars(skill_snapshot['prompt'])
    installed = None
    if skills_dir and skills_dir.is_dir():
        installed = sum(1 for path in skills_dir.iterdir() if (path / 'SKILL.md').is_file())
    skill_info = dict(installedCount=installed, availableCount=len(skill_snapshot['skills']) if isinstance(skill_snapshot.get('skills'), list) else None,
                      listedCount=len(skill_report['entries']) if isinstance(skill_report.get('entries'), list) else None,
                      promptChars=skill_chars, source='runtime_report' if number(skill_report.get('promptChars')) is not None else 'session_skills' if skill_snapshot else 'installed_catalog' if installed is not None else 'unavailable',
                      note='技能目录按会话快照统计；按需读取的 SKILL.md 正文和参考文件计入消息/工具回执，不把全部已安装技能全文算作已注入。')
    return dict(sessionId=session_id, modelRef=selected_ref, observedModelRef=observed_ref,
                capacity=capacity or None, capacitySource=capacity_source, usedTokens=used,
                configuredWindow=configured_window, configuredLimit=configured_limit,
                recordedLimit=recorded_limit, contextReference=reference,
                usageSource=source, updatedAt=updated, stale=stale, breakdown=parts, breakdownStatus=status,
                runtimeStore=store, readWarning=read_warning, skills=skill_info, previousSnapshot=previous,
                note='占用来自最近一次运行时或请求输入快照，包含缓存；不是累计消耗，也不包含尚未提交的草稿。',
                breakdownNote='分类按运行时字符数÷4估算；消息为扣除已知开销后的余量（含工具回执/附件），其它含工作区注入。MCP仅按明确名称识别。')
