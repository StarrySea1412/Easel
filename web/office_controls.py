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
import shutil
import sqlite3
import threading
import time
import urllib.error
import urllib.request

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
THINKING_LEVELS = frozenset({'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive', 'max', 'ultra'})
# Audited agent-command/model-fallback and HTTP/CLI ingress contracts. A newer
# or unknown gateway is not evidence that explicit overrides disable fallback.
# 2026.9.6: agent-via-gateway forwards the run's model to agent RPC; HTTP
# forwards x-openclaw-model. Both validate authorization/visibility before
# executing. agent-command marks explicit overrides as user selections and
# agent-scope projects disabled_by_model_override to an empty fallback list.
# Keep exact releases: a neighboring version does not inherit this audit.
STRICT_MODEL_OVERRIDE_VERSIONS = frozenset({'2026.9.2', '2026.9.6'})
# 2026.9.6 authorizeExistingGatewayDevice pins the public key, platform,
# device family, roles and scopes. CLI/backend client metadata can reuse
# those same grants; it is not a new device or a permission upgrade.
CLI_DEVICE_REUSE_VERSIONS = frozenset({'2026.9.6'})


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


def _model_error(code: str, message: str, status: int = 503):
    raise HTTPException(status, {'code': code, 'category': 'configuration',
                                'retryable': False, 'message': message})


def validate_requested_model(web, model_ref: str) -> None:
    options = configured_models(web.openclaw_state_dir() / 'openclaw.json')
    if model_ref not in {option['id'] for option in options}:
        _model_error('chat_model_not_configured', '只能选择已配置的完整渠道模型，请刷新模型设置。', 400)


def _model_probe_client(transport: str, credentials):
    """Read existing approval before connecting, never request a new identity.

    `agent --model` uses gateway-client/backend + admin in the audited CLI.
    On 2026.9.6 the same paired CLI device can use that client metadata with
    its existing admin grant. Verify that running version on the original
    read connection first; never approve a device or request broader scopes.
    HTTP's separate empty-message probe checks its actual authorization.
    """
    device = gateway._load_device()
    if not gateway.PROFILE_DB.is_file():
        _error('缺少已批准的网关连接，尚不能核验指定模型能力。', 503)
    with sqlite3.connect(gateway.PROFILE_DB.resolve().as_uri() + '?mode=ro', uri=True, timeout=2) as db:
        db.row_factory = sqlite3.Row
        row = db.execute('SELECT * FROM device_pairing_paired WHERE device_id=?',
                         (device['device_id'],)).fetchone()
    if row is None:
        _error('现有设备尚未批准；本页面不会创建配对或扩大权限。', 503)
    row = dict(row)
    approved = json.loads(row.get('approved_scopes_json') or row.get('scopes_json') or '[]')
    roles = json.loads(row.get('roles_json') or '[]')
    identity = (row.get('client_id'), row.get('client_mode'))
    scopes = ['operator.admin'] if transport == 'cli' else ['operator.read']
    valid_identity = identity in {('cli', 'cli'), ('gateway-client', 'backend')}
    metadata = gateway._client_identity()
    metadata_matches = all(not row.get(column) or row[column] == metadata[key]
                           for column, key in (('platform', 'platform'), ('device_family', 'deviceFamily')))
    if (row.get('public_key') != device['public_key'] or not valid_identity or not metadata_matches
            or not (row.get('role') == 'operator' or isinstance(roles, list) and 'operator' in roles)
            or not isinstance(approved, list)
            or not ('operator.admin' in approved or all(scope in approved for scope in scopes))):
        _error('现有连接未批准指定模型所需的身份或权限；本页面不会自动配对或扩大权限。', 503)
    auth = None
    if credentials.mode == 'password' and credentials.password:
        auth = {'password': credentials.password}
    elif credentials.token:
        auth = {'token': credentials.token}
    elif credentials.password:
        auth = {'password': credentials.password}
    if transport == 'cli' and identity == ('cli', 'cli'):
        discovery = gateway.GatewayClient(timeout=10.0, scopes=['operator.read'],
                                         client_id=identity[0], client_mode=identity[1], auth=auth)
        try:
            discovery.connect()
            if (discovery.server_version not in CLI_DEVICE_REUSE_VERSIONS
                    or not ({'operator.read', 'operator.admin'} & discovery.granted_scopes)):
                _error('当前网关尚未核验已批准设备的 CLI 身份复用能力；未请求新配对或扩大权限。', 503)
        finally:
            discovery.close()
        identity = ('gateway-client', 'backend')
    client = gateway.GatewayClient(timeout=10.0, scopes=scopes, client_id=identity[0],
                                   client_mode=identity[1], auth=auth)
    try:
        client.connect()
        if not (set(scopes).issubset(client.granted_scopes)
                or transport == 'http' and 'operator.admin' in client.granted_scopes):
            _error('网关未确认已批准的指定模型权限。', 503)
        return client
    except Exception:
        client.close()
        raise


def _cli_override_version(web) -> str | None:
    """Read the package belonging to the actual argv; never launch a CLI probe."""
    command = web.openclaw_base_cmd()
    if not command:
        return None
    entry = Path(command[-1])
    if not entry.is_absolute():
        located = shutil.which(str(entry))
        if not located:
            return None
        entry = Path(located)
    entry = entry.resolve()
    if not entry.is_file() or entry.name not in {'openclaw.mjs', 'openclaw', 'openclaw.cmd', 'openclaw.ps1'}:
        return None
    for path in (entry.parent / 'package.json', entry.parent / 'node_modules' / 'openclaw' / 'package.json'):
        try:
            package = json.loads(path.read_text(encoding='utf-8-sig'))
        except (OSError, ValueError):
            continue
        if isinstance(package, dict) and package.get('name') == 'openclaw':
            version = package.get('version')
            return version if version in STRICT_MODEL_OVERRIDE_VERSIONS else None
    return None


class _NoProbeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _probe_http_override(web, session: str | None, credentials, model_ref: str | None) -> None:
    """Exercise authorization/validation only: no user message and no runId.

    The capability listing uses an invalid ref to test the override mechanism
    without claiming any registered model is allowed. A submitted model must
    pass its policy check and reach the exact missing-message rejection.
    """
    headers = {'Content-Type': 'application/json', 'x-openclaw-model': model_ref or '/'}
    if session:
        headers['x-openclaw-session-key'] = f'agent:main:{session}'
        headers['x-openclaw-session-id'] = web._openclaw_session_id(session)
    request = urllib.request.Request(web.chat_completions_url(),
        data=b'{"model":"openclaw/default","messages":[]}', headers=headers, method='POST')
    for name, value in credentials.headers().items():
        request.add_unredirected_header(name, value)
    expected = 'Missing user message in `messages`.' if model_ref else 'Invalid `x-openclaw-model`.'
    try:
        with urllib.request.build_opener(_NoProbeRedirect()).open(request, timeout=3):
            pass
    except urllib.error.HTTPError as exc:
        try:
            data = json.loads(exc.read(4096))
        finally:
            exc.close()
        error = data.get('error') if isinstance(data, dict) else None
        if exc.code == 400 and isinstance(error, dict) and error.get('message') == expected:
            return
    _error('网关未确认该请求的指定模型权限或模型允许范围；任务未启动。', 503)


def turn_model_capability(web, session: str | None = None, model_ref: str | None = None,
                          *, transport: str | None = None, credentials=None) -> dict:
    if session and (not isinstance(session, str) or not office.SAFE_ID.fullmatch(session)):
        _error('无效的会话标识。', 400)
    options = configured_models(web.openclaw_state_dir() / 'openclaw.json')
    labels = web._channel_labels() if hasattr(web, '_channel_labels') else {}
    for option in options:
        channel = labels.get(option['provider'], {})
        option['channelName'] = channel.get('name', '未命名渠道')
        option['label'] = f"{option['channelName']} · {option['model']}"
    result = {'available': False, 'scope': 'unavailable', 'currentModelRef': None,
              'options': options, 'reason': '尚未配置可选择的渠道模型。',
              'gatewayVersion': None, 'transport': None}
    config = office._read_json(web.openclaw_state_dir() / 'openclaw.json', web.openclaw_state_dir(), set()) or {}
    agents = config.get('agents', {})
    defaults = agents.get('defaults', {}) if isinstance(agents, dict) else {}
    model = defaults.get('model') if isinstance(defaults, dict) else None
    default_ref = model.get('primary') if isinstance(model, dict) else model
    if isinstance(default_ref, str) and default_ref in {option['id'] for option in options}:
        result['defaultModelRef'] = default_ref
    if not options:
        return result
    client = None
    try:
        if model_ref is not None and model_ref not in {option['id'] for option in options}:
            _error('所选渠道模型已从配置中移除，请重新选择。', 400)
        transport = transport or web._resolve_transport(session or f'office-new-{office.uuid.uuid4().hex}')
        if transport not in ('http', 'cli'):
            _error('当前会话传输方式不支持指定模型。', 503)
        result['transport'] = transport
        credentials = credentials if credentials is not None else web.gateway_credentials()
        if transport == 'cli' and _cli_override_version(web) is None:
            _error('当前 CLI 版本尚未核验指定模型语义，任务不会改用默认模型。', 503)
        client = _model_probe_client(transport, credentials)
        version = getattr(client, 'server_version', None)
        if isinstance(version, str) and re.fullmatch(r'[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,3}(?:[-+][A-Za-z0-9.-]{1,32})?', version):
            result['gatewayVersion'] = version
        if version not in STRICT_MODEL_OVERRIDE_VERSIONS or 'agent' not in client.methods:
            _error('运行网关尚未核验严格指定模型能力，任务不会改用默认或备用模型。', 503)
        # Read the running gateway's own policy, including custom provider
        # metadata. Brand/model-name heuristics cannot determine allowed effort.
        if 'models.list' in client.methods:
            try:
                catalog = client._rpc('models.list', {'agentId': 'main', 'view': 'configured'})
                rows = catalog.get('models', []) if isinstance(catalog, dict) else []
                for option in options:
                    matches = [row for row in rows if isinstance(row, dict)
                               and row.get('provider') == option['provider'] and row.get('id') == option['model']]
                    if len(matches) != 1:
                        continue
                    raw = matches[0].get('thinkingLevels')
                    levels = [row.get('id') for row in raw if isinstance(row, dict) and row.get('id') in THINKING_LEVELS] if isinstance(raw, list) else []
                    if levels:
                        option['thinkingLevels'] = list(dict.fromkeys(levels))
            except Exception:
                pass  # Missing policy is unknown, never an invented off-only list.
        if transport == 'http':
            _probe_http_override(web, session, credentials, model_ref)
        # Only a stored session override can preselect the next turn. The last
        # runtime model is historical evidence, not a persistent selection.
        if session and 'sessions.list' in client.methods:
            payload = client._rpc('sessions.list', {'search': f'agent:main:{session}', 'limit': 32,
                                                   'includeGlobal': False, 'includeUnknown': True})
            rows = payload.get('sessions') if isinstance(payload, dict) else None
            matches = [row for row in rows if isinstance(row, dict) and row.get('key') == f'agent:main:{session}'] if isinstance(rows, list) else []
            if len(matches) == 1 and matches[0].get('sessionId') == web._openclaw_session_id(session):
                row = matches[0]
                ref = (f"{row['providerOverride']}/{row['modelOverride']}"
                       if isinstance(row.get('providerOverride'), str) and isinstance(row.get('modelOverride'), str) else None)
                if ref in {option['id'] for option in options}:
                    result['currentModelRef'] = ref
        result.update(available=True, scope='next_turn', reason=None)
    except HTTPException as exc:
        result['reason'] = str(exc.detail)
    except Exception:
        # Transport/schema/auth errors can contain credentials or private URLs.
        result['reason'] = '无法只读核验当前网关的指定模型能力，任务不会改用默认模型。'
    finally:
        if client is not None:
            client.close()
    return result


def require_model_override(web, session: str | None, model_ref: str, *, transport=None, credentials=None, thinking_level=None) -> dict:
    validate_requested_model(web, model_ref)
    capability = turn_model_capability(web, session, model_ref, transport=transport, credentials=credentials)
    if not capability['available']:
        _model_error('chat_model_override_unavailable', capability['reason'])
    validate_thinking_level(capability, model_ref, thinking_level)
    return capability


def validate_thinking_level(capability, model_ref, thinking_level):
    if thinking_level is None:
        return
    ref = model_ref or capability.get('currentModelRef') or capability.get('defaultModelRef')
    option = next((row for row in capability.get('options', []) if row.get('id') == ref), None)
    levels = option.get('thinkingLevels') if option else None
    if levels and thinking_level not in levels:
        from easel.gateway_auth import gateway_error
        raise HTTPException(400, gateway_error(
            f'Thinking level "{thinking_level}" is not supported for {ref}. Use one of: {", ".join(levels)}.'))


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


def operate(web, session: str, turn: str, agent: str, action='controls', model_ref=None,
            *, expected_run_id: str | None = None):
    if action != 'controls' and not _MUTATION_LOCK.acquire(blocking=False):
        _error('另一个 Agent 控制正在处理，请稍候重试。')
    client = None
    options = []
    try:
        target = resolve_target(web, session, turn, agent)
        if action == 'stop' and expected_run_id is not None and expected_run_id != target.run_id:
            _error('运行标识已变化，请刷新该 Agent 后再停止。')
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
                    'stop': {'available': False, 'scope': 'unavailable', 'runId': None, 'reason': str(exc.detail)}}
        can_model = 'sessions.patch' in client.methods and _can_model(target, row) and bool(options)
        observed_runs = {row[name] for name in ('activeRunId', 'activeWriterRunId', 'lastRunId')
                         if isinstance(row.get(name), str) and row[name]}
        verified_run_id = target.run_id if target.run_id and observed_runs == {target.run_id} else None
        can_stop = ('sessions.abort' in client.methods and target.run_id is not None
                    and row.get('status') not in TERMINAL
                    and (verified_run_id is not None or action == 'stop' and expected_run_id is None))
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
                             'runId': verified_run_id,
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
            return {**base, 'confirmed': confirmed, 'scope': scope, 'runId': target.run_id,
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
                    'stop': {'available': False, 'scope': 'unavailable', 'runId': None, 'reason': '网关暂不可用，停止能力尚未核验。'}}
        _error('网关未确认操作结果，请刷新状态后再检查。', 503)
    finally:
        if client is not None:
            client.close()
        if action != 'controls':
            _MUTATION_LOCK.release()
