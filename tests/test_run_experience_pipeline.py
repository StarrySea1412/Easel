"""Actual supervisor/native/recovery wiring with protocol substitutes, no models."""
import asyncio
import json
from types import SimpleNamespace

import pytest

from easel.codex_service import CodexService
from easel.profile_memory import MemoryStore, digest
from easel.run_experience import binding
from tests.test_chat_model_selection import sandbox, web
from tests.test_codex_tasks import Harness
from tests.test_gateway_reconciliation import terminal
from tests.test_run_experience import env, bind, finish, change, QUOTE, LESSON, PROPOSAL


def prepare(root, ledger=None):
    path = root / 'profiles/one'; path.mkdir(parents=True, exist_ok=True)
    memory = MemoryStore(root, run_ledger=ledger)
    memory.import_legacy('one', {'hash': digest(''), 'profileRevision': 0, 'scope': {'kind': 'profile'}})
    return memory


def test_actual_native_tool_persists_after_client_close_and_reuses_confirmed_prompt(env, monkeypatch):
    import easel.persona as persona
    monkeypatch.setattr(web, 'PROFILES_DIR', env.memory.profiles)
    monkeypatch.setattr(persona, 'PROFILES_DIR', env.memory.profiles)
    monkeypatch.setattr(web, 'OUTPUTS_DIR', env.outputs)
    monkeypatch.setattr(web, '_memory_store', lambda: env.memory)
    monkeypatch.setattr(web, '_writing_context', lambda _: None)
    h = Harness(env.outputs)
    h.codex.budgeted_message_builder = lambda req, transported: web._codex_message(req, prompt_builder=transported)
    def emit(client, state, native_turn):
        events = [
            {'id': 77, 'method': 'item/tool/call', 'params': {'tool': 'easel_memory_candidate', 'arguments': PROPOSAL}},
            {'method': 'item/completed', 'params': {'item': {'id': 'reply', 'type': 'agentMessage', 'text': QUOTE}}},
            {'method': 'turn/completed', 'params': {'turn': {'id': native_turn, 'status': 'completed'}}},
        ]
        for event in events:
            event['params'].update(threadId='native-' + client.workspace.name, turnId=native_turn)
            client.events.put(event)
    h.emit = emit
    h.codex.bind('native-memory', 'codex')
    req = web.ChatRequest(message='检查文件交付', sessionId='native-memory', turnId='native-memory-turn',
                          persona='one', engine='codex', modelRef='codex/fixture')
    h.codex.start(req)
    run = h.codex.active.get(req.sessionId)
    if run: assert run['finished'].wait(8)
    saved = h.codex.snapshot(req.sessionId, req.turnId)
    assert saved['outcome'] == 'completed' and saved['memoryResourceSettled']
    assert h.replies[0]['success'] is True
    assert binding(env.memory, req.sessionId, req.turnId)['receipt']['createdCount'] == 1
    thread = next(p for m, p in h.calls if m == 'thread/start')
    assert any(t['name'] == 'easel_memory_candidate' for t in thread['dynamicTools'])
    sent = next(p for m, p in h.calls if m == 'turn/start')['input'][0]['text']
    assert 'easel_memory_candidate' in sent
    entry = env.memory.state('one')['entries'][0]
    change(env, entry, 'accept')
    req.turnId = 'second-memory-turn'
    prompt = web._codex_message(req)
    assert LESSON in prompt
    assert env.memory.usage('one', req.sessionId)[0]['entries'][0]['id'] == entry['id']
    assert h.dispatched == 1
    h.codex.close()


def test_actual_supervisor_settles_proposals_after_disconnect_recovery(sandbox, monkeypatch):
    import office_controls
    sandbox.transport = 'cli'
    memory = prepare(sandbox.path, web._run_ledger_root())
    memory.bind_run('one', 'memory-live', 'memory-live-turn')
    memory.queue_run('memory-live', 'memory-live-turn', PROPOSAL)
    calls = []
    class Client:
        def _rpc(self, method, params, **kwargs):
            calls.append(method)
            if method == 'agent':
                kwargs['on_accepted']({'runId': 'memory-run'})
                raise OSError('isolated dropped receiver')
            assert method == 'agent.wait'
            return terminal(run='memory-run', session=web._openclaw_session_id('memory-live'), text=QUOTE)
        def close(self): pass
    monkeypatch.setattr(web, '_codex_service', CodexService(sandbox.path / 'outputs'))
    monkeypatch.setattr(web, '_chat_message', lambda req, **_: req.message)
    monkeypatch.setattr(web, '_native_agent_client', lambda _: Client())
    monkeypatch.setattr(office_controls, '_model_probe_client', lambda *_: Client())
    monkeypatch.setattr(web, '_browser_service', SimpleNamespace(has_pages=lambda _: False))
    async def scenario():
        response = await web.api_chat_stream(web.ChatRequest(message='隔离执行',
            sessionId='memory-live', turnId='memory-live-turn', engine='openclaw'))
        received = [event async for event in response.body_iterator]
        assert received[-1]['event'] == 'done'
    asyncio.run(asyncio.wait_for(scenario(), 10))
    # Inspect the durable receipt directly: no UI read-triggered extraction.
    assert binding(memory, 'memory-live', 'memory-live-turn')['receipt']['createdCount'] == 1
    assert memory.state('one')['entries'][0]['status'] == 'pending'
    assert calls == ['agent', 'agent.wait']


@pytest.mark.parametrize('engine', ['openclaw', 'codex'])
def test_real_prompt_includes_proposals_in_final_budget_and_recall(env, monkeypatch, engine):
    import easel.persona as persona
    monkeypatch.setattr(web, 'PROFILES_DIR', env.memory.profiles)
    monkeypatch.setattr(persona, 'PROFILES_DIR', env.memory.profiles)
    monkeypatch.setattr(web, 'OUTPUTS_DIR', env.outputs)
    monkeypatch.setattr(web, '_memory_store', lambda: env.memory)
    monkeypatch.setattr(web, '_writing_context', lambda _: None)
    monkeypatch.setattr(web, '_selected_skill_specs', lambda _: {})
    # _chat_message is replaced by the sandbox in other tests; use its module's original function.
    req = web.ChatRequest(message='交付文件', sessionId='prompt-memory', turnId='first', persona='one', engine=engine)
    prompt = web._codex_message(req) if engine == 'codex' else web._chat_message(req)
    assert 'easel_memory_candidate' in prompt
    assert env.memory.usage('one', req.sessionId)[0]['recall']['promptAdmission']['admitted']
    bound = binding(env.memory, req.sessionId, req.turnId)
    assert bound['engine'] == engine and bound['scope'] == {'kind': 'profile'}


def test_native_tool_rejects_model_supplied_source_identity(env):
    h = Harness(env.outputs)
    bind(env, engine='codex')
    replies = []
    run = {'state': {'sessionId': 's', 'turn_id': 't'}, 'client': SimpleNamespace(reply=lambda *args: replies.append(args))}
    h.codex._request(run, {'id': 1, 'method': 'item/tool/call', 'params': {'tool': 'easel_memory_candidate',
        'arguments': {**PROPOSAL, 'sessionId': 'other'}}})
    assert replies[0][1]['success'] is False
    h.codex.close()


def test_passive_native_recovery_keeps_proposals_until_original_result_and_client_close(env):
    from tests.test_codex_recovery import Client
    bind(env, engine='codex')
    env.memory.queue_run('s', 't', PROPOSAL)
    service = CodexService(env.outputs)
    service.bind('s', 'codex')
    state = {'sessionId': 's', 'turn_id': 't', 'threadId': 'native-thread', 'codexTurnId': 'native-turn',
        'workspace': str(env.outputs / 'workspace'), 'status': 'done', 'outcome': 'unconfirmed', 'seq': 0,
        'text': 'partial', 'thinking': '', 'items': [], 'pending': [],
        'error': {'message': 'connection lost'}, 'elapsedMs': 123}
    service._persist(state)
    assert env.memory.state('one')['entries'] == []
    assert 'receipt' not in binding(env.memory, 's', 't')
    turn = {'id': 'native-turn', 'status': 'completed', 'itemsView': 'full',
        'items': [{'id': 'reply', 'type': 'agentMessage', 'phase': 'final_answer', 'text': QUOTE}]}
    client = Client(state, turn)
    service.factory = lambda _: client
    recovered = service.reconcile('s', 't')
    assert client.closed and recovered['memoryResourceSettled']
    assert binding(env.memory, 's', 't')['receipt']['createdCount'] == 1
    restored = CodexService(env.outputs, lambda _: pytest.fail('No new model call'))
    assert restored.snapshot('s', 't')['text'] == QUOTE
    assert restored.reconcile('s', 't')['outcome'] == 'completed'
    assert len(MemoryStore(env.root).state('one')['entries']) == 1
    assert all(method in ('thread/read', 'thread/turns/list') for method, _ in client.calls)
    service.close(); restored.close()
