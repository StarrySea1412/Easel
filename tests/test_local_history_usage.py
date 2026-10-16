"""Isolated project data only; no model, global Codex profile or paid request."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import sys
import time

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from easel.notifications import NotificationStore, chat_finished
from easel.codex_usage import observe, context, calls, counts, KEYS
from easel.codex_service import CodexService
from usage_stats import collect_usage


def row(ident='one', **patch):
    return {**dict(id=ident, message='task done', tone='success', at=int(time.time() * 1000)), **patch}


def test_notification_restart_read_clear_tombstone_and_concurrency(tmp_path):
    store = NotificationStore(tmp_path)
    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(lambda _: store.add([row()]), range(18)))
    assert len(NotificationStore(tmp_path).list()['notices']) == 1
    store.read('one')
    assert store.list()['notices'][0]['read'] is True
    store.clear()
    store.add([row()])
    assert store.list()['notices'] == []
    assert 'one' in store.list()['seen']
    chat_finished(tmp_path, 's1', 't1', stopped=True)
    assert store.list()['notices'][0]['target'] == dict(page='chat', sessionId='s1')
    assert store.list()['notices'][0]['tone'] == 'info'


def test_notification_retention_validation_and_no_executable_payload(tmp_path):
    store = NotificationStore(tmp_path)
    store.add([row(str(n), target=dict(page='outputs', path='../private'), action='exec') for n in range(1002)])
    data = store.list()
    assert len(data['notices']) == 1000 and len(data['seen']) == 1002
    assert all('action' not in item and 'path' not in item['target'] for item in data['notices'])
    with pytest.raises(ValueError):
        store.add([row('good'), row('bad', at=float('nan'))])
    assert 'good' not in store.list()['seen'], 'validate the entire batch before mutation'


def amount(n):
    return dict(inputTokens=n * 10, cachedInputTokens=n * 2, outputTokens=n * 4,
                reasoningOutputTokens=n, totalTokens=n * 14)


def test_codex_thread_deltas_replay_resume_and_reset():
    state = dict(usageCursor=dict.fromkeys(KEYS, 0))
    observe(state, dict(total=amount(2), last=amount(1), modelContextWindow=200000))
    observe(state, dict(total=amount(2), last=amount(1)))
    observe(state, dict(total=amount(5), last=amount(1)))
    assert [r['values']['totalTokens'] for r in state['usageRecords']] == [28, 42]
    assert all(r['complete'] for r in state['usageRecords'])
    resumed = dict(usageCursor=state['usageCursor'])
    observe(resumed, dict(total=amount(6), last=amount(1)))
    assert resumed['usageRecords'][0]['values'] == counts(amount(1))
    observe(resumed, dict(total=amount(1), last=amount(1)))
    assert resumed['usageRecords'][-1]['source'] == 'last_request'
    observe(resumed, dict(total={'totalTokens': -1}, last=amount(1)))
    assert len(resumed['usageRecords']) == 2


def fixture_turn(outputs, sid='s', tid='t', **patch):
    root = outputs / '_codex' / hashlib.sha256(sid.encode()).hexdigest()
    (root / 'turns').mkdir(parents=True, exist_ok=True)
    (root / 'session.json').write_text(json.dumps(dict(engine='codex', sessionId=sid)), encoding='utf-8')
    state = dict(sessionId=sid, turn_id=tid, status='done', requestedModelRef='codex/test', actualModel='test',
        startedAt=1770000000000, text='PRIVATE MUST NOT LEAVE SOURCE', tokenUsage=dict(total=amount(99), last=amount(1), modelContextWindow=200000), **patch)
    (root / 'turns' / (hashlib.sha256(tid.encode()).hexdigest() + '.json')).write_text(json.dumps(state), encoding='utf-8')
    return state


def test_codex_ledger_historical_lower_bound_privacy_and_idempotency(tmp_path):
    outputs = tmp_path / 'outputs'
    state = fixture_turn(outputs)
    values, issues, n = calls(outputs)
    assert n == 1 and values[0]['totalTokens'] == 14 and issues
    assert 'PRIVATE' not in json.dumps(values)
    data = collect_usage(tmp_path, tmp_path / 'profile', outputs / '_sessions', 's')
    assert data['session']['totalTokens'] == 14 and data['session']['recordedCostUsd'] is None
    assert collect_usage(tmp_path, tmp_path / 'profile', outputs / '_sessions', 's')['project']['totalTokens'] == 14
    snapshot = context(state, 's', 'codex/test')
    assert snapshot['usedTokens'] == 10 and snapshot['capacity'] == 200000
    assert context(state, 's', 'codex/other')['usedTokens'] is None
    with pytest.raises(ValueError):
        context(state, 's', 'bad\nmodel')


def test_codex_context_endpoint_reads_bound_state_without_openclaw(monkeypatch, tmp_path):
    import app
    state = fixture_turn(tmp_path, usageRecords=[dict(values=amount(2), source='thread_delta', complete=True)])
    service = CodexService(tmp_path)
    service._persist(state)
    binding = service.binding('s')
    binding['lastTurnId'] = 't'
    service._write(service.folder('s') / 'session.json', binding)
    monkeypatch.setattr(app, '_codex_service', service)
    response = asyncio.run(app.api_context_usage('s', 'codex/test'))
    value = json.loads(response.body)
    assert value['usedTokens'] == 10 and value['capacity'] == 200000
    assert value['breakdown'] == [] and 'PRIVATE' not in response.body.decode()


def test_protocol_usage_survives_restart_and_foreign_thread_is_ignored(tmp_path):
    service = CodexService(tmp_path)
    service.bind('s', 'codex')
    binding = service.binding('s')
    binding['threadId'] = 'thread'
    service._write(service.folder('s') / 'session.json', binding)
    state = dict(sessionId='s', turn_id='t', codexTurnId='turn', threadId='thread', items=[],
        text='', thinking='', pending=[], seq=0, status='done', usageCursor=dict.fromkeys(KEYS, 0))
    run = dict(state=state, requests={})
    for thread in ('foreign', 'thread'):
        service._consume(run, dict(method='thread/tokenUsage/updated', params=dict(threadId=thread, turnId='turn', tokenUsage=dict(total=amount(2), last=amount(1)))))
    assert len(state['usageRecords']) == 1
    assert service.snapshot('s', 't')['usageRecords'][0]['values']['totalTokens'] == 28
    assert service.binding('s')['usageCursor'] == counts(amount(2))


def test_notification_http_validation_and_scope(tmp_path, monkeypatch):
    import app
    import httpx
    monkeypatch.setattr(app, 'OUTPUTS_DIR', tmp_path)
    async def exercise():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app.app), base_url='http://127.0.0.1:7880') as client:
            assert (await client.post('/api/notifications', json={'notices': [row()]})).status_code == 200
            assert len((await client.get('/api/notifications')).json()['notices']) == 1
            assert (await client.post('/api/notifications', json={'notices': [row('bad', tone='exec')]})).status_code == 400
            await client.post('/api/notifications/read', json={})
            assert (await client.get('/api/notifications')).json()['notices'][0]['read']
            await client.delete('/api/notifications')
            assert (await client.get('/api/notifications')).json()['notices'] == []
    asyncio.run(exercise())


def test_chat_terminal_notice_survives_page_close_and_notice_failure_keeps_result(tmp_path, monkeypatch):
    import app
    monkeypatch.setattr(app, 'OUTPUTS_DIR', tmp_path)
    monkeypatch.setattr(app, 'SESSIONS_DIR', tmp_path / '_sessions')
    app._save_turn('web:s1', 'running', 'partial', {'turn_id': 't1'})
    assert not NotificationStore(tmp_path).list()['notices']
    app._save_turn('web:s1', 'done', 'kept', {'turn_id': 't1', 'stopped': True})
    event = NotificationStore(tmp_path).list()['notices'][0]
    assert event['id'] == 'chat:s1:t1:已停止' and event['tone'] == 'info'
    def fail(*args, **kwargs):
        raise OSError('isolated disk failure')
    monkeypatch.setattr(NotificationStore, 'add', fail)
    app._save_turn('web:s1', 'done', 'complete despite notification failure', {'turn_id': 't2'})
    assert json.loads(app._turn_file('web:s1').read_text(encoding='utf-8'))['text'] == 'complete despite notification failure'


def test_publish_notice_tracks_outcome_without_duplicate_or_altering_receipt(tmp_path, monkeypatch):
    import app
    monkeypatch.setattr(app, 'OUTPUTS_DIR', tmp_path)
    monkeypatch.setattr(app, 'PUBLISH_DIR', tmp_path / '_publish')
    monkeypatch.setattr(app, '_PUBLISH_VOLATILE', {})
    rid = 'c' * 32
    app._publish_receipt_store().create(rid, 'zhihu', 'isolated test only')
    app._save_publish_receipt(rid, {'outcome': 'submitted'})
    app._save_publish_receipt(rid, {'outcome': 'published'})
    app._save_publish_receipt(rid, {'outcome': 'published'})
    events = NotificationStore(tmp_path).list()['notices']
    assert len(events) == 2 and {item['tone'] for item in events} == {'info', 'success'}
    def fail(*args, **kwargs):
        raise OSError('isolated notification failure')
    monkeypatch.setattr(NotificationStore, 'add', fail)
    assert app._save_publish_receipt(rid, {'outcome': 'published'})['outcome'] == 'published'
    assert app._publish_receipt_store().get(rid)['outcome'] == 'published'


def test_job_replay_keeps_valid_events_around_corrupt_lines(tmp_path, monkeypatch):
    import app
    monkeypatch.setattr(app, 'SESSIONS_DIR', tmp_path)
    path = app._job_event_file('turn')
    path.parent.mkdir()
    path.write_text('{"id":1,"event":"token"}\n{broken\nnull\n{"id":2,"event":"done"}\n', encoding='utf-8')
    assert [event['id'] for event in app._read_job_events('turn')] == [1, 2]
    assert [event['id'] for event in app._read_job_events('turn', 1)] == [2]


def test_schedule_summary_does_not_block_event_loop(monkeypatch):
    import app
    import threading
    from types import SimpleNamespace
    main_thread = threading.get_ident()
    worker_threads = []
    def run(*args, **kwargs):
        worker_threads.append(threading.get_ident())
        return SimpleNamespace(returncode=0, stdout='{"summary":"ok"}')
    monkeypatch.setattr(app.subprocess, 'run', run)
    assert asyncio.run(app.api_schedule_context()) == {'summary': 'ok'}
    assert worker_threads and all(ident != main_thread for ident in worker_threads)
