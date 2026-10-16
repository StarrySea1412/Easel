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


class PlanAction(BaseModel):
    model_config = {'extra': 'forbid'}
    action: Literal['enable', 'pause', 'run']
    requestId: str | None = Field(default=None, min_length=1, max_length=120, pattern=r'^[A-Za-z0-9_.-]+$')


class TaskService:
    def __init__(self, web):
        self.web = web
        self.owner = uuid.uuid4().hex
        self.loop = None
        self.work = set()
        self.closing = False

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
        if session and self.web._codex_service.owns(session):
            raise TaskConflict('首版目标使用 OpenClaw，请选择 OpenClaw 对话。')
        office_controls.validate_requested_model(self.web, spec['modelRef'])
        for c in spec['criteria']:
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
        for r in await asyncio.to_thread(store.running):
            if r['state'] == 'unconfirmed':
                await self.settle(r)
        if self.work:
            return
        pair = await asyncio.to_thread(store.claim, self.owner)
        if pair:
            task = asyncio.create_task(self.execute(*pair))
            self.work.add(task)
            task.add_done_callback(self.work.discard)

    async def execute(self, g, r):
        store, web = self.store, self.web
        try:
            await asyncio.to_thread(self.admit, g, g['sessionId'])
            if g.get('configHash') and g['configHash'] != self.config_hash():
                raise TaskConflict('模型配置已变化，请停止并重新建立目标确认新配置。')
            current = await asyncio.to_thread(store.get, 'goals', g['id'])
            if current['status'] != 'active' or current['stopEpoch'] != r['stopEpoch']:
                await asyncio.to_thread(store.finish, r['id'], owner=self.owner, state='stopped', reason='派发前已停止。')
                return
            prompt = ('[Easel 持久目标 / 第' + str(r['iteration']) + '轮]\n' + g['objective'] +
                '\n验收标准：' + json.dumps(g['criteria'], ensure_ascii=False) +
                '\n前次检查：' + json.dumps(g.get('checks', []), ensure_ascii=False) +
                '\n当前步骤：' + json.dumps(g.get('steps', []), ensure_ascii=False) +
                f"\n本目标最多{g['maxIterations']}轮、{g['maxSeconds']}秒、{g['maxTools']}次工具、{g['maxImages']}张图片。" +
                '\n先用 easel_goal_update 将目标拆为可执行步骤；推进时更新步骤状态，保留已完成步骤。'
                '只报告实际做过的工作；卡在权限、材料或用户决策时将相关步骤设为blocked并说明缺失信息。'
                '只处理尚未通过项，保存并交付真实文件；步骤completed只表示自报工作完成，不能替代质量验收。'
                '不要自称质量已通过，不派生Agent、不创建计划。')
            req = web.ChatRequest(message=prompt, sessionId=g['sessionId'], turnId=r['turnId'], modelRef=g['modelRef'], thinkingLevel='low')
            await web.start_chat_run(req, observe=False)
            deadline = time.monotonic() + max(0, g['maxSeconds'] - g['activeSeconds'])
            stopping = False
            while not self.closing:
                if not await asyncio.to_thread(store.heartbeat, r['id'], self.owner):
                    return
                current = await asyncio.to_thread(store.get, 'goals', g['id'])
                expired = time.monotonic() >= deadline
                if not stopping and (current['status'] != 'active' or expired):
                    stopping = True
                    if expired:
                        await asyncio.to_thread(store.block, g['id'], '已达到目标时长上限，正在停止后台运行。', 'budget')
                    await web.api_chat_stop(web.StopRequest(sessionId=g['sessionId'], turnId=r['turnId']))
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
            ledger = web.run_ledger.read(web._run_ledger_root(), r['turnId'])
            safe = ledger is None
            reason = str(exc.detail) if isinstance(exc, HTTPException) and isinstance(exc.detail, str) else str(exc) if isinstance(exc, TaskConflict) else '运行启动或验收失败，请检查服务状态；未自动重发。'
            await asyncio.to_thread(store.finish, r['id'], owner=self.owner, state='failed', reason=reason, resource_settled=safe)

    async def settle(self, r):
        web, store = self.web, self.store
        ledger = web.run_ledger.read(web._run_ledger_root(), r['turnId'])
        if not ledger or not ledger.get('settled') or not ledger.get('resourceSettled'):
            return False
        jobs = ImageJobs(web.OUTPUTS_DIR).list(r['sessionId'])
        unsettled = [j for j in jobs if j.get('turnId') == r['turnId'] and j.get('phase') in ('queued', 'running', 'unconfirmed')]
        if unsettled:
            return False
        text = ''
        try:
            marker = json.loads(web._turn_file('web:' + r['sessionId']).read_text(encoding='utf-8'))
            if marker.get('turn_id') == r['turnId']:
                text = marker.get('text', '')
        except (OSError, ValueError):
            pass
        g = await asyncio.to_thread(store.get, 'goals', r['goalId'])
        checks, fingerprint = await asyncio.to_thread(check_goal, web.OUTPUTS_DIR, g, text)
        state = 'completed' if ledger['status'] == 'completed' else 'stopped' if ledger['status'] == 'stopped' else 'failed'
        await asyncio.to_thread(store.finish, r['id'], owner=r['owner'], text=text, state=state,
            checks=checks, fingerprint=fingerprint, reason=(ledger.get('error') or {}).get('message', ''))
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
            return {'sessions': self.store.session_snapshots()}

        @router.get('/capability')
        def capability():
            return self.guard_status()

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
                if req.action in ('recheck', 'approve'):
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
                            await self.web.api_chat_stop(self.web.StopRequest(sessionId=r['sessionId'], turnId=r['turnId']))
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
