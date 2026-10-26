"""Labelled synthetic plans and workers; real files, transactions and scheduler."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from easel.task_rules import GoalSpec, check_goal
from easel.task_store import TaskStore, TaskConflict
from easel.task_stages import stage_for_run, check_stage, stage_prompt
from easel.task_graph import PLANNED_WORKFLOW

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from task_service import TaskService
import run_ledger


def spec(**patch):
    return GoalSpec(objective='隔离合成：核对两份材料后制作说明，独立审查并交付，不执行真实业务',
        modelRef='fixture/model', workflow=PLANNED_WORKFLOW,
        criteria=[{'type': 'review', 'label': '人工质量验收'}],
        maxIterations=patch.pop('maxIterations', 16), **patch).model_dump()


def active(outputs, **patch):
    store = TaskStore(outputs)
    g = store.create_goal(spec(**patch), session='synthetic-planned-parent')
    store.change_goal(g['id'], 'start')
    return store, store.claim('planner')


def plan(run):
    return {'contract': deepcopy(run['planContract']),
        'groups': [{'id': 'work', 'title': '本地交付', 'parentId': None},
                   {'id': 'inputs', 'title': '材料核对', 'parentId': 'work'}],
        'nodes': [
            {'id': 'facts', 'title': '核对事实', 'objective': '读取材料并记录事实', 'roleId': 'researcher',
             'groupId': 'inputs', 'dependsOn': [], 'access': 'read', 'criteria': []},
            {'id': 'constraints', 'title': '核对约束', 'objective': '读取需求并记录约束', 'roleId': 'orchestrator',
             'groupId': 'inputs', 'dependsOn': [], 'access': 'read', 'criteria': []},
            {'id': 'draft', 'title': '制作说明', 'objective': '根据材料生成本地说明', 'roleId': 'builder',
             'groupId': 'work', 'dependsOn': ['facts', 'constraints'], 'access': 'write', 'criteria': []}]}


def finish(store, pair, payload=None, verdict='pass', target='draft'):
    g, r = pair
    g = store.get('goals', g['id']); s = stage_for_run(g, r)
    text = '隔离合成：' + s['title'] + ' ' + r['turnId']
    if s.get('planGate'):
        payload = plan(r) if payload is None else payload
        text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    elif s.get('reviewGate'):
        text = json.dumps({'contract': r['reviewContract'], 'decision': verdict, 'summary': '合成审查建议，真实质量仍需人工检查',
            'targetStageId': target if verdict == 'revise' else None,
            'findings': [] if verdict == 'pass' else ['合成问题：请补充实际检查步骤']}, ensure_ascii=False)
    path = store.outputs / s['criteria'][0]['value']; path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')
    return store.finish(r['id'], owner=r['owner'], text=text,
        checks=check_goal(store.outputs, g, text)[0], stage_checks=check_stage(store.outputs, s, text)[0])


def test_planner_expands_only_after_valid_settlement_with_frozen_contract(tmp_path):
    store, pair = active(tmp_path); g, r = pair
    assert [s['id'] for s in g['stages']] == ['decompose']
    assert store.claim('premature') is None
    assert '本阶段只生成指定plan.json' in stage_prompt(g, r)
    saved = finish(store, pair)
    assert [s['id'] for s in saved['stages']] == ['decompose', 'facts', 'constraints', 'draft', 'review', 'deliver']
    assert saved['status'] == 'active' and saved['phase'] == 'queued'
    assert saved['stages'][1]['groupPath'] == ['本地交付', '材料核对']
    assert saved['taskPlan']['sourceTurnId'] == r['turnId']
    assert saved['taskPlan']['contract'] == r['planContract']
    assert store.finish(r['id'], owner=r['owner']) == saved, 'duplicate settlement never appends workers twice'


@pytest.mark.parametrize('bad', ['missing', 'old-turn', 'number-type', 'role', 'id', 'group-id', 'group-cycle',
    'group-depth', 'empty-group', 'unknown-group', 'unknown-dependency', 'self', 'cycle', 'duplicates',
    'reserved', 'case-duplicate', 'device-name', 'extra-field', 'human-review', 'path', 'handoff-path', 'empty', 'too-many', 'duplicate-json', 'oversize'])
def test_invalid_plan_never_materializes_or_dispatches_workers(tmp_path, bad):
    store, pair = active(tmp_path); payload = plan(pair[1])
    nodes = payload['nodes']; groups = payload['groups']
    if bad == 'missing': del payload['contract']
    elif bad == 'old-turn': payload['contract']['turnId'] = 'old'
    elif bad == 'number-type': payload['contract']['schemaVersion'] = True
    elif bad == 'role': nodes[0]['roleId'] = 'imaginary'
    elif bad == 'id': nodes[0]['id'] = 'bad.id'
    elif bad == 'group-id': groups[0]['id'] = 'facts'
    elif bad == 'group-cycle': groups[0]['parentId'] = 'inputs'
    elif bad == 'group-depth':
        groups.extend([{'id': 'third', 'title': '第三组', 'parentId': 'inputs'}, {'id': 'fourth', 'title': '第四组', 'parentId': 'third'}])
        nodes[0]['groupId'] = 'fourth'
    elif bad == 'empty-group': groups.append({'id': 'empty', 'title': '空分组', 'parentId': None})
    elif bad == 'unknown-group': nodes[0]['groupId'] = 'missing'
    elif bad == 'unknown-dependency': nodes[0]['dependsOn'] = ['missing']
    elif bad == 'self': nodes[0]['dependsOn'] = ['facts']
    elif bad == 'cycle': nodes[0]['dependsOn'] = ['draft']
    elif bad == 'duplicates': nodes[1]['id'] = 'facts'
    elif bad == 'case-duplicate':
        nodes[1]['id'] = 'FACTS'; nodes[2]['dependsOn'] = ['facts', 'FACTS']
    elif bad == 'device-name':
        nodes[0]['id'] = 'CON'; nodes[2]['dependsOn'] = ['CON', 'constraints']
    elif bad == 'reserved': nodes[0]['id'] = 'review'
    elif bad == 'extra-field': nodes[0]['spawn'] = True
    elif bad == 'human-review': nodes[0]['criteria'] = [{'type': 'review', 'label': '人工检查'}]
    elif bad == 'path': nodes[0]['criteria'] = [{'type': 'file', 'label': '文件', 'value': '../outside.txt'}]
    elif bad == 'handoff-path': nodes[0]['criteria'] = [{'type': 'file', 'label': '文件', 'value': f"outputs/workflows/{pair[0]['id']}/review.json"}]
    elif bad == 'empty': payload['nodes'] = []
    elif bad == 'too-many': payload['nodes'] = [*nodes, *nodes, *nodes]
    elif bad == 'duplicate-json': payload = '{"contract":{},"contract":{}}'
    elif bad == 'oversize': payload = 'x' * 65537
    saved = finish(store, pair, payload)
    assert saved['status'] == 'blocked' and saved['phase'] == 'plan_invalid'
    assert len(saved['stages']) == 1 and 'taskPlan' not in saved
    assert store.claim('should-not-run') is None


def test_remaining_iterations_limit_plan_without_resetting_original_budget(tmp_path):
    store, pair = active(tmp_path, maxIterations=4)
    assert pair[1]['planContract']['maxNodes'] == 1
    assert finish(store, pair)['phase'] == 'plan_invalid'
    values = spec(maxIterations=4); values['criteria'] = [{'type': 'text', 'label': '文字', 'value': '完成'}]
    with pytest.raises(ValidationError, match='最终质量验收'): GoalSpec.model_validate(values)


def test_parallel_reads_then_exclusive_writer_and_shared_budget(tmp_path):
    store, pair = active(tmp_path)
    payload = plan(pair[1]); payload['nodes'][2]['dependsOn'] = []
    finish(store, pair, payload)
    with ThreadPoolExecutor(6) as pool:
        admitted = [p for p in pool.map(lambda i: TaskStore(tmp_path).claim('reader-' + str(i)), range(6)) if p]
    assert {p[1]['stageId'] for p in admitted} == {'facts', 'constraints'}
    assert sum(p[1]['maxRunSeconds'] for p in admitted) <= pair[0]['maxSeconds']
    finish(store, admitted[0]); assert store.claim('write-while-reading') is None
    finish(store, admitted[1]); writer = store.claim('writer'); assert writer[1]['stageId'] == 'draft'
    assert store.claim('read-while-writing') is None
    assert '只写当前阶段交接文件' not in stage_prompt(*writer)
    finish(store, writer)
    review = store.claim('reviewer'); assert review[1]['stageId'] == 'review'
    assert review[1]['reviewContract']['allowedTargets'] == ['facts', 'constraints', 'draft']
    assert [s['stageId'] for s in review[1]['reviewContract']['inputs']][0] == 'decompose'
    finish(store, review); final = finish(store, store.claim('delivery'))
    assert final['phase'] == 'review' and final['status'] == 'blocked'
    assert final['iterations'] == 6 and final['checks'][0]['state'] == 'pending'


def test_writer_already_running_blocks_even_independent_read(tmp_path):
    store, pair = active(tmp_path); payload = plan(pair[1])
    payload['nodes'] = [payload['nodes'][2], *payload['nodes'][:2]]
    payload['nodes'][0]['dependsOn'] = []
    finish(store, pair, payload)
    writer = store.claim('writer'); assert writer[1]['stageId'] == 'draft'
    assert store.claim('reader') is None
    finish(store, writer)
    assert {store.claim('one')[1]['stageId'], store.claim('two')[1]['stageId']} == {'facts', 'constraints'}


def test_plan_expansion_and_run_settlement_roll_back_together(tmp_path, monkeypatch):
    store, pair = active(tmp_path)
    before = store.get('goals', pair[0]['id'])
    with monkeypatch.context() as patch:
        patch.setattr(store, '_goal', lambda *_: (_ for _ in ()).throw(OSError('合成事务回滚')))
        with pytest.raises(OSError, match='事务回滚'): finish(store, pair)
    assert store.get('goals', before['id']) == before
    assert store.get('runs', pair[1]['id'])['state'] == 'running'
    assert len(finish(store, pair)['stages']) == 6


def test_leaf_rework_preserves_plan_and_independent_group_metadata(tmp_path):
    store, pair = active(tmp_path); saved = finish(store, pair)
    original = deepcopy(saved['taskPlan'])
    one, two = store.claim('one'), store.claim('two')
    finish(store, one); finish(store, two); finish(store, store.claim('builder'))
    review = store.claim('reviewer'); saved = finish(store, review, verdict='revise', target='facts')
    assert saved['taskPlan'] == original and saved['autoReworksUsed'] == 1
    assert [s['id'] for s in saved['stages'] if s['status'] == 'completed'] == ['decompose', 'constraints']
    assert saved['stages'][1]['groupPath'] == ['本地交付', '材料核对']
    assert saved['stages'][1]['access'] == 'read' and saved['stages'][3]['access'] == 'write'
    assert [s['id'] for s in store.rework_receipts(saved['id'])[0]['stages']] == ['facts', 'draft', 'review', 'deliver']
    while p := store.claim('retry'): saved = finish(store, p)
    assert saved['phase'] == 'review' and saved['stages'][0]['attempts'] == 1


def test_manual_replan_archives_graph_preserves_attempts_and_remains_paused(tmp_path):
    store, pair = active(tmp_path); finish(store, pair)
    while p := store.claim('workers'): saved = finish(store, p)
    options = dict(stage_id='decompose', revision=saved['revision'], request_id='replan', reason='隔离合成：重新核对任务覆盖范围')
    result = store.rework_stage(saved['id'], **options); reset = result['goal']
    assert reset['status'] == 'paused' and [s['id'] for s in reset['stages']] == ['decompose']
    assert 'taskPlan' not in reset and result['receipt']['taskPlan'] == saved['taskPlan']
    assert reset['iterations'] == saved['iterations'] and reset['stages'][0]['attempts'] == 1
    assert store.rework_stage(saved['id'], **options)['replayed']
    assert store.claim('premature') is None
    store.change_goal(saved['id'], 'resume'); replanning = store.claim('replanner')
    assert replanning[1]['planContract']['revision'] == 2
    expanded = finish(store, replanning)
    assert expanded['stages'][0]['attempts'] == 2 and expanded['stages'][1]['attempts'] == 1
    assert store.claim('reader')[0]['stages'][1]['attempts'] == 2


def test_replanning_rollback_preserves_graph_plan_and_old_receipts(tmp_path, monkeypatch):
    store, pair = active(tmp_path); finish(store, pair)
    before = store.change_goal(pair[0]['id'], 'pause')
    with monkeypatch.context() as patch:
        patch.setattr(store, '_event', lambda *_: (_ for _ in ()).throw(OSError('合成重新规划回滚')))
        with pytest.raises(OSError, match='重新规划回滚'):
            store.rework_stage(before['id'], stage_id='decompose', revision=1, request_id='rollback', reason='隔离合成：重新规划')
    assert store.get('goals', before['id']) == before and store.rework_receipts(before['id']) == []


def test_revising_goal_retires_plan_and_keeps_human_review(tmp_path):
    store, pair = active(tmp_path); finish(store, pair); g = store.change_goal(pair[0]['id'], 'pause')
    with pytest.raises(TaskConflict, match='最终质量验收'): store.revise_goal(g['id'], '新的隔离目标', [])
    revised = store.revise_goal(g['id'], '新的隔离目标', g['criteria'])
    assert 'taskPlan' not in revised and [s['id'] for s in revised['stages']] == ['decompose']
    assert revised['iterations'] == 1 and revised['stages'][0]['attempts'] == 1


def test_paused_schedule_manual_trigger_is_idempotent_and_starts_only_planner(tmp_path):
    store = TaskStore(tmp_path)
    p = store.save_plan({'title': '隔离合成任务拆解排期', 'goal': spec(), 'enabled': False,
        'schedule': {'kind': 'daily', 'timezone': 'Asia/Shanghai', 'time': '09:00'},
        'missedPolicy': 'skip', 'freshnessSeconds': 900}, 2000000000)
    goal = store.trigger_plan(p['id'], request='synthetic-manual')
    repeated = store.trigger_plan(p['id'], request='synthetic-manual')
    assert repeated is None and goal['workflow'] == PLANNED_WORKFLOW
    assert len(store.snapshot()['goals']) == 1
    assert [s['id'] for s in goal['stages']] == ['decompose']
    assert not store.get('plans', p['id'])['enabled']
    assert store.claim('planner')[1]['stageId'] == 'decompose'


def test_minimal_ungrouped_plan_and_changed_plan_file_check(tmp_path, monkeypatch):
    store, pair = active(tmp_path, maxIterations=4); payload = plan(pair[1])
    payload['groups'] = []; payload['nodes'] = [payload['nodes'][0]]; payload['nodes'][0]['groupId'] = None
    with monkeypatch.context() as patch:
        import easel.task_planning as planning
        patch.setattr(planning, 'check_goal', lambda *_: ([{'state': 'passed', 'evidence': 'changed'}], ''))
        saved = finish(store, pair, payload)
    assert saved['phase'] == 'plan_invalid' and 'taskPlan' not in saved
    store.change_goal(saved['id'], 'cancel')
    other = tmp_path / 'other'; store, pair = active(other, maxIterations=4)
    payload = plan(pair[1]); payload['groups'] = []; payload['nodes'] = [payload['nodes'][0]]; payload['nodes'][0]['groupId'] = None
    saved = finish(store, pair, payload)
    assert len(saved['stages']) == 4 and saved['stages'][1]['groupPath'] == []


@pytest.mark.parametrize('action', ['pause', 'cancel', 'delete', 'unknown'])
def test_parent_lifecycle_fences_planner_before_expansion(tmp_path, action):
    store, pair = active(tmp_path); g, r = pair
    if action == 'delete': store.delete_session(g['sessionId'])
    elif action == 'unknown': store.finish(r['id'], owner=r['owner'], resource_settled=False)
    else: store.change_goal(g['id'], action)
    saved = finish(store, pair)
    assert len(saved['stages']) == 1 and 'taskPlan' not in saved and store.claim('late') is None


def test_service_executes_validated_plan_with_real_overlapping_synthetic_awaiters(tmp_path, monkeypatch):
    snapshots = tmp_path / 'snapshots'; snapshots.mkdir()
    web = SimpleNamespace(OUTPUTS_DIR=tmp_path, run_ledger=run_ledger, _run_ledger_root=lambda: tmp_path / 'ledger',
        _run_snapshot_file=lambda turn: snapshots / (turn + '.json'), ChatRequest=lambda **kw: SimpleNamespace(**kw))
    service = TaskService(web); store = service.store
    g = store.create_goal(spec(), session='synthetic-service-parent'); store.change_goal(g['id'], 'start')
    monkeypatch.setattr(service, 'admit', lambda *_: None)
    requested = []; live = set(); peak = [0]
    async def scenario():
        joined = asyncio.Event()
        async def start(req, **_):
            run = next(r for r in store.snapshot()['runs'] if r['turnId'] == req.turnId)
            requested.append(run['stageId']); live.add(req.turnId); peak[0] = max(peak[0], len(live))
            if run['stageId'] in ('facts', 'constraints'):
                if len(live) == 2: joined.set()
                await asyncio.wait_for(joined.wait(), 2)
            current = store.get('goals', g['id']); stage = stage_for_run(current, run)
            text = '隔离合成实际awaiter：' + req.turnId
            if stage.get('planGate'): text = json.dumps(plan(run), ensure_ascii=False)
            if stage.get('reviewGate'): text = json.dumps({'contract': run['reviewContract'], 'decision': 'pass',
                'summary': '合成建议通过，仍需人工验收', 'targetStageId': None, 'findings': []}, ensure_ascii=False)
            path = tmp_path / stage['criteria'][0]['value']; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(text, encoding='utf-8')
            web._run_snapshot_file(req.turnId).write_text(json.dumps({'turn_id': req.turnId, 'session_id': req.sessionId, 'text': text}), encoding='utf-8')
            run_ledger.create(web._run_ledger_root(), req.turnId, session_id=req.sessionId, session_key=req.sessionId)
            run_ledger.mark(web._run_ledger_root(), req.turnId, status='completed', settled=True, resource_settled=True)
            live.remove(req.turnId)
        web.start_chat_run = start
        for _ in range(8):
            await service.tick()
            if service.work: await asyncio.wait_for(asyncio.gather(*service.work), 20)
            if store.get('goals', g['id'])['phase'] == 'review': break
    asyncio.run(scenario())
    assert requested[0] == 'decompose' and set(requested[1:3]) == {'facts', 'constraints'}
    assert requested[3:] == ['draft', 'review', 'deliver']
    assert peak[0] == 2 and store.get('goals', g['id'])['phase'] == 'review'
