"""Evidence, continuation and review regressions; temporary data, no model calls."""
import asyncio
import json
from pathlib import Path
import sys
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from easel.task_rules import GoalSpec, check_goal
from easel.task_store import TaskStore, TaskConflict

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from task_service import TaskService
import run_ledger


def spec(**patch):
    return GoalSpec(objective='准备可验收的素材文件', modelRef='fixture/model', criteria=[
        {'type': 'file', 'label': '素材', 'value': 'draft.txt'},
        {'type': 'review', 'label': '检查质量'},
    ], **patch).model_dump()


def claim(store, goal, provider='provider'):
    store.change_goal(goal['id'], 'start')
    g, r = store.claim('worker')
    store.bind_provider(g['sessionId'], r['turnId'], provider)
    return g, r


def test_rephrased_output_and_step_details_do_not_reset_progress(tmp_path):
    g = spec()
    g['criteria'].insert(0, {'type': 'text', 'label': '包含依据', 'value': '真实依据'})
    g['steps'] = [{'id': 'draft', 'title': '处理材料', 'status': 'in_progress', 'detail': '开始'}]
    checks, first = check_goal(tmp_path, g, '还在处理')
    g['steps'][0].update(title='继续处理材料', detail='继续努力')
    g['steps'].append({'id': 'later', 'title': '新计划', 'status': 'pending'})
    _, rephrased = check_goal(tmp_path, g, '准备继续处理材料')
    assert first == rephrased
    # Actual content hashes stay available for audit, independent of progress.
    assert checks[0]['evidence'] != check_goal(tmp_path, g, '改了文案')[0][0]['evidence']
    _, passed = check_goal(tmp_path, g, '真实依据')
    assert passed != first
    assert check_goal(tmp_path, g, '真实依据；补充一句')[1] == passed
    g['steps'][0]['status'] = 'completed'
    assert check_goal(tmp_path, g, '真实依据')[1] != passed


def test_real_file_changes_are_still_progress(tmp_path):
    g = spec()
    missing = check_goal(tmp_path, g, '')[1]
    (tmp_path / 'draft.txt').write_text('实际素材', encoding='utf-8')
    first = check_goal(tmp_path, g, '')[1]
    (tmp_path / 'draft.txt').write_text('修改后的实际素材', encoding='utf-8')
    assert first != missing and check_goal(tmp_path, g, '')[1] != first


@pytest.mark.parametrize('state', ['failed', 'stopped'])
def test_failed_or_stopped_round_cannot_be_approved_by_api(tmp_path, state):
    marker = tmp_path / 'turn.json'
    web = SimpleNamespace(OUTPUTS_DIR=tmp_path)
    service = TaskService(web)
    store = service.store
    g = store.create_goal(spec(), session='chat')
    _, r = claim(store, g)
    (tmp_path / 'draft.txt').write_text('失败轮留下的文件', encoding='utf-8')
    checks, fingerprint = check_goal(tmp_path, g, 'partial')
    store.finish(r['id'], owner='worker', state=state, checks=checks, fingerprint=fingerprint)
    app = FastAPI(); app.include_router(service.router())
    with TestClient(app) as client:
        for action in ('recheck', 'approve'):
            response = client.post(f"/api/tasks/goals/{g['id']}/action", json={'action': action})
            assert response.status_code == 409
            assert '成功结束' in response.json()['detail']
    saved = store.get('goals', g['id'])
    if state == 'stopped':
        # Interruptions pause the objective instead of failing it.
        assert saved['status'] == 'paused' and saved['phase'] == 'idle'
    else:
        assert saved['phase'] == 'run_failed' and saved['status'] == 'blocked'
    assert not saved.get('reviewedTurnId')
    assert not marker.exists()


def test_partial_checks_cannot_omit_required_human_review(tmp_path):
    store = TaskStore(tmp_path)
    g = store.create_goal(spec(), session='chat'); _, r = claim(store, g)
    (tmp_path / 'draft.txt').write_text('actual', encoding='utf-8')
    checks, _ = check_goal(tmp_path, g, '')
    result = store.finish(r['id'], owner='worker', checks=checks[:1])
    assert result['status'] == 'blocked' and result['phase'] == 'verification_error'
    with pytest.raises(TaskConflict, match='完整'):
        store.apply_checks(g['id'], checks[:1], review=r['turnId'])
    with pytest.raises(TaskConflict, match='轮次'):
        store.apply_checks(g['id'], checks, review='stale-turn')
    checks[-1]['state'] = 'passed'
    assert store.apply_checks(g['id'], checks, review=r['turnId'])['status'] == 'completed'


def test_recheck_error_blocks_and_never_approves_quality(tmp_path):
    store = TaskStore(tmp_path)
    g = store.create_goal(spec(), session='chat'); _, r = claim(store, g)
    (tmp_path / 'draft.txt').write_text('actual', encoding='utf-8')
    checks, _ = check_goal(tmp_path, g, '')
    store.finish(r['id'], owner='worker', checks=checks)
    broken = [{**checks[0], 'state': 'error'}, checks[1]]
    result = store.apply_checks(g['id'], broken, review=r['turnId'])
    assert result['phase'] == 'verification_error' and not result.get('reviewedTurnId')
    # A caller cannot pass a review without the explicit confirmation receipt.
    checks[-1]['state'] = 'passed'
    with pytest.raises(TaskConflict, match='确认'):
        store.apply_checks(g['id'], checks)


def test_only_progress_tools_do_not_keep_continuation_running(tmp_path):
    store = TaskStore(tmp_path)
    g = store.create_goal(spec(), session='chat'); _, first = claim(store, g)
    checks, fingerprint = check_goal(tmp_path, g, '')
    assert store.finish(first['id'], owner='worker', checks=checks, fingerprint=fingerprint)['status'] == 'active'
    _, second = store.claim('worker')
    store.bind_provider('chat', second['turnId'], 'second-provider')
    assert store.guard('chat', 'second-provider', 'progress', 'easel_goal_update')['allowed']
    store.update_progress('chat', 'progress', [{'id': 'a', 'title': '仍在处理', 'status': 'in_progress'}])
    g = store.get('goals', g['id'])
    checks, fingerprint = check_goal(tmp_path, g, '换了说法，文件仍未产生')
    result = store.finish(second['id'], owner='worker', checks=checks, fingerprint=fingerprint)
    assert result['status'] == 'blocked' and result['phase'] == 'no_progress'
    assert '工作工具' in result['reason']
    assert store.claim('another-worker') is None
    assert len(store.snapshot()['runs']) == 2


def test_work_tool_admission_is_durable_idempotent_and_per_round(tmp_path):
    store = TaskStore(tmp_path)
    g = store.create_goal(spec(), session='chat'); _, r = claim(store, g)
    for call, tool in [('read', 'read'), ('read', 'read'), ('status', 'easel_task_guard'), ('plan', 'easel_goal_update'), ('checklist', 'easel_plan_update')]:
        assert store.guard('chat', 'provider', call, tool)['allowed']
    assert not store.guard('chat', 'wrong-provider', 'wrong', 'read')['allowed']
    assert TaskStore(tmp_path).get('runs', r['id'])['workTools'] == 1
    checks, fingerprint = check_goal(tmp_path, g, '')
    store.finish(r['id'], owner='worker', checks=checks, fingerprint=fingerprint)
    _, next_run = store.claim('worker')
    assert next_run['workTools'] == 0
    store.bind_provider('chat', next_run['turnId'], 'new-provider')
    assert store.guard('chat', 'new-provider', 'read', 'read')['allowed']
    result = store.finish(next_run['id'], owner='worker', checks=checks, fingerprint=fingerprint)
    assert result['status'] == 'active'


def test_text_only_goal_can_complete_without_work_tools(tmp_path):
    store = TaskStore(tmp_path)
    g = store.create_goal({**spec(), 'criteria': [{'type': 'text', 'label': '结论', 'value': '完成'}]}, session='chat')
    _, r = claim(store, g)
    checks, fingerprint = check_goal(tmp_path, g, '完成')
    assert store.finish(r['id'], owner='worker', checks=checks, fingerprint=fingerprint)['status'] == 'completed'


def test_worker_stops_rephrasing_after_one_automatic_followup(tmp_path, monkeypatch):
    ledger = tmp_path / 'ledger'
    web = SimpleNamespace(OUTPUTS_DIR=tmp_path, run_ledger=run_ledger, _run_ledger_root=lambda: ledger,
                          _turn_file=lambda _: tmp_path / 'turn.json', ChatRequest=lambda **kw: SimpleNamespace(**kw))
    service = TaskService(web)
    monkeypatch.setattr(service, 'admit', lambda *_: None)
    monkeypatch.setattr(service, 'config_hash', lambda: 'unchanged')
    dispatched = []
    async def start(req, **kw):
        dispatched.append(req)
        web._turn_file('').write_text(json.dumps({'turn_id': req.turnId, 'text': f'正在努力 {len(dispatched)}'}))
        run_ledger.create(ledger, req.turnId, session_id=req.sessionId, session_key=req.sessionId)
        run_ledger.mark(ledger, req.turnId, status='completed', settled=True, resource_settled=True)
    web.start_chat_run = start
    g = service.store.create_goal(spec(), session='chat'); service.store.change_goal(g['id'], 'start')
    async def run():
        for _ in range(4):
            pair = service.store.claim(service.owner)
            if pair:
                await service.execute(*pair)
    asyncio.run(run())
    assert len(dispatched) == 2
    assert service.store.get('goals', g['id'])['phase'] == 'no_progress'
