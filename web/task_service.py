"""One scheduling authority and bounded goal continuation on the chat runner."""
import asyncio
import hashlib
import json
import logging
from pathlib import Path
import time
import urllib.request
import uuid

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from typing import Literal

from easel.task_store import TaskStore, TaskConflict, SAFE_ID
from easel.task_rules import GoalSpec, Criterion, Schedule, next_time, latest_time, upcoming, check_goal
from easel.image_jobs import ImageJobs
from easel.task_graph import parallel
from easel.task_power import TaskPower

log = logging.getLogger(__name__)


class GoalRequest(BaseModel):
    model_config = {'extra': 'forbid'}
    goal: GoalSpec
    sessionId: str | None = Field(default=None, pattern=r'^[A-Za-z0-9_.-]{1,120}$')
    title: str | None = Field(default=None, min_length=1, max_length=100)


class PlanRequest(GoalRequest):
    title: str = Field(default='定时任务', min_length=1, max_length=100)
    schedule: Schedule
    missedPolicy: Literal['skip', 'coalesce'] = 'skip'
    freshnessSeconds: int = Field(default=900, ge=60, le=86400, strict=True)


class Action(BaseModel):
    model_config = {'extra': 'forbid'}
    action: Literal['start', 'resume', 'pause', 'stop', 'cancel', 'recheck', 'approve']


class GoalRevision(BaseModel):
    model_config = {'extra': 'forbid'}
    objective: str = Field(min_length=3, max_length=6000)
    criteria: list[Criterion] = Field(min_length=1, max_length=16)


class StageRework(BaseModel):
    model_config = {'extra': 'forbid', 'str_strip_whitespace': True}
    stageId: str = Field(min_length=1, max_length=80, pattern=r'^[A-Za-z0-9_.-]+$')
    revision: int = Field(ge=1, strict=True)
    requestId: str = Field(min_length=1, max_length=120, pattern=r'^[A-Za-z0-9_.-]+$')
    reason: str = Field(min_length=3, max_length=1200)


class PlanAction(BaseModel):
    model_config = {'extra': 'forbid'}
    action: Literal['enable', 'pause', 'run']
    requestId: str | None = Field(default=None, min_length=1, max_length=120, pattern=r'^[A-Za-z0-9_.-]+$')


class TaskRuntimeRequest(BaseModel):
    model_config = {'extra': 'forbid'}
    keepAwake: bool = Field(strict=True)


class TaskService:
    def __init__(self, web):
        self.web = web
        self.owner = uuid.uuid4().hex
        self.loop = None
        self.work = set()
        self.parallel_goal = None
        self.closing = False
        self.recovery_checks = {}
        self.power = TaskPower()

    @property
    def store(self):
        return TaskStore(self.web.OUTPUTS_DIR)

    def config_hash(self):
        path = self.web.openclaw_state_dir() / 'openclaw.json'
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def guard_status(self):
        """Invoke only a read-only native tool; this never starts an agent/model."""
        web = self.web
        request = urllib.request.Request(web.chat_completions_url().split('/v1/')[0] + '/tools/invoke',
            data=json.dumps({'tool': 'easel_task_guard', 'args': {}, 'sessionKey': 'agent:main:easel-guard-probe'}).encode(),
            headers={'Content-Type': 'application/json', **web.gateway_credentials().headers()}, method='POST')
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                payload = json.load(response)
            result = payload.get('result', {})
            details = result.get('details')
            if not details:
                details = json.loads(next(c['text'] for c in result.get('content', []) if c.get('type') == 'text'))
            expected = Path(web.OUTPUTS_DIR).resolve().parent
            ready = payload.get('ok') is True and details.get('version') == 2 and Path(details['dataRoot']).resolve() == expected
        except Exception:
            ready = False
        return {'ready': ready, 'reason': '' if ready else '网关尚未加载目标执行保护，或数据目录不一致。请在空闲时重启网关后重试。'}

    def validate_goal(self, spec, session):
        import office_controls
        self.store.require_session(session)
        if session and self.web._codex_service.owns(session):
            raise TaskConflict('首版目标使用 OpenClaw，请选择 OpenClaw 对话。')
        office_controls.validate_requested_model(self.web, spec['modelRef'])
        from easel.task_stages import prepare_stages
        criteria = spec['criteria'] + [c for s in prepare_stages(spec, 'validation') for c in s['criteria']]
        for c in criteria:
            if c['type'] == 'file':
                from easel.artifacts import file_path
                file_path(self.web.OUTPUTS_DIR, c['value'])

    def admit(self, spec, session):
        self.validate_goal(spec, session)
        guard = self.guard_status()
        if not guard['ready']:
            raise TaskConflict(guard['reason'])
        import office_controls
        capability = office_controls.require_model_override(self.web, session, spec['modelRef'], transport='cli', thinking_level='low')
        if not capability['available']:
            raise TaskConflict('指定模型当前不可用，未派发。')
        native = self.web._native_agent_client(self.web.gateway_credentials())
        if native is None:
            raise TaskConflict('目标需要支持运行身份回执的原生运行器，当前未派发。')
        native.close()

    def start(self):
        self.closing = False
        self.power.set_enabled(self.store.keep_awake_enabled())
        self.loop = asyncio.create_task(self.serve())

    async def close(self):
        self.closing = True
        if self.loop:
            self.loop.cancel()
            await asyncio.gather(self.loop, return_exceptions=True)
        # Do not claim that cancelling the local waiter aborts the provider.
        for task in self.work:
            task.cancel()
        if self.work:
            await asyncio.gather(*self.work, return_exceptions=True)

    async def serve(self):
        while not self.closing:
            try:
                await self.tick()
            except Exception:
                log.exception('目标调度暂时失败；已持久化的任务不会重发')
            await asyncio.sleep(2)

    async def tick(self):
        store = self.store
        await self.cleanup_deleted_sessions()
        now = time.time()
        for p in await asyncio.to_thread(store.due_plans, now):
            due = p.get('nextAt')
            if p['enabled'] and due is not None and due <= now:
                # Normal wakeup has a 30s dispatch tolerance. Offline coalescing
                # allows exactly one fresh occurrence, never a backlog burst.
                effective = max(due, latest_time(p['schedule'], now) or due) if p['missedPolicy'] == 'coalesce' else due
                missed = now - effective > (p['freshnessSeconds'] if p['missedPolicy'] == 'coalesce' else 30)
                await asyncio.to_thread(store.trigger_plan, p['id'], scheduled_at=due,
                    next_at=next_time(p['schedule'], now), missed=missed, effective_at=effective)
        # Unknown runs can only settle from positive existing ledger evidence.
        checked_external = False
        for r in await asyncio.to_thread(store.running):
            if r['state'] == 'unconfirmed':
                if await self.settle(r):
                    continue
                if (not checked_external and getattr(self.web, '_CrossProcLock', None)
                        and now >= self.recovery_checks.get(r['turnId'], 0)):
                    from chat_recovery import reconcile_orphan
                    self.recovery_checks[r['turnId']] = now + 15
                    checked_external = True
                    goal = await asyncio.to_thread(store.get, 'goals', r['goalId'])
                    if goal.get('cancelRequested'):
                        try:
                            await self.web.api_chat_stop(self.web.StopRequest(sessionId=r['sessionId'], turnId=r['turnId']))
                        except Exception:
                            log.warning('目标停止仍待确认，稍后按原轮次重试：%s', r['goalId'])
                    else:
                        await asyncio.to_thread(reconcile_orphan, self.web, r['sessionId'], r['turnId'])
                    await self.settle(r)
        if self.work and self.parallel_goal is None:
            return
        preferred = self.parallel_goal if self.work else None
        while len(self.work) < 2:
            pair = await asyncio.to_thread(store.claim, self.owner, preferred) if preferred else await asyncio.to_thread(store.claim, self.owner)
            if not pair:
                break
            g, r = pair
            self.parallel_goal = g['id'] if parallel(g) else None
            task = asyncio.create_task(self.execute(*pair))
            self.work.add(task)
            task.add_done_callback(self._finished)
            if not parallel(g):
                break
            preferred = g['id']

    def _finished(self, task):
        self.work.discard(task)
        if not self.work:
            self.parallel_goal = None

    async def execute(self, g, r):
        store, web = self.store, self.web
        power_lease = None
        try:
            await asyncio.to_thread(self.admit, g, r['sessionId'])
            if g.get('configHash') and g['configHash'] != self.config_hash():
                raise TaskConflict('模型配置已变化，请停止并重新建立目标确认新配置。')
            current = await asyncio.to_thread(store.get, 'goals', g['id'])
            if current['status'] != 'active' or current['stopEpoch'] != r['stopEpoch']:
                await asyncio.to_thread(store.finish, r['id'], owner=self.owner, state='stopped', reason='派发前已停止。')
                return
            from easel.task_stages import stage_prompt, validate_handoffs
            try:
                await asyncio.to_thread(validate_handoffs, web.OUTPUTS_DIR, g)
            except ValueError as exc:
                raise TaskConflict(str(exc)) from None
            prompt = ('[Easel 持久目标 / 第' + str(r['iteration']) + '轮]\n' + g['objective'] +
                '\n验收标准：' + json.dumps(g['criteria'], ensure_ascii=False) +
                '\n前次检查：' + json.dumps(g.get('checks', []), ensure_ascii=False) +
                '\n当前步骤：' + json.dumps(g.get('steps', []), ensure_ascii=False) +
                f"\n本目标最多{g['maxIterations']}轮、{g['maxSeconds']}秒、{g['maxTools']}次工具、{g['maxImages']}张图片。" +
                '\n先用 easel_goal_update 将目标拆为可执行步骤；推进时更新步骤状态，保留已完成步骤。'
                '只报告实际做过的工作；卡在权限、材料或用户决策时将相关步骤设为blocked并说明缺失信息。'
                '只处理尚未通过项，保存并交付真实文件；步骤completed只表示自报工作完成，不能替代质量验收。'
                '不要自称质量已通过，不派生Agent、不创建计划。')
            receipts = await asyncio.to_thread(store.rework_receipts, g['id']) if r.get('reworkId') else []
            rework = next((item for item in receipts if item['id'] == r.get('reworkId')), None)
            prompt += stage_prompt(g, r, rework)
            req = web.ChatRequest(message=prompt, sessionId=r['sessionId'], turnId=r['turnId'],
                                  modelRef=g['modelRef'], thinkingLevel='low', roleId=r.get('roleId'))
            power_lease = self.power.acquire()
            await web.start_chat_run(req, observe=False)
            allowance = r.get('maxRunSeconds', g['maxSeconds'] - g['activeSeconds'])
            deadline = time.monotonic() + max(0, allowance - (time.time() - r['startedAt']))
            stopping = False
            while not self.closing:
                try:
                    self.power.set_enabled(await asyncio.to_thread(store.keep_awake_enabled))
                except Exception:
                    log.warning('保持主机唤醒设置暂不可读；保留当前防休眠状态。')
                if not await asyncio.to_thread(store.heartbeat, r['id'], self.owner):
                    return
                current = await asyncio.to_thread(store.get, 'goals', g['id'])
                expired = time.monotonic() >= deadline
                if not stopping and (current['status'] != 'active' or expired):
                    stopping = True
                    if expired:
                        await asyncio.to_thread(store.conclude_budget, g['id'], '已达到目标时长上限，正在停止后台运行。')
                    await web.api_chat_stop(web.StopRequest(sessionId=r['sessionId'], turnId=r['turnId']))
                if await self.settle(r):
                    return
                if stopping and expired:
                    await asyncio.to_thread(store.finish, r['id'], owner=self.owner, state='stopped', resource_settled=False,
                        reason='已请求停止；外部运行或生图尚未确认结算，保留执行占位。')
                    return
                await asyncio.sleep(1)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Starting may have partially reached the provider: retain its slot
            # whenever a ledger exists, and never turn an uncertain failure into retry.
            ledger = await asyncio.to_thread(web.run_ledger.read, web._run_ledger_root(), r['turnId'])
            safe = ledger is None
            reason = str(exc.detail) if isinstance(exc, HTTPException) and isinstance(exc.detail, str) else str(exc) if isinstance(exc, TaskConflict) else '运行启动或验收失败，请检查服务状态；未自动重发。'
            await asyncio.to_thread(store.finish, r['id'], owner=self.owner, state='failed', reason=reason, resource_settled=safe)
        finally:
            if power_lease:
                power_lease.release()

    async def settle(self, r):
        web, store = self.web, self.store
        ledger = await asyncio.to_thread(web.run_ledger.read, web._run_ledger_root(), r['turnId'])
        if not ledger or not ledger.get('settled') or not ledger.get('resourceSettled'):
            return False
        if await asyncio.to_thread(ImageJobs(web.OUTPUTS_DIR).pending, r['sessionId'], r['turnId']):
            return False
        text = ''
        try:
            archive = web._run_snapshot_file(r['turnId']) if hasattr(web, '_run_snapshot_file') else None
            path = archive if archive and archive.is_file() else web._turn_file('web:' + r['sessionId'])
            marker = json.loads(path.read_text(encoding='utf-8'))
            if marker.get('turn_id') == r['turnId'] and marker.get('session_id', r['sessionId']) == r['sessionId']:
                text = marker.get('text', '')
        except (OSError, ValueError):
            pass
        g = await asyncio.to_thread(store.get, 'goals', r['goalId'])
        checks, fingerprint = await asyncio.to_thread(check_goal, web.OUTPUTS_DIR, g, text)
        from easel.task_stages import stage_for_run, check_stage
        stage = stage_for_run(g, r)
        stage_checks = (await asyncio.to_thread(check_stage, web.OUTPUTS_DIR, stage, text))[0] if stage else None
        state = 'completed' if ledger['status'] == 'completed' else 'stopped' if ledger['status'] == 'stopped' else 'failed'
        await asyncio.to_thread(store.finish, r['id'], owner=r['owner'], text=text, state=state,
            checks=checks, fingerprint=fingerprint, stage_checks=stage_checks,
            reason=(ledger.get('error') or {}).get('message', ''))
        return True

    def router(self):
        router = APIRouter(prefix='/api/tasks')

        def conflict(exc):
            raise HTTPException(409, str(exc)) from None

        @router.get('')
        def snapshot(session: str | None = None):
            return JSONResponse(self.store.snapshot(session), headers={'Cache-Control':'no-store'})

        @router.get('/sessions')
        def sessions():
            return JSONResponse(self.store.session_state(), headers={'Cache-Control':'no-store'})

        @router.post('/sessions/{session}/delete')
        async def delete_session(session: str):
            try:
                marker = await asyncio.to_thread(self.store.delete_session, session)
            except TaskConflict as exc:
                conflict(exc)
            await self.cleanup_deleted_sessions()
            for actual, turn in await asyncio.to_thread(self.session_work_items, session):
                try:
                    await asyncio.wait_for(self.web.api_chat_stop(self.web.StopRequest(sessionId=actual, turnId=turn)), timeout=5)
                except Exception:
                    log.warning('对话删除已保存，后台停止仍待确认：%s', actual)
            return {'deleted': True, 'tombstone': marker,
                    'stopPending': bool(await asyncio.to_thread(self.session_work, session))}

        @router.get('/capability')
        def capability():
            return self.guard_status()

        @router.get('/runtime')
        async def runtime():
            enabled = await asyncio.to_thread(self.store.keep_awake_enabled)
            return self.power.set_enabled(enabled)

        @router.post('/runtime')
        async def update_runtime(req: TaskRuntimeRequest):
            if req.keepAwake and not self.power.supported:
                raise HTTPException(409, '此后端主机不支持保持唤醒。')
            await asyncio.to_thread(self.store.set_keep_awake_enabled, req.keepAwake)
            return self.power.set_enabled(req.keepAwake)

        @router.get('/workflows')
        def workflows():
            from easel.task_stages import WORKFLOWS
            return {'workflows': WORKFLOWS, 'execution': 'workflow-dependent', 'maxParallel': 2, 'externalPublishing': False}

        @router.post('/preview')
        def preview(req: Schedule):
            return {'times': upcoming(req, time.time())}

        @router.post('/goals')
        def create(req: GoalRequest):
            try:
                spec = req.goal.model_dump()
                self.validate_goal(spec, req.sessionId)
                spec['configHash'] = self.config_hash()
                return self.store.create_goal(spec, session=req.sessionId, title=req.title)
            except (TaskConflict, ValueError) as exc:
                conflict(exc)

        @router.post('/goals/{key}/action')
        async def action(key: str, req: Action):
            try:
                g = await asyncio.to_thread(self.store.get, 'goals', key)
                if req.action not in ('pause','stop','cancel'):
                    await asyncio.to_thread(self.store.require_session, g['sessionId'])
                if req.action in ('recheck', 'approve'):
                    from easel.task_stages import validate_handoffs
                    try:
                        validate_handoffs(self.web.OUTPUTS_DIR, g)
                    except ValueError as exc:
                        self.store.invalidate_handoff(key, str(exc))
                        raise TaskConflict(str(exc)) from None
                    runs = self.store.snapshot(g['sessionId'])['runs']
                    r = next((r for r in runs if r['turnId'] == g.get('currentTurnId')), None)
                    if not r:
                        raise TaskConflict('目标尚未产生可验收轮次。')
                    before, _ = check_goal(self.web.OUTPUTS_DIR, g, r.get('text', ''))
                    # Changed files invalidate previous approval before accepting
                    # a new human quality confirmation.
                    changed = [c.get('evidence') for c in before if c['type'] == 'file'] != [c.get('evidence') for c in g.get('checks', []) if c['type'] == 'file']
                    if req.action == 'approve' and changed:
                        self.store.apply_checks(key, before)
                        raise TaskConflict('文件版本已变化，请重新查看后再确认。')
                    reviewed = req.action == 'approve' or (g.get('reviewedTurnId') == r['turnId'] and not changed)
                    checks, _ = check_goal(self.web.OUTPUTS_DIR, g, r.get('text', ''), reviewed)
                    return self.store.apply_checks(key, checks, review=r['turnId'] if reviewed else None)
                if req.action in ('start', 'resume'):
                    await asyncio.to_thread(self.admit, g, g['sessionId'])
                result = await asyncio.to_thread(self.store.change_goal, key, req.action)
                if req.action in ('pause', 'stop', 'cancel'):
                    for r in await asyncio.to_thread(self.store.running):
                        if r['goalId'] == key:
                            try:
                                await self.web.api_chat_stop(self.web.StopRequest(sessionId=r['sessionId'], turnId=r['turnId']))
                            except Exception:
                                log.warning('目标状态已保存，后台停止待重试：%s', key)
                return result
            except (TaskConflict, ValueError) as exc:
                conflict(exc)

        @router.put('/goals/{key}')
        def revise(key: str, req: GoalRevision):
            try:
                g = self.store.get('goals', key)
                spec = {**g, 'objective':req.objective, 'criteria':[c.model_dump() for c in req.criteria]}
                self.validate_goal(spec, g['sessionId'])
                return self.store.revise_goal(key, req.objective, spec['criteria'])
            except (TaskConflict, ValueError) as exc:
                conflict(exc)

        @router.post('/goals/{key}/rework')
        def rework(key: str, req: StageRework):
            try:
                return self.store.rework_stage(key, stage_id=req.stageId, revision=req.revision,
                                               request_id=req.requestId, reason=req.reason)
            except (TaskConflict, ValueError) as exc:
                conflict(exc)

        @router.get('/goals/{key}/reworks')
        def reworks(key: str):
            try:
                return JSONResponse({'receipts': self.store.rework_receipts(key)}, headers={'Cache-Control': 'no-store'})
            except (TaskConflict, ValueError) as exc:
                conflict(exc)

        @router.post('/plans')
        @router.put('/plans/{key}')
        def save(req: PlanRequest, key: str | None = None):
            try:
                data = req.model_dump()
                self.validate_goal(data['goal'], req.sessionId)
                data['goal']['configHash'] = self.config_hash()
                data.update(enabled=False)
                times = upcoming(data['schedule'], time.time())
                if not times:
                    raise TaskConflict('请设置未来的执行时间。')
                return self.store.save_plan(data, times[0], key)
            except (TaskConflict, ValueError) as exc:
                conflict(exc)

        @router.post('/plans/{key}/action')
        async def plan_action(key: str, req: PlanAction):
            try:
                p = await asyncio.to_thread(self.store.get, 'plans', key)
                if req.action in ('enable', 'run'):
                    await asyncio.to_thread(self.admit, p['goal'], p.get('sessionId'))
                if req.action == 'run':
                    if not req.requestId:
                        raise TaskConflict('手动运行需要唯一请求标识。')
                    g = await asyncio.to_thread(self.store.trigger_plan, key, request=req.requestId)
                    return {'goal': g, 'plan': self.store.get('plans', key)}
                due = next_time(p['schedule'], time.time())
                if req.action == 'enable' and due is None:
                    raise TaskConflict('该单次计划已过期，请编辑为未来时间。')
                return self.store.set_plan_enabled(key, req.action == 'enable', due)
            except (TaskConflict, ValueError) as exc:
                conflict(exc)

        return router

    def session_work(self, session):
        return sorted({turn for _, turn in self.session_work_items(session)})

    def session_work_items(self, session):
        items = set()
        codex = getattr(self.web, '_codex_service', None)
        for related in self.store.related_sessions(session):
            turns = set(self.store.session_work(related, include_children=False))
            turns.update(ImageJobs(self.web.OUTPUTS_DIR).pending_turns(related))
            if codex and codex.owns(related):
                turns.update(codex.session_work(related))
            items.update((related, turn) for turn in turns)
        return sorted(items)

    async def cleanup_deleted_sessions(self):
        """Retry the durable notification cleanup outbox after interruptions."""
        from easel.notifications import NotificationStore
        store = self.store
        for session in await asyncio.to_thread(store.pending_session_cleanup):
            try:
                await asyncio.to_thread(NotificationStore(self.web.OUTPUTS_DIR).remove_session, session)
                await asyncio.to_thread(store.complete_session_cleanup, session)
            except Exception:
                log.warning('删除后的通知清理稍后重试：%s', session, exc_info=True)
