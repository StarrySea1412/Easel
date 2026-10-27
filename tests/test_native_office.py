"""Durable native office evidence; protocol fixtures never call a real model."""
import asyncio
from copy import deepcopy
import json
import shutil
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from easel.codex_service import CodexService
from easel.task_store import TaskStore
from tests.test_codex_tasks import Harness, spec
from tests.test_task_planning import plan

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import native_office as office
import office_controls


def saved(tmp_path, **patch):
    service = CodexService(tmp_path, lambda _: pytest.fail('Observation opened a native client'))
    service.bind('chat', 'codex')
    state = {'sessionId': 'chat', 'turn_id': 'turn', 'status': 'done', 'outcome': 'completed',
             'startedAt': 1793070000, 'text': '本轮回复', 'thinking': '本轮返回的摘要',
             'thinkingStatus': 'available', 'requestSummary': '用户明确提交的任务', 'items': [],
             'actualModel': 'gpt-5.4', **patch}
    service._persist(state)
    service._write(service.folder('chat') / 'session.json',
                   {'sessionId': 'chat', 'engine': 'codex', 'lastTurnId': 'turn'})
    return SimpleNamespace(OUTPUTS_DIR=tmp_path, _codex_service=service), state


@pytest.mark.parametrize('patch,status', [
    ({}, 'completed'), ({'outcome': 'interrupted'}, 'stopped'),
    ({'outcome': 'failed'}, 'failed'), ({'outcome': 'rejected'}, 'failed'),
    ({'outcome': 'unconfirmed'}, 'unknown'), ({'status': 'mystery'}, 'unknown'),
    ({'status': 'running', 'outcome': 'running', 'pending': {'id': 'approval'}}, 'waiting'),
    ({'status': 'running', 'outcome': 'running', 'thinkingStatus': 'waiting'}, 'thinking'),
])
def test_exact_persisted_native_process_and_conservative_status(tmp_path, patch, status):
    web, state = saved(tmp_path, **patch)
    result = office.snapshot(web, 'chat')
    agent = result['agents'][0]
    assert agent['status'] == status and agent['role'] == 'root'
    assert agent['execution'] == {'engine': 'codex', 'sessionId': 'chat', 'turnId': 'turn'}
    assert agent['process']['text'] == state['text']
    assert agent['task'] == state['requestSummary']
    assert agent['observedModel']['provider'] == 'openai'
    assert not (tmp_path / '_automation/tasks.sqlite3').exists()
    web._codex_service.close()


def test_missing_model_or_turn_never_uses_config_or_another_turn(tmp_path):
    web, state = saved(tmp_path, actualModel=None, requestedModelRef='codex/gpt-5.4')
    assert office.snapshot(web, 'chat')['agents'][0]['observedModel']['source'] == 'unknown'
    web._codex_service._state_path('chat', 'turn').unlink()
    agent = office.snapshot(web, 'chat')['agents'][0]
    assert agent['status'] == 'unknown' and 'process' not in agent
    web._codex_service._state_path('chat', 'turn').write_text('{bad PRIVATE_RECORD', encoding='utf-8')
    with pytest.raises(HTTPException) as exc:
        office.snapshot(web, 'chat')
    assert exc.value.status_code == 503 and 'PRIVATE_RECORD' not in exc.value.detail
    web._codex_service.close()


def test_event_pairing_is_scoped_and_completion_only_does_not_invent_call(tmp_path):
    web, _ = saved(tmp_path, items=[
        {'id': 'only-receipt', 'type': 'commandExecution', 'status': 'completed',
         'aggregatedOutput': 'PRIVATE_TOOL_OUTPUT', '_finishedAt': '2026-10-27T09:00:00Z'},
        {'id': 'pair', 'type': 'mcpToolCall', 'tool': 'read_file', 'status': 'completed',
         '_startedAt': '2026-10-27T09:00:01Z', '_finishedAt': '2026-10-27T09:00:02Z'},
        {'id': 'failure', 'type': 'commandExecution', 'status': 'completed', 'exitCode': 2},
    ])
    result = office.snapshot(web, 'chat')
    events = result['events']
    assert len(events) == 4 and sum(e['kind'] == 'call' for e in events) == 1
    pair = [e for e in events if e['toolName'] == 'read_file']
    assert pair[0]['operationId'] == pair[1]['operationId']
    assert events[-1]['status'] == 'failed'
    assert 'PRIVATE_TOOL_OUTPUT' not in json.dumps(result)
    web._codex_service.close()


def test_limits_and_native_control_fence_have_no_client_or_dispatch_side_effects(tmp_path, monkeypatch):
    web, state = saved(tmp_path, text='文' * 9000, thinking='摘' * 9000,
                       items=[{'id': str(i), 'type': 'commandExecution', 'status': 'completed'} for i in range(100)])
    result = office.snapshot(web, 'chat')
    assert len(result['agents'][0]['process']['text']) <= 8000
    assert result['agents'][0]['process']['truncated'] and result['warnings']
    assert len(result['events']) <= 80
    monkeypatch.setattr(office_controls, 'resolve_target', lambda *a: pytest.fail('Fell through to OpenClaw'))
    for action in ('controls', 'stop', 'model'):
        with pytest.raises(HTTPException, match='Codex 成员'):
            office_controls.operate(web, 'chat', 'turn', 'root:chat', action)
    web._codex_service.close()


def test_identity_change_and_corrupt_binding_do_not_mix_native_records(tmp_path, monkeypatch):
    web, _ = saved(tmp_path)
    original = web._codex_service.snapshot
    def changing(*args):
        value = original(*args)
        web._codex_service._write(web._codex_service.folder('chat') / 'session.json',
            {'sessionId': 'chat', 'engine': 'codex', 'lastTurnId': 'new-turn'})
        return value
    monkeypatch.setattr(web._codex_service, 'snapshot', changing)
    value = office.snapshot(web, 'chat')
    assert not value['events'] and not any(a.get('process') for a in value['agents'])
    monkeypatch.setattr(web._codex_service, 'snapshot', original)
    value = office.snapshot(web, 'chat')
    assert value['agents'][0]['status'] == 'unknown'
    web._codex_service.close()


@pytest.fixture(scope='module')
def graph(tmp_path_factory):
    root = tmp_path_factory.mktemp('native-office-graph')
    h = Harness(root)
    reviews = []
    def contents(goal, run, stage):
        if stage.get('planGate'):
            return json.dumps(plan(run))
        if stage.get('reviewGate'):
            reviews.append(run['turnId'])
            return json.dumps({'contract': run['reviewContract'], 'decision': 'revise' if len(reviews) == 1 else 'pass',
                'summary': '合成审查', 'targetStageId': 'facts' if len(reviews) == 1 else None,
                'findings': ['合成返工要求'] if len(reviews) == 1 else []})
        return '合成文件 · ' + run['turnId']
    h.content = contents
    goal = h.tasks.store.create_goal(spec(workflow='planned-reviewed-delivery', maxIterations=16,
        criteria=[{'type': 'review', 'label': '人工质量', 'value': ''}]), session='parent')
    h.tasks.store.change_goal(goal['id'], 'start')
    # Before the first claimed run there is no invented stage member.
    assert not office.snapshot(h.web, 'parent')['agents'][0].get('parentId')
    for _ in range(12):
        current = asyncio.run(h.run(goal['id']))
        if current['phase'] == 'review':
            break
    assert current['phase'] == 'review' and len(reviews) == 2
    h.codex.close()
    yield h, current


def test_graph_is_actual_scheduled_members_not_native_subagents_and_latest_rework(graph, monkeypatch):
    h, goal = graph
    before = deepcopy(h.calls)
    db_before = h.tasks.store.path.read_bytes()
    result = office.snapshot(h.web, 'parent')
    assert len(result['agents']) == 7
    root, *workers = result['agents']
    assert root['engine'] == 'scheduler' and not root.get('execution')
    assert all(w['role'] == 'worker' and w['engine'] == 'codex' for w in workers)
    assert not any(e['kind'] == 'spawn' for e in result['events'])
    assert any(link['kind'] == 'dependency' and link['delivered'] for link in result['links'])
    facts = next(w for w in workers if w['assignment']['stageId'] == 'facts')
    runs = h.tasks.store.office_context('parent')['runs']
    newest = next(r for r in runs if r['stageId'] == 'facts')
    assert facts['execution']['turnId'] == newest['turnId'] and facts['assignment']['attempts'] == 2
    assert facts['assignment']['handoff'] == 'completed' and goal['status'] == 'blocked'
    assert facts['process']['sessionId'] == newest['sessionId']
    assert office.snapshot(h.web, newest['sessionId'])['agents'][0]['execution'] == facts['execution']
    # Parent has no native binding; controls must still refuse the other engine.
    monkeypatch.setattr(office_controls, 'resolve_target', lambda *a: pytest.fail('OpenClaw control fallback'))
    with pytest.raises(HTTPException, match='Codex 成员'):
        office_controls.operate(h.web, 'parent', newest['turnId'], facts['id'], 'stop')
    assert h.calls == before and h.tasks.store.path.read_bytes() == db_before


def test_restarted_read_only_service_retains_exact_graph_and_model_unknown_alias(graph):
    h, _ = graph
    service = CodexService(h.outputs, lambda _: pytest.fail('Restart observation opened native client'))
    web = SimpleNamespace(OUTPUTS_DIR=h.outputs, _codex_service=service)
    before = office.snapshot(h.web, 'parent')
    after = office.snapshot(web, 'parent')
    assert before['agents'] == after['agents'] and before['links'] == after['links']
    assert all(a['observedModel']['provider'] == 'unknown' for a in after['agents'])
    service.close()


def test_deleted_worker_excluded_from_parent_and_deleted_parent_rejects_workers(graph, tmp_path):
    h, _ = graph
    shutil.copytree(h.outputs, tmp_path, dirs_exist_ok=True)
    store = TaskStore(tmp_path)
    service = CodexService(tmp_path)
    web = SimpleNamespace(OUTPUTS_DIR=tmp_path, _codex_service=service)
    sid = office.snapshot(web, 'parent')['agents'][1]['execution']['sessionId']
    store.delete_session(sid)
    result = office.snapshot(web, 'parent')
    assert len(result['agents']) == 6 and all(a.get('execution', {}).get('sessionId') != sid for a in result['agents'])
    with pytest.raises(HTTPException) as exc:
        office.snapshot(web, sid)
    assert exc.value.status_code == 410
    other = result['agents'][1]['execution']['sessionId']
    store.delete_session('parent')
    for session in ('parent', other):
        with pytest.raises(HTTPException) as exc:
            office.snapshot(web, session)
        assert exc.value.status_code == 410
    service.close()


def test_task_context_change_discards_sample_and_cancel_does_not_rewrite_native_completion(graph, tmp_path, monkeypatch):
    h, goal = graph
    shutil.copytree(h.outputs, tmp_path, dirs_exist_ok=True)
    store = TaskStore(tmp_path)
    service = CodexService(tmp_path)
    web = SimpleNamespace(OUTPUTS_DIR=tmp_path, _codex_service=service)
    original = service.snapshot
    changed = []
    def changing(*args):
        result = original(*args)
        if not changed:
            changed.append(True)
            store.change_goal(goal['id'], 'cancel')
        return result
    monkeypatch.setattr(service, 'snapshot', changing)
    result = office.snapshot(web, 'parent')
    assert not result['events'] and not any(a.get('process') for a in result['agents'])
    monkeypatch.setattr(service, 'snapshot', original)
    result = office.snapshot(web, 'parent')
    assert result['agents'][0]['status'] == 'stopped'
    assert all(a['status'] == 'completed' for a in result['agents'][1:])
    service.close()


def test_replanning_reused_stage_ids_cannot_label_old_process_as_new_stage(graph, tmp_path):
    h, goal = graph
    shutil.copytree(h.outputs, tmp_path, dirs_exist_ok=True)
    h2 = Harness(tmp_path)
    before = office.snapshot(h2.web, 'parent')
    facts = next(a for a in before['agents'] if a.get('assignment', {}).get('stageId') == 'facts')
    h2.tasks.store.rework_stage(goal['id'], stage_id='decompose', revision=goal['revision'],
        request_id='office-replan', reason='合成重新规划')
    # The existing decompose record is archived; the new plan has not run.
    result = office.snapshot(h2.web, 'parent')
    assert len(result['agents']) == 1 and result['agents'][0]['engine'] == 'scheduler'
    archived = office.snapshot(h2.web, facts['execution']['sessionId'])['agents'][0]
    assert archived['execution'] == facts['execution']
    assert archived['assignment']['handoff'] == 'historical'
    assert archived['assignment']['attempts'] == 0
    h2.content = lambda g, r, stage: json.dumps(plan(r))
    h2.tasks.store.change_goal(goal['id'], 'resume')
    current = asyncio.run(h2.run(goal['id']))
    result = office.snapshot(h2.web, 'parent')
    assert len(result['agents']) == 2
    assert result['agents'][1]['assignment']['stageId'] == 'decompose'
    assert not any(a.get('assignment', {}).get('stageId') == 'facts' for a in result['agents'])
    archived = office.snapshot(h2.web, facts['execution']['sessionId'])['agents'][0]
    assert archived['assignment']['handoff'] == 'historical'
    assert archived['process']['turnId'] == facts['execution']['turnId']
    h2.codex.close()


def test_deleted_and_other_engine_contexts_do_not_dispatch_or_initialize(tmp_path):
    web, _ = saved(tmp_path)
    assert office.snapshot(web, 'unbound') is None
    assert office.snapshot(web, 'legacy.chat') is None
    with pytest.raises(HTTPException) as exc:
        office.snapshot(web, '../invalid')
    assert exc.value.status_code == 400
    store = TaskStore(tmp_path)
    store.delete_session('chat')
    with pytest.raises(HTTPException) as exc:
        office.snapshot(web, 'chat')
    assert exc.value.status_code == 410
    web._codex_service.close()


def test_provider_mismatch_and_later_ordinary_turn_do_not_borrow_task_process(tmp_path):
    h = Harness(tmp_path)
    goal = h.tasks.store.create_goal(spec(), session='parent')
    h.tasks.store.change_goal(goal['id'], 'start')
    goal = asyncio.run(h.run(goal['id']))
    run = h.tasks.store.office_context('parent')['runs'][0]
    state = h.codex.snapshot('parent', run['turnId'])
    h.codex._persist({**state, 'codexTurnId': 'foreign-native-turn'})
    assert office.snapshot(h.web, 'parent')['agents'][0]['status'] == 'unknown'
    h.codex._persist({**state, 'turn_id': 'ordinary-later', 'text': '后续普通回复', 'taskGoal': None})
    h.codex._write(h.codex.folder('parent') / 'session.json',
        {'sessionId': 'parent', 'engine': 'codex', 'lastTurnId': 'ordinary-later'})
    agent = office.snapshot(h.web, 'parent')['agents'][0]
    assert agent['execution']['turnId'] == 'ordinary-later' and 'assignment' not in agent
    assert agent['process']['text'] == '后续普通回复'
    h.codex.close()


def test_actual_http_route_reads_native_and_never_falls_back_to_openclaw(tmp_path, monkeypatch):
    import app as web
    import agent_office
    local, _ = saved(tmp_path)
    monkeypatch.setattr(web, 'OUTPUTS_DIR', tmp_path)
    monkeypatch.setattr(web, '_codex_service', local._codex_service)
    monkeypatch.setattr(agent_office, 'snapshot', lambda *a, **kw: pytest.fail('OpenClaw observation fallback'))
    with TestClient(web.app, base_url='http://127.0.0.1:7860', client=('127.0.0.1', 51234)) as client:
        response = client.get('/api/agent-office?sessionId=chat')
        assert response.status_code == 200, response.text
        assert response.json()['agents'][0]['execution']['turnId'] == 'turn'
    local._codex_service.close()
