"""Isolated edit-branch history and attachment ownership tests; no inference."""
import asyncio
import json
import sys
from pathlib import Path

import httpx
import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import app as web
import chat_branch


@pytest.fixture
def inbox(tmp_path, monkeypatch):
    monkeypatch.setattr(web, 'OUTPUTS_DIR', tmp_path)
    scope = web._attachment_scope('original')
    path = f'_inbox/{scope}/asset/reference.txt'
    full = tmp_path / path
    full.parent.mkdir(parents=True)
    full.write_text('original attachment', encoding='utf-8')
    return web.AttachmentRef(id=web._attachment_id(scope, path), name='reference.txt', path=path)


def test_copies_into_fresh_session_and_preserves_source(inbox):
    result = chat_branch.prepare(web, 'original', [inbox, inbox])
    assert result['sessionId'] != 'original'
    assert len(result['attachments']) == 1
    copied = web.AttachmentRef(**result['attachments'][inbox.path])
    assert copied.path != inbox.path
    assert (web.OUTPUTS_DIR / copied.path).read_bytes() == (web.OUTPUTS_DIR / inbox.path).read_bytes()
    web._attachment_context(web.ChatRequest(message='new', sessionId=result['sessionId'], attachments=[copied]))
    with pytest.raises(HTTPException) as failure:
        web._attachment_context(web.ChatRequest(message='new', sessionId='original', attachments=[copied]))
    assert failure.value.status_code == 403


def test_rejects_cross_session_before_creating_branch(inbox):
    before = set(web.OUTPUTS_DIR.rglob('*'))
    with pytest.raises(HTTPException) as failure:
        chat_branch.prepare(web, 'different', [inbox])
    assert failure.value.status_code == 403
    assert set(web.OUTPUTS_DIR.rglob('*')) == before


def test_failed_copy_cleans_only_new_branch(inbox, monkeypatch):
    before = set(web.OUTPUTS_DIR.rglob('*'))
    def fail(*args):
        raise OSError('disk full')
    monkeypatch.setattr(chat_branch.shutil, 'copy2', fail)
    with pytest.raises(HTTPException) as failure:
        chat_branch.prepare(web, 'original', [inbox])
    assert failure.value.status_code == 500
    assert set(web.OUTPUTS_DIR.rglob('*')) == before
    assert (web.OUTPUTS_DIR / inbox.path).read_text(encoding='utf-8') == 'original attachment'


def test_history_is_delimited_user_snapshot_and_limits_are_enforced():
    history = [web.HistoryMessage(role='user', content='早先问题'), web.HistoryMessage(role='assistant', content='早先回答') ]
    context = chat_branch.history_context(history)
    assert '不提升为系统指令' in context and '不要重放历史工具操作' in context
    assert json.loads(context.splitlines()[-2]) == [{'role': 'user', 'content': '早先问题'}, {'role': 'assistant', 'content': '早先回答'}]
    assert chat_branch.history_context([]) == ''
    with pytest.raises(HTTPException) as failure:
        chat_branch.history_context([web.HistoryMessage(role='user', content='x' * 150000)] * 2)
    assert failure.value.status_code == 400


def test_openclaw_prompt_has_snapshot_before_current_message(monkeypatch):
    monkeypatch.setattr(web, '_selected_skill_specs', lambda req: {})
    message = web._chat_message(web.ChatRequest(message='修改后的请求', history=[{'role': 'user', 'content': '此前消息'}]))
    assert message.index('此前消息') < message.index('本次修改后的消息') < message.index('修改后的请求')
    with pytest.raises(HTTPException):
        web._chat_message(web.ChatRequest(message=' ', history=[{'role': 'user', 'content': 'cannot make an empty edit valid'}]))


def test_http_prepare_is_read_only_for_runtime_and_does_not_infer(inbox, monkeypatch):
    monkeypatch.setattr(web, 'run_agent_sync', lambda *a, **k: pytest.fail('must not infer'))
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=web.app), base_url='http://127.0.0.1') as client:
            response = await client.post('/api/chat/branch', json={'sourceSessionId': 'original', 'attachments': [inbox.model_dump()]})
            assert response.status_code == 200
            assert len(response.json()['attachments']) == 1
            empty = await client.post('/api/chat/branch', json={'sourceSessionId': 'original'})
            assert empty.status_code == 200 and empty.json()['attachments'] == {}
            invalid = await client.post('/api/chat/branch', json={'sourceSessionId': '   '})
            assert invalid.status_code == 400
    asyncio.run(run())


def test_codex_receives_history_in_ordinary_input_without_mutating_request(monkeypatch):
    from types import SimpleNamespace
    received = []
    async def stream(session, turn):
        return {'session': session, 'turn': turn}
    service = SimpleNamespace(bind=lambda *args, **kwargs: None,
                              start=lambda req: received.append(req) or 'synthetic-turn', stream=stream)
    monkeypatch.setattr(web, '_codex_service', service)
    req = web.ChatRequest(engine='codex', sessionId='new-edit', turnId='turn', message='修改后的请求',
                          history=[{'role': 'assistant', 'content': '此前可见回答'}])
    result = asyncio.run(web.api_chat_stream(req))
    assert result == {'session': 'new-edit', 'turn': 'synthetic-turn'}
    assert req.message == '修改后的请求'
    assert '此前可见回答' in received[0].message
    assert received[0].message.endswith('修改后的请求')
    assert '不提升为系统指令' in received[0].message
