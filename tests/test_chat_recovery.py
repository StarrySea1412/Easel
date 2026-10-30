"""Stop/replay regressions use isolated files and fake gateway receipts."""
import asyncio
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import app as web
from chat_recovery import release_finished_chat, stop_orphan, reconcile_orphan
from easel.task_store import TaskStore, TaskConflict


@pytest.fixture
def lost(tmp_path, monkeypatch):
    monkeypatch.setattr(web, 'OUTPUTS_DIR', tmp_path / 'outputs')
    monkeypatch.setattr(web, '_browser_service', SimpleNamespace(has_pages=lambda _: False))
    monkeypatch.setattr(web, 'SESSIONS_DIR', tmp_path)
    monkeypatch.setattr(web, '_CHAT_JOBS', {})
    monkeypatch.setattr(web, '_RUNNING_CHAT', {})
    monkeypatch.setattr(web, 'SHARED_RAW_STREAM', tmp_path / 'raw.jsonl')
    monkeypatch.setattr(web, 'gateway_credentials', lambda: None)
    marker = web._turn_file('web:recovery-chat')
    marker.write_text(json.dumps({'status': 'running', 'turn_id': 'lost-turn', 'gateway_run_id': 'exact-run'}))
    events = web._job_event_file('lost-turn')
    events.parent.mkdir()
    events.write_text('\n'.join(json.dumps({'id': i, 'event': kind, 'data': value}) for i, (kind, value) in enumerate([
        ('token', 'outdated'), ('text_snapshot', 'corrected'), ('token', ' reply'), ('thinking', 'retained thinking')], 1)) + '\n')
    calls = []
    state = {'receipt': {'ok': True, 'aborted': True, 'runIds': ['exact-run']}, 'wait': {'status': 'timeout'}}
    class Client:
        def _rpc(self, method, params, **kwargs):
            calls.append((method, params))
            if state.get('replace'):
                marker.write_text(json.dumps({'status': 'running', 'turn_id': 'new-turn'}))
            return state['receipt'] if method == 'chat.abort' else state['wait']
        def close(self): pass
    monkeypatch.setattr(web, '_native_agent_client', lambda _: Client())
    return marker, events, calls, state


def terminal_lease():
    store = TaskStore(web.OUTPUTS_DIR)
    store.reserve_chat('recovery-chat', 'lost-turn')
    web.run_ledger.create(web._run_ledger_root(), 'lost-turn', session_id='recovery-chat',
                          session_key='agent:main:recovery-chat')
    web.run_ledger.mark(web._run_ledger_root(), 'lost-turn', status='failed',
                        settled=True, resource_settled=True)
    marker = web._turn_file('web:recovery-chat')
    marker.write_text(json.dumps({'status': 'done', 'turn_id': 'lost-turn',
                                 'error': {'code': 'chat_supervisor_lost'}, 'text': 'corrected reply'}))
    with web._job_event_file('lost-turn').open('a', encoding='utf-8') as stream:
        stream.write(json.dumps({'id': 5, 'event': 'done',
                                 'data': {'sessionKey': 'recovery-chat', 'stopped': False}}) + '\n')
    return store


@pytest.mark.parametrize('aborted', [True, False])
def test_orphan_settlement_releases_exact_reservation(lost, aborted):
    store = TaskStore(web.OUTPUTS_DIR)
    store.reserve_chat('recovery-chat', 'lost-turn')
    lost[3]['receipt'] = {'ok': True, 'aborted': aborted, 'runIds': ['exact-run'] if aborted else []}
    assert stop_orphan(web, 'recovery-chat', 'lost-turn')['stopped']
    assert store.chat_lease('recovery-chat') is None
    store.reserve_chat('recovery-chat', 'new-turn')
    assert store.chat_lease('recovery-chat') == 'new-turn'


def test_saved_terminal_repairs_reservation_idempotently_without_gateway_call(lost):
    store = terminal_lease()
    before = lost[0].read_bytes(), lost[1].read_bytes()
    assert stop_orphan(web, 'recovery-chat', 'lost-turn')['stopped']
    assert stop_orphan(web, 'recovery-chat', 'lost-turn')['stopped']
    assert store.chat_lease('recovery-chat') is None
    assert lost[2] == [] and before == (lost[0].read_bytes(), lost[1].read_bytes())


def test_settled_ledger_with_unfinished_marker_repairs_without_provider_request(lost):
    store = terminal_lease()
    lost[0].write_text(json.dumps({'status': 'running', 'turn_id': 'lost-turn', 'text': 'preserved'}))
    assert stop_orphan(web, 'recovery-chat', 'lost-turn')['stopped']
    assert store.chat_lease('recovery-chat') is None and lost[2] == []
    marker = json.loads(lost[0].read_text())
    assert marker['status'] == 'done' and marker['text'] == 'corrected reply'


@pytest.mark.parametrize('fault', ['active', 'unsettled', 'resources_pending', 'foreign_session',
                                  'foreign_turn', 'unknown', 'marker_running', 'new_marker',
                                  'corrupt_marker', 'missing_ledger', 'local_job'])
def test_admission_repair_keeps_unconfirmed_or_foreign_reservation(lost, fault, monkeypatch):
    store = terminal_lease()
    ledger = web.run_ledger.read(web._run_ledger_root(), 'lost-turn')
    changes = {'active': {'status': 'running'}, 'unsettled': {'settled': False},
               'resources_pending': {'resourceSettled': False}, 'foreign_session': {'sessionId': 'foreign'},
               'foreign_turn': {'turnId': 'foreign'}, 'unknown': {'status': 'unknown'}}
    ledger.update(changes.get(fault, {}))
    monkeypatch.setattr(web.run_ledger, 'read', lambda *_: None if fault == 'missing_ledger' else ledger)
    if fault == 'marker_running': lost[0].write_text(json.dumps({'status': 'running', 'turn_id': 'lost-turn'}))
    if fault == 'new_marker': lost[0].write_text(json.dumps({'status': 'done', 'turn_id': 'new-turn'}))
    if fault == 'corrupt_marker': lost[0].write_text('{')
    if fault == 'local_job': monkeypatch.setattr(web, '_CHAT_JOBS', {'lost-turn': ('recovery-chat', None)})
    assert not release_finished_chat(web, store, 'recovery-chat')
    assert store.chat_lease('recovery-chat') == 'lost-turn'
    assert lost[2] == []


def test_admission_repair_does_not_release_a_live_process_lock(lost):
    store = terminal_lease()
    lock = web._CrossProcLock('recovery-chat')
    assert lock.acquire(timeout=0)
    try:
        assert not release_finished_chat(web, store, 'recovery-chat')
        assert store.chat_lease('recovery-chat') == 'lost-turn'
    finally:
        lock.release()


def test_late_release_cannot_delete_a_newer_reservation(lost, monkeypatch):
    store = terminal_lease()
    original = store.release_chat
    def replace_before_release(session, turn):
        original(session, turn)
        store.reserve_chat(session, 'newer-turn')
        original(session, turn)
    monkeypatch.setattr(store, 'release_chat', replace_before_release)
    assert release_finished_chat(web, store, 'recovery-chat')
    assert store.chat_lease('recovery-chat') == 'newer-turn'


def test_api_next_send_repairs_old_terminal_and_dispatches_new_request_once(lost, monkeypatch):
    store = terminal_lease()
    before = lost[0].read_bytes(), lost[1].read_bytes()
    dispatched = []
    async def start(req, **kwargs):
        dispatched.append(req.turnId)
        assert store.chat_lease('recovery-chat') == 'next-turn'
        await kwargs['on_done']()
        return {'accepted': req.turnId}
    monkeypatch.setattr(web, 'start_chat_run', start)
    result = asyncio.run(web.api_chat_stream(web.ChatRequest(
        message='explicit next message', sessionId='recovery-chat', turnId='next-turn')))
    assert result == {'accepted': 'next-turn'} and dispatched == ['next-turn']
    assert store.chat_lease('recovery-chat') is None and lost[2] == []
    assert before == (lost[0].read_bytes(), lost[1].read_bytes())


def test_api_unconfirmed_reservation_still_returns_409_without_dispatch(lost, monkeypatch):
    store = TaskStore(web.OUTPUTS_DIR)
    store.reserve_chat('recovery-chat', 'lost-turn')
    async def no_dispatch(*args, **kwargs):
        pytest.fail('unconfirmed run must not dispatch')
    monkeypatch.setattr(web, 'start_chat_run', no_dispatch)
    with pytest.raises(web.HTTPException) as caught:
        asyncio.run(web.api_chat_stream(web.ChatRequest(message='next', sessionId='recovery-chat', turnId='next-turn')))
    assert caught.value.status_code == 409
    assert store.chat_lease('recovery-chat') == 'lost-turn'


def test_orphan_stop_ends_replay_and_preserves_latest_text_without_a_paid_request(lost):
    marker, events, calls, state = lost
    assert stop_orphan(web, 'recovery-chat', 'lost-turn') == {'stopped': True, 'status': 'stopped'}
    saved = json.loads(marker.read_text(encoding='utf-8'))
    assert saved['status'] == 'done' and saved['stop_reason'] == 'user_stopped'
    assert saved['text'] == 'corrected reply' and saved['thinking'] == 'retained thinking'
    assert saved['error'] is None
    assert [method for method, _ in calls] == ['chat.abort']
    assert calls[0][1] == {'sessionKey': 'agent:main:recovery-chat', 'runId': 'exact-run', 'agentId': 'main'}
    assert json.loads(events.read_text(encoding='utf-8').splitlines()[-1])['data']['stopped'] is True


def test_finished_gateway_without_supervisor_is_interrupted_not_fabricated_success(lost):
    marker, events, calls, state = lost
    state['receipt'] = {'ok': True, 'aborted': False, 'runIds': []}
    assert stop_orphan(web, 'recovery-chat', 'lost-turn')['status'] == 'already_finished'
    saved = json.loads(marker.read_text(encoding='utf-8'))
    assert saved['text'] == 'corrected reply' and saved['error']['code'] == 'chat_supervisor_lost'
    assert not saved['clean_end']


def test_unmatched_abort_and_unknown_wait_never_release_or_rewrite_old_run(lost):
    marker, events, calls, state = lost
    before = marker.read_bytes(), events.read_bytes()
    state['receipt'] = {'ok': True, 'aborted': True, 'runIds': ['foreign-run']}
    state['wait'] = {'status': 'ok', 'runId': 'foreign-run'}
    assert stop_orphan(web, 'recovery-chat', 'lost-turn')['stopped'] is False
    assert (marker.read_bytes(), events.read_bytes()) == before


def test_old_stop_does_not_overwrite_new_turn_while_gateway_is_awaited(lost):
    marker, events, calls, state = lost
    state['replace'] = True
    assert stop_orphan(web, 'recovery-chat', 'lost-turn')['status'] == 'superseded'
    assert json.loads(marker.read_text(encoding='utf-8'))['turn_id'] == 'new-turn'
    assert len(events.read_text(encoding='utf-8').splitlines()) == 4


def test_unconfirmed_legacy_done_marker_does_not_prove_resource_release(lost):
    marker, events, calls, state = lost
    marker.write_text(json.dumps({'status': 'done', 'turn_id': 'lost-turn', 'text': 'complete'}))
    assert stop_orphan(web, 'recovery-chat', 'lost-turn')['stopped'] is False
    assert calls == [] and json.loads(marker.read_text(encoding='utf-8'))['text'] == 'complete'


def test_orphan_stop_prefers_durable_provider_identity_after_web_restart(lost):
    marker, events, calls, state = lost
    marker.write_text(json.dumps({'status': 'running', 'turn_id': 'lost-turn'}))
    web.run_ledger.create(web._run_ledger_root(), 'lost-turn', session_id='recovery-chat',
                          session_key='agent:main:recovery-chat')
    web.run_ledger.mark(web._run_ledger_root(), 'lost-turn', event='provider_accepted',
                        status='running', provider_run_id='ledger-run', transport='native')
    state['receipt'] = {'ok': True, 'aborted': True, 'runIds': ['ledger-run']}
    assert stop_orphan(web, 'recovery-chat', 'lost-turn') == {'stopped': True, 'status': 'stopped'}
    assert calls[0][0] == 'chat.abort' and calls[0][1]['runId'] == 'ledger-run'
    ledger = web.run_ledger.read(web._run_ledger_root(), 'lost-turn')
    assert ledger['providerRunId'] == 'ledger-run' and ledger['status'] == 'stopped'


@pytest.mark.parametrize('witnessed', [True, False])
def test_legacy_run_requires_exact_gateway_stream_identity(lost, witnessed):
    marker, events, calls, state = lost
    marker.write_text(json.dumps({'status': 'running', 'turn_id': 'lost-turn'}))
    web.SHARED_RAW_STREAM.write_text(json.dumps({'runId': 'lost-turn' if witnessed else 'foreign-run'}))
    state['receipt']['runIds'] = ['lost-turn']
    assert stop_orphan(web, 'recovery-chat', 'lost-turn')['stopped'] is witnessed
    assert bool(calls) is witnessed


def test_replay_with_existing_log_and_no_owner_ends_with_actionable_recovery(lost):
    async def replay():
        response = await web.api_chat_job_stream('lost-turn')
        return [event async for event in response.body_iterator]
    events = asyncio.run(asyncio.wait_for(replay(), 1))
    assert events[-1]['event'] == 'recovery_required'
    assert '停止' in json.loads(events[-1]['data'])


def durable_lost():
    store = TaskStore(web.OUTPUTS_DIR)
    store.reserve_chat('recovery-chat', 'lost-turn')
    web.run_ledger.accept(web._run_ledger_root(), 'lost-turn', session_id='recovery-chat',
                          session_key='agent:main:recovery-chat')
    web.run_ledger.mark(web._run_ledger_root(), 'lost-turn', status='running',
                        provider_run_id='exact-run', transport='native')
    return store


def test_passive_recovery_confirms_exact_run_without_abort_or_model_dispatch(lost):
    marker, events, calls, state = lost
    store = durable_lost()
    state['wait'] = {'status': 'ok', 'runId': 'exact-run'}
    assert reconcile_orphan(web, 'recovery-chat', 'lost-turn') == {'stopped': True, 'status': 'already_finished'}
    assert [method for method, _ in calls] == ['agent.wait']
    saved = json.loads(marker.read_text(encoding='utf-8'))
    assert saved['text'] == 'corrected reply' and not saved['clean_end']
    assert saved['error']['code'] == 'chat_supervisor_lost'
    record = web.run_ledger.read(web._run_ledger_root(), 'lost-turn')
    assert record['status'] == 'failed' and record['resourceSettled']
    assert record['resourceFacts'] == {'provider': True, 'browser': True}
    assert store.pending_chat('recovery-chat') is None
    before = marker.read_bytes(), events.read_bytes(), record['eventSeq']
    assert reconcile_orphan(web, 'recovery-chat', 'lost-turn')['stopped']
    assert (marker.read_bytes(), events.read_bytes(), web.run_ledger.read(web._run_ledger_root(), 'lost-turn')['eventSeq']) == before
    assert [method for method, _ in calls] == ['agent.wait']


def test_passive_active_run_keeps_every_fact_and_chat_reservation(lost):
    marker, events, calls, state = lost
    store = durable_lost()
    state['wait'] = {'status': 'timeout', 'runId': 'exact-run'}
    before = marker.read_bytes(), events.read_bytes(), web.run_ledger.read(web._run_ledger_root(), 'lost-turn')
    assert reconcile_orphan(web, 'recovery-chat', 'lost-turn') == {'stopped': False, 'status': 'active'}
    assert (marker.read_bytes(), events.read_bytes(), web.run_ledger.read(web._run_ledger_root(), 'lost-turn')) == before
    assert store.pending_chat('recovery-chat') == 'lost-turn'
    assert [method for method, _ in calls] == ['agent.wait']


def test_failed_browser_cleanup_retains_reservation_and_retries_without_second_abort(lost, monkeypatch):
    marker, events, calls, state = lost
    store = durable_lost()
    cleanup = {'fail': True, 'calls': 0}
    def cancel(*_):
        cleanup['calls'] += 1
        if cleanup['fail']:
            raise TimeoutError('Isolated cleanup fixture')
    monkeypatch.setattr(web, '_browser_service', SimpleNamespace(has_pages=lambda _: True, call=cancel))
    assert stop_orphan(web, 'recovery-chat', 'lost-turn') == {'stopped': False, 'status': 'unconfirmed'}
    record = web.run_ledger.read(web._run_ledger_root(), 'lost-turn')
    assert record['status'] == 'stopped' and record['settled'] and not record['resourceSettled']
    assert record['resourceFacts'] == {'provider': True, 'browser': False}
    assert store.pending_chat('recovery-chat') == 'lost-turn'
    assert not any(e['event'] == 'done' for e in web._read_job_events('lost-turn'))
    cleanup['fail'] = False
    assert stop_orphan(web, 'recovery-chat', 'lost-turn')['stopped']
    assert cleanup['calls'] == 2 and [method for method, _ in calls] == ['chat.abort']
    assert store.pending_chat('recovery-chat') is None
    assert web.run_ledger.read(web._run_ledger_root(), 'lost-turn')['resourceSettled']


def test_settled_reply_with_pending_resources_still_requires_provider_confirmation(lost):
    marker, events, calls, state = lost
    store = durable_lost()
    web.run_ledger.mark(web._run_ledger_root(), 'lost-turn', status='failed', settled=True)
    state['wait'] = {'status': 'timeout', 'runId': 'exact-run'}
    assert not reconcile_orphan(web, 'recovery-chat', 'lost-turn')['stopped']
    assert store.pending_chat('recovery-chat') == 'lost-turn'
    assert calls[0][0] == 'agent.wait'


def test_durable_provider_identity_wins_over_an_outdated_marker(lost):
    marker, events, calls, state = lost
    durable_lost()
    marker.write_text(json.dumps({'status': 'running', 'turn_id': 'lost-turn', 'gateway_run_id': 'outdated-run'}))
    assert stop_orphan(web, 'recovery-chat', 'lost-turn')['stopped']
    assert calls[0][1]['runId'] == 'exact-run'


def test_recovered_final_stays_separate_from_an_incomplete_log_tail(lost):
    marker, events, calls, state = lost
    durable_lost()
    with events.open('ab') as stream:
        stream.write(b'{"id":5,"event":"token","data":"\xe4\xb8')
    original = events.read_bytes()
    assert stop_orphan(web, 'recovery-chat', 'lost-turn')['stopped']
    assert events.read_bytes().startswith(original + b'\n')
    assert web._read_job_events('lost-turn')[-1]['event'] == 'done'
    assert json.loads(marker.read_text(encoding='utf-8'))['text'] == 'corrected reply'


def test_expired_and_duplicate_chat_reservations_require_positive_release(tmp_path):
    now = [1000]
    store = TaskStore(tmp_path, clock=lambda: now[0])
    store.reserve_chat('fixture-session', 'fixture-turn')
    now[0] += 7201
    for turn in ['fixture-turn', 'another-turn']:
        with pytest.raises(TaskConflict):
            store.reserve_chat('fixture-session', turn)
    assert store.session_work('fixture-session') == ['fixture-turn']
    store.release_chat('fixture-session', 'another-turn')
    assert store.pending_chat('fixture-session') == 'fixture-turn'
    store.release_chat('fixture-session', 'fixture-turn')
    store.reserve_chat('fixture-session', 'another-turn')


def test_http_passive_check_is_scoped_and_disables_caching(lost):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    marker, events, calls, state = lost
    durable_lost()
    state['wait'] = {'status': 'timeout', 'runId': 'exact-run'}
    app = FastAPI()
    app.post('/api/chat/runs/{turn_id}/reconcile')(web.api_chat_run_reconcile)
    with TestClient(app) as client:
        response = client.post('/api/chat/runs/lost-turn/reconcile?sessionId=recovery-chat')
        assert response.status_code == 200 and response.json()['status'] == 'active'
        assert response.headers['cache-control'] == 'no-store'
        assert client.post('/api/chat/runs/lost-turn/reconcile?sessionId=another-session').status_code == 404
    assert [method for method, _ in calls] == ['agent.wait']


def test_replay_automatically_reconciles_finished_orphan_without_a_new_request(lost):
    marker, events, calls, state = lost
    store = durable_lost()
    state['wait'] = {'status': 'ok', 'runId': 'exact-run'}
    async def replay():
        response = await web.api_chat_job_stream('lost-turn')
        return [event async for event in response.body_iterator]
    received = asyncio.run(asyncio.wait_for(replay(), 3))
    assert received[-1]['event'] == 'error'
    assert json.loads(received[-1]['data'])['code'] == 'chat_supervisor_lost'
    assert [method for method, _ in calls] == ['agent.wait']
    assert store.pending_chat('recovery-chat') is None


def _hold_session_in_process(root, ready, release):
    web.SESSIONS_DIR = Path(root)
    lock = web._CrossProcLock('recovery-chat')
    try:
        if lock.acquire(timeout=1):
            ready.set()
            release.wait(10)
            with web._job_event_file('lost-turn').open('a', encoding='utf-8') as stream:
                stream.write(json.dumps({'id': 5, 'event': 'done', 'data': {'sessionKey': 'recovery-chat'}}) + '\n')
    finally:
        lock.release()


def test_other_web_process_keeps_ownership_and_is_never_stopped(lost, monkeypatch):
    import multiprocessing
    marker, events, calls, state = lost
    store = durable_lost()
    ctx = multiprocessing.get_context('spawn')
    ready, release = ctx.Event(), ctx.Event()
    child = ctx.Process(target=_hold_session_in_process, args=(str(web.SESSIONS_DIR), ready, release))
    child.start()
    try:
        # Windows spawn imports the full web application before acquiring this
        # lock. Bound cold-start separately from the short lock/SSE assertions.
        assert ready.wait(30), f'owner process did not start (exitcode={child.exitcode})'
        before = marker.read_bytes(), events.read_bytes()
        assert stop_orphan(web, 'recovery-chat', 'lost-turn') == {'stopped': False, 'status': 'owned'}
        assert (marker.read_bytes(), events.read_bytes()) == before
        assert calls == [] and store.pending_chat('recovery-chat') == 'lost-turn'
        import chat_recovery
        observed = []
        original = chat_recovery.reconcile_orphan
        def check_owner(*args, **kwargs):
            result = original(*args, **kwargs)
            observed.append(result['status'])
            release.set()
            return result
        monkeypatch.setattr(chat_recovery, 'reconcile_orphan', check_owner)
        async def replay():
            response = await web.api_chat_job_stream('lost-turn')
            return [event async for event in response.body_iterator]
        received = asyncio.run(asyncio.wait_for(replay(), 3))
        assert observed == ['owned'] and received[-1]['event'] == 'done'
        assert calls == [] and all(e['event'] != 'recovery_required' for e in received)
    finally:
        release.set()
        child.join(8)
        if child.is_alive():
            child.terminate()
            child.join(3)
    assert child.exitcode == 0


def test_goal_recovery_settles_only_from_positive_existing_provider_receipt(lost, monkeypatch):
    from task_service import TaskService
    from easel.task_rules import GoalSpec
    marker, events, calls, state = lost
    store = TaskStore(web.OUTPUTS_DIR)
    goal = store.create_goal(GoalSpec(objective='隔离恢复夹具：保留初稿', modelRef='fixture/model',
        criteria=[{'type': 'file', 'label': '初稿', 'value': 'draft.txt'}]).model_dump(), session='recovery-chat')
    store.change_goal(goal['id'], 'start')
    _, run = store.claim('lost-owner')
    store.bind_provider('recovery-chat', run['turnId'], 'exact-run')
    with store.db() as db:
        db.execute('UPDATE runs SET lease=0 WHERE id=?', (run['id'],))
    assert store.claim('new-owner') is None
    assert store.running()[0]['state'] == 'unconfirmed'
    web.run_ledger.accept(web._run_ledger_root(), run['turnId'], session_id='recovery-chat', session_key='agent:main:recovery-chat')
    web.run_ledger.mark(web._run_ledger_root(), run['turnId'], status='running', provider_run_id='exact-run', transport='native')
    marker.write_text(json.dumps({'status': 'running', 'turn_id': run['turnId']}))
    web._job_event_file(run['turnId']).write_bytes(events.read_bytes())
    state['wait'] = {'status': 'ok', 'runId': 'exact-run'}
    service = TaskService(web)
    def unexpected(*_):
        raise AssertionError('Recovery must not dispatch a model')
    monkeypatch.setattr(service, 'admit', unexpected)
    asyncio.run(service.tick())
    assert [method for method, _ in calls] == ['agent.wait']
    assert store.running() == [] and len(store.snapshot()['runs']) == 1
    saved = store.get('goals', goal['id'])
    assert saved['status'] == 'blocked' and saved['phase'] == 'run_failed'
    assert store.snapshot()['runs'][0]['text'] == 'corrected reply'
