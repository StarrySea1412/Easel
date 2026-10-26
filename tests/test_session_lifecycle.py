"""Isolated conversation lifecycle fixtures: no model, provider or production data."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sys
from types import SimpleNamespace
import time

from fastapi import FastAPI
from fastapi.testclient import TestClient
from fastapi import HTTPException
import pytest

from easel.task_rules import GoalSpec
from easel.task_store import TaskStore, TaskConflict
from easel.notifications import NotificationStore

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from task_service import TaskService


def spec():
    return GoalSpec(objective='隔离测试：保留任务记录', modelRef='fixture/model',
                    criteria=[{'type':'review','label':'用户验收'}]).model_dump()


def plan(store, session):
    return store.save_plan({'title':'隔离测试计划','sessionId':session,'goal':spec(),
        'schedule':{'kind':'interval','minutes':60},'missedPolicy':'skip',
        'freshnessSeconds':900,'enabled':True}, time.time()+3600)


def test_deletion_is_durable_idempotent_and_preserves_history_and_files(tmp_path):
    store=TaskStore(tmp_path)
    goal=store.create_goal(spec(),session='removed')
    kept=store.create_goal(spec(),session='kept')
    scheduled=plan(store,'removed')
    output=tmp_path/'result.txt';output.write_text('isolated fixture',encoding='utf-8')
    with ThreadPoolExecutor(4) as pool:
        markers=list(pool.map(lambda _:TaskStore(tmp_path).delete_session('removed'),range(4)))
    assert all(marker==markers[0] for marker in markers)
    restored=TaskStore(tmp_path)
    state=restored.snapshot()
    assert state['deletedSessions']==[markers[0]]
    assert {s['id'] for s in restored.session_state()['sessions']}=={'kept'}
    assert restored.get('goals',goal['id'])['status']=='cancelled'
    assert restored.get('goals',kept['id'])['status']=='draft'
    assert restored.get('plans',scheduled['id'])['enabled'] is False
    assert output.read_text(encoding='utf-8')=='isolated fixture'
    assert next(g for g in state['goals'] if g['id']==goal['id'])['sessionDeleted'] is True
    assert state['revision']>=markers[0]['revision']
    assert restored.claim('fixture-worker') is None


def test_deleted_identity_cannot_be_reused_but_new_conversations_work(tmp_path):
    store=TaskStore(tmp_path)
    goal=store.create_goal(spec(),session='removed');scheduled=plan(store,'removed')
    store.delete_session('removed')
    for action in [lambda:store.create_goal(spec(),session='removed'),
                   lambda:store.reserve_chat('removed','new-turn'),
                   lambda:store.change_goal(goal['id'],'resume'),
                   lambda:store.set_plan_enabled(scheduled['id'],True,time.time()+60),
                   lambda:store.trigger_plan(scheduled['id'],request='manual-new'),
                   lambda:plan(store,'removed')]:
        with pytest.raises(TaskConflict,match='已删除'):
            action()
    assert store.create_goal(spec(),session='new-conversation')['status']=='draft'
    store.reserve_chat('new-human-conversation','new-turn')


@pytest.mark.parametrize('settled',[True,False])
def test_late_run_settlement_never_revives_deleted_goal(tmp_path,settled):
    store=TaskStore(tmp_path)
    goal=store.create_goal(spec(),session='removed');store.change_goal(goal['id'],'start')
    _,run=store.claim('fixture-worker')
    store.delete_session('removed')
    assert store.session_work('removed')==[run['turnId']]
    result=store.finish(run['id'],owner='fixture-worker',text='隔离的迟到回执',resource_settled=settled)
    assert result['status']=='cancelled'
    assert result['phase']==('idle' if settled else 'unconfirmed')
    assert store.session_state()['sessions']==[]
    assert store.claim('next-worker') is None
    assert bool(store.session_work('removed')) is not settled
    assert store.snapshot()['runs'][0]['text']=='隔离的迟到回执'


def test_delete_route_commits_before_stop_and_keeps_uncertain_run_visible(tmp_path):
    store=TaskStore(tmp_path)
    goal=store.create_goal(spec(),session='removed');store.change_goal(goal['id'],'start')
    _,run=store.claim('fixture-worker')
    async def stop(req):
        assert req.sessionId=='removed' and req.turnId==run['turnId']
        assert TaskStore(tmp_path).get('goals',goal['id'])['status']=='cancelled'
        raise RuntimeError('isolated stop observation unavailable')
    service=TaskService(SimpleNamespace(OUTPUTS_DIR=tmp_path,api_chat_stop=stop,StopRequest=SimpleNamespace))
    app=FastAPI();app.include_router(service.router())
    with TestClient(app) as client:
        result=client.post('/api/tasks/sessions/removed/delete',json={})
        assert result.status_code==200 and result.json()['stopPending'] is True
        assert client.get('/api/tasks/sessions').json()['sessions']==[]
        state=client.get('/api/tasks').json()
        assert state['runs'][0]['state']=='running'
        assert state['goals'][0]['sessionDeleted'] is True
        assert client.post('/api/tasks/sessions/removed/delete',json={}).json()['tombstone']==result.json()['tombstone']


def test_notification_cleanup_outbox_survives_failure_and_service_restart(tmp_path,monkeypatch):
    store=TaskStore(tmp_path)
    notes=NotificationStore(tmp_path)
    notes.add([dict(id='fixture-note',message='隔离通知',tone='info',at=time.time()*1000,
                    target=dict(page='chat',sessionId='removed'))])
    store.delete_session('removed')
    original=NotificationStore.remove_session
    def unavailable(*_):
        raise OSError('isolated temporary storage failure')
    monkeypatch.setattr(NotificationStore,'remove_session',unavailable)
    service=TaskService(SimpleNamespace(OUTPUTS_DIR=tmp_path))
    asyncio.run(service.cleanup_deleted_sessions())
    assert TaskStore(tmp_path).pending_session_cleanup()==['removed']
    monkeypatch.setattr(NotificationStore,'remove_session',original)
    restarted=TaskService(SimpleNamespace(OUTPUTS_DIR=tmp_path))
    asyncio.run(restarted.cleanup_deleted_sessions())
    assert notes.list()['notices']==[]
    assert TaskStore(tmp_path).pending_session_cleanup()==[]


@pytest.mark.parametrize('status,outcome,pending', [('running','running',True),('done','unconfirmed',True),('done','interrupted',False)])
def test_delete_includes_codex_turn_after_chat_lease_is_released(tmp_path,status,outcome,pending):
    from easel.codex_service import CodexService
    codex=CodexService(tmp_path)
    codex._write(codex.folder('removed')/'session.json',{'engine':'codex','lastTurnId':'turn'})
    codex._persist({'sessionId':'removed','turn_id':'turn','status':status,'outcome':outcome})
    calls=[]
    async def stop(req):
        calls.append(req.turnId)
        return {'stopped':False}
    service=TaskService(SimpleNamespace(OUTPUTS_DIR=tmp_path,_codex_service=codex,
                                      api_chat_stop=stop,StopRequest=SimpleNamespace))
    app=FastAPI();app.include_router(service.router())
    with TestClient(app) as client:
        result=client.post('/api/tasks/sessions/removed/delete',json={})
    assert result.status_code==200 and result.json()['stopPending'] is pending
    assert calls==(['turn'] if pending else [])
    for callback in [lambda:codex.start(SimpleNamespace(sessionId='removed',turnId='new')),
                     lambda:codex._active(SimpleNamespace(sessionId='removed',turnId='turn'))]:
        with pytest.raises(HTTPException) as error:
            callback()
        assert error.value.status_code==409
