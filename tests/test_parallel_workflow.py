"""Labelled synthetic workers with real SQLite, files and overlapping awaiters."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import multiprocessing
from pathlib import Path
import sys
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from easel.task_rules import GoalSpec, check_goal
from easel.task_store import TaskStore, TaskConflict
from easel.task_stages import stage_for_run, check_stage, validate_handoffs, stage_prompt

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from task_service import TaskService
import run_ledger


def spec(**patch):
    return GoalSpec(objective='隔离合成：核对材料和约束后制作本地交付，不执行真实业务', modelRef='fixture/model',
        workflow='parallel-reviewed-delivery', criteria=[{'type':'review','label':'人工质量验收'}],
        maxIterations=patch.pop('maxIterations', 8), **patch).model_dump()


def active(tmp_path, clock=None, **patch):
    store=TaskStore(tmp_path, **({'clock':clock} if clock else {}))
    goal=store.create_goal(spec(**patch),session='synthetic-parent')
    store.change_goal(goal['id'],'start')
    return store,goal


def finish(store, goal, run, verdict='pass', target='research'):
    current=store.get('goals',goal['id']);stage=stage_for_run(current,run)
    text='隔离合成文件 '+stage['title']+' '+run['turnId']
    if stage.get('reviewGate'):
        text=json.dumps({'contract':run['reviewContract'],'decision':verdict,'summary':'合成审查：核对引用和检查步骤',
            'targetStageId':target if verdict=='revise' else None,
            'findings':['合成问题：资料分支需要补充本地检查步骤。'] if verdict!='pass' else []},ensure_ascii=False)
    path=store.outputs/stage['criteria'][0]['value'];path.parent.mkdir(parents=True,exist_ok=True);path.write_text(text,encoding='utf-8')
    return store.finish(run['id'],owner=run['owner'],text=text,checks=check_goal(store.outputs,current,text)[0],
        stage_checks=check_stage(store.outputs,stage,text)[0])


def test_two_atomic_claims_have_distinct_workers_and_join_only_after_both(tmp_path):
    store,goal=active(tmp_path)
    with ThreadPoolExecutor(8) as pool:
        pairs=[pair for pair in pool.map(lambda i:TaskStore(tmp_path).claim('worker-'+str(i)),range(8)) if pair]
    assert len(pairs)==2
    runs={r['stageId']:(g,r) for g,r in pairs}
    assert set(runs)=={'research','plan'}
    assert len({r['sessionId'] for _,r in pairs})==2
    assert all(r['parentSessionId']==goal['sessionId'] and r['sessionId']!=goal['sessionId'] for _,r in pairs)
    assert sum(r['maxRunSeconds'] for _,r in pairs)==goal['maxSeconds']
    assert len(store.snapshot(goal['sessionId'])['runs'])==2
    with pytest.raises(TaskConflict):store.reserve_chat(goal['sessionId'],'human')
    finish(store,*runs['plan'])
    assert store.claim('third') is None
    saved=finish(store,*runs['research'])
    assert saved['status']=='active'
    g,r=store.claim('third');assert r['stageId']=='build'
    assert '约束与验收' in stage_prompt(g,r)
    assert '只写当前阶段交接文件' not in stage_prompt(g,r), 'builder must be allowed to implement the authorized artifacts'
    assert len(store.session_state()['sessions'])==1,'internal worker contexts do not clutter the conversation list'


def _claim_in_process(outputs, barrier, results, owner):
    barrier.wait(timeout=20)
    results.put(TaskStore(outputs).claim(owner))


def test_separate_processes_share_two_worker_admission(tmp_path):
    store,goal=active(tmp_path)
    context=multiprocessing.get_context('spawn')
    barrier=context.Barrier(4);results=context.Queue()
    processes=[context.Process(target=_claim_in_process,args=(str(tmp_path),barrier,results,'process-'+str(i))) for i in range(4)]
    try:
        for process in processes:process.start()
        pairs=[results.get(timeout=30) for _ in processes]
        for process in processes:
            process.join(timeout=10)
            assert process.exitcode==0
        admitted=[pair for pair in pairs if pair]
        assert {r['stageId'] for _,r in admitted}=={'research','plan'} and len(admitted)==2
        assert len(store.snapshot(goal['sessionId'])['runs'])==2
    finally:
        for process in processes:
            if process.is_alive():process.terminate();process.join()
        results.close()


def test_independent_steps_shared_tool_budget_and_own_time_allowance(tmp_path):
    now=[100.0];store,goal=active(tmp_path,clock=lambda:now[0],maxSeconds=120,maxTools=4)
    one,two=store.claim('one'),store.claim('two')
    for i,(g,r) in enumerate((one,two)):
        provider='synthetic-'+r['stageId'];store.bind_provider(r['sessionId'],r['turnId'],provider)
        assert store.guard(r['sessionId'],provider,'progress','easel_goal_update')['allowed']
        store.update_progress(r['sessionId'],'progress',[{'id':'one','title':'独立步骤'+str(i),'status':'completed'}])
        assert store.guard(r['sessionId'],provider,'read','read')['allowed']
    saved=store.get('goals',goal['id'])
    assert saved['toolsUsed']==4
    assert [s['steps'][0]['title'] for s in saved['stages'][:2]]==['独立步骤0','独立步骤1']
    assert not saved.get('steps')
    now[0]=161
    assert not store.guard(one[1]['sessionId'],'synthetic-research','late','read')['allowed']


def test_unused_reserved_time_returns_to_the_joined_stage(tmp_path):
    now=[100.0];store,goal=active(tmp_path,clock=lambda:now[0],maxSeconds=120)
    one,two=store.claim('one'),store.claim('two')
    now[0]=110;finish(store,*one)
    now[0]=120;finish(store,*two)
    g,r=store.claim('joined')
    assert g['activeSeconds']==30 and r['maxRunSeconds']==90
    assert r['stageId']=='build'


@pytest.mark.parametrize('action',['pause','cancel','delete','failure'])
def test_parent_action_fences_both_workers_and_late_peer_preserves_cause(tmp_path,action):
    store,goal=active(tmp_path);one,two=store.claim('one'),store.claim('two')
    if action=='delete':store.delete_session(goal['sessionId'])
    elif action=='failure':store.finish(one[1]['id'],owner='one',state='failed',reason='合成资料失败')
    else:store.change_goal(goal['id'],action)
    for g,r in (one,two):
        provider='synthetic-'+r['stageId'];store.bind_provider(r['sessionId'],r['turnId'],provider)
        assert not store.guard(r['sessionId'],provider,'late','read')['allowed']
    saved=finish(store,*two)
    assert saved['status']==('cancelled' if action in ('delete','cancel') else 'blocked' if action=='failure' else 'paused')
    if action=='failure':assert saved['phase']=='run_failed' and saved['reason']=='合成资料失败'
    assert store.claim('late') is None
    if action=='delete':
        with pytest.raises(TaskConflict):store.require_session(two[1]['sessionId'])


def test_graph_rework_preserves_independent_branch_and_rechecks_every_completed_input(tmp_path):
    store,goal=active(tmp_path);one,two=store.claim('one'),store.claim('two')
    finish(store,*two);finish(store,*one)
    g,r=store.claim('build');finish(store,g,r)
    g,r=store.claim('review');saved=finish(store,g,r,'revise')
    assert saved['revision']==2 and saved['autoReworksUsed']==1
    assert [s['id'] for s in saved['stages'] if s['status']=='completed']==['plan']
    receipt=store.rework_receipts(goal['id'])[0]
    assert [s['id'] for s in receipt['stages']]==['research','build','review','deliver']
    validate_handoffs(tmp_path,saved)
    path=tmp_path/saved['stages'][1]['criteria'][0]['value'];path.write_text('合成资料已变化',encoding='utf-8')
    with pytest.raises(ValueError,match='证据已变化'):validate_handoffs(tmp_path,saved)
    path.write_text('隔离合成文件 '+saved['stages'][1]['title']+' '+two[1]['turnId'],encoding='utf-8')
    for _ in range(4):
        g,r=store.claim('retry');saved=finish(store,g,r)
    assert saved['phase']=='review' and saved['iterations']==8
    assert saved['stages'][1]['attempts']==1
    assert store.claim('more') is None


def test_restart_keeps_unknown_workers_and_blocks_new_dispatch(tmp_path):
    now=[100.0];store,goal=active(tmp_path,clock=lambda:now[0])
    store.claim('one');store.claim('two');now[0]=200
    restarted=TaskStore(tmp_path,clock=lambda:now[0])
    assert restarted.claim('new') is None
    assert {r['state'] for r in restarted.running()}=={'unconfirmed'}
    assert restarted.get('goals',goal['id'])['phase']=='unconfirmed'
    with pytest.raises(TaskConflict):restarted.change_goal(goal['id'],'resume')


def test_manual_graph_rework_rolls_back_and_preserves_independent_receipt(tmp_path,monkeypatch):
    store,goal=active(tmp_path,maxIterations=12)
    one,two=store.claim('one'),store.claim('two')
    finish(store,*one);finish(store,*two)
    for _ in range(3):g,r=store.claim('later');finish(store,g,r)
    saved=store.get('goals',goal['id'])
    plan=saved['stages'][1]
    options=dict(stage_id='research',revision=1,request_id='manual-graph',reason='隔离合成：重新核对资料分支')
    with monkeypatch.context() as patch:
        def fail(*_):raise OSError('合成事务中断')
        patch.setattr(store,'_event',fail)
        with pytest.raises(OSError,match='合成事务'):store.rework_stage(goal['id'],**options)
    assert store.get('goals',goal['id'])==saved and store.rework_receipts(goal['id'])==[]
    result=store.rework_stage(goal['id'],**options)
    assert result['goal']['stages'][1]==plan and result['goal']['status']=='paused'
    assert [s['id'] for s in result['receipt']['stages']]==['research','build','review','deliver']
    assert store.rework_stage(goal['id'],**options)['replayed']
    assert all(result['goal'][key]==saved[key] for key in ('iterations','activeSeconds','toolsUsed','imagesUsed'))
    validate_handoffs(tmp_path,result['goal'])
    assert store.claim('premature') is None
    store.change_goal(goal['id'],'resume')
    g,r=store.claim('resumed');assert r['stageId']=='research'
    assert '只写当前阶段交接文件' in stage_prompt(g,r)
    assert store.claim('independent-already-done') is None


def test_parent_delete_stops_exact_worker_identities_over_http(tmp_path):
    store,goal=active(tmp_path);pairs=[store.claim('one'),store.claim('two')];stops=[]
    async def stop(req):stops.append((req.sessionId,req.turnId))
    service=TaskService(SimpleNamespace(OUTPUTS_DIR=tmp_path,api_chat_stop=stop,StopRequest=lambda **kw:SimpleNamespace(**kw)))
    app=FastAPI();app.include_router(service.router())
    with TestClient(app) as client:
        response=client.post('/api/tasks/sessions/'+goal['sessionId']+'/delete')
        assert response.status_code==200 and response.json()['stopPending']
    assert set(stops)=={(r['sessionId'],r['turnId']) for _,r in pairs}
    assert len(stops)==2


def test_task_service_starts_overlapping_workers_then_joins_and_awaits_human(tmp_path,monkeypatch):
    ledger=tmp_path/'ledger';snapshots=tmp_path/'snapshots';snapshots.mkdir()
    web=SimpleNamespace(OUTPUTS_DIR=tmp_path,run_ledger=run_ledger,_run_ledger_root=lambda:ledger,
        _run_snapshot_file=lambda turn:snapshots/(turn+'.json'),ChatRequest=lambda **kw:SimpleNamespace(**kw))
    service=TaskService(web);store=service.store;goal=store.create_goal(spec(),session='synthetic-parent')
    store.change_goal(goal['id'],'start');requests=[];peak=[0];live=set()
    monkeypatch.setattr(service,'admit',lambda *_:None)
    async def scenario():
        joined=asyncio.Event()
        async def start(req,**_):
            run=next(r for r in store.snapshot()['runs'] if r['turnId']==req.turnId)
            requests.append(run['stageId']);live.add(req.turnId);peak[0]=max(peak[0],len(live))
            if run['stageId'] in ('research','plan'):
                if len(live)==2:joined.set()
                await asyncio.wait_for(joined.wait(),2)
            g=store.get('goals',goal['id']);stage=stage_for_run(g,run)
            text='隔离合成产物 '+run['turnId']
            if stage.get('reviewGate'):
                text=json.dumps({'contract':run['reviewContract'],'decision':'pass','summary':'合成建议通过，仍需人工验收','targetStageId':None,'findings':[]},ensure_ascii=False)
            path=tmp_path/stage['criteria'][0]['value'];path.parent.mkdir(parents=True,exist_ok=True);path.write_text(text,encoding='utf-8')
            web._run_snapshot_file(req.turnId).write_text(json.dumps({'turn_id':req.turnId,'session_id':req.sessionId,'text':text}),encoding='utf-8')
            run_ledger.create(ledger,req.turnId,session_id=req.sessionId,session_key=req.sessionId)
            run_ledger.mark(ledger,req.turnId,status='completed',settled=True,resource_settled=True)
            live.remove(req.turnId)
        web.start_chat_run=start
        for _ in range(6):
            await service.tick()
            # SQLite may wait up to 15s for a writer on a busy Windows runner.
            # Overlap is established by the barrier above, not a timing guess.
            if service.work:await asyncio.wait_for(asyncio.gather(*service.work),20)
            if store.get('goals',goal['id'])['phase']=='review':break
    asyncio.run(scenario())
    assert peak[0]==2 and set(requests[:2])=={'research','plan'}
    assert requests[2:]==['build','review','deliver']
    saved=store.get('goals',goal['id'])
    assert saved['phase']=='review' and saved['status']=='blocked' and saved['checks'][0]['state']=='pending'
