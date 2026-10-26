"""Bounded review loops using labelled synthetic decisions and real local files."""
import asyncio
from copy import deepcopy
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from easel.task_rules import GoalSpec, check_goal
from easel.task_stages import current_stage, check_stage
from easel.task_store import TaskStore, TaskConflict

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from task_service import TaskService
import run_ledger


def spec(**patch):
    return GoalSpec(objective='隔离合成：制作本地说明并审查可核验内容', modelRef='fixture/model',
        criteria=[{'type':'review','label':'用户检查质量'}], workflow='reviewed-delivery',
        maxIterations=patch.pop('maxIterations', 8), **patch).model_dump()


def decision(run, verdict='pass', target='build'):
    return {'contract': deepcopy(run['reviewContract']), 'decision': verdict,
            'summary': '合成审查：' + {'pass':'建议通过，仍需人工质量检查', 'revise':'制作说明缺少检查步骤', 'blocked':'缺少可核验原材料'}[verdict],
            'targetStageId': target if verdict=='revise' else None,
            'findings': [] if verdict=='pass' else ['隔离合成：请补充本地说明文件的实际检查步骤。']}


def finish(store, goal, run, payload=None):
    stage = current_stage(goal)
    text = '隔离合成产物 ' + stage['id'] + ' ' + run['turnId']
    path = store.outputs / stage['criteria'][0]['value'];path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False) if stage.get('reviewGate') else text, encoding='utf-8')
    return store.finish(run['id'], owner=run['owner'], text=text, checks=check_goal(store.outputs,goal,text)[0],
        stage_checks=check_stage(store.outputs,stage,text)[0])


def at_review(outputs, **patch):
    store=TaskStore(outputs);goal=store.create_goal(spec(**patch),session='review-synthetic')
    store.change_goal(goal['id'],'start')
    for _ in range(2):
        g,r=store.claim('worker');finish(store,g,r)
    g,r=store.claim('worker')
    assert r['stageId']=='review'
    return store,g,r


def test_new_protocol_freezes_review_inputs_and_old_workflow_stays_ungated(tmp_path):
    store,g,r=at_review(tmp_path)
    assert g['stages'][2]['criteria'][0]['value'].endswith('/review.json')
    contract=r['reviewContract']
    assert contract['goalId']==g['id'] and contract['turnId']==r['turnId'] and contract['revision']==1
    assert contract['allowedTargets']==['research','build']
    assert contract['inputs'][1]['checks'][0]['evidence']==g['stages'][1]['checks'][0]['evidence']
    old_spec=spec();old_spec['workflow']='research-delivery'
    old=store.create_goal(old_spec,session='old-synthetic')
    assert not any(stage.get('reviewGate') for stage in old['stages'])
    assert old['stages'][2]['criteria'][0]['value'].endswith('/review.md')


def test_reviewed_protocol_keeps_human_acceptance_on_creation_and_revision(tmp_path):
    values=spec();values['criteria']=[{'type':'text','label':'结果','value':'已完成'}]
    with pytest.raises(ValidationError,match='最终质量验收'):
        GoalSpec.model_validate(values)
    store,g,r=at_review(tmp_path)
    store.change_goal(g['id'],'pause');store.finish(r['id'],owner='worker',state='stopped')
    with pytest.raises(TaskConflict,match='最终质量验收'):
        store.revise_goal(g['id'],g['objective'],values['criteria'])


def test_unconfirmed_review_settlement_does_not_automatically_return_work(tmp_path):
    store,g,r=at_review(tmp_path)
    stage=current_stage(g);path=tmp_path/stage['criteria'][0]['value']
    path.write_text(json.dumps(decision(r,'revise'),ensure_ascii=False),encoding='utf-8')
    checks=check_stage(tmp_path,stage,'')[0]
    store.finish(r['id'],owner='worker',resource_settled=False,stage_checks=checks)
    assert store.get('runs',r['id'])['state']=='unconfirmed' and not store.rework_receipts(g['id'])
    saved=store.finish(r['id'],owner='worker',state='completed',stage_checks=checks)
    assert saved['status']=='blocked' and not saved.get('autoReworksUsed')
    assert store.claim('another') is None


def test_reviewer_can_return_to_first_upstream_stage(tmp_path):
    store,g,r=at_review(tmp_path)
    saved=finish(store,g,r,decision(r,'revise',target='research'))
    assert saved['revision']==2 and all(s['status']=='pending' for s in saved['stages'])
    receipt=store.rework_receipts(g['id'])[0]
    assert receipt['stages'][0]['id']=='research'
    _,run=store.claim('worker')
    assert run['stageId']=='research' and run['iteration']==4


@pytest.mark.parametrize('verdict,phase', [('pass','queued'),('blocked','review_blocked')])
def test_explicit_pass_or_blocked_controls_delivery(tmp_path,verdict,phase):
    store,g,r=at_review(tmp_path)
    saved=finish(store,g,r,decision(r,verdict))
    assert saved['phase']==phase and saved['stages'][2]['review']['decision']==verdict
    assert not saved.get('autoReworksUsed') and store.rework_receipts(g['id'])==[]
    pair=store.claim('next')
    if verdict=='pass':
        assert pair[1]['stageId']=='deliver'
    else:
        assert pair is None and saved['stages'][2]['status']=='blocked'


@pytest.mark.parametrize('edit', ['plain-text','missing-fields','old-turn','missing-input','inconsistent-pass','missing-findings'])
def test_incomplete_or_stale_reviews_do_not_advance(tmp_path,edit):
    store,g,r=at_review(tmp_path)
    payload=decision(r)
    if edit=='old-turn':payload['contract']['turnId']='synthetic-old-turn'
    elif edit=='missing-input':payload['contract']['inputs'].pop()
    elif edit=='inconsistent-pass':payload['findings']=['合成问题尚未解决']
    elif edit=='missing-findings':payload.update(decision='revise',targetStageId='build')
    elif edit=='missing-fields':payload={'decision':'pass'}
    else:payload='普通审查文字，没有结构化结论'
    saved=finish(store,g,r,payload)
    assert saved['status']=='blocked' and saved['phase']=='review_invalid'
    assert store.claim('other') is None and store.rework_receipts(g['id'])==[]


def test_changed_upstream_is_not_reviewed_evidence(tmp_path):
    store,g,r=at_review(tmp_path)
    path=tmp_path/g['stages'][1]['criteria'][0]['value'];path.write_text('审查期间修改了制作文件',encoding='utf-8')
    saved=finish(store,g,r,decision(r))
    assert saved['phase']=='review_invalid' and '证据已变化' in saved['reason']


def test_revise_archives_and_reopens_only_downstream_once_then_waits_for_human(tmp_path):
    store,g,r=at_review(tmp_path)
    original=deepcopy(g['stages'][0]);before_iterations=g['iterations']
    saved=finish(store,g,r,decision(r,'revise'))
    assert saved['status']=='active' and saved['phase']=='queued' and saved['revision']==2
    assert saved['iterations']==before_iterations and saved['autoReworksUsed']==1
    assert saved['stages'][0]==original and all(s['status']=='pending' for s in saved['stages'][1:])
    receipt=TaskStore(tmp_path).rework_receipts(g['id'])[0]
    assert receipt['source']=='reviewer' and receipt['currentTurnId']==r['turnId']
    assert receipt['stages'][1]['review']['decision']=='revise'
    assert store.finish(r['id'],owner='worker',state='completed')==saved
    # A new store represents restart after the atomic reviewer settlement.
    store=TaskStore(tmp_path)
    for expected in ('build','review','deliver'):
        g,r=store.claim('worker');assert r['stageId']==expected
        assert r['reworkId']==receipt['id']
        saved=finish(store,g,r,decision(r) if expected=='review' else None)
    assert saved['phase']=='review' and saved['status']=='blocked' and saved['iterations']==6
    assert saved['stages'][0]==original and [s['attempts'] for s in saved['stages']]==[1,2,2,1]
    assert saved['stages'][2]['review']['decision']=='pass'
    assert not saved.get('reviewedTurnId')
    approved=store.apply_checks(saved['id'],check_goal(tmp_path,saved,'',True)[0],review=r['turnId'])
    assert approved['status']=='completed'


def test_repeated_revise_or_insufficient_budget_stops_without_another_rework(tmp_path):
    store,g,r=at_review(tmp_path)
    finish(store,g,r,decision(r,'revise'))
    g,r=store.claim('worker');finish(store,g,r)
    g,r=store.claim('worker');saved=finish(store,g,r,decision(r,'revise'))
    assert saved['phase']=='review_rework_limit' and saved['autoReworksUsed']==1
    assert saved['stages'][2]['status']=='blocked' and store.claim('other') is None
    assert len(store.rework_receipts(g['id']))==1
    store.revise_goal(g['id'],g['objective']+'（人工修改）',g['criteria'])
    assert store.get('goals',g['id'])['autoReworksUsed']==1


@pytest.mark.parametrize('budget', ['iterations','time','tools'])
def test_return_budget_uses_cumulative_limits(tmp_path,budget):
    store,g,r=at_review(tmp_path,maxIterations=4 if budget=='iterations' else 8)
    if budget!='iterations':
        with store.db() as db:
            current=store._get(db,'goals',g['id'])
            current['activeSeconds' if budget=='time' else 'toolsUsed']=current['maxSeconds' if budget=='time' else 'maxTools']
            store._goal(db,current)
    saved=finish(store,g,r,decision(r,'revise'))
    assert saved['phase']=='review_rework_limit' and not saved.get('autoReworksUsed')
    assert store.claim('other') is None and store.rework_receipts(g['id'])==[]


@pytest.mark.parametrize('action',['pause','cancel','delete'])
def test_late_review_after_user_action_never_restarts(tmp_path,action):
    store,g,r=at_review(tmp_path)
    if action=='delete':store.delete_session(g['sessionId'])
    else:store.change_goal(g['id'],action)
    saved=finish(store,g,r,decision(r,'revise'))
    assert saved['status'] in ('paused','cancelled') and saved['revision']==1
    assert not saved.get('autoReworksUsed') and store.claim('other') is None


def test_review_archive_and_run_settlement_are_atomic_and_retry_same_turn(tmp_path,monkeypatch):
    store,g,r=at_review(tmp_path)
    event=store._event
    def fail(db,session,kind,value):
        if kind=='stage_rework':raise OSError('合成事务故障')
        return event(db,session,kind,value)
    monkeypatch.setattr(store,'_event',fail)
    with pytest.raises(OSError,match='合成事务'):
        finish(store,g,r,decision(r,'revise'))
    assert store.get('runs',r['id'])['state']=='running' and store.get('goals',g['id'])['revision']==1
    assert store.rework_receipts(g['id'])==[]
    monkeypatch.setattr(store,'_event',event)
    saved=finish(store,g,r,decision(r,'revise'))
    assert saved['revision']==2 and len(store.snapshot()['runs'])==3


def test_actual_task_service_drives_six_specialist_turns_with_synthetic_model(tmp_path,monkeypatch):
    ledger=tmp_path/'ledger'
    web=SimpleNamespace(OUTPUTS_DIR=tmp_path,run_ledger=run_ledger,_run_ledger_root=lambda:ledger,
        _turn_file=lambda _:tmp_path/'turn.json',ChatRequest=lambda **kw:SimpleNamespace(**kw))
    service=TaskService(web);store=service.store;requests=[];reviews=[]
    monkeypatch.setattr(service,'admit',lambda *_:None)
    async def start(req,**_):
        requests.append(req)
        g=store.get('goals',goal['id']);stage=current_stage(g)
        text='合成模型回执：'+stage['title']+' '+req.turnId
        if stage.get('reviewGate'):
            assert 'contract.allowedTargets' in req.message and req.turnId in req.message
            r=next(r for r in store.snapshot()['runs'] if r['turnId']==req.turnId)
            reviews.append(r);text=json.dumps(decision(r,'revise' if len(reviews)==1 else 'pass'),ensure_ascii=False)
        elif len(requests)==4:
            assert '隔离合成：请补充本地说明文件的实际检查步骤' in req.message
        path=tmp_path/stage['criteria'][0]['value'];path.parent.mkdir(parents=True,exist_ok=True);path.write_text(text,encoding='utf-8')
        (tmp_path/'turn.json').write_text(json.dumps({'turn_id':req.turnId,'text':text}),encoding='utf-8')
        run_ledger.create(ledger,req.turnId,session_id=req.sessionId,session_key=req.sessionId)
        run_ledger.mark(ledger,req.turnId,status='completed',settled=True,resource_settled=True)
    web.start_chat_run=start
    goal=store.create_goal(spec(),session='model-synthetic');store.change_goal(goal['id'],'start')
    async def run():
        for _ in range(8):
            pair=store.claim(service.owner)
            if not pair:break
            await service.execute(*pair)
    asyncio.run(run())
    assert [req.roleId for req in requests]==['researcher','builder','reviewer','builder','reviewer','publisher']
    assert len({req.turnId for req in requests})==6
    saved=store.get('goals',goal['id'])
    assert saved['phase']=='review' and saved['autoReworksUsed']==1
