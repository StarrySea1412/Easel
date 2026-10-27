"""Ordinary analysis/writing lifecycle with labelled synthetic local evidence."""
import json
import asyncio
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from analysis_conversations import AnalysisConversations
from content_analysis import Store
from easel.creation_drafts import CreationDrafts
from easel.task_store import TaskStore
from easel.writing_handoffs import WritingHandoffs


def seeded(tmp_path):
    ledger = tmp_path / '_sessions'
    ledger.mkdir()
    (ledger / 'web_analysis-chat.json').write_text('{}', encoding='utf-8')
    store = Store(tmp_path / '_analytics/workbench')
    store.ingest({'platform': 'zhihu', 'accountId': 'isolated-owner', 'name': '隔离合成账号',
                  'contents': [{'id': 'sample', 'title': '合成咖啡教程', 'body': '隔离合成材料，仅作流程验证。'}]})
    conversations = AnalysisConversations(store)
    binding = conversations.prepare({'platform': 'zhihu', 'accountId': 'isolated-owner', 'sessionId': 'analysis-chat'})
    result = {'sessionId': 'analysis-chat', 'turnId': 'analysis-turn',
              'markdown': '## 隔离合成分析\n作品 sample 提及咖啡教程；可尝试按冲煮顺序写作。未验证实际效果。'}
    conversations.save_result(binding['id'], result)
    return WritingHandoffs(tmp_path), store, conversations, binding, result


def prepare(service, binding, **extra):
    return service.prepare(binding['id'], 'analysis-chat', **extra)


def test_repeat_intake_survives_restart_and_serializes_clicks(tmp_path):
    service, _, _, binding, _ = seeded(tmp_path)
    with ThreadPoolExecutor(3) as pool:
        records = list(pool.map(lambda _: prepare(service, binding), range(3)))
    assert len({item['id'] for item in records}) == 1
    item = WritingHandoffs(tmp_path).checked(records[0]['sessionId'])
    assert item['analysis']['turnId'] == 'analysis-turn'
    assert '合成分析' in item['analysis']['markdown']
    assert 'analysis' not in records[0]
    remote = TaskStore(tmp_path).session_snapshots()
    assert remote[0]['writingContext'] == records[0]
    assert not (tmp_path / '_sessions' / ('web_' + item['sessionId'] + '.json')).exists()


def test_material_refresh_preserves_old_handoff_and_requires_fresh_analysis(tmp_path):
    service, store, _, binding, _ = seeded(tmp_path)
    old = prepare(service, binding)
    store.ingest({'platform': 'zhihu', 'accountId': 'isolated-owner',
                  'contents': [{'id': 'sample', 'title': '更新后的合成教程'}]})
    with pytest.raises(ValueError, match='材料已改变'):
        service.checked(old['sessionId'])
    with service.db() as db:
        saved = json.loads(db.execute('SELECT data FROM writing_handoffs WHERE id=?', (old['id'],)).fetchone()[0])
    assert saved['analysis']['turnId'] == 'analysis-turn'


def test_new_analysis_result_creates_new_intake_without_replacing_old_record(tmp_path):
    service, _, conversations, binding, result = seeded(tmp_path)
    old = prepare(service, binding)
    conversations.save_result(binding['id'], {**result, 'turnId': 'new-turn', 'markdown': result['markdown'] + '新版本。'})
    with pytest.raises(ValueError, match='原分析已变化'):
        service.checked(old['sessionId'])
    new = prepare(service, binding)
    assert new['id'] != old['id'] and new['sourceTurnId'] == 'new-turn'


def test_deleting_writing_keeps_tombstone_and_allows_new_explicit_intake(tmp_path):
    service, _, _, binding, _ = seeded(tmp_path)
    old = prepare(service, binding)
    TaskStore(tmp_path).delete_session(old['sessionId'])
    new = prepare(service, binding)
    assert new['sessionId'] != old['sessionId']
    with pytest.raises(ValueError, match='原对话已删除'):
        service.checked(old['sessionId'])
    assert service.checked(new['sessionId'])['sourceSessionId'] == 'analysis-chat'


def test_source_deletion_keeps_history_and_stops_new_intake(tmp_path):
    service, _, _, binding, _ = seeded(tmp_path)
    item = prepare(service, binding)
    TaskStore(tmp_path).delete_session('analysis-chat')
    with pytest.raises(ValueError, match='原对话已删除'):
        service.checked(item['sessionId'])
    with pytest.raises(ValueError, match='原对话已删除'):
        prepare(service, binding)


def test_publishing_preparation_inherits_and_rechecks_writing_source(tmp_path):
    service, _, conversations, binding, result = seeded(tmp_path)
    handoff = prepare(service, binding)
    drafts = CreationDrafts(tmp_path)
    item = drafts.prepare(handoff['sessionId'], 'writing-turn', {'requestId': 'draft-one', 'body': '合成新稿，不是分析报告。'})
    assert item['analysis']['writingHandoffId'] == handoff['id']
    assert item['analysis']['sessionId'] == 'analysis-chat'
    assert drafts.checked(handoff['sessionId'], item['id']) == item
    conversations.save_result(binding['id'], {**result, 'turnId': 'updated-turn', 'markdown': result['markdown'] + '来源修改。'})
    with pytest.raises(ValueError, match='原分析已变化'):
        drafts.checked(handoff['sessionId'], item['id'])


def test_editing_branch_retains_analysis_and_a_separate_publishing_source(tmp_path):
    service, _, _, binding, _ = seeded(tmp_path)
    original = prepare(service, binding)
    branch = service.branch(original['sessionId'], 'edit-synthetic')
    assert branch['id'] != original['id']
    assert branch['sourceSessionId'] == 'analysis-chat'
    assert service.checked('edit-synthetic')['analysis'] == service.checked(original['sessionId'])['analysis']
    item = CreationDrafts(tmp_path).prepare('edit-synthetic', 'edited-turn', {'requestId': 'draft', 'body': '编辑分支合成稿'})
    assert item['analysis']['writingHandoffId'] == branch['id']


def test_web_intake_read_and_prompt_preserve_user_request(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    import app as web
    service, _, _, binding, _ = seeded(tmp_path)
    monkeypatch.setattr(web, 'OUTPUTS_DIR', tmp_path)
    monkeypatch.setattr(web, '_run_ledger_root', lambda: tmp_path / '_sessions')
    app = FastAPI()
    app.add_api_route('/intake/{binding_id}', web.api_analysis_writing, methods=['POST'])
    app.add_api_route('/read/{session_id}', web.api_writing_handoff, methods=['GET'])
    with TestClient(app) as client:
        first = client.post('/intake/' + binding['id'], json={'sourceSessionId': 'analysis-chat'})
        assert first.status_code == 200
        context = first.json()
        assert client.get('/read/' + context['sessionId']).json() == context
        assert client.post('/intake/' + binding['id'], json={'sourceSessionId': 'analysis-chat'}).json() == context
    monkeypatch.setattr(web, '_chat_memory_context', lambda req, writing=None, **kwargs: None)
    monkeypatch.setattr(web, '_chat_agent_runtime', lambda req: {})
    monkeypatch.setattr(web, '_chat_role_contract', lambda req: '')
    monkeypatch.setattr(web, '_selected_skill_specs', lambda req: {})
    message = web._chat_message(web.ChatRequest(message='只写咖啡步骤，暂不出图', sessionId=context['sessionId']))
    assert 'analysis-writing' in message and '隔离合成分析' in message
    assert '只写咖啡步骤，暂不出图' in message
    assert service.checked(context['sessionId'])['analysis']['turnId'] == 'analysis-turn'


def test_codex_dispatch_receives_the_checked_source_with_a_controlled_transport(tmp_path, monkeypatch):
    import app as web
    service, _, _, binding, _ = seeded(tmp_path)
    context = prepare(service, binding, engine='codex')
    monkeypatch.setattr(web, 'OUTPUTS_DIR', tmp_path)
    monkeypatch.setattr(web, '_run_ledger_root', lambda: tmp_path / '_sessions')
    monkeypatch.setattr(web, '_chat_role_contract', lambda req: '')
    monkeypatch.setattr(web, '_attachment_context', lambda req: '')
    captured = []
    class Transport:
        def bind(self, *args, **kwargs): pass
        def start(self, req):
            captured.append(web._codex_message(req))
            return 'synthetic-turn'
        async def stream(self, session, turn): return {'session': session, 'turn': turn}
    monkeypatch.setattr(web, '_codex_service', Transport())
    result = asyncio.run(web.start_chat_run(web.ChatRequest(message='只准备可编辑稿', engine='codex', sessionId=context['sessionId'])))
    assert result['turn'] == 'synthetic-turn' and len(captured) == 1
    assert 'analysis-writing' in captured[0] and '隔离合成分析' in captured[0]
    assert '只准备可编辑稿' in captured[0]
