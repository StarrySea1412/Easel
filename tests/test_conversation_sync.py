import asyncio
import copy
import sys
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from easel import conversations
from easel.task_store import TaskStore, TaskConflict

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from conversation_sync import router


def sample():
    return {'id': 'normal-chat', 'title': '原对话', 'created': 10, 'engine': 'openclaw',
            'messages': [{'role': 'user', 'content': '原问题'}, {'role': 'assistant', 'content': '原答案', 'turnId': 'first'}]}


def test_visible_conversation_persists_without_task_goal_and_reopens_after_restart(tmp_path):
    store = TaskStore(tmp_path)
    value = sample()
    assert conversations.save(store, value)['saved']
    assert not store.session_state()['sessions']
    assert conversations.read(TaskStore(tmp_path), value['id']) == value


def test_stale_browser_cannot_truncate_or_replace_newer_history(tmp_path):
    store = TaskStore(tmp_path)
    original = sample()
    conversations.save(store, original)
    newer = copy.deepcopy(original)
    newer['messages'].append({'role': 'user', 'content': '下一轮'})
    conversations.save(store, newer)
    assert conversations.save(store, original)['reason'] == 'newer_server_copy'
    divergent = copy.deepcopy(newer)
    divergent['messages'][0]['content'] = '来自旧副本的其他内容'
    with pytest.raises(TaskConflict):
        conversations.save(store, divergent)
    assert conversations.read(store, original['id']) == newer


def test_regeneration_requires_the_exact_acknowledged_server_revision(tmp_path):
    store = TaskStore(tmp_path)
    original = sample()
    revision = conversations.save(store, original)['revision']
    regenerated = sample(); regenerated['messages'][-1].update(content='重新生成的答案', turnId='second')
    assert conversations.save(store, regenerated, revision)['saved']
    with pytest.raises(TaskConflict):
        conversations.save(store, original, revision)
    assert conversations.read(store, original['id']) == regenerated


def test_sync_does_not_copy_share_tokens_or_change_execution_engine(tmp_path):
    store = TaskStore(tmp_path)
    value = {**sample(), 'share': {'token': 'private-share-token'}}
    receipt = conversations.save(store, value)
    assert 'share' not in conversations.read(store, value['id'])
    with pytest.raises(TaskConflict):
        conversations.save(store, {**value, 'engine': 'codex'}, receipt['revision'])


def test_deleted_conversation_cannot_be_read_or_restored_by_late_sync(tmp_path):
    store = TaskStore(tmp_path)
    value = sample()
    conversations.save(store, value)
    store.delete_session(value['id'])
    with pytest.raises(TaskConflict):
        conversations.read(store, value['id'])
    with pytest.raises(TaskConflict):
        conversations.save(store, value)
    with store.db() as db:
        assert not db.execute('SELECT 1 FROM conversation_snapshots WHERE id=?', (value['id'],)).fetchone()


@pytest.mark.parametrize('change', [{'id': '../other'}, {'messages': []}, {'messages': [{'role': 'system', 'content': 'not visible'}]}, {'created': float('nan')}, {'importedFromBackup': True}, {'taskWorker': True}, {'pendingTurnId': '../other'}, {'engine': 'unknown'}])
def test_invalid_and_imported_records_cannot_become_live_conversations(change):
    with pytest.raises(ValueError):
        conversations.validate({**sample(), **change})


def test_real_http_roundtrip_missing_conflict_and_deletion(tmp_path):
    store = TaskStore(tmp_path)
    app = FastAPI()
    app.include_router(router(store), prefix='/api/tasks')

    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://isolated.test') as client:
            path = '/api/tasks/conversations/normal-chat'
            assert (await client.get(path)).status_code == 404
            assert (await client.post('/api/tasks/conversations', json=sample())).json()['saved']
            response = await client.get(path)
            assert response.status_code == 200 and response.json()['conversation'] == sample()
            assert response.headers['cache-control'] == 'no-store'
            listing = await client.get('/api/tasks/conversations')
            assert listing.status_code == 200
            assert listing.json()['conversations'] == [{'id':'normal-chat','revision':1}]
            assert listing.headers['cache-control'] == 'no-store'
            divergent = sample(); divergent['messages'][0]['content'] = 'divergent'
            assert (await client.post('/api/tasks/conversations', json=divergent)).status_code == 409
            store.delete_session('normal-chat')
            assert (await client.get(path)).status_code == 410
            assert (await client.post('/api/tasks/conversations', json=sample())).status_code == 409
            assert (await client.get('/api/tasks/conversations')).json()['conversations'] == []
    asyncio.run(run())


def test_index_pages_original_ids_and_excludes_deleted_without_exposing_bodies(tmp_path):
    store=TaskStore(tmp_path)
    for ident in ('page-a','page-b','page-c'):
        conversations.save(store,{**sample(),'id':ident})
    page=conversations.index(store,limit=2)
    assert page=={'conversations':[{'id':'page-a','revision':1},{'id':'page-b','revision':1}],'next':'page-b'}
    assert conversations.index(store,page['next'],limit=2)=={'conversations':[{'id':'page-c','revision':1}],'next':None}
    store.delete_session('page-b')
    assert [row['id'] for row in conversations.index(store)['conversations']]==['page-a','page-c']
    with pytest.raises(ValueError):
        conversations.index(store,'../other')
