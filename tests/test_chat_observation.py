"""Existing provider output is observed without another model request."""
import asyncio
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import app as web
import chat_observation as observation
from chat_recovery import reconcile_orphan
from easel.task_store import TaskStore
from tests.test_chat_recovery import lost, durable_lost


def append(path, kind='assistant_text_stream', *, phase='text_delta', run='exact-run', session=None, **extra):
    row = {'event': kind, 'evtType': phase, 'runId': run, **extra}
    if session is not None:
        row['sessionId'] = session
    with path.open('ab') as stream:
        stream.write((json.dumps(row, ensure_ascii=False) + '\n').encode())


def test_reader_resumes_utf8_half_line_and_keeps_foreign_runs_out(tmp_path):
    path = tmp_path / 'raw.jsonl'
    point = observation.capture(path)
    append(path, delta='第一段', session='runtime')
    append(path, delta='FOREIGN', run='other')
    append(path, delta='WRONG SESSION', session='other')
    tail = (json.dumps({'event': 'assistant_text_stream', 'evtType': 'text_delta',
                       'runId': 'exact-run', 'delta': '第二段'}, ensure_ascii=False) + '\n').encode()
    with path.open('ab') as stream:
        stream.write(tail[:-3])
    first = observation.read(path, point, 'exact-run', 'runtime')
    assert first['text'] == '第一段'
    point = first['checkpoint']
    assert observation.read(path, point, 'exact-run', 'runtime')['checkpoint']['offset'] == point['offset']
    with path.open('ab') as stream:
        stream.write(tail[-3:])
    second = observation.read(path, point, 'exact-run', 'runtime')
    assert second['text'] == '第一段第二段'
    assert observation.read(path, second['checkpoint'], 'exact-run', 'runtime')['text'] == second['text']


def test_reader_pins_offset_detects_rewrite_rotation_and_invalid_rows(tmp_path):
    path = tmp_path / 'raw.jsonl'
    append(path, delta='old output')
    point = observation.capture(path)
    append(path, delta='new output')
    current = observation.read(path, point, 'exact-run', 'runtime')
    assert current['text'] == 'new output'
    original = path.read_bytes()
    at = point['offset'] - 1
    path.write_bytes(original[:at] + b'X' + original[at + 1:])
    assert observation.read(path, point, 'exact-run', 'runtime') is None
    path.write_bytes(original)
    old = tmp_path / 'rotated.jsonl'
    path.rename(old)
    path.write_bytes(original)
    assert observation.read(path, current['checkpoint'], 'exact-run', 'runtime') is None
    point = observation.capture(path)
    with path.open('ab') as stream:
        stream.write(b'not-json\n')
    assert observation.read(path, point, 'exact-run', 'runtime') is None
    assert old.read_bytes() == original


def test_reader_boundaries_thinking_wrappers_and_bounded_progress(tmp_path, monkeypatch):
    path = tmp_path / 'raw.jsonl'
    point = observation.capture(path)
    for text in ['<thi', 'nk>理由</think>初稿']:
        append(path, delta=text)
    append(path, 'assistant_message_end', rawText='<think>理由</think>初稿', rawThinking='理由')
    append(path, phase='text_start')
    append(path, delta='终稿')
    append(path, 'assistant_message_end', rawText='终稿')
    monkeypatch.setattr(observation, 'READ_BUDGET', 256)
    offsets = []
    for _ in range(20):
        result = observation.read(path, point, 'exact-run', 'runtime')
        assert result
        point = result['checkpoint']
        offsets.append(point['offset'])
        if not result['hasMore']:
            break
    assert offsets == sorted(set(offsets))
    assert offsets[-1] == path.stat().st_size
    assert result['text'] == '初稿终稿' and result['thinking'] == '理由'


def prepare_observation(lost):
    marker, events, calls, state = lost
    store = durable_lost()
    point = observation.capture(web.SHARED_RAW_STREAM)
    web.run_ledger.mark(web._run_ledger_root(), 'lost-turn', observation=point)
    append(web.SHARED_RAW_STREAM, delta='corrected reply plus new content')
    append(web.SHARED_RAW_STREAM, 'assistant_thinking_stream', phase='thinking_delta',
           delta='retained thinking plus observation')
    state['wait'] = {'status': 'timeout', 'runId': 'exact-run'}
    return marker, events, calls, state, store


def test_active_orphan_resumes_observation_and_repeat_does_not_duplicate(lost):
    marker, events, calls, state, store = prepare_observation(lost)
    assert reconcile_orphan(web, 'recovery-chat', 'lost-turn')['status'] == 'observing'
    saved = asyncio.run(web.api_chat_last('recovery-chat', turn_id='lost-turn'))
    assert saved['text'] == 'corrected reply plus new content'
    assert saved['thinking'] == 'retained thinking plus observation'
    assert store.pending_chat('recovery-chat') == 'lost-turn'
    before = events.read_bytes()
    assert reconcile_orphan(web, 'recovery-chat', 'lost-turn')['status'] == 'observing'
    assert events.read_bytes() == before
    append(web.SHARED_RAW_STREAM, delta=' after restart')
    state['wait'] = {'status': 'ok', 'runId': 'exact-run'}
    assert reconcile_orphan(web, 'recovery-chat', 'lost-turn')['stopped']
    saved = asyncio.run(web.api_chat_last('recovery-chat', turn_id='lost-turn'))
    assert saved['text'].endswith(' after restart') and not saved['clean_end']
    assert saved['error']['code'] == 'chat_supervisor_lost'
    assert store.pending_chat('recovery-chat') is None
    assert {method for method, _ in calls} == {'agent.wait'}


def test_sse_keeps_observing_existing_run_instead_of_requiring_stop(lost, monkeypatch):
    marker, events, calls, state, store = prepare_observation(lost)
    import chat_recovery
    original = chat_recovery.reconcile_orphan
    def recover(*args, **kwargs):
        result = original(*args, **kwargs)
        state['wait'] = {'status': 'ok', 'runId': 'exact-run'}
        return result
    monkeypatch.setattr(chat_recovery, 'reconcile_orphan', recover)
    async def replay():
        response = await web.api_chat_job_stream('lost-turn')
        return [event async for event in response.body_iterator]
    received = asyncio.run(asyncio.wait_for(replay(), 6))
    assert any(event['event'] == 'text_snapshot' and 'new content' in event['data'] for event in received)
    assert all(event['event'] != 'recovery_required' for event in received)
    assert received[-1]['event'] == 'error'
    assert all(method == 'agent.wait' for method, _ in calls)


def test_old_turn_snapshot_recovers_without_overwriting_new_turn_or_cancelling_its_browser(lost, monkeypatch):
    marker, events, calls, state, store = prepare_observation(lost)
    assert reconcile_orphan(web, 'recovery-chat', 'lost-turn')['status'] == 'observing'
    web._save_turn('web:recovery-chat', 'done', 'newer answer', {'turn_id': 'new-turn', 'clean_end': True})
    newer = marker.read_bytes()
    state['wait'] = {'status': 'ok', 'runId': 'exact-run'}
    cancellations = []
    monkeypatch.setattr(web._browser_service, 'has_pages', lambda _: True)
    monkeypatch.setattr(web._browser_service, 'call', lambda *args: cancellations.append(args), raising=False)
    assert reconcile_orphan(web, 'recovery-chat', 'lost-turn')['status'] == 'unconfirmed'
    assert marker.read_bytes() == newer and cancellations == []
    assert store.pending_chat('recovery-chat') == 'lost-turn'
    monkeypatch.setattr(web._browser_service, 'has_pages', lambda _: False)
    assert reconcile_orphan(web, 'recovery-chat', 'lost-turn')['stopped']
    assert marker.read_bytes() == newer and cancellations == []
    saved = asyncio.run(web.api_chat_last('recovery-chat', turn_id='lost-turn'))
    assert saved['text'] == 'corrected reply plus new content'
    assert asyncio.run(web.api_chat_last('recovery-chat', turn_id='new-turn'))['text'] == 'newer answer'
    assert asyncio.run(web.api_chat_last('another-session', turn_id='lost-turn'))['status'] == 'none'


def test_snapshot_failure_keeps_reservation_and_retry_does_not_duplicate_projection(lost, monkeypatch):
    marker, events, calls, state, store = prepare_observation(lost)
    save = web._save_turn
    monkeypatch.setattr(web, '_save_turn', lambda *_args, **_kwargs: False)
    assert reconcile_orphan(web, 'recovery-chat', 'lost-turn')['status'] == 'unconfirmed'
    before = events.read_bytes()
    assert store.pending_chat('recovery-chat') == 'lost-turn'
    monkeypatch.setattr(web, '_save_turn', save)
    assert reconcile_orphan(web, 'recovery-chat', 'lost-turn')['status'] == 'observing'
    assert events.read_bytes() == before


@pytest.mark.parametrize('damaged', [b'{"turn_id":', b'[]', b'\xff'])
def test_independent_turn_recovers_with_damaged_latest_marker_preserved(lost, damaged):
    marker, events, calls, state, store = prepare_observation(lost)
    assert reconcile_orphan(web, 'recovery-chat', 'lost-turn')['status'] == 'observing'
    marker.write_bytes(damaged)
    append(web.SHARED_RAW_STREAM, delta=' after latest marker damage')
    assert reconcile_orphan(web, 'recovery-chat', 'lost-turn')['status'] == 'observing'
    assert marker.read_bytes() == damaged
    state['wait'] = {'status': 'ok', 'runId': 'exact-run'}
    assert reconcile_orphan(web, 'recovery-chat', 'lost-turn')['stopped']
    assert marker.read_bytes() == damaged
    saved = asyncio.run(web.api_chat_last('recovery-chat', turn_id='lost-turn'))
    assert saved['text'].endswith(' after latest marker damage')
    assert store.pending_chat('recovery-chat') is None


def test_late_running_update_cannot_replace_terminal_snapshot_or_latest_turn(lost):
    marker, events, calls, state = lost
    assert web._save_turn('web:recovery-chat', 'done', 'complete answer', {'turn_id': 'lost-turn'})
    original = web._run_snapshot_file('lost-turn').read_bytes()
    web._save_turn('web:recovery-chat', 'done', 'next answer', {'turn_id': 'new-turn'})
    newer = marker.read_bytes()
    assert web._save_turn('web:recovery-chat', 'running', '', {'turn_id': 'lost-turn'}, expected_latest='lost-turn')
    assert web._run_snapshot_file('lost-turn').read_bytes() == original
    assert marker.read_bytes() == newer
