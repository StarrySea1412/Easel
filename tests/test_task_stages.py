"""Exercise durable specialization on the real goal scheduler with a fake model.

The fixture writes actual deliverables; no provider, network, or paid calls.
"""
import asyncio
import json
from pathlib import Path
import sys
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from pydantic import ValidationError

from easel.task_rules import GoalSpec, check_goal
from easel.task_store import TaskStore, TaskConflict
from easel.task_stages import current_stage, check_stage, validate_handoffs

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from task_service import TaskService
import run_ledger


def spec(**patch):
    return GoalSpec(objective='核对研究依据并交付实际方案文件', modelRef='fixture/model',
                    criteria=[{'type': 'review', 'label': '检查实际质量'}],
                    workflow='research-delivery', **patch).model_dump()


def finish_stage(store, g, r, content='本阶段实际产物'):
    stage = current_stage(g)
    for c in stage['criteria']:
        p = store.outputs / c['value']; p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding='utf-8')
    checks, fingerprint = check_goal(store.outputs, g, content)
    return store.finish(r['id'], owner=r['owner'], text=content, checks=checks, fingerprint=fingerprint,
                        stage_checks=check_stage(store.outputs, stage, content)[0])


def test_templates_use_unique_artifacts_and_immutable_role_receipts(tmp_path):
    store = TaskStore(tmp_path)
    g = store.create_goal(spec(), session='one')
    other = store.create_goal(spec(), session='two')
    paths = {s['criteria'][0]['value'] for s in g['stages']}
    assert len(paths) == 4 and paths.isdisjoint(s['criteria'][0]['value'] for s in other['stages'])
    store.change_goal(g['id'], 'start'); _, r = store.claim('worker')
    assert r['roleId'] == 'researcher' and r['role']['outputs']
    saved = TaskStore(tmp_path).get('runs', r['id'])
    r['role']['outputs'].clear()
    assert saved['role']['outputs']


def test_no_file_or_partial_evidence_cannot_advance_or_be_approved(tmp_path):
    store = TaskStore(tmp_path); g = store.create_goal(spec(), session='one')
    store.change_goal(g['id'], 'start'); g, r = store.claim('worker')
    result = store.finish(r['id'], owner='worker', text='我已完成', checks=check_goal(tmp_path, g, '')[0], stage_checks=[])
    assert result['phase'] == 'handoff_failed' and result['stages'][0]['status'] == 'blocked'
    assert store.claim('other') is None
    with pytest.raises(TaskConflict, match='阶段'):
        store.apply_checks(g['id'], [{**g['criteria'][0], 'state': 'passed'}], review=r['turnId'])


def test_four_actual_specialist_turns_use_ledger_and_wait_for_human_review(tmp_path, monkeypatch):
    ledger = tmp_path / 'ledger'
    web = SimpleNamespace(OUTPUTS_DIR=tmp_path, run_ledger=run_ledger, _run_ledger_root=lambda: ledger,
                          _turn_file=lambda _: tmp_path / 'turn.json', ChatRequest=lambda **kw: SimpleNamespace(**kw))
    service = TaskService(web); store = service.store
    monkeypatch.setattr(service, 'admit', lambda *_: None)
    requests = []
    async def start(req, **_):
        requests.append(req)
        g = store.snapshot()['goals'][0]; stage = current_stage(g)
        assert stage['roleId'] == req.roleId
        assert stage['criteria'][0]['value'] in req.message
        if len(requests) > 1:
            assert '<easel_handoff_data>' in req.message and requests[-2].turnId in req.message
        path = tmp_path / stage['criteria'][0]['value']; path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('实际阶段结果 ' + stage['id'], encoding='utf-8')
        web._turn_file('').write_text(json.dumps({'turn_id': req.turnId, 'text': stage['title']}), encoding='utf-8')
        run_ledger.create(ledger, req.turnId, session_id=req.sessionId, session_key=req.sessionId, role_id=req.roleId)
        run_ledger.mark(ledger, req.turnId, status='completed', settled=True, resource_settled=True)
    web.start_chat_run = start
    g = store.create_goal(spec(), session='one'); store.change_goal(g['id'], 'start')
    async def run():
        for _ in range(5):
            pair = store.claim(service.owner)
            if pair:
                await service.execute(*pair)
    asyncio.run(run())
    saved = TaskStore(tmp_path).get('goals', g['id'])
    assert [r.roleId for r in requests] == ['researcher', 'builder', 'reviewer', 'publisher']
    assert len({r.turnId for r in requests}) == 4
    assert all(s['status'] == 'completed' and s['checks'][0]['evidence'] for s in saved['stages'])
    assert saved['phase'] == 'review' and saved['status'] == 'blocked'
    app = FastAPI(); app.include_router(service.router())
    with TestClient(app) as client:
        response = client.post(f"/api/tasks/goals/{g['id']}/action", json={'action': 'approve'})
        assert response.status_code == 200 and response.json()['status'] == 'completed'
        first = tmp_path / saved['stages'][0]['criteria'][0]['value']; first.write_text('changed', encoding='utf-8')
        assert client.post(f"/api/tasks/goals/{g['id']}/action", json={'action': 'recheck'}).status_code == 409
    assert store.get('goals', g['id'])['phase'] == 'evidence_changed'


def test_unchanged_previous_file_is_not_new_stage_work(tmp_path):
    store = TaskStore(tmp_path); g = store.create_goal(spec(), session='one')
    path = tmp_path / g['stages'][0]['criteria'][0]['value']; path.parent.mkdir(parents=True)
    path.write_text('preexisting', encoding='utf-8')
    store.change_goal(g['id'], 'start'); g, r = store.claim('worker')
    result = finish_stage(store, g, r, content='preexisting')
    assert result['phase'] == 'handoff_failed'


def test_changed_handoff_blocks_next_provider_dispatch(tmp_path, monkeypatch):
    store = TaskStore(tmp_path); g = store.create_goal(spec(), session='one')
    store.change_goal(g['id'], 'start'); g, r = store.claim('worker')
    g = finish_stage(store, g, r)
    assert g['status'] == 'active' and g['stages'][0]['status'] == 'completed'
    path = tmp_path / g['stages'][0]['criteria'][0]['value']; path.unlink()
    with pytest.raises(ValueError, match='证据'):
        validate_handoffs(tmp_path, g)
    web = SimpleNamespace(OUTPUTS_DIR=tmp_path, run_ledger=run_ledger, _run_ledger_root=lambda: tmp_path / 'ledger')
    service = TaskService(web); monkeypatch.setattr(service, 'admit', lambda *_: None)
    pair = store.claim(service.owner)
    asyncio.run(service.execute(*pair))
    assert store.get('goals', g['id'])['status'] == 'blocked'
    assert '证据已变化' in store.get('goals', g['id'])['reason']


def test_stop_fence_and_restart_uncertainty_prevent_handoff_and_replay(tmp_path):
    now = [1000]; store = TaskStore(tmp_path, clock=lambda: now[0])
    g = store.create_goal(spec(), session='one'); store.change_goal(g['id'], 'start')
    g, r = store.claim('worker'); store.change_goal(g['id'], 'stop')
    result = finish_stage(store, g, r)
    assert result['status'] == 'paused' and result['stages'][0]['status'] != 'completed'
    store.change_goal(g['id'], 'resume'); _, second = store.claim('worker')
    now[0] += 91
    assert store.claim('another') is None
    assert store.running()[0]['state'] == 'unconfirmed'
    assert len(store.snapshot()['runs']) == 2 and second['stageId'] == r['stageId']


def test_stage_specs_reject_unknown_roles_duplicate_ids_and_insufficient_budget():
    for patch in ({'maxIterations': 3}, {'workflow': 'invented'}):
        with pytest.raises(ValidationError):
            GoalSpec.model_validate({**spec(), **patch})
    stage = {'id': 'one', 'title': '阶段', 'objective': '真实交付内容', 'roleId': 'invented',
             'criteria': [{'type': 'text', 'label': '结果', 'value': '实际结果'}]}
    with pytest.raises(ValidationError):
        GoalSpec.model_validate({**spec(), 'workflow': None, 'stages': [stage]})
    stage['roleId'] = 'researcher'
    with pytest.raises(ValidationError):
        GoalSpec.model_validate({**spec(), 'workflow': None, 'stages': [stage, stage]})


def test_final_criteria_failure_cannot_dispatch_a_turn_without_a_stage(tmp_path):
    store = TaskStore(tmp_path)
    goal_spec = spec(maxIterations=8)
    goal_spec['criteria'].insert(0, {'type': 'file', 'label': '最终作品', 'value': 'final/actual.md'})
    g = store.create_goal(goal_spec, session='one'); store.change_goal(g['id'], 'start')
    for _ in range(4):
        g, r = store.claim('worker'); g = finish_stage(store, g, r)
    assert g['phase'] == 'final_checks' and g['status'] == 'blocked'
    assert store.claim('worker') is None
    store.change_goal(g['id'], 'resume'); g, r = store.claim('worker')
    assert r['stageId'] == 'deliver' and r['roleId'] == 'publisher'


def test_historical_handoff_recheck_cannot_replace_a_later_goal(tmp_path):
    store = TaskStore(tmp_path)
    g = store.create_goal(spec(maxIterations=8), session='one'); store.change_goal(g['id'], 'start')
    for _ in range(4):
        g, r = store.claim('worker'); g = finish_stage(store, g, r)
    checks, _ = check_goal(tmp_path, g, '', reviewed=True)
    store.apply_checks(g['id'], checks, review=r['turnId'])
    new_goal = store.create_goal(spec(), session='one')
    with pytest.raises(TaskConflict, match='后续目标'):
        store.invalidate_handoff(g['id'], '旧文件被修改')
    assert store.get('goals', new_goal['id'])['status'] == 'draft'
    assert store.get('goals', g['id'])['status'] == 'completed'
