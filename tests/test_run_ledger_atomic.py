"""Isolated reliability fixtures: processes, migration and replay; no model calls."""
from concurrent.futures import ProcessPoolExecutor
import asyncio
import hashlib
import json
import multiprocessing
from pathlib import Path
import sqlite3
from types import SimpleNamespace

import pytest

from web import run_ledger as ledger


def accept_worker(args):
    root, worker = args
    try:
        ledger.accept(Path(root), 'same-turn', session_id='fixture-session', session_key='fixture-session')
        return worker, True
    except ledger.RunExists:
        return worker, False


def event_worker(args):
    root, worker = args
    for index in range(20):
        ledger.mark(Path(root), 'same-turn', event='fixture-event', worker=worker, index=index)
    return True


def test_processes_accept_once_and_keep_every_committed_event(tmp_path):
    with ProcessPoolExecutor(max_workers=4, mp_context=multiprocessing.get_context('spawn')) as pool:
        accepted = list(pool.map(accept_worker, [(str(tmp_path), i) for i in range(8)]))
        assert sum(won for _, won in accepted) == 1
        assert all(pool.map(event_worker, [(str(tmp_path), i) for i in range(4)]))
    saved = ledger.read(tmp_path, 'same-turn')
    assert saved['eventSeq'] == 81
    page = ledger.event_page(tmp_path, 'same-turn', limit=200)
    assert [e['seq'] for e in page['events']] == list(range(1, 82))
    assert {(e['worker'], e['index']) for e in page['events'][1:]} == {(w,i) for w in range(4) for i in range(20)}
    projection = json.loads((tmp_path/'runs/same-turn.json').read_text(encoding='utf-8'))
    assert projection == saved


def old_record(tmp_path, *, truncated=False):
    seq = 220 if truncated else 1
    events = [{'seq': i, 'type': 'fixture-event', 'at': 'fixture-time'}
              for i in (range(21, 221) if truncated else [1])]
    record = {'schemaVersion':1,'turnId':'legacy-turn','sessionId':'fixture-session',
              'sessionKey':'fixture-session','status':'running','settled':False,
              'resourceSettled':False,'eventSeq':seq,'events':events}
    path = tmp_path/'runs/legacy-turn.json'
    path.parent.mkdir(parents=True)
    raw = json.dumps(record, ensure_ascii=False, indent=2).replace('\n','\r\n').encode()+b'\r\n'
    path.write_bytes(raw)
    return record, path, raw


def test_legacy_import_retains_exact_source_and_rejects_second_acceptance(tmp_path):
    record, path, raw = old_record(tmp_path)
    with pytest.raises(ledger.RunExists):
        ledger.accept(tmp_path,'legacy-turn',session_id='different',session_key='different')
    assert ledger.read(tmp_path,'legacy-turn') == record
    assert path.read_bytes() == raw
    with sqlite3.connect(tmp_path/'ledger.sqlite3') as db:
        assert db.execute('PRAGMA user_version').fetchone()[0] == ledger.STORAGE_VERSION
        source, digest = db.execute('SELECT source,sha256 FROM legacy_snapshots').fetchone()
    assert source == raw and digest == hashlib.sha256(raw).hexdigest()
    # Once imported, the database is authoritative even if an old projection changes.
    path.write_text('{}',encoding='utf-8')
    assert ledger.read(tmp_path,'legacy-turn') == record


def test_paging_reports_legacy_gap_and_new_history_outlives_bounded_snapshot(tmp_path):
    _, _, _ = old_record(tmp_path,truncated=True)
    page = ledger.event_page(tmp_path,'legacy-turn',limit=100)
    assert page['historyTruncated'] and page['firstAvailableSeq'] == 21
    assert page['next'] == 120 and page['hasMore'] and page['revision'] == 220
    next_page = ledger.event_page(tmp_path,'legacy-turn',after=page['next'],limit=100)
    assert not next_page['historyTruncated'] and not next_page['hasMore']
    assert next_page['next'] == 220
    ledger.accept(tmp_path,'fresh-turn',session_id='fixture-session',session_key='fixture-session')
    for index in range(205):
        ledger.mark(tmp_path,'fresh-turn',event='fixture-event',index=index)
    assert len(ledger.read(tmp_path,'fresh-turn')['events']) == 200
    page = ledger.event_page(tmp_path,'fresh-turn',limit=200)
    assert page['events'][0]['seq'] == 1 and page['hasMore'] and not page['historyTruncated']
    assert len(ledger.event_page(tmp_path,'fresh-turn',after=200)['events']) == 6


def test_projection_failure_does_not_erase_committed_admission(tmp_path,monkeypatch):
    def unavailable(*_):
        raise OSError('isolated projection failure')
    monkeypatch.setattr(ledger,'_atomic_write',unavailable)
    first = ledger.accept(tmp_path,'fixture-turn',session_id='fixture-session',session_key='fixture-session')
    assert ledger.read(tmp_path,'fixture-turn') == first
    assert not (tmp_path/'runs/fixture-turn.json').exists()
    with pytest.raises(ledger.RunExists):
        ledger.accept(tmp_path,'fixture-turn',session_id='fixture-session',session_key='fixture-session')


def test_settled_outcome_cursor_and_compare_revision_are_monotonic(tmp_path):
    ledger.accept(tmp_path,'fixture-turn',session_id='fixture-session',session_key='fixture-session')
    terminal = ledger.mark(tmp_path,'fixture-turn',status='stopped',settled=True,resource_settled=True,
                           last_event_id=30,stop_reason='fixture-stop')
    later = ledger.mark(tmp_path,'fixture-turn',status='running',settled=False,resource_settled=False,
                        last_event_id=4,stop_reason=None,error={'message':'late fixture event'})
    assert later['status'] == 'stopped' and later['settled'] and later['resourceSettled']
    assert later['lastEventId'] == 30 and later['stopReason'] == 'fixture-stop' and later['error'] is None
    with pytest.raises(ledger.LedgerError,match='changed'):
        ledger.mark(tmp_path,'fixture-turn',status='completed',expected_revision=terminal['eventSeq'])
    assert ledger.read(tmp_path,'fixture-turn') == later


@pytest.mark.parametrize('raw',[b'broken',b'{}',b'{"turnId":"different"}'])
def test_unreadable_legacy_is_never_accepted_as_new(tmp_path,raw):
    path = tmp_path/'runs/fixture-turn.json';path.parent.mkdir();path.write_bytes(raw)
    with pytest.raises(ledger.LedgerError):
        ledger.accept(tmp_path,'fixture-turn',session_id='fixture-session',session_key='fixture-session')
    assert path.read_bytes() == raw


def test_backup_restores_snapshot_events_and_original_migration_source(tmp_path):
    record, _, raw = old_record(tmp_path/'source')
    ledger.read(tmp_path/'source','legacy-turn')
    target = ledger.backup(tmp_path/'source',tmp_path/'restored/ledger.sqlite3')
    with pytest.raises(FileExistsError):
        ledger.backup(tmp_path/'source',target)
    assert ledger.read(target.parent,'legacy-turn') == record
    assert len(ledger.event_page(target.parent,'legacy-turn')['events']) == 1
    with sqlite3.connect(target) as db:
        assert db.execute('SELECT source FROM legacy_snapshots').fetchone()[0] == raw
    with sqlite3.connect(tmp_path/'source/ledger.sqlite3') as db:
        db.execute('PRAGMA user_version=99')
    with pytest.raises(ledger.LedgerError,match='Unsupported'):
        ledger.accept(tmp_path/'source','new-turn',session_id='fixture-session',session_key='fixture-session')
    assert not (tmp_path/'source/runs/new-turn.json').exists()


@pytest.mark.parametrize('terminal',[False,True])
def test_actual_chat_start_rejects_duplicate_before_artifact_or_provider_work(tmp_path,monkeypatch,terminal):
    from web import app as web
    from fastapi import HTTPException
    import office_controls
    monkeypatch.setattr(web,'OUTPUTS_DIR',tmp_path/'outputs')
    monkeypatch.setattr(web,'SESSIONS_DIR',tmp_path/'sessions')
    monkeypatch.setattr(web,'_run_ledger_root',lambda:tmp_path/'ledger')
    monkeypatch.setattr(web._codex_service,'bind',lambda *a,**k:None)
    monkeypatch.setattr(web,'_chat_role_contract',lambda *_:None)
    monkeypatch.setattr(web,'_chat_message',lambda *_:'isolated fixture')
    monkeypatch.setattr(web,'_selected_skill_specs',lambda *_:[])
    monkeypatch.setattr(web,'admit',lambda *_:SimpleNamespace(admitted=True))
    monkeypatch.setattr(office_controls,'require_model_override',lambda *a,**k:{})
    def unexpected(*a,**k):
        raise AssertionError('Duplicate entered post-admission work')
    monkeypatch.setattr(web,'ArtifactStore',unexpected)
    ledger.accept(tmp_path/'ledger','duplicate-turn',session_id='fixture-session',session_key='fixture-session')
    if terminal:
        ledger.mark(tmp_path/'ledger','duplicate-turn',status='completed',settled=True,resource_settled=True)
    req=web.ChatRequest(message='isolated fixture',sessionId='fixture-session',turnId='duplicate-turn',modelRef='fixture/model')
    with pytest.raises(HTTPException) as error:
        asyncio.run(web.start_chat_run(req))
    assert error.value.status_code == 409
    assert error.value.detail['code'] == ('chat_run_already_settled' if terminal else 'chat_run_already_active')


def test_event_http_endpoint_returns_cursor_and_disables_caching(tmp_path,monkeypatch):
    from web import app as web
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    monkeypatch.setattr(web,'_run_ledger_root',lambda:tmp_path)
    ledger.accept(tmp_path,'fixture-turn',session_id='fixture-session',session_key='fixture-session')
    ledger.mark(tmp_path,'fixture-turn',event='fixture-event')
    app=FastAPI();app.get('/api/chat/runs/{turn_id}/events')(web.api_chat_run_events)
    app.get('/api/chat/runs/{turn_id}')(web.api_chat_run)
    with TestClient(app) as client:
        response=client.get('/api/chat/runs/fixture-turn/events?after=0&limit=1')
        assert response.status_code == 200 and response.headers['cache-control'] == 'no-store'
        assert response.json()['hasMore'] and response.json()['next'] == 1
        assert client.get('/api/chat/runs/fixture-turn/events?after=1').json()['events'][0]['seq'] == 2
        assert client.get('/api/chat/runs/missing-turn/events').status_code == 404
        assert client.get('/api/chat/runs/fixture-turn/events?limit=0').status_code == 422
        assert client.get('/api/chat/runs/fixture-turn').headers['cache-control'] == 'no-store'


def test_snapshot_wait_keeps_event_loop_responsive(tmp_path, monkeypatch):
    from web import app as web
    import threading

    entered = threading.Event()
    release = threading.Event()
    record = {'turnId': 'fixture-turn', 'status': 'completed'}

    def waiting_read(*_):
        entered.set()
        if not release.wait(2):
            raise AssertionError('The ledger wait blocked the event loop')
        return record

    monkeypatch.setattr(web.run_ledger, 'read', waiting_read)
    monkeypatch.setattr(web, '_run_ledger_root', lambda: tmp_path)

    async def scenario():
        request = asyncio.create_task(web.api_chat_run('fixture-turn'))
        try:
            for _ in range(200):
                if entered.is_set():
                    break
                await asyncio.sleep(0.005)
            assert entered.is_set() and not request.done()
            release.set()
            response = await request
            assert json.loads(response.body) == record
        finally:
            release.set()
            await asyncio.gather(request, return_exceptions=True)

    asyncio.run(scenario())
