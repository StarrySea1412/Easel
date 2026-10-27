"""Protocol receipts are fixtures, never a model call or business acceptance."""
import asyncio
import copy
import json
import threading

import pytest

from easel.gateway_agent import GatewayAgentProc
from easel.gateway_reconciliation import wait_outcome
from tests.test_chat_recovery import lost, durable_lost, web
from chat_recovery import reconcile_orphan, stop_orphan
from tests.test_chat_model_selection import sandbox


def terminal(session='native-session', run='exact-run', text='隔离协议最终回复', **extra):
    return {'runId': run, 'status': 'ok', 'endedAt': 1793080000000,
            'terminalReceipt': {'runId': run, 'sessionId': session, 'turnId': 'provider-turn',
                                'terminalDisposition': 'visible'},
            'terminalReply': {'disposition': 'visible', 'text': text}, **extra}


@pytest.mark.parametrize('changes', [
    {'runId': 'other'}, {'status': 'timeout'}, {'status': 'pending'},
    {'pendingError': True}, {'yielded': True},
])
def test_nonterminal_or_foreign_wait_cannot_settle(changes):
    assert wait_outcome(terminal(**changes), 'exact-run', 'native-session') is None


@pytest.mark.parametrize('field,value', [
    ('terminalReceipt', None), ('terminalReceipt', {'runId': 'exact-run'}),
    ('terminalReply', {'disposition': 'silent'}), ('terminalReply', {'disposition': 'empty'}),
    ('terminalReply', {'disposition': 'visible', 'text': 4}),
    ('terminalReply', {'disposition': 'visible', 'text': ''}),
    ('endedAt', True), ('endedAt', float('nan')), ('endedAt', 0),
])
def test_weak_receipts_prove_settlement_without_inventing_a_reply(field, value):
    receipt = terminal()
    receipt[field] = value
    fact = wait_outcome(receipt, 'exact-run', 'native-session')
    assert fact is not None and not fact['complete'] and fact['text'] is None


@pytest.mark.parametrize('text,complete', [('完整正文', True), ('字'*4094, True),
    ('字'*4095, False), ('字'*4095+'…', False), ('😀'*2048, False), ('x'*100000, False)],
    ids=['short', 'below-cap', 'boundary', 'truncated', 'utf16-cap', 'oversize'])
def test_producer_summary_limit_uses_utf16_and_never_replaces_full_output(text, complete):
    fact = wait_outcome(terminal(text=text), 'exact-run', 'native-session')
    assert fact['complete'] is complete
    assert fact['text'] == (text if complete else None)


@pytest.mark.parametrize('extra,code', [({'stopReason': 'max_tokens'}, 'model_output_limit'),
    ({'stopReason': 'tool_use'}, 'model_run_incomplete'),
    ({'status': 'error', 'error': 'PRIVATE'}, 'model_run_failed'),
    ({'livenessState': 'abandoned'}, 'model_run_failed')])
def test_explicit_incomplete_run_preserves_canonical_partial_and_safe_cause(extra, code):
    fact = wait_outcome(terminal(**extra), 'exact-run', 'native-session')
    assert not fact['complete'] and fact['text'] == '隔离协议最终回复'
    assert fact['error']['code'] == code and 'PRIVATE' not in str(fact)


@pytest.mark.parametrize('reason', [True, {'text': 'PRIVATE'}, 'PRIVATE', 'x'*5000])
def test_unknown_or_malformed_stop_reason_is_not_success_and_does_not_leak(reason):
    fact = wait_outcome(terminal(stopReason=reason), 'exact-run', 'native-session')
    assert not fact['complete'] and fact['stopReason'] == 'unknown'
    assert 'PRIVATE' not in str(fact)


def test_missing_runtime_identity_cannot_confirm_a_reply():
    receipt = terminal()
    receipt['terminalReceipt'].pop('sessionId')
    assert not wait_outcome(receipt, 'exact-run', None)['complete']


@pytest.mark.parametrize('field', ['runId', 'sessionId'])
def test_contradictory_terminal_identity_is_not_settlement(field):
    receipt = terminal()
    receipt['terminalReceipt'][field] = 'foreign'
    assert wait_outcome(receipt, 'exact-run', 'native-session') is None


def test_live_disconnect_waits_through_timeouts_and_foreign_runs_without_abort(monkeypatch):
    import easel.gateway_agent as gateway
    monkeypatch.setattr(gateway.time, 'sleep', lambda _: None)
    calls = []
    replies = iter([{'status': 'timeout', 'runId': 'exact-run'},
                    terminal(run='foreign'), terminal()])
    class Client:
        def _rpc(self, method, params, **kwargs):
            calls.append((method, copy.deepcopy(params)))
            if method == 'agent':
                kwargs['on_accepted']({'runId': 'exact-run'})
                raise OSError('isolated dropped receiver')
            assert method == 'agent.wait'
            return next(replies)
        def close(self): pass
    proc = GatewayAgentProc(Client(), Client, {'idempotencyKey': 'logical-turn',
        'agentId': 'main', 'sessionId': 'native-session', 'sessionKey': 'agent:main:chat'}, 10)
    assert proc.wait(2) == 0 and proc.clean_end and proc.error_text is None
    assert ''.join(proc.stdout) == '隔离协议最终回复\n'
    assert [m for m, _ in calls] == ['agent', 'agent.wait', 'agent.wait', 'agent.wait']
    assert all(p == {'runId': 'exact-run', 'timeoutMs': 1000} for m, p in calls if m == 'agent.wait')


def test_explicit_stop_during_disconnected_observation_aborts_only_exact_run():
    waiting, release = threading.Event(), threading.Event()
    calls = []
    class Client:
        def _rpc(self, method, params, **kwargs):
            calls.append((method, dict(params)))
            if method == 'agent':
                kwargs['on_accepted']({'runId': 'exact-run'})
                raise OSError('isolated dropped receiver')
            if method == 'agent.wait':
                waiting.set()
                assert release.wait(3)
                return terminal()
            assert method == 'chat.abort' and params['runId'] == 'exact-run'
            release.set()
            return {'ok': True, 'aborted': True, 'runIds': ['exact-run']}
        def close(self): pass
    proc = GatewayAgentProc(Client(), Client, {'idempotencyKey': 'logical-turn',
        'agentId': 'main', 'sessionId': 'native-session', 'sessionKey': 'agent:main:chat'}, 10)
    assert waiting.wait(2)
    proc.terminate()
    assert proc.wait(2) == 1 and not proc.clean_end
    assert ''.join(proc.stdout) == ''
    assert len([m for m, _ in calls if m == 'agent']) == 1
    assert [p['runId'] for m, p in calls if m == 'chat.abort'] == ['exact-run']


def test_actual_chat_supervisor_recovers_native_response_after_receiver_disconnect(sandbox, monkeypatch):
    from easel.codex_service import CodexService
    from types import SimpleNamespace
    import office_controls
    calls = []
    class Client:
        def _rpc(self, method, params, **kwargs):
            calls.append((method, dict(params)))
            if method == 'agent':
                kwargs['on_accepted']({'runId':'exact-run'})
                raise OSError('isolated receiver disconnected')
            assert method == 'agent.wait' and params['runId'] == 'exact-run'
            return terminal(session=web._openclaw_session_id('live-fixture'))
        def close(self): pass
    sandbox.transport = 'cli'
    monkeypatch.setattr(web, '_codex_service', CodexService(sandbox.path/'outputs'))
    monkeypatch.setattr(web, '_chat_message', lambda req, **_: req.message)
    monkeypatch.setattr(web, '_native_agent_client', lambda _: Client())
    monkeypatch.setattr(office_controls, '_model_probe_client', lambda *_: Client())
    monkeypatch.setattr(web, '_browser_service', SimpleNamespace(has_pages=lambda _: False))
    async def scenario():
        response = await web.api_chat_stream(web.ChatRequest(message='隔离协议请求',
            sessionId='live-fixture', turnId='live-turn', engine='openclaw'))
        received = [e async for e in response.body_iterator]
        assert received[-1]['event'] == 'done'
        assert all(e['event'] not in ('error','recovery_required') for e in received)
        saved = await web.api_chat_last('live-fixture', 'live-turn')
        assert saved['clean_end'] and saved['text'] == '隔离协议最终回复' and not saved['error']
        row = web.run_ledger.read(web._run_ledger_root(), 'live-turn')
        assert row['status'] == 'completed' and row['resourceSettled']
    asyncio.run(asyncio.wait_for(scenario(), 8))
    assert [m for m, _ in calls] == ['agent','agent.wait']


def recovered(lost):
    marker, events, calls, state = lost
    store = durable_lost()
    state['wait'] = terminal(session=web._openclaw_session_id('recovery-chat'))
    return marker, events, calls, state, store


def test_orphan_replaces_outdated_prefix_and_sse_finishes_once(lost):
    marker, events, calls, state, store = recovered(lost)
    async def replay():
        response = await web.api_chat_job_stream('lost-turn')
        return [event async for event in response.body_iterator]
    received = asyncio.run(asyncio.wait_for(replay(), 3))
    assert received[-1]['event'] == 'done' and all(e['event'] != 'error' for e in received)
    saved = json.loads(marker.read_text(encoding='utf-8'))
    assert saved['text'] == '隔离协议最终回复' and saved['thinking'] == 'retained thinking'
    assert saved['clean_end'] and saved['error'] is None
    row = web.run_ledger.read(web._run_ledger_root(), 'lost-turn')
    assert row['status'] == 'completed' and row['resourceSettled']
    assert store.pending_chat('recovery-chat') is None
    before = events.read_bytes(), marker.read_bytes(), row
    assert reconcile_orphan(web, 'recovery-chat', 'lost-turn')['stopped']
    assert (events.read_bytes(), marker.read_bytes(), web.run_ledger.read(web._run_ledger_root(), 'lost-turn')) == before
    assert [m for m, _ in calls] == ['agent.wait']


def test_sse_waits_for_exact_active_run_without_raw_log_or_stop_requirement(lost, monkeypatch):
    marker, events, calls, state, store = recovered(lost)
    final = state['wait']
    state['wait'] = {'status': 'timeout', 'runId': 'exact-run'}
    import chat_recovery
    original = chat_recovery.reconcile_orphan
    def checked(*args, **kwargs):
        result = original(*args, **kwargs)
        state['wait'] = final
        return result
    monkeypatch.setattr(chat_recovery, 'reconcile_orphan', checked)
    async def replay():
        response = await web.api_chat_job_stream('lost-turn')
        return [e async for e in response.body_iterator]
    received = asyncio.run(asyncio.wait_for(replay(), 5))
    assert received[-1]['event'] == 'done'
    assert all(e['event'] not in ('error', 'recovery_required') for e in received)
    assert [m for m, _ in calls] == ['agent.wait', 'agent.wait']


def test_provider_receipt_survives_final_snapshot_failure_then_recovers_without_rpc(lost, monkeypatch):
    marker, events, calls, state, store = recovered(lost)
    original = web._save_turn
    def save(*args, **kwargs):
        return False if args[1] == 'done' else original(*args, **kwargs)
    monkeypatch.setattr(web, '_save_turn', save)
    assert not reconcile_orphan(web, 'recovery-chat', 'lost-turn')['stopped']
    assert store.pending_chat('recovery-chat') == 'lost-turn'
    assert not web.run_ledger.read(web._run_ledger_root(), 'lost-turn')['settled']
    saved = json.loads(web._run_snapshot_file('lost-turn').read_text(encoding='utf-8'))
    assert saved['recovery']['outcome']['complete'] is True
    monkeypatch.setattr(web, '_save_turn', original)
    assert reconcile_orphan(web, 'recovery-chat', 'lost-turn')['stopped']
    assert [m for m, _ in calls] == ['agent.wait']
    assert sum(e['event'] == 'text_snapshot' and e['data'] == '隔离协议最终回复'
               for e in web._read_job_events('lost-turn')) == 1
    assert json.loads(marker.read_text(encoding='utf-8'))['clean_end']


def test_cleanup_retry_preserves_recovered_success_without_another_native_call(lost, monkeypatch):
    marker, events, calls, state, store = recovered(lost)
    def failed(*_): raise OSError('isolated cleanup failure')
    monkeypatch.setattr(web._browser_service, 'has_pages', lambda _: True)
    monkeypatch.setattr(web._browser_service, 'call', failed, raising=False)
    assert not reconcile_orphan(web, 'recovery-chat', 'lost-turn')['stopped']
    assert json.loads(marker.read_text(encoding='utf-8'))['clean_end']
    assert store.pending_chat('recovery-chat') == 'lost-turn'
    monkeypatch.setattr(web._browser_service, 'has_pages', lambda _: False)
    assert reconcile_orphan(web, 'recovery-chat', 'lost-turn')['stopped']
    assert [m for m, _ in calls] == ['agent.wait']
    assert web.run_ledger.read(web._run_ledger_root(), 'lost-turn')['status'] == 'completed'


def test_stop_and_long_summary_do_not_turn_partial_or_cancelled_runs_into_success(lost):
    marker, events, calls, state, store = recovered(lost)
    state['wait'] = terminal(session=web._openclaw_session_id('recovery-chat'), text='x'*4095+'…')
    assert reconcile_orphan(web, 'recovery-chat', 'lost-turn')['stopped']
    saved = json.loads(marker.read_text(encoding='utf-8'))
    assert not saved['clean_end'] and saved['text'] == 'corrected reply'
    assert saved['error']['code'] == 'chat_supervisor_lost'


def test_explicit_abort_wins_over_available_success(lost):
    marker, events, calls, state, store = recovered(lost)
    assert stop_orphan(web, 'recovery-chat', 'lost-turn')['stopped']
    saved = json.loads(marker.read_text(encoding='utf-8'))
    assert not saved['clean_end'] and saved['text'] == 'corrected reply'
    assert [m for m, _ in calls] == ['chat.abort']


def test_newer_turn_and_its_browser_are_preserved_during_old_success_recovery(lost, monkeypatch):
    marker, events, calls, state, store = recovered(lost)
    assert web._save_turn('web:recovery-chat', 'running', 'corrected reply', {'turn_id': 'lost-turn'})
    assert web._save_turn('web:recovery-chat', 'done', 'new reply', {'turn_id': 'new-turn', 'clean_end': True})
    before = marker.read_bytes()
    cancellations = []
    monkeypatch.setattr(web._browser_service, 'has_pages', lambda _: True)
    monkeypatch.setattr(web._browser_service, 'call', lambda *args: cancellations.append(args), raising=False)
    assert not reconcile_orphan(web, 'recovery-chat', 'lost-turn')['stopped']
    assert marker.read_bytes() == before and cancellations == []
    saved = asyncio.run(web.api_chat_last('recovery-chat', turn_id='lost-turn'))
    assert saved['clean_end'] and saved['text'] == '隔离协议最终回复'


@pytest.mark.parametrize('pause', [False, True])
def test_recovered_goal_run_does_not_bypass_human_acceptance_or_resume_pause(lost, monkeypatch, pause):
    from task_service import TaskService
    from easel.task_rules import GoalSpec
    marker, events, calls, state = lost
    store = web._task_service.store.__class__(web.OUTPUTS_DIR)
    goal = store.create_goal(GoalSpec(objective='隔离协议质量验收', modelRef='fixture/model',
        criteria=[{'type': 'review', 'label': '人工验收', 'value': ''}]).model_dump(), session='recovery-chat')
    store.change_goal(goal['id'], 'start')
    _, run = store.claim('lost-owner')
    store.bind_provider('recovery-chat', run['turnId'], 'exact-run')
    with store.db() as db:
        db.execute('UPDATE runs SET lease=0 WHERE id=?', (run['id'],))
    assert store.claim('new-owner') is None
    if pause:
        factory = web._native_agent_client
        class PauseWhileWaiting:
            def __init__(self, *args): self.client = factory(*args)
            def _rpc(self, method, params, **kwargs):
                result = self.client._rpc(method, params, **kwargs)
                if method == 'agent.wait':
                    store.change_goal(goal['id'], 'pause')
                return result
            def close(self): self.client.close()
        monkeypatch.setattr(web, '_native_agent_client', PauseWhileWaiting)
    web.run_ledger.accept(web._run_ledger_root(), run['turnId'], session_id='recovery-chat',
                          session_key='agent:main:recovery-chat')
    web.run_ledger.mark(web._run_ledger_root(), run['turnId'], status='running',
                        provider_run_id='exact-run', transport='native')
    marker.write_text(json.dumps({'status': 'running', 'turn_id': run['turnId']}))
    web._job_event_file(run['turnId']).write_bytes(events.read_bytes())
    state['wait'] = terminal(session=web._openclaw_session_id('recovery-chat'))
    service = TaskService(web)
    monkeypatch.setattr(service, 'admit', lambda *_: pytest.fail('Recovery must not dispatch'))
    asyncio.run(service.tick())
    saved = store.get('goals', goal['id'])
    assert saved['status'] == ('paused' if pause else 'blocked')
    assert saved['status'] != 'completed'
    assert len(store.snapshot()['runs']) == 1 and store.snapshot()['runs'][0]['state'] == 'completed'
    assert all(check['state'] != 'passed' for check in saved['checks'] if check['type'] == 'review')
    assert [m for m, _ in calls] == ['agent.wait']
