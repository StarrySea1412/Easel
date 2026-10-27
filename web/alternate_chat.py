"""Durable web admission for the existing API and native harness adapters.

This does not invent a native turn-recovery protocol. A lost producer stays
unconfirmed; reconnecting only tails the original, persisted web event stream.
"""
import asyncio
import json
import threading
import time
import uuid

from fastapi import HTTPException
from sse_starlette.sse import EventSourceResponse


def model_capability(web, session=None, model_ref=None):
    """Describe the saved chat route without probing or dispatching another engine."""
    config = web._harness_settings()
    runtime = web._chat_backend(session)
    if runtime == 'openclaw':
        import office_controls
        return office_controls.turn_model_capability(web, session, model_ref)
    result = dict(available=False, scope='unavailable', currentModelRef=None,
                  options=[], reason='请先在底座设置中保存模型。', runtime=runtime,
                  transport='harness_' + runtime, verificationState='unverified')
    if runtime == 'api':
        try:
            _, model, _ = web.api_config(web.read_settings(web.ENV_FILE))
        except web.DirectAPIError as exc:
            result['reason'] = str(exc)
            return result
        provider, label = 'direct-api', 'API 直连'
    else:
        model = config['models'].get(runtime, '')
        provider, label = runtime, {'codex': 'Codex（兼容）', 'opencode': 'OpenCode', 'acp': 'ACP'}[runtime]
        if not web.harnesses.describe(runtime)['installed']:
            result['reason'] = '当前底座 CLI 尚未安装。'
            return result
        # Native defaults are resolved by the CLI, not invented as a model id.
        if not model:
            result.update(available=True, scope='next_turn', reason=None)
            return result
    ref = provider + '/' + model
    result.update(available=True, scope='next_turn', currentModelRef=ref, defaultModelRef=ref,
                  reason=None, options=[dict(id=ref, provider=provider, model=model,
                    label=label + ' · ' + model, channelName=label, configured=True)])
    return result


class Lifecycle:
    def __init__(self, web, req, runtime, config, observe):
        self.web, self.req, self.runtime, self.config = web, req, runtime, config
        self.cancel = threading.Event()
        self.claimed = self.saved = False
        self.text, self.thinking, self.errors = [], [], []
        self.queue = asyncio.Queue()
        self.observing = observe
        self.sequence = 0
        self.started_at = int(time.time() * 1000)
        self.started_clock = time.monotonic()
        self.settings = web.read_settings(web.ENV_FILE)

    def before_dispatch(self):
        if self.cancel.is_set():
            raise asyncio.CancelledError
        if (self.web._harness_settings() != self.config
                or self.web.read_settings(self.web.ENV_FILE) != self.settings):
            raise self.web.HarnessError('运行器配置已变化，本轮未派发，请重新确认。')
        self.web._ACTIVE_SKILL_TURNS[self.req.sessionId] = self.req.turnId
        self.claimed = True
        self.web.run_ledger.mark(self.web._run_ledger_root(), self.req.turnId,
            event='transport_started', status='running', transport='harness_' + self.runtime)

    def save(self, key, status, text, extra):
        self.saved = False
        self.saved = self.web._save_turn(key, status, text, {
            **extra, 'runtime': self.runtime, 'thinking': ''.join(self.thinking),
            'thinkingStatus': ('available' if extra.get('clean_end') else 'partial') if self.thinking else 'unavailable',
            'startedAt': self.started_at, 'elapsedMs': int((time.monotonic() - self.started_clock) * 1000),
            'error': self.errors[-1] if self.errors else None,
            'stopped': extra.get('stop_reason') in ('stopped', 'user_stopped'),
        }, expected_latest=None if status == 'running' and self.claimed else self.req.turnId) is not False
        if not self.saved:
            raise OSError('运行快照保存失败')

    def emit(self, kind, value):
        if kind == 'token':
            self.text.append(value)
        elif kind == 'thinking':
            self.thinking.append(value)
        elif kind == 'error':
            self.errors.append(value)
        self.sequence += 1
        data = json.loads(value) if kind == 'question' else value
        event = {'id': self.sequence, 'event': kind, 'data': data}
        with self.web._job_event_file(self.req.turnId).open('a', encoding='utf-8') as stream:
            stream.write(json.dumps(event, ensure_ascii=False) + '\n')
            stream.flush()
        if self.observing:
            self.queue.put_nowait(event)


async def start(web, req, runtime, config, *, observe=True, on_done=None, interactive=True):
    req = req.model_copy(update={'sessionId': req.sessionId or uuid.uuid4().hex,
                                 'turnId': req.turnId or uuid.uuid4().hex})
    try:
        selected_model = ('direct-api/' + web.api_config(web.read_settings(web.ENV_FILE))[1]
                          if runtime == 'api' else runtime + '/' + config['models'].get(runtime, ''))
    except web.DirectAPIError as exc:
        raise HTTPException(409, str(exc)) from None
    if (req.modelRef is not None and req.modelRef != selected_model) or req.thinkingLevel is not None:
        raise HTTPException(409, '当前底座使用设置中确认的模型；本轮模型与思考档位覆盖仅支持原生执行入口。')
    if runtime == 'api':
        content, system = web._direct_chat_content(req)
    else:
        content, system = web._chat_message(req), ''
    state = Lifecycle(web, req, runtime, config, observe)
    try:
        web.run_ledger.accept(web._run_ledger_root(), req.turnId, session_id=req.sessionId,
            session_key='agent:main:' + req.sessionId, engine=runtime,
            model_ref=selected_model, role_id=req.roleId)
    except web.run_ledger.RunExists:
        raise HTTPException(409, '该轮已有运行记录，请恢复原连接，避免重复提交。') from None
    except web.run_ledger.LedgerError:
        raise HTTPException(409, '运行记录无法核对，本轮未派发。') from None
    # Fence passive recovery before any await or dispatch. Unknown transports
    # must never fall through to OpenClaw agent.wait / chat.abort.
    web.run_ledger.mark(web._run_ledger_root(), req.turnId,
        event='supervisor_started', status='running', transport='harness_' + runtime)
    path = web._job_event_file(req.turnId)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch(exist_ok=False)
    web._CHAT_JOBS[req.turnId] = (req.sessionId, state.cancel)

    async def produce():
        settled = False
        try:
            state.emit('timing', {'startedAt': state.started_at})
            if runtime == 'api':
                await web._run_direct_chat(req, req.sessionId, content, system, state.emit, lifecycle=state)
            else:
                await web._run_harness_chat(req, req.sessionId, content, runtime, config,
                    state.emit, interactive=interactive, lifecycle=state)
        except asyncio.CancelledError:
            state.cancel.set()
        except Exception:
            # Never expose protocol/server exception strings or credentials.
            try:
                state.emit('error', '运行中断或记录保存失败，请核对原轮次。')
            except OSError:
                pass
        finally:
            stopped = state.cancel.is_set() or req.sessionId in web._STOPPED_CHAT
            try:
                marker = json.loads(web._run_snapshot_file(req.turnId).read_text(encoding='utf-8'))
            except (OSError, ValueError):
                marker = {}
            if not state.claimed or marker.get('status') != 'done':
                # Save only this independent archive; never replace a prior
                # session result when admission/ownership failed before dispatch.
                try:
                    state.save('web:' + req.sessionId, 'done', ''.join(state.text), {
                        'turn_id': req.turnId, 'clean_end': False,
                        'stop_reason': 'user_stopped' if stopped else 'admission_failed'})
                    marker = json.loads(web._run_snapshot_file(req.turnId).read_text(encoding='utf-8'))
                except (OSError, ValueError):
                    pass
            stopped = stopped or marker.get('stopped') is True
            try:
                from chat_recovery import settle_resources
                facts = await asyncio.to_thread(settle_resources, web, req.sessionId,
                    provider_settled=True) if state.claimed else {'provider': True, 'browser': True}
                complete = marker.get('status') == 'done' and marker.get('clean_end') is True and not state.errors
                web.run_ledger.mark(web._run_ledger_root(), req.turnId, event='terminal',
                    status='stopped' if stopped else 'completed' if complete else 'failed', settled=True,
                    stop_reason=marker.get('stop_reason', 'snapshot_unconfirmed'))
                settled = state.saved and all(facts.values())
                web.run_ledger.mark(web._run_ledger_root(), req.turnId,
                    event='resources_settled' if settled else 'resources_pending',
                    resource_settled=settled, resource_facts=facts)
                if settled:
                    if on_done:
                        await on_done()
                    state.emit('done', {'sessionKey': req.sessionId, **({'stopped': True} if stopped else {})})
                else:
                    state.emit('recovery_required', '运行记录或资源收尾待核实，请保留原轮次。')
            except Exception:
                web.log.warning('其他运行器收尾尚未确认：%s', req.turnId, exc_info=True)
            if web._ACTIVE_SKILL_TURNS.get(req.sessionId) == req.turnId:
                web._ACTIVE_SKILL_TURNS.pop(req.sessionId, None)
            web._CHAT_JOBS.pop(req.turnId, None)
            state.queue.put_nowait(None)

    task = asyncio.create_task(produce())
    web._BG_TASKS.add(task)
    task.add_done_callback(web._BG_TASKS.discard)
    if not observe:
        return {'turnId': req.turnId, 'sessionId': req.sessionId, 'task': task}

    async def forward():
        try:
            while True:
                try:
                    event = await asyncio.wait_for(state.queue.get(), 15)
                except asyncio.TimeoutError:
                    yield {'event': 'heartbeat', 'data': '{}'}
                    continue
                if event is None:
                    return
                yield {'id': str(event['id']), 'event': event['event'],
                       'data': json.dumps(event['data'], ensure_ascii=False)}
        finally:
            state.observing = False
            while not state.queue.empty():
                state.queue.get_nowait()
    return EventSourceResponse(forward(), headers={'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no', 'Content-Encoding': 'identity'})
