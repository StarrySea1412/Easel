"""Ordinary stage-rework lifecycle, isolated files and synthetic model receipts."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sys
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from easel.image_jobs import ImageJobs
from easel.task_rules import GoalSpec, check_goal
from easel.task_stages import check_stage, current_stage
from easel.task_store import TaskConflict, TaskStore

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from task_service import TaskService
import run_ledger


def ready(outputs, **patch):
    store = TaskStore(outputs)
    g = store.create_goal(GoalSpec(objective='合成验收：制作并审查本地说明文件', modelRef='fixture/model',
        criteria=[{'type': 'review', 'label': '用户检查质量'}], workflow='research-delivery',
        maxIterations=patch.pop('maxIterations', 10), **patch).model_dump(), session='rework-test')
    store.change_goal(g['id'], 'start')
    for _ in range(4):
        g, r = store.claim('worker')
        stage = current_stage(g)
        path = outputs / stage['criteria'][0]['value']; path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('合成原始文件：' + stage['id'], encoding='utf-8')
        g = store.finish(r['id'], owner='worker', text='原回执：' + stage['id'],
            checks=check_goal(outputs, g, '')[0], stage_checks=check_stage(outputs, stage, '')[0])
    assert g['phase'] == 'review'
    return store, g, r


def rework(store, g, **patch):
    return store.rework_stage(g['id'], **({'stage_id': 'build', 'revision': g['revision'],
        'request_id': 'retry-one', 'reason': '合成验收：补充制作与审查细节'} | patch))


def test_rework_keeps_upstream_files_budget_and_old_receipts_after_reopen(tmp_path):
    store, g, old_run = ready(tmp_path)
    files = {s['id']: (tmp_path / s['criteria'][0]['value']).read_bytes() for s in g['stages']}
    result = rework(store, g)
    saved = TaskStore(tmp_path).get('goals', g['id'])
    assert saved == result['goal'] and saved['status'] == 'paused'
    assert saved['stages'][0] == g['stages'][0]
    assert all(s['status'] == 'pending' and not s['checks'] and not s.get('handoff') for s in saved['stages'][1:])
    assert saved['revision'] == 2 and saved['currentTurnId'] is None and saved['reviewedTurnId'] is None
    for key in ('iterations', 'activeSeconds', 'imagesUsed', 'toolsUsed'):
        assert saved[key] == g[key]
    assert all((tmp_path / s['criteria'][0]['value']).read_bytes() == files[s['id']] for s in saved['stages'])
    receipt = TaskStore(tmp_path).rework_receipts(g['id'])[0]
    assert receipt == result['receipt'] and receipt['stages'] == g['stages'][1:]
    assert store.claim('other') is None
    # A repeated terminal callback cannot change the new revision.
    assert store.finish(old_run['id'], owner='worker', text='晚到旧回执', state='failed') == saved
    assert rework(store, g)['replayed'] is True
    assert len(store.rework_receipts(g['id'])) == 1
    with pytest.raises(TaskConflict, match='不同的重做'):
        rework(store, g, reason='另一条不同原因')


def test_resume_runs_only_reset_roles_and_requires_new_files_and_human_review(tmp_path, monkeypatch):
    store, g, _ = ready(tmp_path)
    rework(store, g)
    ledger = tmp_path / 'ledger'
    web = SimpleNamespace(OUTPUTS_DIR=tmp_path, run_ledger=run_ledger, _run_ledger_root=lambda: ledger,
        _turn_file=lambda _: tmp_path / 'turn.json', ChatRequest=lambda **kw: SimpleNamespace(**kw))
    service = TaskService(web); monkeypatch.setattr(service, 'admit', lambda *_: None)
    requests = []
    async def start(req, **_):
        requests.append(req)
        assert '补充制作与审查细节' in req.message and '原回执：review' in req.message
        assert '不是当前版本已完成的证据' in req.message
        g = store.get('goals', goal_id); stage = current_stage(g)
        (tmp_path / stage['criteria'][0]['value']).write_text('合成重做新文件：' + stage['id'], encoding='utf-8')
        (tmp_path / 'turn.json').write_text(json.dumps({'turn_id': req.turnId, 'text': '合成新版回执'}), encoding='utf-8')
        run_ledger.create(ledger, req.turnId, session_id=req.sessionId, session_key=req.sessionId)
        run_ledger.mark(ledger, req.turnId, status='completed', settled=True, resource_settled=True)
    web.start_chat_run = start
    goal_id = g['id']; store.change_goal(goal_id, 'resume')
    async def execute():
        for _ in range(3):
            await service.execute(*store.claim(service.owner))
    asyncio.run(execute())
    saved = store.get('goals', goal_id)
    assert [req.roleId for req in requests] == ['builder', 'reviewer', 'publisher']
    assert saved['iterations'] == 7 and saved['phase'] == 'review'
    assert saved['stages'][0] == g['stages'][0]
    assert [s['attempts'] for s in saved['stages']] == [1, 2, 2, 2]
    assert all(r.get('reworkId') == 'retry-one' for r in store.snapshot()['runs'] if r['revision'] == 2)
    with pytest.raises(TaskConflict, match='当前轮次'):
        store.apply_checks(goal_id, check_goal(tmp_path, saved, '', True)[0], review=g['currentTurnId'])
    store.apply_checks(goal_id, check_goal(tmp_path, saved, '', True)[0], review=saved['currentTurnId'])
    assert store.get('goals', goal_id)['status'] == 'completed'


def test_existing_downstream_file_is_not_fresh_evidence(tmp_path):
    store, g, _ = ready(tmp_path)
    rework(store, g); store.change_goal(g['id'], 'resume'); g, r = store.claim('worker')
    stage = current_stage(g)
    checks = check_stage(tmp_path, stage, '我已完成')[0]
    assert checks[0]['state'] == 'failed'
    result = store.finish(r['id'], owner='worker', text='我已完成', checks=check_goal(tmp_path, g, '')[0], stage_checks=checks)
    assert result['phase'] == 'handoff_failed'


def test_concurrent_retries_deduplicate_and_other_revisions_conflict(tmp_path):
    store, g, _ = ready(tmp_path)
    with ThreadPoolExecutor(4) as pool:
        results = list(pool.map(lambda _: rework(TaskStore(tmp_path), g), range(4)))
    assert sum(not r['replayed'] for r in results) == 1
    assert len(store.rework_receipts(g['id'])) == 1
    with pytest.raises(TaskConflict, match='版本已变化'):
        rework(store, g, request_id='other')
    with pytest.raises(TaskConflict, match='无需重做'):
        rework(store, store.get('goals', g['id']), request_id='other')


@pytest.mark.parametrize('blocker', ['active', 'running', 'unconfirmed', 'chat', 'image', 'completed', 'cancelled', 'deleted'])
def test_unsettled_or_terminal_goals_never_change_revision(tmp_path, blocker):
    store, g, _ = ready(tmp_path)
    if blocker in ('active', 'running', 'unconfirmed'):
        store.change_goal(g['id'], 'resume')
        if blocker != 'active':
            _, r = store.claim('worker'); store.change_goal(g['id'], 'pause')
            if blocker == 'unconfirmed':
                store.finish(r['id'], owner='worker', resource_settled=False)
    elif blocker == 'chat':
        store.reserve_chat(g['sessionId'], 'ordinary-chat')
    elif blocker == 'image':
        with ImageJobs(tmp_path).db() as db:
            db.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                ('synthetic-image', g['sessionId'] + ':old', 'synthetic', 'synthetic', '', '', 'unconfirmed', None, 0, 0, '{}'))
    elif blocker == 'completed':
        store.apply_checks(g['id'], check_goal(tmp_path, g, '', True)[0], review=g['currentTurnId'])
    elif blocker == 'cancelled':
        store.change_goal(g['id'], 'cancel')
    else:
        store.delete_session(g['sessionId'])
    before = store.get('goals', g['id'])
    with pytest.raises(TaskConflict):
        rework(store, before)
    assert store.get('goals', g['id']) == before and store.rework_receipts(g['id']) == []


def test_changed_upstream_requires_an_earlier_restart_and_limited_budget_is_preserved(tmp_path):
    store, g, _ = ready(tmp_path, maxIterations=8)
    first = tmp_path / g['stages'][0]['criteria'][0]['value']; first.write_text('已变更的原始依据', encoding='utf-8')
    with pytest.raises(TaskConflict, match='证据已变化'):
        rework(store, g)
    # Starting from the first stage retains no upstream and is allowed.
    result = rework(store, g, stage_id='research')
    assert result['goal']['iterations'] == 4


@pytest.mark.parametrize('patch', [{'maxIterations': 6}, {'activeSeconds': 1200}, {'toolsUsed': 40}])
def test_remaining_budget_must_cover_reset_stages(tmp_path, patch):
    store, g, _ = ready(tmp_path)
    with store.db() as db:
        g.update(patch); store._goal(db, g)
    with pytest.raises(TaskConflict, match='预算|轮次'):
        rework(store, g)
    assert store.rework_receipts(g['id']) == []


def test_atomic_receipt_and_goal_rollback(tmp_path, monkeypatch):
    store, g, _ = ready(tmp_path)
    def fail(*_):
        raise OSError('合成事务故障')
    monkeypatch.setattr(store, '_event', fail)
    with pytest.raises(OSError, match='合成事务'):
        rework(store, g)
    assert TaskStore(tmp_path).get('goals', g['id']) == g
    assert store.rework_receipts(g['id']) == []


def test_http_validation_no_admission_and_durable_history(tmp_path, monkeypatch):
    store, g, _ = ready(tmp_path)
    service = TaskService(SimpleNamespace(OUTPUTS_DIR=tmp_path))
    def forbidden(*_):
        pytest.fail('准备重做不得派发或核对模型')
    monkeypatch.setattr(service, 'admit', forbidden)
    app = FastAPI(); app.include_router(service.router())
    body = {'stageId': 'build', 'revision': 1, 'requestId': 'http-one', 'reason': '合成验收重做原因'}
    url = f"/api/tasks/goals/{g['id']}/rework"
    with TestClient(app) as client:
        assert client.post(url, json={**body, 'reason': '  '}).status_code == 422
        response = client.post(url, json=body)
        assert response.status_code == 200 and not response.json()['replayed']
        assert client.post(url, json=body).json()['replayed']
        assert client.post(url, json={**body, 'requestId': 'different'}).status_code == 409
        history = client.get(url + 's')
        assert history.headers['cache-control'] == 'no-store'
        assert len(history.json()['receipts']) == 1
        assert store.get('goals', g['id'])['status'] == 'paused'
