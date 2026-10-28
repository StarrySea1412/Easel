"""Recovery commits must survive local storage failure without another model call."""
import asyncio
import json
import multiprocessing
import os
from pathlib import Path

import pytest
from fastapi import HTTPException

from easel.codex_service import CodexService
from easel import codex_settlement
from tests.test_codex_recovery import Client, case


def rows(service):
    return [json.loads(line) for line in service._event_path('s', 't').read_text(encoding='utf-8').splitlines()]


def deny_native(_):
    raise AssertionError('native read repeated')


def test_failed_terminal_snapshot_keeps_occupancy_until_restart_commit(case, monkeypatch):
    service, _, _, client = case
    persist = service._persist
    failed = False

    def fail_once(state):
        nonlocal failed
        if not failed and state.get('outcome') == 'completed':
            failed = True
            raise OSError('synthetic interrupted snapshot write')
        persist(state)

    monkeypatch.setattr(service, '_persist', fail_once)
    saved = service.reconcile('s', 't')
    assert failed
    assert saved['outcome'] == 'unconfirmed'
    assert service.session_work('s') == ['t']
    calls = len(client.calls)
    restored = CodexService(service.outputs, deny_native)
    saved = restored.reconcile('s', 't')
    assert saved['outcome'] == 'completed' and saved['text'] == 'original result'
    assert restored.session_work('s') == [] and len(client.calls) == calls
    events = rows(service)
    assert [row['event'] for row in events][-3:] == ['text_snapshot', 'execution', 'done']
    assert len([row for row in events if row['event'] == 'text_snapshot']) == 1


@pytest.mark.parametrize('boundary', ['pending-snapshot', 'event-replace', 'final-snapshot', 'journal-remove'])
def test_each_commit_boundary_is_retryable_without_requery(case, monkeypatch, boundary):
    service, _, _, client = case
    persist, replace, unlink = service._persist, codex_settlement.replace_events, Path.unlink
    journal = codex_settlement.path(service, 's', 't')
    failed = False

    def fail():
        nonlocal failed
        failed = True
        raise OSError('synthetic local write failure')

    def guarded_persist(state):
        if not failed and journal.exists() and (
                boundary == 'pending-snapshot' and state['outcome'] == 'unconfirmed'
                or boundary == 'final-snapshot' and state['outcome'] == 'completed'):
            fail()
        persist(state)

    def guarded_replace(*args):
        if not failed and boundary == 'event-replace':
            fail()
        replace(*args)

    def guarded_unlink(target, *args, **kwargs):
        if not failed and target == journal and boundary == 'journal-remove':
            fail()
        return unlink(target, *args, **kwargs)

    monkeypatch.setattr(service, '_persist', guarded_persist)
    monkeypatch.setattr(codex_settlement, 'replace_events', guarded_replace)
    monkeypatch.setattr(Path, 'unlink', guarded_unlink)
    assert service.reconcile('s', 't')['outcome'] == 'unconfirmed'
    assert failed and journal.exists() and service.session_work('s') == ['t']
    before = len(client.calls)
    assert service.reconcile('s', 't')['outcome'] == 'completed'
    assert not journal.exists() and service.session_work('s') == [] and len(client.calls) == before
    events = rows(service)
    assert [event['id'] for event in events] == [1, 2, 3, 4]
    assert [event['event'] for event in events] == ['error', 'text_snapshot', 'execution', 'done']
    raw = service._event_path('s', 't').read_bytes()
    service.reconcile('s', 't')
    assert service._event_path('s', 't').read_bytes() == raw and len(client.calls) == before


def leave_pending(service, monkeypatch):
    with monkeypatch.context() as patch:
        patch.setattr(codex_settlement, 'replace_events', lambda *_: (_ for _ in ()).throw(OSError('fixture failure')))
        assert service.reconcile('s', 't')['outcome'] == 'unconfirmed'
    return codex_settlement.path(service, 's', 't')


@pytest.mark.parametrize('damage', ['non-object', 'foreign-session', 'foreign-turn', 'event-id', 'event-data', 'terminal'])
def test_damaged_journal_blocks_send_and_never_overwrites_events(case, monkeypatch, damage):
    service, _, _, client = case
    journal = leave_pending(service, monkeypatch)
    record = json.loads(journal.read_text(encoding='utf-8'))
    if damage == 'non-object': record = []
    if damage == 'foreign-session': record['sessionId'] = 'foreign'
    if damage == 'foreign-turn': record['state']['turn_id'] = 'foreign'
    if damage == 'event-id': record['events'][1]['id'] = 9
    if damage == 'event-data': record['events'][1]['data'] = None
    if damage == 'terminal': record['events'][2]['data']['stopped'] = True
    journal.write_text(json.dumps(record), encoding='utf-8')
    before = service._event_path('s', 't').read_bytes(), len(client.calls)
    restored = CodexService(service.outputs, deny_native)
    assert restored.reconcile('s', 't')['outcome'] == 'unconfirmed'
    with pytest.raises(HTTPException) as exc:
        restored.session_work('s')
    assert exc.value.status_code == 503
    assert (service._event_path('s', 't').read_bytes(), len(client.calls)) == before


def test_changed_event_log_is_preserved_and_retains_occupancy(case, monkeypatch):
    service, *_ = case
    leave_pending(service, monkeypatch)
    target = service._event_path('s', 't')
    target.write_bytes(target.read_bytes() + b'{"id":2,"event":"token","data":"later"}\n')
    before = target.read_bytes()
    restored = CodexService(service.outputs, deny_native)
    assert restored.reconcile('s', 't')['outcome'] == 'unconfirmed'
    assert restored.session_work('s') == ['t'] and target.read_bytes() == before


def test_only_torn_final_log_record_can_be_replaced(case):
    service, *_ = case
    target = service._event_path('s', 't')
    target.write_bytes(target.read_bytes() + b'{"id":2,"event":"tok')
    assert service.reconcile('s', 't')['outcome'] == 'completed'
    assert [row['id'] for row in rows(service)] == [1, 2, 3, 4]


def test_complete_corrupt_log_is_not_truncated(case):
    service, *_ = case
    target = service._event_path('s', 't')
    target.write_bytes(target.read_bytes() + b'broken complete record\n')
    before = target.read_bytes()
    assert service.reconcile('s', 't')['outcome'] == 'unconfirmed'
    assert service.session_work('s') == ['t'] and target.read_bytes() == before


def test_slow_observer_waits_for_commit_and_does_not_lock_event_file(case, monkeypatch):
    service, *_ = case
    persist = service._persist

    def fail_final(state):
        if state.get('outcome') == 'completed':
            raise OSError('final snapshot unavailable')
        persist(state)

    with monkeypatch.context() as patch:
        patch.setattr(service, '_persist', fail_final)
        assert service.reconcile('s', 't')['outcome'] == 'unconfirmed'

    async def read():
        response = await service.stream('s', 't')
        iterator = response.body_iterator
        assert (await anext(iterator))['event'] == 'text_snapshot'
        assert (await anext(iterator))['event'] == 'execution'
        terminal = asyncio.create_task(anext(iterator))
        await asyncio.sleep(.03)
        assert not terminal.done(), 'uncommitted terminal leaked to observer'
        assert service.reconcile('s', 't')['outcome'] == 'completed'
        assert (await asyncio.wait_for(terminal, 2))['event'] == 'done'
        await iterator.aclose()

    asyncio.run(read())


def _crash_commit(root, state, turn, boundary):
    service = CodexService(Path(root))
    client = Client(state, turn)
    service.factory = lambda _: client
    write, persist, replace = service._write, service._persist, codex_settlement.replace_events

    def die():
        os._exit(73)

    def crash_write(target, data):
        write(target, data)
        if boundary == 'journal' and target.suffix == '.recovery': die()

    def crash_replace(*args):
        replace(*args)
        if boundary == 'events': die()

    def crash_persist(value):
        persist(value)
        if boundary == 'snapshot' and value.get('outcome') == 'completed': die()

    service._write, service._persist = crash_write, crash_persist
    codex_settlement.replace_events = crash_replace
    service.reconcile('s', 't')
    raise AssertionError('process did not reach expected crash boundary')


@pytest.mark.parametrize('boundary', ['journal', 'events', 'snapshot'])
def test_real_process_death_restores_commit_without_native_work(case, boundary):
    service, state, turn, _ = case
    child = multiprocessing.get_context('spawn').Process(target=_crash_commit,
        args=(str(service.outputs), state, turn, boundary))
    child.start()
    try:
        child.join(30)
        assert child.exitcode == 73
    finally:
        if child.is_alive():
            child.terminate(); child.join(5)
    restored = CodexService(service.outputs, deny_native)
    saved = restored.snapshot('s', 't')
    assert saved['outcome'] == 'completed' and saved['text'] == 'original result'
    assert restored.session_work('s') == []
    assert [row['event'] for row in rows(restored)] == ['error', 'text_snapshot', 'execution', 'done']
