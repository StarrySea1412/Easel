"""Exact, evidence-bound office controls. No spawning or model inference.

Gateway mutations use a non-admin connection so a session model selection cannot
persist a global/default model. Missing evidence or unsupported RPCs fail closed.
"""
from __future__ import annotations

from dataclasses import dataclass
from collections import OrderedDict
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import threading
import time

from fastapi import HTTPException

import agent_office as office
from easel import gateway_questions as gateway

SCOPES = ['operator.read', 'operator.write']
TERMINAL = {'done', 'failed', 'killed', 'timeout', 'completed', 'stopped', 'cancelled', 'canceled'}
MODEL_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.:/+-]{0,199}$')
CHILD_KEY = re.compile(r'^agent:([A-Za-z0-9_-]{1,80}):subagent:[A-Za-z0-9_.-]{1,120}$')
_MUTATION_LOCK = threading.Lock()
_RECEIPT_LOCK = threading.Lock()
_STOP_RECEIPTS: OrderedDict[tuple[str, str, str], dict] = OrderedDict()
MAX_STOP_RECEIPTS = 128


def _error(message: str, status: int = 409):
    raise HTTPException(status, message)


def configured_models(config_path: Path) -> list[dict]:
    """Project only explicitly configured identifiers; never return auth or URLs."""
    config = office._read_json(config_path, config_path.parent, set()) or {}
    models = config.get('models')
    providers = models.get('providers') if isinstance(models, dict) else None
    if not isinstance(providers, dict):
        return []
    result = []
    seen = set()
    for provider, value in providers.items():
        if (not isinstance(provider, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,79}', provider)
                or not isinstance(value, dict)):
            continue
        for row in value.get('models', []) if isinstance(value.get('models'), list) else []:
            model = row.get('id') if isinstance(row, dict) else None
            if not isinstance(model, str) or not MODEL_ID.fullmatch(model):
                continue
            ref = f'{provider}/{model}'
            if ref in seen:
                continue
            seen.add(ref)
            result.append({'id': ref, 'provider': provider, 'model': model,
                           'label': f'{provider} · {model}', 'configured': True})
            if len(result) >= 256:
                return result
    return result


def _new_client():
    """Require existing matching pairing before any connection (no auto-pair)."""
    device = gateway._load_device()
    if not gateway.PROFILE_DB.is_file():
        _error('尚未找到已批准的网关设备连接，请在网关中完成设备配置后重试。', 503)
    try:
        with sqlite3.connect(f'file:{gateway.PROFILE_DB.as_posix()}?mode=ro', uri=True) as db:
            row = db.execute('SELECT public_key, approved_scopes_json, scopes_json, role, '
                             'roles_json, client_id, client_mode FROM device_pairing_paired '
                             'WHERE device_id=?', (device['device_id'],)).fetchone()
        approved = json.loads(row[1] or row[2] or '[]') if row else []
        roles = json.loads(row[4] or '[]') if row else []
        if (not row or row[0] != device['public_key'] or row[5] != 'cli' or row[6] != 'cli'
                or not (row[3] == 'operator' or isinstance(roles, list) and 'operator' in roles)
                or not isinstance(approved, list)
                or not ('operator.admin' in approved or all(scope in approved for scope in SCOPES))):
            _error('现有网关设备未批准所需会话权限；本页面不会自动配对或扩大权限。', 503)
    except (sqlite3.Error, ValueError, TypeError):
        _error('无法核验现有网关设备权限，控制暂不可用。', 503)
    client = gateway.GatewayClient(timeout=3.0, scopes=SCOPES)
    try:
        client.connect()
        # Admin in the actual hello would permit sticky config writes. Reject
        # instead of trusting only the requested scopes.
        if 'operator.admin' in client.granted_scopes or not set(SCOPES).issubset(client.granted_scopes):
            _error('网关未确认独立会话控制权限，控制暂不可用。', 503)
        return client
    except Exception:
        client.close()
        raise


@dataclass
class Target:
    identity: dict
    key: str
    run_id: str | None
    process: object
    active_turn: str
    live: bool
    marker_revision: tuple | None
    status: str
    child: bool


def _execution(web, session):
    process = web._RUNNING_CHAT.get(session)
    try:
        live = process is not None and process.poll() is None
    except OSError:
        live = False
    return process, web._ACTIVE_SKILL_TURNS.get(session, ''), live


def _child_identity(events, agent_id):
    calls = {}
    candidates = set()
    # Membership is established by the same validated current-turn event reader
    # as the office view, then narrowed to an OpenClaw spawn receipt with both
    # key and exact run. A list/search result alone can never create authority.
    for event in events:
        message = event.get('message', event)
        if not isinstance(message, dict):
            continue
        if message.get('role') == 'assistant':
            for ident, tool, _ in office._tool_calls(message):
                if tool == 'sessions_spawn':
                    calls[ident] = tool
            continue
        call_id = message.get('toolCallId') or message.get('tool_call_id') or message.get('tool_use_id')
        if (message.get('role') not in ('toolResult', 'tool', 'tool_result')
                or not isinstance(call_id, str) or call_id not in calls or message.get('isError') is True):
            continue
        for payload in office._payloads(message):
            raw_ids = office._identities(payload, 'sessions_spawn')
            status = payload.get('status')
            if (not raw_ids or payload.get('error') or status in ('error', 'failed', 'rejected', 'forbidden')
                    or not (status in ('accepted', 'ok', 'success', 'running', 'started', 'pending', 'queued', 'completed')
                            or message.get('isError') is False)):
                continue
            if 'subagent:' + hashlib.sha256(raw_ids[0].encode()).hexdigest()[:20] != agent_id:
                continue
            key, run_id = payload.get('childSessionKey'), payload.get('runId')
            if isinstance(key, str) and CHILD_KEY.fullmatch(key):
                candidates.add((key, run_id if isinstance(run_id, str) and office.SAFE_ID.fullmatch(run_id) else None))
    if len(candidates) != 1:
        _error('该 Agent 缺少唯一可核验的网关身份，暂不能独立控制。', 422)
    return next(iter(candidates))


def resolve_target(web, session, turn, agent) -> Target:
    if not office.SAFE_ID.fullmatch(session) or not office.SAFE_ID.fullmatch(turn):
        _error('无效的会话或轮次标识。', 400)
    if agent != f'root:{session}' and not re.fullmatch(r'subagent:[a-f0-9]{20}', agent):
        _error('无效的 Agent 标识。', 400)
    marker_path = web.SESSIONS_DIR / f'web_{session}.json'
    revision = office._marker_revision(marker_path)
    process, active_turn, live = _execution(web, session)
    view = office.snapshot(session, web.SESSIONS_DIR, web.OUTPUTS_DIR / '_skill_audits',
                           web.OPENCLAW_SESSIONS_DIR, live=live, active_turn_id=active_turn)
    if view.get('turnId') != turn:
        _error('会话轮次已变化，请刷新当前任务后再操作。')
    member = next((item for item in view['agents'] if item['id'] == agent), None)
    if not member:
        _error('当前轮次没有该 Agent 的归属证据。', 404)
    marker = office._read_json(marker_path, web.SESSIONS_DIR, set()) or {}
    if marker.get('turn_id') != turn:
        _error('会话轮次正在更新，请刷新后再操作。')
    child = agent != f'root:{session}'
    key, run_id = f'agent:main:{session}', getattr(process, '_office_run_id', None) or marker.get('gateway_run_id')
    run_id = run_id if isinstance(run_id, str) and office.SAFE_ID.fullmatch(run_id) else None
    if child:
        audit = office._audit_record(web.OUTPUTS_DIR / '_skill_audits', session, turn, set())
        finished = revision[3] / 1e9 if revision and marker.get('status') == 'done' else None
        events = office._events(web.OPENCLAW_SESSIONS_DIR, session, audit,
                                live and marker.get('status') != 'done', finished, set())
        key, run_id = _child_identity(events, agent)
    target = Target({'sessionId': session, 'turnId': turn, 'agentId': agent}, key,
                    run_id, process, active_turn, live, revision, member['status'], child)
    _assert_current(web, target)
    return target


def _assert_current(web, target):
    session = target.identity['sessionId']
    process, active_turn, live = _execution(web, session)
    if (process is not target.process or active_turn != target.active_turn or live != target.live
            or office._marker_revision(web.SESSIONS_DIR / f'web_{session}.json') != target.marker_revision):
        _error('执行状态已变化，请刷新当前轮次后再操作。')


def _session_row(client, target):
    if 'sessions.list' not in client.methods:
        _error('此网关未提供可核验的会话控制接口。', 503)
    payload = client._rpc('sessions.list', {'search': target.key, 'limit': 32,
                                           'includeGlobal': False, 'includeUnknown': True})
    rows = payload.get('sessions') if isinstance(payload, dict) else None
    matches = [row for row in rows if isinstance(row, dict) and row.get('key') == target.key] if isinstance(rows, list) else []
    if len(matches) != 1 or not isinstance(matches[0].get('sessionId'), str):
        _error('网关未确认该 Agent 的唯一会话，控制未执行。', 503)
    row = matches[0]
    if not office.SAFE_ID.fullmatch(row['sessionId']):
        _error('网关会话标识不可核验，控制未执行。', 503)
    if target.child:
        # The parent transcript is necessary; gateway provenance is an
        # additional cross-check, never a replacement for that evidence.
        parents = {f"agent:main:{target.identity['sessionId']}", f"agent:main:web:{target.identity['sessionId']}"}
        if row.get('spawnedBy') not in parents:
            _error('网关未确认该子 Agent 属于当前会话，控制未执行。', 409)
    elif row['sessionId'] != str(office.uuid.uuid5(office.SESSION_NS, target.identity['sessionId'])):
        _error('网关会话已被替换，请刷新当前任务。', 409)
    return row


def _model_ref(row):
    provider = row.get('providerOverride') or row.get('modelProvider')
    model = row.get('modelOverride') or row.get('model')
    return f'{provider}/{model}' if isinstance(provider, str) and isinstance(model, str) else None


def _can_model(target, row):
    # Unknown is not idle. Running patch may switch the next inference step on
    # modern OpenClaw, so do not promise next-turn semantics for a live target.
    return (row.get('status') in TERMINAL and target.run_id is not None
            and row.get('lastRunId') == target.run_id and (target.child or not target.live))


def _remember_stop(target, runtime_session_id=None):
    key = tuple(target.identity[name] for name in ('sessionId', 'turnId', 'agentId'))
    with _RECEIPT_LOCK:
        _STOP_RECEIPTS.pop(key, None)
        _STOP_RECEIPTS[key] = {'key': target.key, 'runId': target.run_id,
                               'runtimeSessionId': runtime_session_id, 'at': time.time()}
        while len(_STOP_RECEIPTS) > MAX_STOP_RECEIPTS:
            _STOP_RECEIPTS.popitem(last=False)


def confirmed_stop_snapshot(web, snapshot):
    """Overlay confirmed child stops only after re-reading exact current runs.

    A receipt alone is historical evidence, not a license to paint an agent
    stopped forever. One bounded gateway metadata read verifies all candidates;
    new runs, lost ancestry, unavailable gateway or changed turn keep raw state.
    """
    session, turn = snapshot.get('sessionId'), snapshot.get('turnId')
    if not session or not turn:
        return snapshot
    with _RECEIPT_LOCK:
        receipts = {ident[2]: dict(receipt) for ident, receipt in _STOP_RECEIPTS.items()
                    if ident[:2] == (session, turn) and time.time() - receipt['at'] < 3600}
    candidates = [agent for agent in snapshot.get('agents', [])
                  if agent.get('role') == 'subagent' and agent.get('id') in receipts and agent.get('status') != 'stopped']
    if not candidates:
        return snapshot
    client = None
    try:
        # Resolve local ownership again after the snapshot worker was awaited.
        targets = [(agent, resolve_target(web, session, turn, agent['id'])) for agent in candidates]
        client = _new_client()
        if 'sessions.list' not in client.methods:
            return snapshot
        parent = f'agent:main:{session}'
        payload = client._rpc('sessions.list', {'spawnedBy': parent, 'limit': 64,
                                               'includeGlobal': False, 'includeUnknown': True})
        rows = payload.get('sessions') if isinstance(payload, dict) else None
        if not isinstance(rows, list):
            return snapshot
        changes = []
        for agent, target in targets:
            receipt = receipts[agent['id']]
            if receipt['key'] != target.key or receipt['runId'] != target.run_id:
                continue
            _assert_current(web, target)
            exact = [row for row in rows if isinstance(row, dict) and row.get('key') == target.key
                     and row.get('spawnedBy') == parent]
            if (len(exact) == 1 and exact[0].get('status') in TERMINAL and exact[0].get('lastRunId') == target.run_id
                    and exact[0].get('sessionId') == receipt['runtimeSessionId']):
                changes.append(agent)
        for agent in changes:
            agent.update(status='stopped', evidence='网关已确认该次运行停止，且当前会话归属与结束运行标识再次核验一致。')
    except Exception:
        pass  # Keep the observed trace state; never manufacture a stop on error.
    finally:
        if client is not None:
            client.close()
    return snapshot


def operate(web, session: str, turn: str, agent: str, action='controls', model_ref=None):
    if action != 'controls' and not _MUTATION_LOCK.acquire(blocking=False):
        _error('另一个 Agent 控制正在处理，请稍候重试。')
    client = None
    options = []
    try:
        target = resolve_target(web, session, turn, agent)
        options = configured_models(web.openclaw_state_dir() / 'openclaw.json')
        base = target.identity
        if action == 'model' and model_ref not in {option['id'] for option in options}:
            _error('只能选择已配置的渠道模型，请刷新模型设置。', 400)
        try:
            client = _new_client()
            row = _session_row(client, target)
            _assert_current(web, target)
        except HTTPException as exc:
            if action != 'controls':
                raise
            return {**base, 'model': {'available': False, 'scope': 'unavailable', 'options': options,
                                      'currentModelRef': None, 'reason': str(exc.detail)},
                    'stop': {'available': False, 'scope': 'unavailable', 'reason': str(exc.detail)}}
        can_model = 'sessions.patch' in client.methods and _can_model(target, row) and bool(options)
        can_stop = ('sessions.abort' in client.methods and target.run_id is not None
                    and row.get('status') not in TERMINAL)
        scope = 'agent' if target.child else 'session'
        if action == 'controls':
            reason = ('保存到该 Agent 会话，后续模型调用使用所选渠道；不会重新运行已完成任务。' if can_model
                      else '网关未提供与本轮匹配的结束运行标识，暂不能配置；请刷新当前任务。'
                      if row.get('status') in TERMINAL and (target.run_id is None or row.get('lastRunId') != target.run_id)
                      else '请先停止该 Agent，待网关确认结束后再分配模型。' if not _can_model(target, row)
                      else '没有已配置的渠道模型，请先配置模型。' if not options
                      else '当前网关不支持该 Agent 的独立模型配置。')
            current = _model_ref(row)
            return {**base, 'model': {'available': can_model, 'scope': 'subsequent_calls' if 'sessions.patch' in client.methods else 'unavailable',
                                      'options': options, 'currentModelRef': current if current in {o['id'] for o in options} else None,
                                      'reason': reason},
                    'stop': {'available': can_stop, 'scope': scope if 'sessions.abort' in client.methods else 'unavailable',
                             'reason': '停止该 Agent 及其派生任务，不停止父级或兄弟 Agent。' if can_stop and target.child
                             else '停止本轮会话及其派生任务。' if can_stop
                             else '未确认精确运行标识、任务已结束或网关不支持停止，不能发送停止请求。'}}
        if action == 'model':
            if not can_model:
                if row.get('status') in TERMINAL and (target.run_id is None or row.get('lastRunId') != target.run_id):
                    _error('网关缺少与本轮匹配的结束运行标识，模型配置未执行。')
                _error('请先停止该 Agent 并等待网关确认结束，再配置后续轮次模型。')
            params = {'key': target.key, 'model': model_ref, 'expectedSessionId': row['sessionId']}
            if isinstance(row.get('lifecycleRevision'), str):
                params['expectedLifecycleRevision'] = row['lifecycleRevision']
            _assert_current(web, target)
            receipt = client._rpc('sessions.patch', params)
            entry = receipt.get('entry') if isinstance(receipt, dict) else None
            resolved = receipt.get('resolved') if isinstance(receipt, dict) else None
            confirmed = (isinstance(receipt, dict) and receipt.get('ok') is True and receipt.get('key') == target.key
                         and isinstance(entry, dict) and entry.get('sessionId') == row['sessionId']
                         and ((_model_ref(entry) == model_ref) or isinstance(resolved, dict) and _model_ref(resolved) == model_ref))
            return {**base, 'applied': confirmed, 'scope': 'subsequent_calls', 'modelRef': model_ref if confirmed else None,
                    'message': '该 Agent 的后续模型调用配置已确认。' if confirmed else '网关未返回匹配的模型保存回执，请刷新检查。'}
        if action == 'stop':
            if not can_stop:
                _error('缺少精确运行证据或任务已结束，停止未执行。')
            _assert_current(web, target)
            receipt = client._rpc('sessions.abort', {'key': target.key, 'runId': target.run_id})
            confirmed = (isinstance(receipt, dict) and receipt.get('ok') is True
                         and receipt.get('status') == 'aborted' and receipt.get('abortedRunId') == target.run_id)
            if confirmed:
                _remember_stop(target, row['sessionId'])
            # Only an exact gateway receipt authorizes marking the parent's
            # supervisor as user-stopped. Child controls never touch it.
            if (confirmed and not target.child and target.live and target.process is not None
                    and web._RUNNING_CHAT.get(session) is target.process):
                web._STOPPED_CHAT.add(session)
            return {**base, 'confirmed': confirmed, 'scope': scope,
                    'message': '网关已确认停止。' if confirmed else '网关未确认该次运行已停止，请刷新检查。'}
        _error('不支持的控制操作。', 400)
    except HTTPException:
        raise
    except Exception:
        # RPC/transport errors may contain tokens, URLs or unrelated session
        # details. Never expose raw exception text or pretend a timeout succeeded.
        if action == 'controls':
            return {'sessionId': session, 'turnId': turn, 'agentId': agent, 'model': {'available': False, 'scope': 'unavailable', 'options': options,
                                                'currentModelRef': None, 'reason': '网关暂不可用，模型控制尚未核验。'},
                    'stop': {'available': False, 'scope': 'unavailable', 'reason': '网关暂不可用，停止能力尚未核验。'}}
        _error('网关未确认操作结果，请刷新状态后再检查。', 503)
    finally:
        if client is not None:
            client.close()
        if action != 'controls':
            _MUTATION_LOCK.release()
