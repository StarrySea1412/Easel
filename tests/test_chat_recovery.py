"""Stop/replay regressions use isolated files and fake gateway receipts."""
import asyncio
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import app as web
from chat_recovery import stop_orphan


@pytest.fixture
def lost(tmp_path, monkeypatch):
    monkeypatch.setattr(web, 'SESSIONS_DIR', tmp_path)
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
