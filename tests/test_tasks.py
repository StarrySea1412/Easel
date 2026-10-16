import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from easel.task_rules import GoalSpec, Schedule, next_time, latest_time, check_goal
from easel.task_store import TaskStore, TaskConflict

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from task_service import TaskService
import run_ledger


def spec(**patch):
    return GoalSpec(objective='保存选题初稿文件并完成质量检查', modelRef='test/model',
                    criteria=[{'type': 'file', 'label': '选题文件', 'value': 'topic/a.txt'},
                              {'type': 'review', 'label': '质量'}], **patch).model_dump()


def active(store, **kw):
    g = store.create_goal(spec(**kw), session='chat')
    store.change_goal(g['id'], 'start')
    g,r = store.claim('worker')
    store.bind_provider(g['sessionId'],r['turnId'],'provider')
    return g,r


def test_multi_connection_admission_and_stop_fence(tmp_path):
    store = TaskStore(tmp_path)
    goal = store.create_goal(spec(), session='chat')
    store.change_goal(goal['id'], 'start')
    with ThreadPoolExecutor(8) as pool:
        claimed = list(pool.map(lambda i: TaskStore(tmp_path).claim(str(i)), range(8)))
    pairs = [p for p in claimed if p]
    assert len(pairs) == 1
    g, r = pairs[0]
    store.change_goal(g['id'], 'stop')
    with pytest.raises(TaskConflict):
        store.change_goal(g['id'], 'resume')
    checks = [{**c, 'state': 'passed'} for c in g['criteria']]
    result = store.finish(r['id'], owner=r['owner'], checks=checks, text='已完成')
    assert result['status'] == 'paused'
    assert TaskStore(tmp_path).claim('another') is None
    assert store.session_snapshots()[0]['messages'][-1]['content'] == '已完成'


def test_owner_fencing_and_restart_unknown_not_replayed(tmp_path):
    now = [1000]
    store = TaskStore(tmp_path, clock=lambda: now[0])
    g, r = active(store)
    now[0] += 91
    assert TaskStore(tmp_path, clock=lambda: now[0]).claim('new') is None
    assert store.running()[0]['state'] == 'unconfirmed'
    with pytest.raises(TaskConflict):
        store.finish(r['id'], owner='new', text='假的完成')
    with pytest.raises(TaskConflict):
        store.change_goal(g['id'], 'resume')
    assert len(store.snapshot()['runs']) == 1
    store.finish(r['id'], owner='worker', state='stopped')
    assert store.snapshot()['goals'][0]['status'] == 'blocked'


def test_human_input_pauses_between_rounds_but_cannot_race_running(tmp_path):
    store = TaskStore(tmp_path)
    g = store.create_goal(spec(), session='chat')
    store.change_goal(g['id'], 'start')
    store.reserve_chat('chat', 'human')
    assert store.claim('worker') is None
    assert store.get('goals', g['id'])['status'] == 'paused'
    store.release_chat('chat', 'human')
    store.change_goal(g['id'], 'resume')
    _, r = store.claim('worker')
    with pytest.raises(TaskConflict):
        store.reserve_chat('chat', 'human2')
    store.finish(r['id'], owner='worker', state='stopped')


def test_tools_and_images_reserve_atomically_with_idempotency(tmp_path):
    store = TaskStore(tmp_path)
    g, r = active(store, maxTools=2, maxImages=3)
    assert store.guard('chat', 'provider', 'one', 'read')['allowed']
    assert store.guard('chat', 'provider', 'one', 'read')['allowed']
    assert not store.guard('chat', 'other-provider', 'two', 'read')['allowed']
    assert store.guard('chat', 'provider', 'two', 'exec')['allowed']
    assert not store.guard('chat', 'provider', 'three', 'exec')['allowed']
    assert store.get('goals', g['id'])['toolsUsed'] == 2
    store.change_goal(g['id'], 'stop')
    with pytest.raises(TaskConflict):
        store.reserve_image('chat', r['turnId'], 'a')
    store.finish(r['id'], owner='worker', state='stopped')
    store.change_goal(g['id'], 'resume')
    _, second = store.claim('worker')
    store.bind_provider('chat',second['turnId'],'provider2')
    store.reserve_image('chat', second['turnId'], 'a', 2)
    store.reserve_image('chat', second['turnId'], 'a', 2)
    store.reserve_image('chat', second['turnId'], 'b', 1)
    with pytest.raises(TaskConflict):
        store.reserve_image('chat', second['turnId'], 'c')
    assert store.get('goals', g['id'])['imagesUsed'] == 3
    assert not store.guard('chat', 'provider', 'late', 'exec')['allowed']


def test_delegation_is_blocked_and_late_tools_stay_blocked(tmp_path):
    store = TaskStore(tmp_path)
    g, r = active(store)
    assert not store.guard('chat', 'provider', 'spawn', 'sessions_spawn')['allowed']
    assert store.get('goals', g['id'])['status'] == 'blocked'
    store.finish(r['id'], owner='worker', state='stopped')
    assert not store.guard('chat', 'provider', 'late', 'exec')['allowed']
    store.reserve_chat('chat', 'human')
    assert store.guard('chat', 'human-provider', 'normal', 'read')['allowed']
    assert not store.guard('chat', 'provider', 'late', 'read')['allowed']


def test_checks_files_dependencies_changes_and_no_fail_open(tmp_path):
    folder = tmp_path / 'topic'; folder.mkdir()
    (folder / 'page.html').write_text('<img src="missing.png">')
    g = {'criteria': [{'type': 'file', 'label': '页面', 'value': 'topic/page.html'},
                      {'type': 'text', 'label': '说明', 'value': 'source'},
                      {'type': 'review', 'label': '质量', 'value': ''}]}
    checks, first = check_goal(tmp_path, g, 'no')
    assert [c['state'] for c in checks] == ['failed', 'failed', 'pending']
    (folder / 'page.html').write_text('<p>hello</p>')
    checks, second = check_goal(tmp_path, g, 'source', reviewed=True)
    assert all(c['state'] == 'passed' for c in checks) and first != second
    g['criteria'][0]['value'] = '../private'
    assert check_goal(tmp_path, g, 'source')[0][0]['state'] == 'error'


def test_review_then_completion_and_budget_cannot_reset(tmp_path):
    store = TaskStore(tmp_path)
    g, r = active(store, maxIterations=1)
    checks = [{**g['criteria'][0], 'state': 'passed'}, {**g['criteria'][1], 'state': 'pending'}]
    result = store.finish(r['id'], owner='worker', text='ok', checks=checks)
    assert (result['status'], result['phase']) == ('blocked', 'review')
    with pytest.raises(TaskConflict):
        store.change_goal(g['id'], 'resume')
    checks[-1]['state'] = 'passed'
    assert store.apply_checks(g['id'], checks, review=r['turnId'])['status'] == 'completed'
    checks[0]['state'] = 'failed'
    assert store.apply_checks(g['id'], checks)['phase'] == 'evidence_changed'


def test_history_recheck_cannot_replace_new_current_goal(tmp_path):
    store=TaskStore(tmp_path)
    g,r=active(store)
    checks=[{**c,'state':'passed'} for c in g['criteria']]
    store.finish(r['id'],owner='worker',checks=checks)
    new=store.create_goal(spec(),session='chat')
    checks[0]['state']='failed'
    with pytest.raises(TaskConflict):
        store.apply_checks(g['id'],checks)
    assert store.get('goals',new['id'])['status']=='draft'
    assert len(store.snapshot()['goals'])==2


def test_error_verification_blocks_and_no_progress_is_bounded(tmp_path):
    store = TaskStore(tmp_path)
    g, r = active(store)
    result = store.finish(r['id'], owner='worker', checks=[{'state': 'error', 'type': 'file'}])
    assert result['phase'] == 'verification_error'
    store.change_goal(g['id'], 'resume')
    for _ in range(3):
        _, r = store.claim('worker')
        store.finish(r['id'], owner='worker', checks=[{'state': 'failed', 'type': 'file'}], fingerprint='same')
    assert store.get('goals', g['id'])['phase'] == 'no_progress'


def ts(value):
    return datetime.fromisoformat(value).timestamp()


@pytest.mark.parametrize('kind,start,expected', [
    ('daily','2026-10-16T00:59:00+00:00','2026-10-16T01:00:00+00:00'),
    ('workdays','2026-10-16T01:01:00+00:00','2026-10-19T01:00:00+00:00'),
    ('weekly','2026-10-16T00:00:00+00:00','2026-10-19T01:00:00+00:00'),
])
def test_wall_clock_schedules(kind, start, expected):
    assert next_time({'kind': kind}, ts(start)) == ts(expected)


def test_dst_missing_hour_skipped_and_fold_only_once():
    rule = {'kind': 'daily', 'timezone': 'America/New_York', 'time': '02:30'}
    assert next_time(rule, ts('2026-03-08T05:00:00+00:00')) == ts('2026-03-09T06:30:00+00:00')
    rule['time'] = '01:30'
    assert next_time(rule, ts('2026-11-01T05:40:00+00:00')) == ts('2026-11-02T06:30:00+00:00')
    assert next_time({'kind':'interval','at':1000,'minutes':5}, 1300) == 1600
    assert next_time({'kind':'once','at':1000}, 1001) is None
    assert latest_time({'kind':'interval','at':1000,'minutes':5}, 1300) == 1300
    assert latest_time({'kind':'daily','timezone':'Asia/Shanghai'}, ts('2026-10-16T01:05:00+00:00')) == ts('2026-10-16T01:00:00+00:00')
    with pytest.raises(ValidationError):
        Schedule(kind='daily', timezone='Not/AZone')


def test_plan_slot_idempotency_manual_does_not_shift_schedule(tmp_path):
    store = TaskStore(tmp_path)
    p = store.save_plan({'title':'日报','goal':spec(),'enabled':True}, 1000)
    with ThreadPoolExecutor(6) as pool:
        values = list(pool.map(lambda _: TaskStore(tmp_path).trigger_plan(p['id'], scheduled_at=1000, next_at=2000), range(6)))
    assert sum(bool(v) for v in values) == 1
    manual = store.trigger_plan(p['id'], request='request')
    assert manual and store.get('plans', p['id'])['nextAt'] == 2000
    assert store.trigger_plan(p['id'], request='request') is None
    store.trigger_plan(p['id'], scheduled_at=2000, next_at=3000, missed=True)
    saved = store.get('plans', p['id'])
    assert saved['history'][-1]['status'] == 'skipped' and len(store.snapshot()['goals']) == 2


def test_worker_two_rounds_same_chat_and_no_sse_observer(tmp_path, monkeypatch):
    ledger = tmp_path / '_sessions'
    web = SimpleNamespace(OUTPUTS_DIR=tmp_path, run_ledger=run_ledger, _run_ledger_root=lambda:ledger,
                          _turn_file=lambda s:ledger / 'turn.json', ChatRequest=lambda **kw:SimpleNamespace(**kw))
    service = TaskService(web)
    monkeypatch.setattr(service, 'admit', lambda *_:None)
    monkeypatch.setattr(service, 'config_hash', lambda:'config')
    dispatched = []
    async def start(req, **kw):
        assert kw == {'observe':False}
        dispatched.append(req)
        ledger.mkdir(exist_ok=True)
        (ledger / 'turn.json').write_text(json.dumps({'turn_id':req.turnId,'text':'真实输出'}))
        run_ledger.create(ledger, req.turnId, session_id=req.sessionId, session_key=req.sessionId)
        run_ledger.mark(ledger, req.turnId, status='completed', settled=True, resource_settled=True)
        if len(dispatched) == 2:
            (tmp_path / 'topic').mkdir();(tmp_path / 'topic/a.txt').write_text('真实文件')
    web.start_chat_run = start
    g = service.store.create_goal(spec(), session='chat')
    service.store.change_goal(g['id'], 'start')
    async def run():
        for _ in range(2):
            g,r = service.store.claim(service.owner)
            await service.execute(g,r)
    asyncio.run(run())
    assert len(dispatched) == 2 and dispatched[0].sessionId == dispatched[1].sessionId
    assert dispatched[0].turnId != dispatched[1].turnId
    assert service.store.get('goals', g['id'])['phase'] == 'review'
    assert len(service.store.session_snapshots()[0]['messages']) == 3


def test_api_validation_paused_plan_and_guard_failure(tmp_path, monkeypatch):
    service = TaskService(SimpleNamespace(OUTPUTS_DIR=tmp_path))
    monkeypatch.setattr(service, 'validate_goal', lambda *_:None)
    monkeypatch.setattr(service, 'config_hash', lambda:'config')
    monkeypatch.setattr(service, 'admit', lambda *_:(_ for _ in ()).throw(TaskConflict('保护未加载')))
    app = FastAPI();app.include_router(service.router());client=TestClient(app)
    bad = spec();bad['maxIterations'] = 100
    assert client.post('/api/tasks/goals', json={'goal':bad}).status_code == 422
    g = client.post('/api/tasks/goals', json={'goal':spec()}).json()
    response = client.post(f"/api/tasks/goals/{g['id']}/action", json={'action':'start'})
    assert response.status_code == 409 and service.store.get('goals',g['id'])['status'] == 'draft'
    p = client.post('/api/tasks/plans', json={'goal':spec(),'title':'test','schedule':{'kind':'daily'}}).json()
    assert not p['enabled']
    assert client.get('/api/tasks/sessions').json()['sessions'][0]['id'] == g['sessionId']


def test_paused_goal_cancels_queued_images_before_provider(tmp_path):
    from easel.image_jobs import ImageJobs
    store = TaskStore(tmp_path)
    g, r = active(store, maxImages=2)
    config = {'IMG_BASE_URL':'https://fixture.invalid/v1','IMG_MODEL':'fixture','IMG_API_KEY':'dummy'}
    jobs = ImageJobs(tmp_path)
    job = jobs.submit({'prompt':'test','n':2},config,session='chat',turn=r['turnId'],request_id='one')
    assert store.get('goals',g['id'])['imagesUsed'] == 2
    store.change_goal(g['id'],'stop')
    assert jobs.claim(config,'image-worker') is None
    assert jobs.get(job['jobId'])['phase'] == 'error'


def test_settlement_keeps_unknown_images_and_only_finishes_after_receipt(tmp_path):
    from easel.image_jobs import ImageJobs
    root = tmp_path / 'ledger'
    service = TaskService(SimpleNamespace(OUTPUTS_DIR=tmp_path, run_ledger=run_ledger,
        _run_ledger_root=lambda:root, _turn_file=lambda s:tmp_path/'missing.json'))
    g,r = active(service.store,maxImages=1)
    run_ledger.create(root,r['turnId'],session_id='chat',session_key='chat')
    run_ledger.mark(root,r['turnId'],status='completed',settled=True,resource_settled=True)
    config = {'IMG_BASE_URL':'https://fixture.invalid/v1','IMG_MODEL':'fixture','IMG_API_KEY':'dummy'}
    jobs=ImageJobs(tmp_path)
    job=jobs.submit({'prompt':'test'},config,session='chat',turn=r['turnId'],request_id='one')
    jobs.claim(config,'worker',now=1)
    jobs.claim(config,'new-worker',now=100)
    assert asyncio.run(service.settle(r)) is False
    assert jobs.get(job['jobId'])['phase']=='unconfirmed'
    assert service.store.running()


def test_restart_coalesces_only_latest_fresh_interval_and_default_skips(tmp_path, monkeypatch):
    import task_service
    now=100000.0
    monkeypatch.setattr(task_service.time,'time',lambda:now)
    service=TaskService(SimpleNamespace(OUTPUTS_DIR=tmp_path))
    # Keep the worker occupied so this assertion tests scheduling only.
    service.work.add('fixture')
    rule={'kind':'interval','at':now-3600,'minutes':5}
    common={'title':'fixture','goal':spec(),'enabled':True,'schedule':rule,'freshnessSeconds':900}
    p=service.store.save_plan({**common,'missedPolicy':'coalesce'},now-3600)
    skipped=service.store.save_plan({**common,'missedPolicy':'skip'},now-3600)
    asyncio.run(service.tick());asyncio.run(service.tick())
    assert len(service.store.snapshot()['goals'])==1
    saved=service.store.get('plans',p['id'])
    assert len(saved['history'])==1 and saved['history'][0]['scheduledAt']==now
    assert saved['nextAt']==now+300
    assert service.store.get('plans',skipped['id'])['lastResult']['status']=='skipped'


def test_edit_plan_keeps_trigger_history_and_default_api_title(tmp_path, monkeypatch):
    service = TaskService(SimpleNamespace(OUTPUTS_DIR=tmp_path))
    monkeypatch.setattr(service, 'validate_goal', lambda *_:None)
    monkeypatch.setattr(service, 'config_hash', lambda:'config')
    app = FastAPI(); app.include_router(service.router()); client = TestClient(app)
    payload = {'goal':spec(), 'schedule':{'kind':'daily'}}
    response = client.post('/api/tasks/plans', json=payload)
    assert response.status_code == 200
    p = response.json()
    assert p['title'] == '定时任务'
    service.store.trigger_plan(p['id'], request='manual')
    old = service.store.get('plans', p['id'])
    changed = client.put(f"/api/tasks/plans/{p['id']}", json={**payload, 'title':'修改名称'}).json()
    assert changed['history'] == old['history'] and changed['lastResult'] == old['lastResult']
    assert changed['revision'] == old['revision'] + 1 and not changed['enabled']


def test_old_session_and_due_plan_survive_management_history_limits(tmp_path):
    store = TaskStore(tmp_path)
    old = store.create_goal(spec(), session='old-chat')
    plan = store.save_plan({'title':'due', 'goal':spec(), 'enabled':True}, 1000)
    # Use one transaction to simulate a populated historical database.
    with store.db() as db:
        for i in range(301):
            data = {**old, 'id':f'new-{i}', 'sessionId':f'chat-{i}'}
            store._goal(db, data)
            db.execute('INSERT INTO plans VALUES(?,?,?,?)', (f'p-{i}',0,2000,json.dumps({'id':f'p-{i}'})))
    assert not any(g['id'] == old['id'] for g in store.snapshot()['goals'])
    assert store.snapshot('old-chat')['goals'][0]['id'] == old['id']
    assert store.due_plans(1001)[0]['id'] == plan['id']


def test_goal_revision_requires_settlement_and_preserves_budget(tmp_path):
    store=TaskStore(tmp_path)
    g,r=active(store,maxImages=1)
    store.guard('chat','provider','read-call','read')
    store.reserve_image('chat',r['turnId'],'image-call')
    with pytest.raises(TaskConflict):store.revise_goal(g['id'],'修改持续目标',g['criteria'])
    store.change_goal(g['id'],'stop')
    with pytest.raises(TaskConflict):store.revise_goal(g['id'],'修改持续目标',g['criteria'])
    store.finish(r['id'],owner='worker',state='stopped')
    revised=store.revise_goal(g['id'],'修改持续目标',g['criteria'])
    assert (revised['iterations'],revised['toolsUsed'],revised['imagesUsed'])==(1,1,1)
    assert revised['revision']==2 and revised['currentTurnId'] is None
    assert revised['activeSeconds']>0 and revised['steps']==[]


def test_step_reporting_keeps_work_separate_from_quality_and_blocks(tmp_path):
    store=TaskStore(tmp_path);g,r=active(store)
    steps=[{'id':'one','title':'检查材料','status':'completed'}, {'id':'two','title':'等待用户提供文件','status':'blocked','detail':'缺少原始图片'}]
    with pytest.raises(TaskConflict):store.update_progress('chat','step-call',steps)
    store.guard('chat','provider','wrong-tool','read')
    with pytest.raises(TaskConflict):store.update_progress('chat','wrong-tool',steps)
    assert store.guard('chat','provider','step-call','easel_goal_update')['allowed']
    receipt=store.update_progress('chat','step-call',steps)
    assert receipt['completed']==1 and receipt['qualityApproved'] is False
    saved=store.get('goals',g['id']);assert saved['checks']==[]
    assert check_goal(tmp_path,g,'')[1]!=check_goal(tmp_path,saved,'')[1]
    final=store.finish(r['id'],owner='worker',checks=[{'type':'review','state':'pending'}])
    assert final['phase']=='waiting_input' and final['reason']=='缺少原始图片'


def test_passed_evidence_cannot_complete_unfinished_work_steps(tmp_path):
    store=TaskStore(tmp_path);g,r=active(store)
    store.guard('chat','provider','step-call','easel_goal_update')
    store.update_progress('chat','step-call',[{'id':'one','title':'检查实际成品','status':'in_progress'}])
    checks=[{'type':'file','state':'passed'}]
    final=store.finish(r['id'],owner='worker',checks=checks)
    assert final['status']=='active' and final['phase']=='queued'
    rechecked=store.apply_checks(g['id'],checks)
    assert rechecked['status']!='completed'
