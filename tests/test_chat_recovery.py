"""Stop/replay regressions use isolated files and fake gateway receipts."""
import asyncio
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import app as web
from chat_recovery import release_finished_chat, stop_orphan
from easel.task_store import TaskStore, TaskConflict


@pytest.fixture
def lost(tmp_path, monkeypatch):
    monkeypatch.setattr(web, 'OUTPUTS_DIR', tmp_path / 'outputs')
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
                                 'error': {'code': 'chat_supervisor_lost'}, 'text': 'retained'}))
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
    assert marker['status'] == 'done' and marker['text'] == 'preserved'


@pytest.mark.parametrize('fault', ['active', 'unsettled', 'resources_pending', 'foreign_session',
                                  'foreign_turn', 'unknown', 'marker_running', 'new_marker',
                                  'corrupt_marker', 'missing_ledger', 'local_job'])
def test_admission_repair_keeps_unconfirmed_or_foreign_reservation(lost, fault, monkeypatch):
    store = terminal_lease()
    ledger_path = web._run_ledger_root() / 'runs' / 'lost-turn.json'
    ledger = json.loads(ledger_path.read_text())
    changes = {'active': {'status': 'running'}, 'unsettled': {'settled': False},
               'resources_pending': {'resourceSettled': False}, 'foreign_session': {'sessionId': 'foreign'},
               'foreign_turn': {'turnId': 'foreign'}, 'unknown': {'status': 'unknown'}}
    ledger.update(changes.get(fault, {})); ledger_path.write_text(json.dumps(ledger))
    if fault == 'marker_running': lost[0].write_text(json.dumps({'status': 'running', 'turn_id': 'lost-turn'}))
    if fault == 'new_marker': lost[0].write_text(json.dumps({'status': 'done', 'turn_id': 'new-turn'}))
    if fault == 'corrupt_marker': lost[0].write_text('{')
    if fault == 'missing_ledger': ledger_path.unlink()
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
        kwargs['on_done']()
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


def test_already_saved_final_does_not_send_another_abort(lost):
    marker, events, calls, state = lost
    marker.write_text(json.dumps({'status': 'done', 'turn_id': 'lost-turn', 'text': 'complete'}))
    assert stop_orphan(web, 'recovery-chat', 'lost-turn')['status'] == 'already_finished'
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
