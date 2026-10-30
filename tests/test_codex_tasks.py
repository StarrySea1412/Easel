"""Exercise real Codex/task services with isolated App Server protocol fixtures."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from easel.codex_service import CodexService
from easel.codex_tasks import CodexTasks
from easel.task_rules import GoalSpec
from easel.task_store import TaskStore, TaskConflict

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from task_service import TaskService


def spec(**patch):
    return GoalSpec(**{'engine': 'codex', 'toolBudgetMode': 'observed', 'modelRef': 'codex/fixture',
        'objective': '隔离合成：完成文件并留待人工验收',
        'criteria': [{'type': 'file', 'label': '交付文件', 'value': 'delivery/result.txt'},
                     {'type': 'review', 'label': '人工质量', 'value': ''}],
        'maxTools': 80, 'maxIterations': 8, 'maxSeconds': 120, **patch}).model_dump()


def active(tmp_path, **patch):
    store = TaskStore(tmp_path)
    goal = store.create_goal(spec(**patch), session='parent')
    store.change_goal(goal['id'], 'start')
    goal, run = store.claim('fixture-owner')
    store.bind_provider(run['sessionId'], run['turnId'], 'native-turn')
    workspace = tmp_path / 'codex' / 'fixture'
    workspace.mkdir(parents=True)
    state = {'sessionId': run['sessionId'], 'turn_id': run['turnId'],
             'codexTurnId': 'native-turn', 'workspace': str(workspace)}
    return store, goal, run, state


def test_explicit_native_budget_mode_and_legacy_defaults():
    legacy = {k: v for k, v in spec().items() if k not in ('engine', 'toolBudgetMode')}
    legacy['modelRef'] = 'fixture/model'
    assert GoalSpec(**legacy).engine == 'openclaw'
    assert GoalSpec(**legacy).toolBudgetMode == 'admission'
    for values in ({'engine': 'codex', 'toolBudgetMode': 'admission'},
                   {'engine': 'openclaw', 'toolBudgetMode': 'observed'},
                   {'engine': 'codex', 'modelRef': 'other/model'}):
        with pytest.raises(ValidationError):
            spec(**values)


def test_observations_count_parallel_excess_once_and_preserve_cancellation(tmp_path):
    store, goal, run, state = active(tmp_path, maxTools=2)
    def observed(call):
        return TaskStore(tmp_path).observe_codex_tool('parent', run['turnId'], 'native-turn', call, 'commandExecution')
    with ThreadPoolExecutor(4) as pool:
        list(pool.map(observed, ['one', 'two', 'one', 'three']))
    saved = store.get('goals', goal['id'])
    assert saved['toolsUsed'] == 3 and saved['phase'] == 'budget'
    assert store.get('runs', run['id'])['workTools'] == 3
    assert '可能超额' in saved['reason']
    store.change_goal(goal['id'], 'cancel')
    observed('late')
    assert store.get('goals', goal['id'])['status'] == 'cancelled'
    assert store.get('goals', goal['id'])['toolsUsed'] == 4
    with pytest.raises(TaskConflict):
        store.observe_codex_tool('parent', run['turnId'], 'wrong-native-turn', 'forged', 'commandExecution')


def test_delivery_is_scoped_and_stopped_runs_cannot_write_shared_evidence(tmp_path):
    store, goal, run, state = active(tmp_path)
    bridge = CodexTasks(tmp_path)
    assert bridge.prepare(state)
    workspace = Path(state['workspace'])
    (workspace / 'delivery').mkdir()
    (workspace / 'delivery/result.txt').write_text('真实本地文件', encoding='utf-8')
    bridge.guard(state, 'delivery-call', 'easel_task_deliver')
    values = bridge.deliver(state, [{'path': 'delivery/result.txt'}])
    assert values[0]['path'] == 'delivery/result.txt'
    assert (tmp_path / 'delivery/result.txt').read_text(encoding='utf-8') == '真实本地文件'
    for path in ('../../outside.txt', '_automation/tasks.sqlite3', 'undeclared.txt'):
        with pytest.raises(ValueError):
            bridge.deliver(state, [{'path': path}])
    store.change_goal(goal['id'], 'stop')
    (workspace / 'delivery/result.txt').write_text('晚到内容', encoding='utf-8')
    with pytest.raises(TaskConflict):
        bridge.deliver(state, [{'path': 'delivery/result.txt'}])
    assert (tmp_path / 'delivery/result.txt').read_text(encoding='utf-8') == '真实本地文件'


def test_native_progress_uses_exact_run_and_cannot_approve_quality(tmp_path):
    store, goal, run, state = active(tmp_path)
    bridge = CodexTasks(tmp_path); bridge.prepare(state)
    plan = [{'step': '核对材料', 'status': 'completed'}, {'step': '制作文件', 'status': 'in_progress'}]
    bridge.progress(state, plan); bridge.progress(state, plan)
    current = store.get('goals', goal['id'])
    assert current['steps'][1]['status'] == 'in_progress' and current['toolsUsed'] == 1
    assert not current.get('reviewedTurnId')
    store.change_goal(goal['id'], 'stop')
    with pytest.raises(TaskConflict):
        bridge.progress(state, [{'step': '假的完成', 'status': 'completed'}])


class NativeFixture:
    version = '0.147.0'

    def __init__(self, workspace, harness):
        self.workspace, self.h = workspace, harness
        self.proc = SimpleNamespace(poll=lambda: None)
        self._closed = threading.Event()
        self.events = queue.Queue()

    def rpc(self, method, params, **kwargs):
        self.h.calls.append((method, deepcopy(params)))
        if method == 'account/read':
            return {'requiresOpenaiAuth': False}
        if method == 'model/list':
            return {'data': [{'model': 'fixture', 'displayName': '隔离协议替身', 'hidden': False,
                'supportedReasoningEfforts': [{'reasoningEffort': 'low'}],
                'defaultReasoningEffort': 'low', 'isDefault': True}]}
        if method == 'config/read':
            return {'config': {'model_provider': 'fixture', 'revision': self.h.config}}
        if method == 'hooks/list':
            return {'data': [{'cwd': str(self.workspace), 'errors': [], 'hooks': self.h.hooks}]}
        if method in ('thread/start', 'thread/resume'):
            if self.h.before_thread:
                self.h.before_thread()
            return {'thread': {'id': params.get('threadId', 'native-' + self.workspace.name)}, 'model': 'fixture'}
        if method == 'turn/start':
            self.h.dispatched += 1
            native_turn = 'native-turn-' + str(self.h.dispatched)
            state = next(v['state'] for v in self.h.codex.active.values() if v['state']['workspace'] == str(self.workspace))
            self.h.emit(self, state, native_turn)
            return {'turn': {'id': native_turn}}
        if method == 'turn/interrupt':
            self.events.put({'method': 'turn/completed', 'params': {'threadId': params['threadId'],
                'turn': {'id': params['turnId'], 'status': 'interrupted'}}})
            return {}
        raise AssertionError('Unexpected native RPC: ' + method)

    def subscribe(self, thread):
        return self.events

    def unsubscribe(self, thread):
        pass

    def reply(self, ident, result):
        self.h.replies.append(result)

    def close(self):
        self._closed.set()


class Harness:
    def __init__(self, outputs):
        self.outputs, self.calls, self.replies = outputs, [], []
        self.config, self.dispatched = 1, 0
        self.hooks = []
        self.before_thread = None
        self.content = None
        self.codex = CodexService(outputs, lambda workspace: NativeFixture(workspace, self))
        async def start(req, **kwargs):
            self.codex.bind(req.sessionId, req.engine)
            return await asyncio.to_thread(self.codex.start, req)
        async def stop(req):
            return await asyncio.to_thread(self.codex.stop, req.sessionId, req.turnId)
        def request(**kwargs):
            return SimpleNamespace(attachments=[], selectedSkills=[], skillRequirements={}, **kwargs)
        self.web = SimpleNamespace(OUTPUTS_DIR=outputs, _codex_service=self.codex,
            start_chat_run=start, api_chat_stop=stop, StopRequest=SimpleNamespace, ChatRequest=request)
        self.tasks = TaskService(self.web)
        self.emit = self.success

    def success(self, client, state, native_turn):
        store = TaskStore(self.outputs)
        goal, run = store.run_context(state['sessionId'], state['turn_id'])
        stage = next((s for s in goal['stages'] if s['id'] == run.get('stageId')), None)
        paths = [c['value'] for c in (stage or goal)['criteria'] if c['type'] == 'file']
        for path in paths:
            target = client.workspace / path; target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(self.content(goal, run, stage) if self.content else '合成新版本 · ' + native_turn, encoding='utf-8')
        events = [
            {'method': 'turn/plan/updated', 'params': {'plan': [{'step': '完成本轮文件', 'status': 'in_progress'}]}},
            {'method': 'item/completed', 'params': {'item': {'id': 'cmd', 'type': 'commandExecution',
                'status': 'completed', 'aggregatedOutput': 'EASEL_TASK_DELIVER ' + json.dumps({'files': [{'path': p} for p in paths]})}}},
            {'method': 'turn/plan/updated', 'params': {'plan': [{'step': '完成本轮文件', 'status': 'completed'}]}},
            {'method': 'item/completed', 'params': {'item': {'id': 'reply', 'type': 'agentMessage', 'text': '合成运行已完成'}}},
            {'method': 'turn/completed', 'params': {'turn': {'id': native_turn, 'status': 'completed'}}},
        ]
        for event in events:
            event['params'].update(threadId='native-' + client.workspace.name, turnId=native_turn)
            client.events.put(event)

    async def run(self, goal_id):
        pair = self.tasks.store.claim(self.tasks.owner, goal_id)
        assert pair
        await asyncio.wait_for(self.tasks.execute(*pair), 12)
        return self.tasks.store.get('goals', goal_id)


def test_real_services_dispatch_native_protocol_and_wait_for_human_review(tmp_path):
    h = Harness(tmp_path)
    goal = h.tasks.store.create_goal({**spec(), 'configHash': h.tasks.spec_hash(spec())}, session='parent')
    h.tasks.store.change_goal(goal['id'], 'start')
    current = asyncio.run(h.run(goal['id']))
    assert current['phase'] == 'review' and current['status'] == 'blocked', current
    assert current['toolsUsed'] == 3 and current['steps'][0]['status'] == 'completed'
    message = next(m for m in h.tasks.store.session_snapshots()[0]['messages'] if m.get('taskRunId'))
    assert message['thinkingStatus'] == 'unavailable' and message['elapsedMs'] >= 0
    state = h.codex.snapshot('parent', current['currentTurnId'])
    assert state['resourceSettled'] is True and state['outcome'] == 'completed'
    params = next(p for m, p in h.calls if m == 'thread/start')
    assert params['config']['features.goals'] is False
    assert params['config']['features.multi_agent'] is False
    assert any(t['name'] == 'easel_task_deliver' for t in params['dynamicTools'])
    assert h.dispatched == 1 and not any(m.startswith('thread/goal/') for m, _ in h.calls)
    assert h.tasks.store.session_snapshots()[0]['engine'] == 'codex'
    h.codex.close()


def test_native_continuation_hooks_are_rejected_without_disabling_protections(tmp_path):
    h = Harness(tmp_path)
    h.hooks = [{'eventName': 'stop', 'enabled': True, 'trustStatus': 'trusted'}]
    goal = h.tasks.store.create_goal(spec(), session='parent')
    h.tasks.store.change_goal(goal['id'], 'start')
    result = asyncio.run(h.run(goal['id']))
    assert result['status'] == 'blocked' and h.dispatched == 0
    assert h.hooks[0]['enabled'] is True
    assert not h.codex.session_work('parent')
    h.codex.close()


def test_native_sequential_stages_copy_actual_upstream_and_reuse_thread(tmp_path):
    h = Harness(tmp_path)
    # Custom stages exercise the full handoff runner without pretending a model wrote a review JSON.
    stages = [{'id': key, 'title': key, 'roleId': 'builder', 'objective': '生成本阶段的新文件',
        'criteria': [{'type': 'file', 'label': key, 'value': f'work/{key}.txt'}]} for key in ('first', 'second')]
    goal = h.tasks.store.create_goal(spec(stages=stages, criteria=[{'type': 'review', 'label': '质量', 'value': ''}]), session='parent')
    h.tasks.store.change_goal(goal['id'], 'start')
    first = asyncio.run(h.run(goal['id']))
    assert first['stages'][0]['status'] == 'completed', first
    second = asyncio.run(h.run(goal['id']))
    assert second['phase'] == 'review', second
    assert all(s['status'] == 'completed' for s in second['stages'])
    assert len([m for m, _ in h.calls if m == 'thread/start']) == 1
    assert len([m for m, _ in h.calls if m == 'thread/resume']) == 1
    assert h.dispatched == 2
    h.codex.close()


def test_config_drift_blocks_enable_and_manual_run_before_dispatch(tmp_path):
    h = Harness(tmp_path)
    app = FastAPI(); app.include_router(h.tasks.router())
    with TestClient(app) as client:
        response = client.post('/api/tasks/plans', json={'title': '隔离计划', 'goal': spec(),
            'schedule': {'kind': 'once', 'at': time.time() + 3600}})
        assert response.status_code == 200, response.text
        plan = response.json(); h.config = 2
        for action in ('enable', 'run'):
            response = client.post(f"/api/tasks/plans/{plan['id']}/action", json={'action': action, 'requestId': 'request'})
            assert response.status_code == 409 and '配置已变化' in response.text
        assert not h.tasks.store.get('plans', plan['id'])['enabled'] and h.dispatched == 0
        # Saving the explicit edit refreshes the digest; no runtime launch on save/enable.
        response = client.put(f"/api/tasks/plans/{plan['id']}", json={'title': '隔离计划', 'goal': spec(),
            'schedule': {'kind': 'once', 'at': time.time() + 3600}})
        assert response.status_code == 200
        assert client.post(f"/api/tasks/plans/{plan['id']}/action", json={'action': 'enable'}).status_code == 200
    h.codex.close()


def test_engine_mismatch_and_observation_opt_in_are_enforced_by_http(tmp_path):
    h = Harness(tmp_path); h.codex.bind('open-session', 'openclaw')
    app = FastAPI(); app.include_router(h.tasks.router())
    with TestClient(app) as client:
        assert client.post('/api/tasks/goals', json={'sessionId': 'open-session', 'goal': spec()}).status_code == 409
        values = spec(); values.pop('toolBudgetMode')
        assert client.post('/api/tasks/goals', json={'goal': values}).status_code == 422
        assert client.get('/api/tasks/capability?engine=codex').json()['toolBudgetMode'] == 'observed'
    assert h.dispatched == 0
    h.codex.close()


def test_pause_between_thread_admission_and_turn_start_never_submits(tmp_path):
    h = Harness(tmp_path)
    goal = h.tasks.store.create_goal(spec(), session='parent')
    h.tasks.store.change_goal(goal['id'], 'start')
    h.before_thread = lambda: h.tasks.store.change_goal(goal['id'], 'stop')
    result = asyncio.run(h.run(goal['id']))
    assert result['status'] == 'paused' and h.dispatched == 0
    assert not any(method == 'turn/start' for method, _ in h.calls)
    state = h.codex.snapshot('parent', result['currentTurnId'])
    assert state['outcome'] == 'rejected' and state['resourceSettled'] is True
    h.codex.close()


def test_native_planned_parallel_rework_and_delivery_share_one_scheduler(tmp_path):
    from tests.test_task_planning import plan
    from easel.task_stages import stage_for_run
    h = Harness(tmp_path)
    reviews, paths_seen = [], []
    barrier = threading.Barrier(2, timeout=20)
    def contents(goal, run, stage):
        if stage.get('planGate'):
            return json.dumps(plan(run), ensure_ascii=False)
        if stage.get('reviewGate'):
            reviews.append(run['turnId'])
            return json.dumps({'contract': run['reviewContract'], 'decision': 'revise' if len(reviews) == 1 else 'pass',
                'summary': '明确合成审查，仅验证状态机', 'targetStageId': 'facts' if len(reviews) == 1 else None,
                'findings': ['合成返工要求'] if len(reviews) == 1 else []}, ensure_ascii=False)
        return '合成文件 · ' + run['turnId']
    h.content = contents
    def emit(client, state, native_turn):
        goal, run = h.tasks.store.run_context(state['sessionId'], state['turn_id'])
        stage = stage_for_run(goal, run)
        # prepare must copy the exact completed ancestor evidence before native dispatch.
        for previous in goal['stages']:
            if previous['status'] == 'completed' and previous['id'] in __import__('easel.task_graph', fromlist=['ancestors']).ancestors(goal, stage['id']):
                for check in previous['checks']:
                    if check['type'] == 'file':
                        assert (client.workspace / check['value']).read_bytes() == (tmp_path / check['value']).read_bytes()
        paths_seen.append(run['stageId'])
        if run['stageId'] in ('facts', 'constraints') and run['iteration'] < 4:
            barrier.wait()
        h.success(client, state, native_turn)
    h.emit = emit
    goal = h.tasks.store.create_goal(spec(workflow='planned-reviewed-delivery', maxIterations=16,
        criteria=[{'type': 'review', 'label': '人工质量', 'value': ''}]), session='parent')
    h.tasks.store.change_goal(goal['id'], 'start')
    async def execute_graph():
        await h.run(goal['id'])
        pairs = [h.tasks.store.claim(h.tasks.owner, goal['id']) for _ in range(2)]
        assert {pair[1]['stageId'] for pair in pairs} == {'facts', 'constraints'}
        await asyncio.wait_for(asyncio.gather(*(h.tasks.execute(*pair) for pair in pairs)), 30)
        for _ in range(8):
            if h.tasks.store.get('goals', goal['id'])['phase'] == 'review':
                break
            await h.run(goal['id'])
    asyncio.run(execute_graph())
    current = h.tasks.store.get('goals', goal['id'])
    assert current['status'] == 'blocked' and current['phase'] == 'review', current
    assert paths_seen[:3] == ['decompose', 'facts', 'constraints'] or paths_seen[:3] == ['decompose', 'constraints', 'facts']
    assert paths_seen.count('constraints') == 1 and paths_seen.count('facts') == 2
    assert len(reviews) == 2 and len(h.tasks.store.rework_receipts(goal['id'])) == 1
    assert current['toolsUsed'] == h.dispatched * 3
    from easel.artifacts import ArtifactStore
    assert len(ArtifactStore(tmp_path).snapshot('parent')['artifacts']) >= 6
    assert all(row['engine'] == 'codex' for row in h.tasks.store.session_snapshots())
    assert not any(method.startswith('thread/goal/') for method, _ in h.calls)
    h.codex.close()


def test_dynamic_delivery_is_denied_after_pause_even_with_valid_native_call(tmp_path):
    store, goal, run, state = active(tmp_path)
    service = CodexService(tmp_path)
    bridge = CodexTasks(tmp_path); bridge.prepare(state)
    store.change_goal(goal['id'], 'stop')
    replies = []
    native_run = {'state': state, 'client': SimpleNamespace(reply=lambda ident, result: replies.append(result))}
    service._request(native_run, {'id': 'late-request', 'method': 'item/tool/call',
        'params': {'tool': 'easel_task_deliver', 'callId': 'late-call', 'arguments': {'files': [{'path': 'delivery/result.txt'}]}}})
    assert replies[0]['success'] is False and not (tmp_path / 'delivery/result.txt').exists()
    assert store.get('goals', goal['id'])['toolsUsed'] == 0


def test_native_unknown_reconciles_exact_original_without_replaying_delivery(tmp_path):
    from tests.test_codex_recovery import Client
    h = Harness(tmp_path)
    goal = h.tasks.store.create_goal(spec(), session='parent')
    h.tasks.store.change_goal(goal['id'], 'start'); goal, run = h.tasks.store.claim(h.tasks.owner)
    h.emit = lambda client, state, turn: client.events.put({'method': 'easel/transportClosed'})
    request = h.web.ChatRequest(message='隔离断线测试', sessionId=run['sessionId'], turnId=run['turnId'], engine='codex', modelRef='codex/fixture', thinkingLevel=None, roleId=None)
    asyncio.run(h.web.start_chat_run(request))
    native_run = h.codex.active.get(run['sessionId'])
    if native_run:
        assert native_run['finished'].wait(15)
    state = h.codex.snapshot(run['sessionId'], run['turnId'])
    assert state['outcome'] == 'unconfirmed'
    h.tasks.store.finish(run['id'], owner=h.tasks.owner, resource_settled=False)
    h.tasks.store.change_goal(goal['id'], 'cancel')
    client = Client(state, {'id': state['codexTurnId'], 'status': 'completed', 'itemsView': 'full',
        'items': [{'id': 'cmd', 'type': 'commandExecution', 'status': 'completed',
            'aggregatedOutput': 'EASEL_TASK_DELIVER {"files":[{"path":"delivery/result.txt"}]}'},
            {'id': 'final', 'type': 'agentMessage', 'text': '合成原轮次恢复'}]})
    h.codex.factory = lambda _: client
    h.codex.reconcile(run['sessionId'], run['turnId'])
    assert asyncio.run(h.tasks.settle(run))
    assert h.tasks.store.get('goals', goal['id'])['status'] == 'cancelled'
    assert h.dispatched == 1 and not (tmp_path / 'delivery/result.txt').exists()
    assert all(method in ('thread/read', 'thread/turns/list') for method, _ in client.calls)
    h.codex.close()


def test_terminal_native_turn_waits_for_browser_and_image_resources(tmp_path, monkeypatch):
    h = Harness(tmp_path)
    goal = h.tasks.store.create_goal(spec(), session='parent'); h.tasks.store.change_goal(goal['id'], 'start')
    current = asyncio.run(h.run(goal['id']))
    record = h.tasks.store.snapshot('parent')['runs'][0]
    calls = []
    monkeypatch.setattr(h.codex, 'task_browser_settled', lambda sid: calls.append(sid) or False)
    assert not asyncio.run(h.tasks.settle(record))
    monkeypatch.setattr(h.codex, 'task_browser_settled', lambda sid: True)
    monkeypatch.setattr('task_service.ImageJobs.pending', lambda *args: ['pending-image'])
    assert not asyncio.run(h.tasks.settle(record))
    assert calls == ['parent'] and current['phase'] == 'review'
    h.codex.close()


def test_handoff_rechecks_saved_versions_and_protects_upstream_dependencies(tmp_path):
    from easel.task_rules import check_goal
    store, goal, run, state = active(tmp_path, stages=[
        {'id':'first','title':'上游','roleId':'builder','objective':'创建网页',
         'criteria':[{'type':'file','label':'网页','value':'work/first.html'}]},
        {'id':'second','title':'下游','roleId':'builder','objective':'创建另一个网页',
         'criteria':[{'type':'file','label':'网页','value':'work/second.html'}]}])
    root = tmp_path/'work'; root.mkdir()
    (root/'first.html').write_text('<link rel="stylesheet" href="shared.css">', encoding='utf-8')
    (root/'shared.css').write_text('body{color:red}', encoding='utf-8')
    store.finish(run['id'],owner=run['owner'],stage_checks=check_goal(tmp_path,goal['stages'][0],'')[0])
    goal, run = store.claim('second-owner')
    store.bind_provider(run['sessionId'], run['turnId'], 'second-turn')
    state.update(turn_id=run['turnId'], codexTurnId='second-turn')
    bridge = CodexTasks(tmp_path); bridge.prepare(state)
    workspace = Path(state['workspace'])
    assert (workspace/'work/shared.css').read_bytes() == (root/'shared.css').read_bytes()
    (workspace/'work/second.html').write_text('<link rel="stylesheet" href="shared.css">', encoding='utf-8')
    (workspace/'work/shared.css').write_text('body{color:blue}', encoding='utf-8')
    with pytest.raises(TaskConflict, match='其他阶段'):
        bridge.deliver(state,[{'path':'work/second.html'}])
    assert not (root/'second.html').exists()
    (root/'shared.css').write_text('body{color:green}', encoding='utf-8')
    with pytest.raises(TaskConflict, match='版本已变化'):
        bridge.prepare(state)
    assert (workspace/'work/shared.css').read_text(encoding='utf-8') == 'body{color:blue}'


@pytest.mark.parametrize('role', ['reviewer', 'publisher'])
@pytest.mark.parametrize('resource', ['delivery/result.css', 'delivery/style.css'])
def test_non_writing_role_cannot_replace_final_files_through_html_dependencies(tmp_path, role, resource):
    final = 'delivery/result.css' if resource.endswith('result.css') else 'delivery/result.html'
    store, goal, run, state = active(tmp_path, criteria=[
        {'type': 'file', 'label': '最终产物', 'value': final},
        {'type': 'review', 'label': '人工验收', 'value': ''}], stages=[
        {'id': 'inspect', 'title': '记录检查', 'roleId': role, 'objective': '检查既有产物并保存说明',
         'criteria': [{'type': 'file', 'label': '检查说明', 'value': 'review/report.html'}]}])
    target = tmp_path / resource
    target.parent.mkdir(parents=True)
    target.write_text('body{color:green}', encoding='utf-8')
    if final.endswith('.html'):
        (tmp_path / final).write_text('<link rel="stylesheet" href="style.css">', encoding='utf-8')
    bridge = CodexTasks(tmp_path)
    assert bridge.prepare(state)
    workspace = Path(state['workspace'])
    (workspace / 'review').mkdir()
    (workspace / 'delivery').mkdir()
    (workspace / 'review/report.html').write_text(
        '<link rel="stylesheet" href="../' + resource + '">', encoding='utf-8')
    (workspace / resource).write_text('body{color:red}', encoding='utf-8')
    from easel.artifacts import ArtifactStore
    with ArtifactStore(tmp_path).db() as db:
        before = db.execute('SELECT * FROM events').fetchall()
    with pytest.raises(TaskConflict, match='其他阶段|最终产物'):
        bridge.deliver(state, [{'path': 'review/report.html'}])
    assert target.read_text(encoding='utf-8') == 'body{color:green}'
    assert not (tmp_path / 'review/report.html').exists()
    with ArtifactStore(tmp_path).db() as db:
        assert db.execute('SELECT * FROM events').fetchall() == before


def test_dependency_alias_cannot_replace_upstream_evidence(tmp_path):
    from easel.task_rules import check_goal
    store, goal, run, state = active(tmp_path, stages=[
        {'id': 'first', 'title': '上游资料', 'roleId': 'builder', 'objective': '保存上游网页',
         'criteria': [{'type': 'file', 'label': '上游网页', 'value': 'work/first.html'}]},
        {'id': 'second', 'title': '下游结果', 'roleId': 'builder', 'objective': '生成下游网页',
         'criteria': [{'type': 'file', 'label': '下游网页', 'value': 'work/second.html'}]}])
    root = tmp_path / 'work'
    root.mkdir()
    (root / 'first.html').write_text('<link rel="stylesheet" href="shared.css">', encoding='utf-8')
    (root / 'shared.css').write_text('body{color:green}', encoding='utf-8')
    try:
        (tmp_path / 'alias').symlink_to(root, target_is_directory=True)
    except OSError:
        if sys.platform != 'win32':
            pytest.skip('Creating directory symlinks is unavailable on this host')
        linked = subprocess.run(['cmd.exe', '/c', 'mklink', '/J', str(tmp_path / 'alias'), str(root)],
                                capture_output=True, check=False)
        if linked.returncode:
            pytest.skip('Creating directory junctions is unavailable on this host')
    store.finish(run['id'], owner=run['owner'], stage_checks=check_goal(tmp_path, goal['stages'][0], '')[0])
    goal, run = store.claim('second-owner')
    store.bind_provider(run['sessionId'], run['turnId'], 'second-turn')
    state.update(turn_id=run['turnId'], codexTurnId='second-turn')
    bridge = CodexTasks(tmp_path)
    bridge.prepare(state)
    workspace = Path(state['workspace'])
    (workspace / 'alias').mkdir()
    (workspace / 'alias/shared.css').write_text('body{color:red}', encoding='utf-8')
    (workspace / 'work/second.html').write_text(
        '<link rel="stylesheet" href="../alias/shared.css">', encoding='utf-8')
    with pytest.raises(TaskConflict, match='其他阶段'):
        bridge.deliver(state, [{'path': 'work/second.html'}])
    assert (root / 'shared.css').read_text(encoding='utf-8') == 'body{color:green}'
    assert not (root / 'second.html').exists()


@pytest.mark.parametrize('role', ['builder', 'reviewer'])
def test_handoff_preserves_identical_final_resource_and_builder_can_update_it(tmp_path, role):
    store, goal, run, state = active(tmp_path, criteria=[
        {'type': 'file', 'label': '最终样式', 'value': 'delivery/result.css'}], stages=[
        {'id': 'inspect', 'title': '阶段说明', 'roleId': role, 'objective': '生成本阶段网页说明',
         'criteria': [{'type': 'file', 'label': '阶段网页', 'value': 'review/report.html'}]}])
    target = tmp_path / 'delivery/result.css'
    target.parent.mkdir()
    target.write_text('body{color:green}', encoding='utf-8')
    os.utime(target, ns=(1000000000000000000, 1000000000000000000))
    before = target.stat().st_mtime_ns
    workspace = Path(state['workspace'])
    (workspace / 'delivery').mkdir()
    (workspace / 'review').mkdir()
    content = 'body{color:red}' if role == 'builder' else 'body{color:green}'
    (workspace / 'delivery/result.css').write_text(content, encoding='utf-8')
    (workspace / 'review/report.html').write_text(
        '<link rel="stylesheet" href="../delivery/result.css">', encoding='utf-8')
    result = CodexTasks(tmp_path).deliver(state, [{'path': 'review/report.html'}])
    assert result[0]['path'] == 'review/report.html'
    assert target.read_text(encoding='utf-8') == content
    if role == 'reviewer':
        assert target.stat().st_mtime_ns == before


def test_native_delivery_rejection_is_reported_without_partial_files_or_receipts(tmp_path):
    store, goal, run, state = active(tmp_path, criteria=[
        {'type': 'file', 'label': '最终文件', 'value': 'delivery/result.css'}], stages=[
        {'id': 'inspect', 'title': '审查资料', 'roleId': 'reviewer', 'objective': '保存独立审查记录',
         'criteria': [{'type': 'file', 'label': '说明', 'value': 'review/notes.txt'},
                      {'type': 'file', 'label': '网页', 'value': 'review/report.html'}]}])
    target = tmp_path / 'delivery/result.css'
    target.parent.mkdir()
    target.write_text('body{color:green}', encoding='utf-8')
    workspace = Path(state['workspace'])
    (workspace / 'delivery').mkdir()
    (workspace / 'review').mkdir()
    (workspace / 'review/notes.txt').write_text('有效的阶段说明', encoding='utf-8')
    (workspace / 'review/report.html').write_text(
        '<link rel="stylesheet" href="../delivery/result.css">', encoding='utf-8')
    (workspace / 'delivery/result.css').write_text('body{color:red}', encoding='utf-8')
    bridge = CodexTasks(tmp_path)
    bridge.prepare(state)
    replies = []
    native = {'state': state, 'client': SimpleNamespace(reply=lambda ident, result: replies.append(result))}
    service = CodexService(tmp_path)
    service._request(native, {'id': 'delivery-request', 'method': 'item/tool/call', 'params': {
        'tool': 'easel_task_deliver', 'callId': 'delivery-call', 'arguments': {'files': [
            {'path': 'review/notes.txt'}, {'path': 'review/report.html'}]}}})
    assert replies[0]['success'] is False
    assert target.read_text(encoding='utf-8') == 'body{color:green}'
    assert not (tmp_path / 'review/notes.txt').exists()
    assert not (tmp_path / 'review/report.html').exists()
    from easel.artifacts import ArtifactStore
    assert ArtifactStore(tmp_path).snapshot('parent')['artifacts'] == []
    assert store.get('goals', goal['id'])['status'] == 'active'
    assert store.get('runs', run['id'])['state'] == 'running'
