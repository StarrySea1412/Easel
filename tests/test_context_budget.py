"""Isolated ordinary prompt budgeting; no external runtime or model requests."""
import asyncio
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from easel.context_budget import (ContextBudgetError, admit, estimate_tokens,
                                  experience_reference, serialized)
from easel.profile_memory import MemoryStore, digest


@pytest.fixture
def store(tmp_path):
    (tmp_path / 'profiles/one').mkdir(parents=True)
    result = MemoryStore(tmp_path)
    result.import_legacy('one', {'hash': digest(''), 'profileRevision': 0, 'scope': {'kind': 'profile'}})
    return result


def activate(store, text):
    row = store.propose('one', {'text': text, 'scope': {'kind': 'profile'}})
    return store.change('one', row['id'], 'accept', {
        'revision': row['revision'], 'profileRevision': store.state('one')['revision'],
        'contentHash': row['contentHash'], 'scopeHash': row['scopeHash']})


def test_unicode_estimate_and_public_scope_are_explicit():
    assert estimate_tokens('12345') == 2
    assert estimate_tokens('中文') == 3
    assert estimate_tokens('😀') == 2
    assert estimate_tokens('a中😀') == 4
    result = admit('中文', budget=10, reserve=7)
    assert result.admitted and result.remaining_tokens == 0
    assert not admit('中文a', budget=10, reserve=7).admitted
    assert result.public()['nativeContextMeasured'] is False
    assert result.public()['estimator'] == 'unicode-weighted/1'


def test_serialized_metadata_counts_and_diagnostics_are_excluded(store):
    row = activate(store, '摄影')
    result = store.context('one')
    used = result['recall']['usedTokens']
    assert used == estimate_tokens(serialized(experience_reference(result)))
    assert used > estimate_tokens(row['text'])
    assert 'recall' not in experience_reference(result) and 'policy' not in experience_reference(result)
    assert not store.context('one', token_budget=used - 1)['entries']
    assert store.context('one', token_budget=used)['entries'][0]['id'] == row['id']
    assert experience_reference(store.context('one', token_budget=0)) is None
    assert store.context('one', token_budget=0)['recall']['usedTokens'] == 0


def test_final_prompt_budget_skips_large_entry_and_keeps_mandatory_input(store, monkeypatch):
    big = activate(store, '摄影教程步骤光线' * 50)
    small = activate(store, '摄影短结论')
    monkeypatch.setenv('EASEL_CHAT_PROMPT_BUDGET_TOKENS', '16000')
    monkeypatch.setenv('EASEL_CHAT_PROMPT_RESERVE_TOKENS', '0')
    # Larger entry ranks first. Its body fits the legacy character allowance,
    # but the full serialized reference exceeds the remaining prompt allowance.
    mandatory = 'X' * 62500
    def render(context):
        ref = experience_reference(context)
        return mandatory + (serialized(ref) if ref else '')
    result = store.context('one', '摄影教程步骤光线', token_budget=10000, prompt_builder=render)
    assert [entry['id'] for entry in result['entries']] == [small['id']]
    assert result['recall']['skippedPromptBudgetCount'] == 1
    assert result['recall']['promptAdmission']['admitted']
    assert render(result).startswith(mandatory) and big['text'] not in render(result)
    assert store.record_use('one', 'session', 'turn', result)
    assert store.record_use('one', 'session', 'turn', result)
    assert mandatory not in json.dumps(store.usage('one', 'session'))
    assert not store.record_use('one', 'session', 'turn', store.context('one'))


def test_over_budget_base_keeps_empty_reference_and_no_false_admission(store, monkeypatch):
    activate(store, '摄影')
    monkeypatch.setenv('EASEL_CHAT_PROMPT_BUDGET_TOKENS', '16000')
    monkeypatch.setenv('EASEL_CHAT_PROMPT_RESERVE_TOKENS', '0')
    result = store.context('one', prompt_builder=lambda _: '中' * 11000)
    assert not result['entries'] and result['recall']['reason'] == 'prompt-budget'
    assert not result['recall']['promptAdmission']['admitted']
    monkeypatch.setenv('EASEL_MEMORY_BUDGET_TOKENS', '0')
    assert store.context('one')['recall']['budgetTokens'] == 0


def test_persona_uses_dispatch_serializer_before_selecting_experience(store, monkeypatch):
    from easel import persona
    monkeypatch.setattr(persona, 'PROFILES_DIR', store.profiles)
    activate(store, '摄影教程' * 100)
    monkeypatch.setenv('EASEL_CHAT_PROMPT_BUDGET_TOKENS', '16000')
    monkeypatch.setenv('EASEL_CHAT_PROMPT_RESERVE_TOKENS', '0')
    plain = persona.model_turn_message('摄影教程', 'one')
    assert 'profile-experience' in plain
    result = persona.model_turn_message('摄影教程', 'one', prompt_builder=lambda text: 'x' * 55000 + text)
    assert 'profile-experience' not in result and '摄影教程' in result
    assert 'recall' not in result


def test_web_final_suffix_is_counted_before_admission_and_empty_reference_is_omitted(monkeypatch):
    import web.app as web
    monkeypatch.setenv('EASEL_CHAT_PROMPT_BUDGET_TOKENS', '16000')
    monkeypatch.setenv('EASEL_CHAT_PROMPT_RESERVE_TOKENS', '0')
    monkeypatch.setattr(web, '_writing_context', lambda _: None)
    req = web.ChatRequest(message='原始正文完整保留')
    result = web._chat_message(req)
    assert '原始正文完整保留' in result and 'profile-experience' not in result
    with pytest.raises(HTTPException) as caught:
        web._chat_message(req, suffix='x' * 64000)
    assert caught.value.status_code == 413
    assert req.message == '原始正文完整保留'


def test_codex_final_metadata_rejects_before_job_and_dedup_keeps_receipt(store, monkeypatch):
    from easel.codex_service import CodexService
    import easel.codex_service as module
    service = CodexService(store.root / 'outputs')
    model = {'id': 'codex/isolated', 'model': 'isolated', 'thinkingLevels': [], 'defaultEffort': 'low'}
    monkeypatch.setattr(service, 'runtime', lambda: {'available': True, 'auth': 'local_provider',
                        'defaultModelRef': model['id'], 'options': [model]})
    service.bind('budget-session', 'codex')
    req = SimpleNamespace(sessionId='budget-session', turnId='budget-turn', selectedSkills=[],
        skillRequirements={}, message='x' * 63000, attachments=[], modelRef=None, thinkingLevel=None)
    monkeypatch.setenv('EASEL_CHAT_PROMPT_BUDGET_TOKENS', '16000')
    monkeypatch.setenv('EASEL_CHAT_PROMPT_RESERVE_TOKENS', '0')
    assert admit(req.message).admitted
    with pytest.raises(HTTPException) as caught:
        service.start(req)
    assert caught.value.status_code == 413 and not service.active
    assert not service._state_path(req.sessionId, req.turnId).exists()
    captured = []
    class Thread:
        def __init__(self, *, args, **kwargs): captured.append(args)
        def start(self): pass
    monkeypatch.setattr(module.threading, 'Thread', Thread)
    req.message = 'isolated short input'
    assert service.start(req) == req.turnId
    assert service.snapshot(req.sessionId)['promptAdmission']['admitted']
    req.message = '中' * 20000
    assert service.start(req) == req.turnId and len(captured) == 1


def test_direct_api_counts_loaded_history_system_and_never_opens_network_on_rejection(tmp_path, monkeypatch):
    from easel import direct_api
    monkeypatch.setenv('EASEL_CHAT_PROMPT_BUDGET_TOKENS', '16000')
    monkeypatch.setenv('EASEL_CHAT_PROMPT_RESERVE_TOKENS', '0')
    path = tmp_path / 'history.json'
    original = json.dumps([{'role': 'user', 'content': '中' * 10500}])
    path.write_text(original, encoding='utf-8')
    monkeypatch.setattr(direct_api.httpx, 'AsyncClient', lambda **_: pytest.fail('network client created'))
    async def consume():
        return [item async for item in direct_api.stream_chat(
            {'EASEL_DIRECT_API_BASE_URL': 'http://localhost/v1', 'EASEL_DIRECT_API_MODEL': 'isolated'},
            '当前正文', system='system' * 300, history_file=path)]
    with pytest.raises(direct_api.DirectAPIError, match='未提交模型请求'):
        asyncio.run(consume())
    assert path.read_text(encoding='utf-8') == original


def test_programmatic_console_rejects_before_adapter_dispatch(tmp_path, monkeypatch):
    from easel import harnesses
    monkeypatch.setenv('EASEL_CHAT_PROMPT_BUDGET_TOKENS', '16000')
    monkeypatch.setenv('EASEL_CHAT_PROMPT_RESERVE_TOKENS', '0')
    monkeypatch.setattr(harnesses, 'adapter', lambda _: pytest.fail('adapter dispatched'))
    with pytest.raises(harnesses.HarnessError, match='未提交模型请求'):
        asyncio.run(harnesses.console_turn('中' * 11000, tmp_path, {}))


def test_direct_success_callback_sees_system_history_and_selected_reference(store, monkeypatch):
    import httpx
    from easel import direct_api, persona
    monkeypatch.setattr(persona, 'PROFILES_DIR', store.profiles)
    row = activate(store, '摄影先展示成品')
    path = store.root / 'api-history.json'
    path.write_text(json.dumps([{'role': 'user', 'content': '原始历史'}]), encoding='utf-8')
    captured = []
    original_client = httpx.AsyncClient
    def respond(request):
        body = json.loads(request.content)
        captured.append(body)
        assert body['messages'][0]['content'] == '当前系统'
        assert body['messages'][1]['content'] == '原始历史'
        content = body['messages'][-1]['content']
        assert row['text'] in content and '摄影问题' in content
        assert 'recall' not in content and '先查技能库' not in content
        return httpx.Response(200, text='data: ' + json.dumps({'choices': [
            {'delta': {'content': '隔离合成答复'}, 'finish_reason': 'stop'}]}) + '\n\n')
    monkeypatch.setattr(direct_api.httpx, 'AsyncClient', lambda **kwargs: original_client(
        transport=httpx.MockTransport(respond), **kwargs))
    async def consume():
        return [item async for item in direct_api.stream_chat(
            {'EASEL_DIRECT_API_BASE_URL': 'http://localhost/v1', 'EASEL_DIRECT_API_MODEL': 'isolated'},
            '摄影问题', system='当前系统', history_file=path, content_builder=lambda builder:
                persona.model_api_message('摄影问题', 'one', prompt_builder=builder))]
    assert asyncio.run(consume())[-1] == ('finish', 'stop')
    assert len(captured) == 1
    history = json.loads(path.read_text(encoding='utf-8'))
    assert len(history) == 3 and history[0]['content'] == '原始历史'


def test_codex_budget_changed_after_acceptance_is_rejected_without_native_turn(store, monkeypatch):
    from easel.codex_service import CodexService
    import easel.codex_service as module
    service = CodexService(store.root / 'outputs', client_factory=lambda _: pytest.fail('native client started'))
    model = {'id': 'codex/isolated', 'model': 'isolated', 'thinkingLevels': [], 'defaultEffort': 'low'}
    monkeypatch.setattr(service, 'runtime', lambda: {'available': True, 'auth': 'local_provider',
                        'defaultModelRef': model['id'], 'options': [model]})
    captured = []
    class Thread:
        def __init__(self, *, args, **kwargs): captured.append(args)
        def start(self): pass
    monkeypatch.setattr(module.threading, 'Thread', Thread)
    service.bind('late-session', 'codex')
    req = SimpleNamespace(sessionId='late-session', turnId='late-turn', selectedSkills=[],
        skillRequirements={}, message='x' * 64000, attachments=[], modelRef=None, thinkingLevel=None)
    service.start(req)
    monkeypatch.setenv('EASEL_CHAT_PROMPT_BUDGET_TOKENS', '16000')
    monkeypatch.setenv('EASEL_CHAT_PROMPT_RESERVE_TOKENS', '0')
    service._run(*captured[0])
    result = service.snapshot(req.sessionId)
    assert result['status'] == 'done' and result['outcome'] == 'rejected'
    assert result['error']['category'] == 'context_budget' and not service.active
