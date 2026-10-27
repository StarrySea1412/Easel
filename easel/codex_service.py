"""Local Codex sessions and durable, replayable UI events (App Server 0.147)."""
from __future__ import annotations

from easel.context_budget import ContextBudgetError

import asyncio
import copy
import hashlib
import json
from pathlib import Path
import queue
import re
import shutil
import sqlite3
import threading
import time
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from .codex_client import CodexClient, CodexError
from .gateway_auth import redact_gateway_text
from .execution import codex_rows, page, iso, public_text
from .artifacts import ArtifactStore, PRESENT_TOOL
from .image_jobs import ImageJobs, read_config, GENERATE_TOOL
from .creation_drafts import CreationDrafts, PREPARE_TOOL
from .browser_tools import BROWSER_TOOL
from .browser_runtime import BrowserError
from .local_records import _write_lock, RecordConflict
from .codex_tasks import CodexTasks, DELIVER_TOOL
from .task_store import TaskConflict


def safe(value):
    if isinstance(value, str):
        return public_text(value)
    if isinstance(value, list):
        return [safe(v) for v in value]
    if isinstance(value, dict):
        return {k: safe(v) for k, v in value.items()
                if not re.search(r'api.?key|access.?token|refresh.?token|authorization|password', k, re.I)}
    return value


def key(value: str) -> str:
    if not value or len(value) > 200 or not re.fullmatch(r'[a-zA-Z0-9_-]+', value):
        raise HTTPException(400, '会话或任务标识无效。')
    return hashlib.sha256(value.encode()).hexdigest()


class Control(BaseModel):
    sessionId: str
    turnId: str
    requestId: str | None = None
    decision: str | None = None
    answers: dict[str, list[str]] = Field(default_factory=dict)
    message: str = Field(default='', max_length=20000)
    modelRef: str | None = None
    thinkingLevel: str | None = None


class CodexService:
    def __init__(self, outputs: Path, client_factory=CodexClient):
        self.outputs = outputs
        self.root = outputs / '_codex'
        self.root.mkdir(parents=True, exist_ok=True)
        self.factory = client_factory
        self.lock = threading.RLock()
        self.active: dict[str, dict] = {}
        self.metadata_client = None
        self.browser_service = None
        self.failure_events = None
        self.message_builder = None
        self.budgeted_message_builder = None
        self._recover()

    def _recover(self):
        # A dead host cannot keep waiting for approvals. Do not replay turn/start.
        for path in self.root.glob('*/turns/*.json'):
            try:
                with _write_lock(path.parent.parent / 'owner', 'Codex 会话'):
                    state = json.loads(path.read_text(encoding='utf-8'))
                    if self._state_path(state['sessionId'], state['turn_id']) != path:
                        continue
                    if state.get('status') == 'running':
                        state.update(status='done', outcome='unconfirmed', pending=[],
                                     error={'message': 'Easel 后端曾中断；此轮完成状态未确认，可核对原生结果。'})
                        state.pop('startedAt', None)
                        for item in state.get('items', []):
                            if item.get('status') == 'inProgress':
                                item['status'] = 'unconfirmed'
                        self._write(path, state)
                        self._execution_event(state)
                        self._event(state, 'error', state['error'])
            except (OSError, ValueError, KeyError, RecordConflict):
                continue

    def _owner(self, sid):
        folder = self.folder(sid)
        folder.mkdir(parents=True, exist_ok=True)
        return _write_lock(folder / 'owner', 'Codex 会话')

    def _write(self, path, data):
        # Windows readers hold the destination open; serialize all in-process
        # snapshots/bindings with replacement, including startup/final cleanup.
        with self.lock:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix('.tmp')
            tmp.write_text(json.dumps(safe(data), ensure_ascii=False), encoding='utf-8')
            tmp.replace(path)

    def folder(self, sid):
        return self.root / key(sid)

    def binding(self, sid):
        with self.lock:
            path = self.folder(sid) / 'session.json'
            return json.loads(path.read_text(encoding='utf-8')) if path.exists() else None

    def bind(self, sid, engine, legacy=False):
        with self.lock:
            current = self.binding(sid)
            if current and current['engine'] != engine or legacy and engine != 'openclaw':
                raise HTTPException(409, '会话引擎已绑定；请新建会话切换引擎。')
            if not current:
                try:
                    with self._owner(sid):
                        # Another backend may have bound it while this process waited.
                        current = self.binding(sid)
                        if current and current['engine'] != engine:
                            raise HTTPException(409, '会话引擎已绑定；请新建会话切换引擎。')
                        if not current:
                            self._write(self.folder(sid) / 'session.json', {'engine': engine, 'sessionId': sid})
                except RecordConflict:
                    raise HTTPException(409, '会话正在被另一运行使用。') from None

    def owns(self, sid):
        binding = self.binding(sid)
        return binding and binding['engine'] == 'codex'

    def _state_path(self, sid, tid):
        return self.folder(sid) / 'turns' / (key(tid) + '.json')

    def snapshot(self, sid, tid=None):
        with self.lock:
            if not tid:
                binding = self.binding(sid) or {}
                tid = binding.get('lastTurnId')
            if not tid:
                return {'status': 'none', 'text': ''}
            path = self._state_path(sid, tid)
            if not path.exists():
                raise HTTPException(404, 'Codex 任务记录不存在。')
            state = json.loads(path.read_text(encoding='utf-8'))
            if state.get('sessionId') != sid or state.get('turn_id') != tid:
                raise HTTPException(409, 'Codex 记录身份不匹配，未采用该记录。')
            return state

    def _persist(self, state):
        if (self.failure_events is not None and state.get('status') == 'done'
                and state.get('outcome') != 'interrupted' and isinstance(state.get('error'), dict)):
            from .gateway_auth import gateway_error
            error = state['error']
            classified = gateway_error(error.get('message', ''))
            event_id = self.failure_events.record_chat(
                turn_id=state['turn_id'], session_id=state['sessionId'],
                error={**classified, **error}, model_ref=state.get('requestedModelRef'),
                duration=state.get('elapsedMs', 0))
            if event_id:
                error['failureEventId'] = event_id
        self._write(self._state_path(state['sessionId'], state['turn_id']), state)

    def execution(self, sid, tid, before=None, limit=40):
        state = self.snapshot(sid, tid)
        state['_outputs'] = self.outputs
        rows = codex_rows(state)
        return {'sessionId': sid, 'turnId': tid, 'warnings': [], 'source': 'codex',
                **page(rows, before, limit), 'plan': state.get('plan', []),
                'progress': self._progress(state), 'timeline': self._timeline(state, rows)}

    @staticmethod
    def _timeline(state, rows):
        entries = []
        for order, item in enumerate(state.get('items', [])):
            if item.get('type') == 'agentMessage' and item.get('phase') == 'commentary' and item.get('text'):
                entries.append({'id': 'progress-' + item['id'], 'type': 'progress',
                                'order': order, 'text': public_text(item['text'], limit=4000)})
            entries.extend({'id': row['id'], 'type': 'operation', 'operationId': row['id'], 'order': order}
                           for row in rows if row['order'] == order)
        return entries[-500:]

    @staticmethod
    def _progress(state):
        return [public_text(item.get('text', '')) for item in state.get('items', [])
                if item.get('type') == 'agentMessage' and item.get('phase') == 'commentary'
                and item.get('text')][-50:]

    def _execution_event(self, state):
        rows = codex_rows({**state, '_outputs': self.outputs})
        self._event(state, 'execution', {'sessionId': state['sessionId'], 'turnId': state['turn_id'],
            **page(rows, limit=100), 'source': 'codex',
            'plan': state.get('plan', []), 'progress': self._progress(state), 'timeline': self._timeline(state, rows)})

    def _event_path(self, sid, tid):
        return self.folder(sid) / 'turns' / (key(tid) + '.jsonl')

    def _event(self, state, name, data):
        state['seq'] = state.get('seq', 0) + 1
        path = self._event_path(state['sessionId'], state['turn_id'])
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('a', encoding='utf-8') as out:
            out.write(json.dumps({'id': state['seq'], 'event': name, 'data': safe(data)}, ensure_ascii=False) + '\n')
        self._persist(state)

    def _metadata(self):
        with self.lock:
            if self.metadata_client is None or self.metadata_client.proc.poll() is not None:
                self.metadata_client = self.factory(self.root)
            return self.metadata_client

    def runtime(self):
        try:
            client = self._metadata()
            account = client.rpc('account/read', {})
            models, cursor = [], None
            for _ in range(10):
                batch = client.rpc('model/list', {'cursor': cursor} if cursor else {})
                models.extend(batch.get('data', []))
                cursor = batch.get('nextCursor')
                if not cursor:
                    break
            options = []
            for model in models:
                if not model.get('hidden'):
                    options.append({'id': 'codex/' + model['model'], 'provider': 'codex',
                        'model': model['model'], 'label': model['displayName'], 'configured': True,
                        'thinkingLevels': [x['reasoningEffort'].replace('none', 'off') for x in model['supportedReasoningEfforts']],
                        'defaultEffort': model['defaultReasoningEffort'], 'isDefault': model['isDefault']})
            return {'available': True, 'version': client.version,
                    'auth': 'login_required' if account.get('requiresOpenaiAuth') and not account.get('account')
                            else (account.get('account') or {}).get('type', 'local_provider'),
                    'source': '本机 Codex 账号与配置', 'options': options,
                    'defaultModelRef': next((x['id'] for x in options if x['isDefault']), ''),
                    'reasoning': 'summary', 'webSearch': 'cached',
                    'skills': False, 'agentOffice': False}
        except (CodexError, OSError) as exc:
            return {'available': False, 'error': safe(str(exc)), 'options': []}

    def login(self):
        result = self._metadata().rpc('account/login/start', {'type': 'chatgpt'})
        # Only these UI fields, never auth blobs or email addresses.
        return {k: result[k] for k in ('type', 'authUrl', 'loginId') if k in result}

    def task_config_hash(self):
        # Hash internally; the native configuration may contain private values.
        client = self._metadata()
        config = client.rpc('config/read', {'includeLayers': False}).get('config')
        if not isinstance(config, dict):
            raise TaskConflict('Codex配置不可核对，未启用目标。')
        return hashlib.sha256(json.dumps({'version': client.version, 'config': config},
                                        sort_keys=True, ensure_ascii=False).encode()).hexdigest()

    @staticmethod
    def require_task_hooks(client, workspace):
        entries = client.rpc('hooks/list', {'cwds': [str(workspace)]}).get('data')
        if (not isinstance(entries, list) or not entries
                or any(not isinstance(row, dict) or row.get('errors') or not isinstance(row.get('hooks'), list) for row in entries)):
            raise TaskConflict('Codex运行钩子不可核对，未派发目标。')
        if any(hook.get('enabled') and hook.get('eventName') in ('stop', 'subagentStop')
               and hook.get('trustStatus') in ('trusted', 'managed')
               for row in entries for hook in row['hooks']):
            raise TaskConflict('Codex存在运行结束钩子，可能另行续跑；请使用独立Codex配置执行Easel目标。')

    def _require_session(self, sid):
        from .task_store import TaskStore, TaskConflict
        try:
            TaskStore(self.outputs).require_session(sid)
        except TaskConflict as exc:
            raise HTTPException(409, str(exc)) from None

    def start(self, req):
        # Hold ownership across admission, native execution and resource cleanup.
        key(req.sessionId or '')
        key(req.turnId or '')
        self._require_session(req.sessionId)
        if self._state_path(req.sessionId, req.turnId).exists() and self.owns(req.sessionId):
            self.snapshot(req.sessionId, req.turnId)
            return req.turnId
        owner = self._owner(req.sessionId)
        try:
            owner.__enter__()
        except RecordConflict:
            if self._state_path(req.sessionId, req.turnId).exists():
                return req.turnId  # Attach only; never dispatch a duplicate.
            raise HTTPException(409, '此 Codex 会话仍由另一运行或核对操作占用。') from None
        transferred = False
        try:
            result, transferred = self._start(req, owner)
            return result
        finally:
            if not transferred:
                owner.__exit__(None, None, None)

    def _start(self, req, owner):
        sid, tid = req.sessionId, req.turnId
        key(sid or '')
        key(tid or '')
        self._require_session(sid)
        if req.selectedSkills or req.skillRequirements:
            raise HTTPException(400, 'Codex 的 Easel 技能适配尚未接通，请清空技能选择。')
        if not req.message.strip() and not req.attachments:
            raise HTTPException(400, '消息或附件不能为空。')
        if self.session_work(sid):
            raise HTTPException(409, '此会话有未确认的原轮次，请先核对结果；本条消息未发送。')
        runtime = self.runtime()
        if not runtime['available'] or runtime['auth'] == 'login_required':
            raise HTTPException(503, runtime.get('error', '请先登录本机 Codex。'))
        selected = req.modelRef or runtime['defaultModelRef']
        model = next((m for m in runtime['options'] if m['id'] == selected), None)
        if not model or req.thinkingLevel and req.thinkingLevel not in model['thinkingLevels']:
            raise HTTPException(400, '模型或思考强度不在本机 Codex 返回的支持范围内。')
        with self.lock:
            binding = self.binding(sid) or {}
            if binding.get('engine') != 'codex':
                raise HTTPException(409, '此会话没有绑定 Codex。')
            existing = self._state_path(sid, tid)
            if existing.exists():
                return tid, False  # Attach only; never dispatch a duplicate.
            if sid in self.active:
                raise HTTPException(409, '此会话上一轮仍在运行。')
            if self.session_work(sid):
                raise HTTPException(409, '此会话有未确认的原轮次，请先核对结果；本条消息未发送。')
            workspace = self.outputs / 'codex' / key(sid)[:24]
            workspace.mkdir(parents=True, exist_ok=True)
            manifest, images = [], []
            for attachment in req.attachments:
                # Ownership is checked by the existing upload validator before this method.
                source = (self.outputs / attachment.path).resolve()
                if not source.is_relative_to(self.outputs.resolve()) or not source.is_file():
                    raise HTTPException(400, '附件路径无效。')
                target = workspace / 'assets' / (attachment.id + source.suffix)
                target.parent.mkdir(exist_ok=True)
                shutil.copy2(source, target)
                manifest.append(target.relative_to(workspace).as_posix())
                if source.suffix.lower() in {'.png', '.jpg', '.jpeg', '.webp', '.gif'}:
                    images.append(str(target))
            from easel.agent_roles import role_snapshot
            role = role_snapshot(getattr(req, 'roleId', None))
            if getattr(req, 'roleId', None) and role is None:
                raise HTTPException(400, '角色不存在或已被移除。')
            state = {'sessionId': sid, 'turn_id': tid, 'engine': 'codex', 'status': 'running',
                     'outcome': 'running', 'roleId': getattr(req, 'roleId', None), 'role': role,
                     'text': '', 'thinking': '', 'thinkingStatus': 'waiting',
                     'items': [], 'pending': [], 'seq': 0, 'requestedModelRef': selected,
                     'requestedThinkingLevel': req.thinkingLevel, 'workspace': str(workspace),
                     'webSearch': 'cached', 'startedAt': int(time.time() * 1000), 'threadId': binding.get('threadId')}
            task_mode = CodexTasks(self.outputs).prepare(state)
            if task_mode:
                self.require_task_hooks(self._metadata(), workspace)
            from easel.context_budget import ContextBudgetError, require_admitted
            ticket = ArtifactStore(self.outputs).bind(sid, tid)
            params = self._thread_params(state, model, ticket)
            effort = (state['requestedThinkingLevel'] or model['defaultEffort']).replace('off', 'none')
            suffix = ('\n\n本轮附件（位于当前工作目录）：\n' + '\n'.join(manifest)) if manifest else ''
            def transported(text):
                return self._local_payload(text + suffix, params, images, effort)
            try:
                text = (self.budgeted_message_builder(req, transported) if self.budgeted_message_builder
                        else self.message_builder(req) if self.message_builder else req.message)
                text += suffix
                state['promptAdmission'] = require_admitted(self._local_payload(text, params, images, effort)).public()
            except ContextBudgetError as exc:
                raise HTTPException(413, exc.public()) from None
            state['usageCursor'] = binding.get('usageCursor') if binding.get('threadId') else dict.fromkeys(
                ('inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'), 0)
            binding['lastTurnId'] = tid
            self._write(self.folder(sid) / 'session.json', binding)
            self._persist(state)
            self._event(state, 'timing', {'startedAt': state['startedAt']})
            self._event(state, 'activity', 'Codex 正在启动；等待实际事件。')
            run = {'threadParams': params, 'effort': effort, 'state': state, 'client': None, 'queue': None, 'requests': {},
                   'inputImages': images, 'browserJobs': set(), 'browserFinished': False, 'browserStop':threading.Event(),
                   'startedMonotonic': time.monotonic(),
                   'finished': threading.Event(), 'controlLock': threading.Lock(), 'owner': owner}
            self.active[sid] = run
            try:
                threading.Thread(target=self._run, args=(run, text, model), daemon=True, name='easel-codex-turn').start()
            except Exception:
                self.active.pop(sid, None)
                raise
            return tid, True

    def _thread_params(self, state, model, ticket):
        params = {'cwd': state['workspace'], 'model': model['model'], 'approvalPolicy': 'on-request',
                  'approvalsReviewer': 'user', 'sandbox': 'workspace-write',
                  'config': {'web_search': 'cached'},
                  'developerInstructions': '你正在 Easel 本地工作台中协助用户。用中文回答。产出保存在当前工作目录。仅使用本轮明确提供的附件。思考摘要和工具记录以真实协议事件为准，不编造。'}
        if state.get('role'):
            from easel.agent_roles import role_context
            params['developerInstructions'] += '\n' + role_context(state['roleId'])
        params['developerInstructions'] += ('保存产物后调用easel_present交付已有文件到当前对话；'
            '不要只在最终回复中写链接。如果旧会话没有该工具，在一次命令工具输出独立一行 '
            'EASEL_PRESENT {"files":[{"path":"相对工作目录的实际文件路径"}]}，由宿主校验交付。'
            'HTML使用自包含CSS/脚本或本地资源；预览隔离运行，不依赖外部CDN、联网接口或嵌套网页。')
        params['developerInstructions'] += ('复杂或长任务先使用原生update_plan提交可验收的步骤，执行中持续更新；'
            '短问答不强制建计划。工具回执不代表步骤完成，实际核验后才能标completed；失败或中断不得自动勾选剩余步骤。')
        if self.browser_service:
            from .browser_bridge import instructions
            params['developerInstructions'] += instructions(state['sessionId'])
        script = Path(__file__).resolve().parents[1] / 'skills/shared/scripts/image_job.py'
        publish_script = Path(__file__).resolve().parents[1] / 'skills/shared/scripts/prepare_publish.py'
        params['developerInstructions'] += (f'用户要求准备发布内容时，调用easel_prepare_publish登记可编辑草稿，必须提供固定requestId和body。'
            f'旧会话缺此工具时，将正文保存为UTF-8文件，执行 python "{publish_script}" --ticket {ticket} --request-id "<固定标识>" --body-file "<正文文件>"。'
            '草稿自动关联当前对话，可在辅助面板查看。该工具不发布；账号预检和最终提交由用户在发布中心确认。')
        params['developerInstructions'] += (f'用户明确要求AI生图时使用easel_generate_image，requestId为每张图固定标识，prompt为提示词。'
            f'旧会话缺此工具时可执行 python "{script}" submit --ticket {ticket} --request-id "<固定标识>" --prompt "<提示词>"。'
            '可能产生图片费用，只用专用生图通道，不改请求标识重试，不隐式换模型；任务完成后文件自动展示。')
        if state['threadId']:
            params['threadId'] = state['threadId']
        else:
            params['dynamicTools'] = [PRESENT_TOOL, GENERATE_TOOL, PREPARE_TOOL] + ([BROWSER_TOOL] if self.browser_service else [])
            if state.get('taskGoal'):
                params['dynamicTools'].append(DELIVER_TOOL)
        if state.get('taskGoal'):
            # Easel alone schedules turns/roles. Never enable native goal/delegation loops.
            params['config'].update({'features.goals': False, 'features.multi_agent': False,
                                     'features.multi_agent_v2': False, 'features.image_generation': False,
                                     'features.memories': False})
            params['developerInstructions'] += (
                '\n本轮由Easel目标调度器管理，只执行当前步骤，不创建原生目标或子Agent。'
                '工具为观察上限，达到后宿主请求中断；不得以其他工具绕过。'
                '验收及交接文件按条件中的相对路径写入当前工作目录，调用easel_task_deliver登记到共享证据目录。'
                '若恢复的旧线程缺少该工具，在命令输出独立一行EASEL_TASK_DELIVER '
                '{"files":[{"path":"与验收条件相同的相对路径"}]}，宿主会校验。'
                '仅在工作目录保存文件或调用easel_present不能代替任务交接。')
        return params

    @staticmethod
    def _local_payload(text, params, images, effort):
        from easel.context_budget import serialized
        return serialized({'thread': params, 'turn': {'threadId': params.get('threadId', ''),
                           'model': params['model'], 'summary': 'auto', 'effort': effort,
                           'input': [{'type': 'text', 'text': text}] +
                           [{'type': 'localImage', 'path': path} for path in images]}})

    def _run(self, run, text, model):
        try:
            self._run_owned(run, text, model)
        finally:
            try:
                if run.get('client'):
                    run['client'].close()
                run['clientClosed'] = True
            finally:
                with self.lock:
                    self._task_cleanup_receipt(run)
                    if self.active.get(run['state']['sessionId']) is run:
                        self.active.pop(run['state']['sessionId'], None)
                    run['finished'].set()
                if run.get('owner'):
                    run['owner'].__exit__(None, None, None)

    def _task_cleanup_receipt(self, run):
        state = run['state']
        if (state.get('taskGoal') and run.get('clientClosed') and not run.get('browserJobs')
                and not run.get('browserCleanupFailed')):
            state['resourceSettled'] = True
            self._persist(state)

    def _stop_task_async(self, run):
        if run.get('taskStopping'):
            return
        run['taskStopping'] = True
        def stop():
            try:
                self.stop(run['state']['sessionId'], run['state']['turn_id'])
            except Exception:
                pass  # Preserve the unconfirmed run; never invent a terminal receipt.
        threading.Thread(target=stop, daemon=True, name='easel-codex-task-stop').start()

    def _run_owned(self, run, text, model):
        state, client, thread = run['state'], None, None
        try:
            from easel.context_budget import require_admitted
            require_admitted(self._local_payload(text, run['threadParams'], run.get('inputImages', []), run['effort']))
            client = self.factory(Path(state['workspace']))
            run['client'] = client
            if state.get('taskGoal'):
                self.require_task_hooks(client, state['workspace'])
            params = run['threadParams']
            if state['threadId']:
                response = client.rpc('thread/resume', params)
            else:
                response = client.rpc('thread/start', params)
            thread = response['thread']['id']
            with self.lock:
                state['threadId'] = thread
                state['actualModel'] = response.get('model')
                binding = self.binding(state['sessionId'])
                binding['threadId'] = thread
                self._write(self.folder(state['sessionId']) / 'session.json', binding)
            events = client.subscribe(thread)
            run['queue'] = events
            self._require_session(state['sessionId'])
            turn_params = {'threadId': thread, 'input': [{'type': 'text', 'text': text}] +
                [{'type': 'localImage', 'path': path} for path in run.get('inputImages', [])],
                'model': model['model'], 'effort': run['effort'],
                'summary': 'auto'}
            from easel.context_budget import serialized
            state['promptAdmission'] = require_admitted(serialized({'thread': params, 'turn': turn_params})).public()
            if state.get('taskGoal'):
                CodexTasks(self.outputs).context(state, current=True)
            run['turnSubmitted'] = True
            started = client.rpc('turn/start', turn_params)
            state['codexTurnId'] = started['turn']['id']
            if state.get('taskGoal'):
                tasks = CodexTasks(self.outputs)
                if not tasks.store.bind_provider(state['sessionId'], state['turn_id'], state['codexTurnId']):
                    self._stop_task_async(run)
                try:
                    tasks.context(state, current=True)
                except TaskConflict:
                    self._stop_task_async(run)
            self._persist(state)
            while True:
                try:
                    event = events.get(timeout=1)
                except queue.Empty:
                    if client.proc.poll() is not None or client._closed.is_set():
                        raise CodexError('Codex 事件连接中断，完成状态未确认。')
                    continue
                with self.lock:
                    if self._consume(run, event):
                        break
                    self._persist(state)
        except ContextBudgetError as exc:
            with self.lock:
                state.update(outcome='rejected', error=exc.public(), promptAdmission=exc.admission.public())
        except Exception as exc:
            with self.lock:
                state.update(outcome='rejected' if state.get('taskGoal') and not run.get('turnSubmitted') else 'unconfirmed',
                             error={'message': safe(str(exc))[:1500]})
        finally:
            self._cancel_browser_jobs(run)
            with self.lock:
                state['elapsedMs'] = max(0, round((time.monotonic() - run['startedMonotonic']) * 1000))
                state['status'] = 'done'
                state['pending'] = []
                run['requests'].clear()
                if state['thinking']:
                    state['thinkingStatus'] = 'partial' if state.get('error') or state['outcome'] == 'interrupted' else 'available'
                else:
                    state['thinkingStatus'] = 'unavailable'
                for item in state['items']:
                    if item.get('status') == 'inProgress':
                        item['status'] = 'unconfirmed'
                self._persist(state)
                self._execution_event(state)
                self._event(state, 'timing', {'startedAt': state['startedAt'], 'elapsedMs': state['elapsedMs']})
                self._event(state, 'error' if state.get('error') else 'done', state.get('error') or {'sessionKey': 'codex:' + (thread or '')})
                try:
                    from .notifications import chat_finished
                    chat_finished(self.outputs, state['sessionId'], state['turn_id'],
                                  failed=bool(state.get('error')), stopped=state.get('outcome') == 'interrupted')
                except (OSError, ValueError, sqlite3.Error):
                    pass  # A notification failure must never prevent task cleanup.
            if client:
                if thread:
                    client.unsubscribe(thread)

    def _consume(self, run, event):
        state = run['state']
        method, params = event.get('method', ''), event.get('params') or {}
        if method == 'easel/transportClosed':
            raise CodexError('Codex 连接中断，完成状态未确认。')
        if params.get('turnId') and params['turnId'] != state['codexTurnId']:
            return False
        if params.get('threadId') and params['threadId'] != state.get('threadId'):
            return False
        if 'id' in event:
            return self._request(run, event)
        if method == 'item/agentMessage/delta':
            delta = safe(params.get('delta', ''))
            item = next((i for i in state['items'] if i['id'] == params.get('itemId')), None)
            if item is not None:
                item['text'] = item.get('text', '') + delta
            if item is not None and item.get('phase') == 'commentary':
                self._execution_event(state)
            else:
                state['text'] += delta
                self._event(state, 'token', delta)
        elif method == 'item/reasoning/summaryTextDelta':
            delta = safe(params.get('delta', ''))
            block = str(params.get('itemId', '')) + ':' + str(params.get('summaryIndex', 0))
            if state.get('_reasoningBlock') is not None and state['_reasoningBlock'] != block:
                delta = '\n\n' + delta
            state['_reasoningBlock'] = block
            state['thinking'] += delta
            state['thinkingStatus'] = 'available'
            self._event(state, 'thinking', delta)
        elif method in ('item/started', 'item/completed'):
            raw_item = params.get('item', {})
            item = safe(raw_item)
            if not isinstance(item, dict):
                return False
            if (state.get('taskGoal') and item.get('id') and item.get('type') not in
                    ('userMessage', 'agentMessage', 'reasoning', 'plan', 'contextCompaction', 'dynamicToolCall', 'hookPrompt')):
                decision = CodexTasks(self.outputs).store.observe_codex_tool(
                    state['sessionId'], state['turn_id'], state['codexTurnId'], item['id'], item.get('type', 'unknown'))
                if decision['stop']:
                    self._stop_task_async(run)
            if isinstance(raw_item.get('aggregatedOutput'), str) and len(raw_item['aggregatedOutput']) > 64000:
                item['_outputTruncated'] = True
            for index, change in enumerate(raw_item.get('changes') or []):
                if isinstance(change, dict) and isinstance(change.get('diff'), str) and len(change['diff']) > 64000:
                    item['changes'][index]['_diffTruncated'] = True
            if method == 'item/completed' and 'status' not in item:
                item['status'] = 'completed'
            if isinstance(item.get('aggregatedOutput'), str):
                item['aggregatedOutput'] = public_text(item['aggregatedOutput'])
            if item.get('id'):
                if method == 'item/completed' and item.get('type') == 'commandExecution' and item.get('status') == 'completed':
                    for line in str(raw_item.get('aggregatedOutput', '')).splitlines():
                        if line.startswith('EASEL_PRESENT '):
                            try:
                                self._present_files(state, json.loads(line[len('EASEL_PRESENT '):]).get('files'), item['id'])
                            except (ValueError, OSError, TypeError, KeyError):
                                self._event(state, 'activity', '文件交付未通过校验，请核对实际路径和文件。')
                        if state.get('taskGoal') and line.startswith('EASEL_TASK_DELIVER '):
                            try:
                                values = CodexTasks(self.outputs).deliver(state, json.loads(line[len('EASEL_TASK_DELIVER '):]).get('files'))
                                self._event(state, 'artifacts', {'artifacts': values})
                            except (ValueError, OSError, TypeError):
                                self._event(state, 'activity', '任务交接未通过路径、文件或运行状态校验。')
                old = next((i for i in state['items'] if i['id'] == item['id']), None)
                if old is None:
                    item['_startedAt'] = iso(time.time()) if method == 'item/started' else None
                    if method == 'item/completed':
                        item['_finishedAt'] = iso(time.time())
                    state['items'].append(item)
                else:
                    old.update(item)
                    if method == 'item/completed':
                        old['_finishedAt'] = iso(time.time())
                if item.get('type') not in ('userMessage', 'reasoning', 'agentMessage'):
                    self._event(state, 'activity', f"{item.get('type')} · {item.get('status', '开始' if method.endswith('started') else '完成')}")
                    self._execution_event(state)
                # Some providers send only completed item text. Snapshot corrects missing deltas.
                if method == 'item/completed' and item.get('type') == 'agentMessage':
                    messages = [i.get('text', '') for i in state['items'] if i.get('type') == 'agentMessage'
                                and i.get('phase') != 'commentary']
                    state['text'] = '\n\n'.join(messages)
                    self._event(state, 'text_snapshot', state['text'])
                    self._execution_event(state)
                if method == 'item/completed' and item.get('type') == 'reasoning' and not state['thinking']:
                    summary = item.get('summary') or []
                    if summary:
                        state['thinking'] = '\n'.join(summary)
                        state['thinkingStatus'] = 'available'
                        self._event(state, 'thinking', state['thinking'])
        elif method == 'item/commandExecution/outputDelta':
            item = next((i for i in state['items'] if i['id'] == params.get('itemId')), None)
            if item:
                output = (item.get('aggregatedOutput') or '') + safe(params.get('delta', ''))
                item['aggregatedOutput'] = public_text(output)
                item['_outputTruncated'] = item.get('_outputTruncated', False) or len(output) > 64000
                self._execution_event(state)
        elif method == 'turn/plan/updated':
            state['plan'] = safe(params.get('plan') or [])
            if state.get('taskGoal'):
                try:
                    CodexTasks(self.outputs).progress(state, params.get('plan'))
                except (ValueError, KeyError, TypeError):
                    self._event(state, 'activity', '目标步骤未更新，请核对运行状态及步骤内容。')
            self._execution_event(state)
        elif method == 'thread/tokenUsage/updated':
            from .codex_usage import observe
            observe(state, params.get('tokenUsage'))
            state['usageAt'] = int(time.time() * 1000)
            self._persist(state)
            binding = self.binding(state['sessionId'])
            if binding and binding.get('threadId') == state.get('threadId'):
                binding['usageCursor'] = state.get('usageCursor')
                self._write(self.folder(state['sessionId']) / 'session.json', binding)
        elif method == 'turn/diff/updated':
            state['diff'] = safe(params.get('diff', ''))
        elif method == 'serverRequest/resolved':
            request_id = str(params.get('requestId'))
            run['requests'].pop(request_id, None)
            state['pending'] = [r for r in state['pending'] if r['requestId'] != request_id]
        elif method == 'turn/completed':
            turn = params.get('turn') or {}
            state['outcome'] = turn.get('status', 'unconfirmed')
            if turn.get('error'):
                state['error'] = {'message': safe(turn['error'].get('message', 'Codex 任务失败。'))}
            elif state['outcome'] == 'failed':
                state['error'] = {'message': 'Codex 上报本轮执行失败。'}
            return True
        elif method == 'error':
            error = params.get('error') or {}
            state['error'] = {'message': public_text(error.get('message', 'Codex 返回错误。'), limit=1500)}
        return False

    def _request(self, run, event):
        method, params = event['method'], event.get('params') or {}
        if run['state'].get('taskGoal') and method == 'item/tool/call':
            try:
                CodexTasks(self.outputs).guard(run['state'], params.get('callId') or event['id'], params.get('tool', 'unknown'))
            except TaskConflict as exc:
                run['client'].reply(event['id'], {'success': False, 'contentItems': [{'type': 'inputText', 'text': str(exc)}]})
                self._stop_task_async(run)
                return False
        if method == 'item/tool/call' and params.get('tool') == 'easel_task_deliver' and not params.get('namespace'):
            try:
                if not run['state'].get('taskGoal'):
                    raise TaskConflict('当前轮次未绑定Codex目标。')
                values = CodexTasks(self.outputs).deliver(run['state'], params.get('arguments', {}).get('files'))
                result = {'success': True, 'contentItems': [{'type': 'inputText', 'text': json.dumps({'artifacts': values, 'qualityApproved': False}, ensure_ascii=False)}]}
                self._event(run['state'], 'artifacts', {'artifacts': values})
            except (ValueError, OSError, TypeError, AttributeError):
                result = {'success': False, 'contentItems': [{'type': 'inputText', 'text': '交接未接受：文件须存在于工作目录且路径匹配当前阶段/最终文件条件，目标必须仍在运行。'}]}
            run['client'].reply(event['id'], result)
            return False
        if method == 'item/tool/call' and params.get('tool') == 'easel_prepare_publish' and not params.get('namespace'):
            try:
                state = run['state']
                draft = CreationDrafts(self.outputs).prepare(state['sessionId'], state['turn_id'], params.get('arguments'))
                result = {'success': True, 'contentItems': [{'type': 'inputText', 'text': json.dumps({'draft': draft, 'requiresUserConfirmation': True}, ensure_ascii=False)}]}
                self._event(state, 'activity', '发布草稿已准备，可在辅助面板编辑；尚未提交发布。')
            except (ValueError, OSError, TypeError, LookupError):
                result = {'success': False, 'contentItems': [{'type': 'inputText', 'text': '草稿未接受，请核对正文、平台、固定请求标识和本机素材。未执行发布。'}]}
            run['client'].reply(event['id'], result)
            return False
        if method == 'item/tool/call' and params.get('tool') == 'easel_browser' and not params.get('namespace'):
            if not self.browser_service:
                run['client'].reply(event['id'], {'success':False,'contentItems':[{'type':'inputText','text':'当前浏览器服务不可用。'}]})
                return False
            args = params.get('arguments')
            if not isinstance(args, dict):
                run['client'].reply(event['id'], {'success':False,'contentItems':[{'type':'inputText','text':'浏览器参数必须是对象。'}]})
                return False
            if args.get('action') not in ('state','image') and not args.get('requestId'):
                run['client'].reply(event['id'], {'success':False,'contentItems':[{'type':'inputText','text':'操作必须提供固定requestId，避免重复执行。'}]})
                return False
            request_id = args.get('requestId') or 'codex-' + uuid.uuid4().hex
            if not isinstance(request_id,str):
                run['client'].reply(event['id'], {'success':False,'contentItems':[{'type':'inputText','text':'requestId必须是字符串。'}]})
                return False
            args = {**args, 'requestId':request_id}
            run.setdefault('browserJobs',set()).add(request_id)
            threading.Thread(target=self._browser_tool_worker,args=(run,event,args),daemon=True,name='easel-codex-browser').start()
            return False
        if method == 'item/tool/call' and params.get('tool') == 'easel_generate_image' and not params.get('namespace'):
            try:
                args = params.get('arguments')
                if not isinstance(args, dict) or not isinstance(args.get('requestId'), str):
                    raise ValueError('Invalid arguments')
                state = run['state']
                job = ImageJobs(self.outputs).submit({'prompt': args.get('prompt'), 'size': args.get('size', '1024x1024')},
                    read_config(self.outputs.parent), session=state['sessionId'], turn=state['turn_id'], request_id=args['requestId'])
                result = {'success': True, 'contentItems': [{'type': 'inputText', 'text': json.dumps({'job': job}, ensure_ascii=False)}]}
                self._event(state, 'activity', '生图任务已登记，等待专用图片通道执行；勿重复提交。')
            except (ValueError, OSError, TypeError):
                result = {'success': False, 'contentItems': [{'type': 'inputText', 'text': '生图任务未接受：请检查请求标识、提示词和专用图片通道配置，不自动回退或重试。'}]}
            run['client'].reply(event['id'], result)
            return False
        if method == 'item/tool/call' and params.get('tool') == 'easel_present' and not params.get('namespace'):
            try:
                arguments = params.get('arguments')
                if not isinstance(arguments, dict):
                    raise ValueError('Invalid tool arguments')
                values = self._present_files(run['state'], arguments.get('files'), params.get('callId'))
                result = {'success': True, 'contentItems': [{'type': 'inputText', 'text': json.dumps({'artifacts': values}, ensure_ascii=False)}]}
            except (ValueError, OSError, TypeError, KeyError):
                result = {'success': False, 'contentItems': [{'type': 'inputText', 'text': '交付失败：文件必须实际存在于当前工作目录，且不能是附件、隐藏文件或越界路径。'}]}
            run['client'].reply(event['id'], result)
            return False
        supported = {'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
                     'item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request'}
        if method not in supported:
            run['client'].send({'id': event['id'], 'error': {'code': -32601, 'message': 'Easel does not support this request'}})
            self._event(run['state'], 'activity', 'Codex 请求尚未支持：' + method)
            return False
        ident = str(event['id'])
        run['requests'][ident] = event
        run['state']['pending'].append({'requestId': ident, 'method': method, 'params': safe(params)})
        self._event(run['state'], 'activity', 'Codex 等待你的审批或回答。')
        return False

    def _browser_tool_worker(self, run, event, args):
        try:
            with self.lock:
                if run.get('browserFinished'):
                    run.setdefault('browserJobs',set()).discard(args['requestId'])
                    self._task_cleanup_receipt(run)
                    return
                # Submit under the same lock used by stop, so cancellation cannot
                # run before the host has registered this browser operation.
                future = self.browser_service.submit('bound_tool', run['state']['sessionId'], args, run.setdefault('browserStop',threading.Event()))
            result = future.result(timeout=40)
        except Exception as exc:
            if isinstance(exc, TimeoutError):
                try:
                    self.browser_service.call('cancel',run['state']['sessionId'],args['requestId'])
                except (BrowserError, TimeoutError):
                    run['browserCleanupFailed'] = True
            text = str(exc) if isinstance(exc, BrowserError) else '浏览器工具未完成，请先重新观察；不要重复执行未确认操作。'
            result = {'success':False,'contentItems':[{'type':'inputText','text':public_text(text,limit=800)}]}
        try:
            run['client'].reply(event['id'],result)
        except (OSError, CodexError, RuntimeError):
            pass
        finally:
            with self.lock:
                run.setdefault('browserJobs',set()).discard(args['requestId'])
                self._task_cleanup_receipt(run)

    def _cancel_browser_jobs(self, run):
        with self.lock:
            run['browserFinished'] = True
            run.setdefault('browserStop',threading.Event()).set()
            ids = list(run.get('browserJobs',()))
        if self.browser_service:
            for request_id in ids:
                try:
                    self.browser_service.call('cancel',run['state']['sessionId'],request_id)
                except (BrowserError, TimeoutError):
                    run['browserCleanupFailed'] = True
            # Older resumed threads use the CLI bridge, whose calls do not
            # appear as dynamic tool requests on this App Server connection.
            if self.browser_service.has_pages(run['state']['sessionId']):
                try:
                    self.browser_service.call('cancel_agents',run['state']['sessionId'])
                except (BrowserError, TimeoutError):
                    run['browserCleanupFailed'] = True

    def _present_files(self, state, files, call):
        if not isinstance(files, list) or not 1 <= len(files) <= 16:
            raise ValueError('Invalid delivery list')
        workspace = Path(state['workspace']).resolve()
        normalized = []
        for entry in files:
            if not isinstance(entry, dict) or not isinstance(entry.get('path'), str):
                raise ValueError('Invalid file')
            target = (workspace / entry['path']).resolve()
            relative = target.relative_to(workspace)
            if not relative.parts or relative.parts[0] == 'assets':
                raise ValueError('Request attachments cannot be presented as generated files')
            normalized.append({**entry, 'path': str(target)})
        values = ArtifactStore(self.outputs).present(state['sessionId'], state['turn_id'], normalized, source='codex', call=call)
        self._event(state, 'artifacts', {'artifacts': values})
        return values

    def _active(self, req):
        self._require_session(req.sessionId)
        run = self.active.get(req.sessionId)
        if not run or run['state']['turn_id'] != req.turnId or not run['state'].get('codexTurnId'):
            raise HTTPException(409, '此轮已结束或尚未启动；控制请求未发送。')
        return run

    def answer(self, req):
        with self.lock:
            run = self._active(req)
            event = run['requests'].get(req.requestId)
            if event is None:
                raise HTTPException(409, '该审批已解决或失效，未重复提交。')
            method, params = event['method'], event['params']
            if method == 'item/tool/requestUserInput':
                questions = params.get('questions') or []
                expected = {q['id'] for q in questions}
                if set(req.answers) != expected or any(not a or any(not x.strip() or len(x) > 20000 for x in a) for a in req.answers.values()):
                    raise HTTPException(400, '请回答所有问题。')
                result = {'answers': {k: {'answers': v} for k, v in req.answers.items()}}
            elif method == 'mcpServer/elicitation/request':
                if req.decision not in ('decline', 'cancel'):
                    raise HTTPException(400, '此版暂不支持 MCP 表单授权，可拒绝或取消。')
                result = {'action': req.decision}
            elif method == 'item/permissions/requestApproval':
                if req.decision not in ('accept', 'decline'):
                    raise HTTPException(400, '审批选项无效。')
                result = {'permissions': params['permissions'] if req.decision == 'accept' else {}, 'scope': 'turn'}
            else:
                if req.decision not in ('accept', 'decline', 'cancel'):
                    raise HTTPException(400, '审批选项无效。')
                result = {'decision': req.decision}
            run['client'].reply(event['id'], result)
            run['requests'].pop(req.requestId)
            state = run['state']
            state['pending'] = [r for r in state['pending'] if r['requestId'] != req.requestId]
            self._persist(state)
            return {'ok': True}

    def steer(self, req):
        with self.lock:
            run = self._active(req)
            state = run['state']
            if req.modelRef != state['requestedModelRef'] or req.thinkingLevel != state['requestedThinkingLevel']:
                raise HTTPException(409, '插话的模型和强度必须与当前轮相同；其他配置请排队到下一轮。')
            if not req.message.strip():
                raise HTTPException(400, '插话不能为空。')
            client, thread, turn = run['client'], state['threadId'], state['codexTurnId']
        with run['controlLock']:
            with self.lock:
                receipts = state.setdefault('steering', {})
                if not req.requestId:
                    raise HTTPException(400, '插话缺少去重标识。')
                if req.requestId in receipts:
                    if receipts[req.requestId] == 'accepted':
                        return {'ok': True, 'turnId': turn}
                    raise HTTPException(409, '上次插话回执未确认，为避免重复未重发。')
                from easel.context_budget import require_admitted, serialized
                payload = {'threadId': thread, 'expectedTurnId': turn,
                           'input': [{'type': 'text', 'text': req.message}]}
                try:
                    require_admitted(serialized(payload))
                except ContextBudgetError as exc:
                    raise HTTPException(413, exc.public()) from None
                receipts[req.requestId] = 'unconfirmed'
                self._persist(state)
            result = client.rpc('turn/steer', payload)
            with self.lock:
                receipts[req.requestId] = 'accepted'
                self._persist(state)
        return {'ok': True, 'turnId': result.get('turnId', turn)}

    def session_work(self, sid):
        """Include unsettled persisted turns even after the chat lease was released."""
        turns = []
        with self.lock:
            for path in (self.folder(sid) / 'turns').glob('*.json'):
                try:
                    state = json.loads(path.read_text(encoding='utf-8'))
                except (OSError, ValueError):
                    raise HTTPException(503, 'Codex会话历史损坏，未发送新消息。') from None
                turn = state.get('turn_id')
                if (state.get('sessionId') != sid or not isinstance(turn, str)
                        or self._state_path(sid, turn) != path):
                    raise HTTPException(503, 'Codex会话历史身份不匹配，未发送新消息。')
                if state.get('status') != 'done' or state.get('outcome') == 'unconfirmed':
                    turns.append(turn)
        return sorted(set(turns))

    def reconcile(self, sid, tid):
        from .codex_recovery import read_turn, project
        try:
            with self._owner(sid):
                state = self.snapshot(sid, tid)
                if state.get('status') != 'running' and state.get('outcome') != 'unconfirmed':
                    if state.get('taskGoal') and state.get('outcome') in ('completed', 'failed', 'interrupted', 'rejected'):
                        state['resourceSettled'] = self.task_browser_settled(sid)
                        self._persist(state)
                    return state
                client = None
                try:
                    if not state.get('threadId') or not state.get('codexTurnId'):
                        raise CodexError('原生线程或轮次标识缺失，无法确认结果。')
                    client = self.factory(self.root)
                    native = read_turn(client, state)
                    # Deleted sessions may settle their history, but never dispatch again.
                    recovered = copy.deepcopy(state)
                    project(recovered, native, safe)
                    if state.get('taskGoal'):
                        recovered['resourceSettled'] = self.task_browser_settled(sid)
                    state = recovered
                    state['recoveryEventAfter'] = state.get('seq', 0)
                    state['recovery'] = {'source': 'codex-persisted-turn', 'status': 'adopted',
                                         'checkedAt': int(time.time() * 1000)}
                    self._event(state, 'text_snapshot', state['text'])
                    self._execution_event(state)
                    self._event(state, 'error' if state.get('error') else 'done', state.get('error') or
                        {'sessionKey': 'codex:' + state['threadId'], 'stopped': state['stopped']})
                except Exception as exc:
                    state['recovery'] = {'source': 'codex-persisted-turn', 'status': 'unconfirmed',
                        'checkedAt': int(time.time() * 1000), 'message': safe(str(exc))[:1500]}
                    self._persist(state)
                finally:
                    if client:
                        try:
                            client.close()
                        except Exception:
                            pass
                return state
        except RecordConflict:
            raise HTTPException(409, '原轮次仍被运行或核对操作占用，请稍后读取。') from None

    def task_browser_settled(self, sid):
        if not self.browser_service or not self.browser_service.has_pages(sid):
            return True
        try:
            state = self.browser_service.call('state', sid)
            return all(job.get('state') not in ('queued', 'running') for job in state.get('jobs', []))
        except (BrowserError, TimeoutError):
            return False

    def stop(self, sid, tid):
        req = Control(sessionId=sid, turnId=tid or '')
        with self.lock:
            run = self.active.get(sid)
            if not run or tid and run['state']['turn_id'] != tid:
                return {'stopped': False}
            state = run['state']
            if not state.get('codexTurnId'):
                return {'stopped': False}
            client, thread, turn = run['client'], state['threadId'], state['codexTurnId']
        self._cancel_browser_jobs(run)
        with run['controlLock']:
            client.rpc('turn/interrupt', {'threadId': thread, 'turnId': turn})
        return {'stopped': run['finished'].wait(35)}

    async def stream(self, sid, tid, after=0):
        path = self._event_path(sid, tid)
        if not path.exists():
            raise HTTPException(404, 'Codex 任务记录不存在。')

        async def events():
            cursor, offset, heartbeat = max(0, after), 0, time.monotonic()
            while True:
                with path.open('r', encoding='utf-8') as source:
                    source.seek(offset)
                    while True:
                        line_start = source.tell()
                        line = source.readline()
                        if not line or not line.endswith('\n'):
                            offset = line_start
                            break
                        offset = source.tell()
                        event = json.loads(line)
                        if event['id'] <= cursor:
                            continue
                        cursor = event['id']
                        if event['event'] in ('done', 'error') and event['id'] <= self.snapshot(sid, tid).get('recoveryEventAfter', 0):
                            continue
                        yield {'id': str(cursor), 'event': event['event'], 'data': json.dumps(event['data'], ensure_ascii=False)}
                        if event['event'] in ('done', 'error'):
                            return
                if self.snapshot(sid, tid)['status'] == 'done':
                    if offset < path.stat().st_size:
                        continue
                    return
                if time.monotonic() - heartbeat >= 15:
                    yield {'event': 'ping', 'data': '{}'}
                    heartbeat = time.monotonic()
                await asyncio.sleep(.25)
        return EventSourceResponse(events(), headers={'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no'})

    def turn_session(self, tid):
        name = key(tid) + '.json'
        found = list(self.root.glob('*/turns/' + name))
        return json.loads(found[0].read_text(encoding='utf-8'))['sessionId'] if found else None

    def close(self):
        with self.lock:
            clients = [r['client'] for r in self.active.values() if r['client']] + [self.metadata_client]
        for client in clients:
            if client:
                client.close()

    def router(self):
        router = APIRouter(prefix='/api/codex')

        @router.get('/runtime')
        async def runtime():
            return await asyncio.to_thread(self.runtime)

        @router.post('/login')
        async def login():
            return await asyncio.to_thread(self.login)

        @router.get('/turn/{session_id}/{turn_id}')
        async def turn(session_id: str, turn_id: str):
            return self.snapshot(session_id, turn_id)

        @router.post('/answer')
        async def answer(req: Control):
            return await asyncio.to_thread(self.answer, req)

        @router.post('/steer')
        async def steer(req: Control):
            return await asyncio.to_thread(self.steer, req)

        @router.post('/reconcile')
        async def reconcile(req: Control):
            return await asyncio.to_thread(self.reconcile, req.sessionId, req.turnId)

        return router
