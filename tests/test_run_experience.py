"""Original-run proposal pipeline. Synthetic evidence; no provider dispatch."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
from threading import Event, get_ident
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from easel.profile_memory import Conflict, MemoryStore, digest
from easel.run_experience import (RejectedSource, binding, evidence, from_outputs,
                                  instructions, settle_pending, source)
from easel.memory_sources import UnsettledSource
from easel.task_store import TaskStore
from web.profile_memory_routes import create_router

QUOTE = '隔离样本：先检查最终文件实际存在，再提供交付链接；一次检查不能证明长期可用。'
LESSON = '交付文件先检查存在性与内容，验证范围要明确。'
PROPOSAL = {'text': LESSON, 'quote': QUOTE}


@pytest.fixture
def env(tmp_path):
    for name in ('one', 'two'):
        (tmp_path / 'profiles' / name).mkdir(parents=True)
    memory = MemoryStore(tmp_path)
    for name in ('one', 'two'):
        memory.import_legacy(name, {'hash': digest(''), 'profileRevision': 0, 'scope': {'kind': 'profile'}})
    return SimpleNamespace(root=tmp_path, memory=memory, outputs=memory.run_outputs, ledger=memory.run_ledger)


def bind(env, session='s', turn='t', engine='openclaw', **kwargs):
    return env.memory.bind_run('one', session, turn, engine=engine, **kwargs)


def finish(env, session='s', turn='t', engine='openclaw', **patch):
    snapshot = {'session_id': session, 'turn_id': turn, 'status': 'done', 'text': '合成结果\n' + QUOTE,
                'clean_end': True, 'outcome': 'completed', 'memoryResourceSettled': True, **patch}
    if engine == 'codex':
        folder = env.outputs / '_codex' / digest(session)
        folder.mkdir(parents=True, exist_ok=True)
        (folder / 'session.json').write_text('{}', encoding='utf-8')
        target = folder / 'turns' / (digest(turn) + '.json')
    else:
        env.ledger.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(env.ledger / 'ledger.sqlite3') as db:
            db.execute('CREATE TABLE IF NOT EXISTS runs(turn TEXT PRIMARY KEY,data TEXT)')
            run = {'sessionId': session, 'turnId': turn, 'engine': engine, 'status': 'completed',
                   'settled': True, 'resourceSettled': True}
            db.execute('INSERT OR REPLACE INTO runs VALUES(?,?)', (turn, json.dumps(run)))
        target = env.ledger / 'jobs' / (turn + '.snapshot.json')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(snapshot), encoding='utf-8')
    return target


def change(env, entry, action):
    return env.memory.change('one', entry['id'], action, {**{key: entry[key] for key in
        ('revision', 'contentHash', 'scopeHash', 'conditionsHash')},
        'profileRevision': env.memory.state('one')['revision']})


@pytest.mark.parametrize('engine', ['openclaw', 'codex'])
def test_exact_run_pending_confirmation_recall_and_evidence(env, engine):
    selected = {'kind': 'account', 'platform': 'douyin', 'accountId': 'A'}
    bound = bind(env, engine=engine, selected_scope=selected, task_type='writing')
    assert 'easel_memory_candidate' in instructions(bound, env.root)
    receipt = env.memory.queue_run('s', 't', PROPOSAL)
    assert receipt['status'] == 'queued'
    assert env.memory.state('one')['entries'] == []
    finish(env, engine=engine)
    settled = env.memory.settle_run('s', 't')
    assert settled['createdCount'] == 1 and settled['modelRequests'] == 0
    assert QUOTE not in json.dumps(settled, ensure_ascii=False)
    entry = env.memory.state('one')['entries'][0]
    assert entry['scope'] == selected and entry['status'] == 'pending'
    assert entry['conditions']['taskTypes'] == ['writing']
    assert entry['sourceStatus'] == 'available'
    assert evidence(env.memory, 'one', entry['id'])['quote'] == QUOTE
    assert not env.memory.context('one', '交付文件', 'douyin', 'A', task_type='writing')['entries']
    change(env, entry, 'accept')
    assert env.memory.context('one', '交付文件', 'douyin', 'A', task_type='writing')['entries'][0]['id'] == entry['id']
    assert not env.memory.context('one', '交付文件', 'douyin', 'B', task_type='writing')['entries']
    assert not env.memory.context('one', '交付文件', 'douyin', 'A', task_type='coding')['entries']
    assert env.memory.state('two')['entries'] == []
    assert MemoryStore(env.root).settle_run('s', 't') == settled
    with env.memory.connect() as db:
        assert not db.execute('SELECT * FROM run_proposals').fetchall()


def test_binding_is_immutable_and_historical_runs_cannot_rebind_rebuilt_profile(env):
    bind(env)
    for kwargs in ({'selected_scope': {'kind': 'account', 'platform': 'douyin', 'accountId': 'B'}},
                   {'engine': 'codex'}):
        with pytest.raises(Conflict): bind(env, **kwargs)
    with pytest.raises(Conflict): env.memory.bind_run('two', 's', 't')
    finish(env)
    env.memory.purge_profile('one')
    (env.root / 'profiles/one/memory.md').unlink()
    env.memory.import_legacy('one', {'hash': digest(''), 'profileRevision': 0, 'scope': {'kind': 'profile'}})
    with pytest.raises(Conflict, match='旧轮次'): bind(env)
    assert env.memory.settle_run('s', 't') is None


def test_concurrent_proposals_and_settlement_are_bounded_and_idempotent(env):
    bind(env)
    with ThreadPoolExecutor(4) as pool:
        values = list(pool.map(lambda _: env.memory.queue_run('s', 't', PROPOSAL), range(4)))
    assert values.count(values[0]) == 4
    env.memory.queue_run('s', 't', {'text': LESSON + '二', 'quote': QUOTE})
    env.memory.queue_run('s', 't', {'text': LESSON + '三', 'quote': '未出现在本轮最终正文的虚构引文。'})
    with pytest.raises(Conflict): env.memory.queue_run('s', 't', {'text': LESSON + '四', 'quote': QUOTE})
    finish(env)
    with ThreadPoolExecutor(3) as pool:
        receipts = list(pool.map(lambda _: env.memory.settle_run('s', 't'), range(3)))
    assert receipts[0] == receipts[1] == receipts[2]
    assert (receipts[0]['createdCount'], receipts[0]['unmatchedCount']) == (2, 1)
    first, second = env.memory.state('one')['entries']
    change(env, first, 'reject'); change(env, second, 'delete')
    assert env.memory.queue_run('s', 't', PROPOSAL) == receipts[0]
    assert [e['status'] for e in env.memory.state('one')['entries']] == ['rejected']


def test_settlement_completed_after_initial_read_returns_same_receipt(env, monkeypatch):
    bind(env)
    env.memory.queue_run('s', 't', PROPOSAL)
    finish(env)
    original = env.memory.connect
    paused, resume = Event(), Event()
    worker = {'id': None, 'reads': 0}

    @contextmanager
    def interleaved_connection():
        with original() as db:
            yield db
        if get_ident() == worker['id']:
            worker['reads'] += 1
            if worker['reads'] == 1:
                paused.set()
                assert resume.wait(15), 'competing settlement did not finish'

    monkeypatch.setattr(env.memory, 'connect', interleaved_connection)

    def settle_paused():
        worker['id'] = get_ident()
        return env.memory.settle_run('s', 't')

    with ThreadPoolExecutor(1) as pool:
        first = pool.submit(settle_paused)
        try:
            assert paused.wait(15), 'first settlement did not reach its initial read'
            completed = env.memory.settle_run('s', 't')
        finally:
            resume.set()
        assert first.result(timeout=15) == completed
    assert completed['createdCount'] == 1
    assert len(env.memory.state('one')['entries']) == 1


@pytest.mark.parametrize('engine,patch', [
    ('openclaw', {'status': 'running'}), ('openclaw', {'turn_id': 'foreign'}),
    ('openclaw', {'session_id': 'foreign'}), ('openclaw', {'clean_end': False}),
    ('codex', {'memoryResourceSettled': False}), ('codex', {'outcome': 'unconfirmed'}),
])
def test_unconfirmed_or_foreign_source_never_proposes(env, engine, patch):
    bind(env, engine=engine); env.memory.queue_run('s', 't', PROPOSAL)
    finish(env, engine=engine, **patch)
    with pytest.raises(UnsettledSource): env.memory.settle_run('s', 't')
    assert not env.memory.state('one')['entries']


@pytest.mark.parametrize('engine,patch', [
    ('openclaw', {'stop_reason': 'max_tokens'}), ('openclaw', {'stopped': True}),
    ('openclaw', {'error': 'failed'}), ('codex', {'outcome': 'failed'}),
    ('codex', {'outcome': 'interrupted'}),
])
def test_terminal_failure_discards_raw_quotes_and_never_resurrects(env, engine, patch):
    bind(env, engine=engine); env.memory.queue_run('s', 't', PROPOSAL)
    finish(env, engine=engine, **patch)
    assert env.memory.settle_run('s', 't')['status'] == 'skipped'
    finish(env, engine=engine)
    assert not env.memory.state('one')['entries']
    with env.memory.connect() as db:
        assert db.execute('SELECT count(*) FROM run_proposals').fetchone()[0] == 0


def test_delete_and_policy_off_clear_queued_quotes_even_after_reenable(env):
    bind(env); env.memory.queue_run('s', 't', PROPOSAL)
    TaskStore(env.outputs).delete_session('s')
    finish(env)
    assert env.memory.settle_run('s', 't')['status'] == 'skipped'
    bind(env, session='other', turn='other')
    env.memory.queue_run('other', 'other', PROPOSAL)
    revision = env.memory.state('one')['revision']
    env.memory.set_policy('one', {'profileRevision': revision, 'candidatesEnabled': False})
    env.memory.set_policy('one', {'profileRevision': revision + 1, 'candidatesEnabled': True})
    finish(env, session='other', turn='other')
    assert env.memory.queue_run('other', 'other', PROPOSAL)['reason'] == 'candidates-disabled'
    assert not env.memory.state('one')['entries']


def test_transaction_failure_and_changed_source_rollback_all_entries(env, monkeypatch):
    bind(env); env.memory.queue_run('s', 't', PROPOSAL)
    env.memory.queue_run('s', 't', {'text': LESSON + '第二条', 'quote': QUOTE})
    finish(env)
    original = env.memory._insert
    calls = []
    def failing(*args, **kwargs):
        calls.append(1)
        if len(calls) == 2: raise OSError('isolated storage failure')
        return original(*args, **kwargs)
    monkeypatch.setattr(env.memory, '_insert', failing)
    with pytest.raises(OSError): env.memory.settle_run('s', 't')
    with env.memory.connect() as db:
        assert db.execute('SELECT count(*) FROM entries').fetchone()[0] == 0
        assert db.execute('SELECT count(*) FROM run_proposals').fetchone()[0] == 2
    assert 'receipt' not in binding(env.memory, 's', 't')
    monkeypatch.setattr(env.memory, '_insert', original)
    resolver = env.memory.resolve_run_source
    reads = []
    def changing(*args):
        value = resolver(*args); reads.append(1)
        if len(reads) > 1: value['sourceHash'] = 'changed'
        return value
    monkeypatch.setattr(env.memory, 'resolve_run_source', changing)
    with pytest.raises(Conflict, match='改变'): env.memory.settle_run('s', 't')
    monkeypatch.setattr(env.memory, 'resolve_run_source', resolver)
    assert env.memory.settle_run('s', 't')['createdCount'] == 2


def test_legacy_missing_tables_do_not_invent_success_and_corruption_is_not_hidden(env):
    env.ledger.mkdir(parents=True)
    with sqlite3.connect(env.ledger / 'ledger.sqlite3') as db: db.execute('CREATE TABLE older(x)')
    with TaskStore(env.outputs).db(): pass
    with sqlite3.connect(env.outputs / '_automation/tasks.sqlite3') as db: db.execute('DROP TABLE deleted_sessions')
    assert bind(env)
    with pytest.raises(UnsettledSource): source(env.outputs, 's', 't', 'openclaw')
    (env.ledger / 'ledger.sqlite3').write_bytes(b'corrupt')
    with pytest.raises(sqlite3.DatabaseError): source(env.outputs, 's', 't', 'openclaw')


def test_background_rotation_does_not_starve_later_profile_or_run(env):
    for index in range(53):
        bind(env, session=f's{index}', turn=f't{index}')
        env.memory.queue_run(f's{index}', f't{index}', PROPOSAL)
    finish(env, session='s52', turn='t52')
    assert settle_pending(env.memory) == []
    assert settle_pending(env.memory)[0]['createdCount'] == 1
    env.memory.bind_run('two', 'second', 'second')
    env.memory.queue_run('second', 'second', PROPOSAL)
    finish(env, session='second', turn='second')
    assert settle_pending(env.memory, 'two')[0]['createdCount'] == 1


def test_cli_script_and_http_evidence_cannot_activate_or_cross_profile(env, tmp_path):
    bind(env)
    proposal = tmp_path / 'proposal.json'; proposal.write_text(json.dumps(PROPOSAL), encoding='utf-8')
    script = Path(__file__).resolve().parents[1] / 'skills/shared/scripts/queue_experience.py'
    run = subprocess.run([sys.executable, str(script), '--data-root', str(env.root), '--session', 's',
        '--turn', 't', '--proposal-file', str(proposal)], capture_output=True, text=True, check=True)
    assert json.loads(run.stdout)['status'] == 'queued'
    finish(env); from_outputs(env.outputs)
    app = FastAPI(); app.include_router(create_router(lambda: env.memory))
    with TestClient(app) as client:
        entry = client.get('/api/persona/one/memory').json()['entries'][0]
        url = '/api/persona/one/memory/entries/' + entry['id']
        assert client.get(url + '/evidence').json()['quote'] == QUOTE
        assert client.get(url.replace('/one/', '/two/') + '/evidence').status_code == 404
        assert client.post(url + '/accept', json={}).status_code == 403
        target = finish(env, text='changed source')
        assert client.get(url + '/evidence').status_code == 409
        target.unlink()
        assert client.get(url + '/evidence').status_code == 400


@pytest.mark.parametrize('data', [
    {**PROPOSAL, 'status': 'active'}, {**PROPOSAL, 'sessionId': 'other'},
    {**PROPOSAL, 'quote': 'short'}, {**PROPOSAL, 'text': 'api_key=isolated_secret'},
    {**PROPOSAL, 'conditions': {'taskTypes': ['coding']}},
])
def test_proposals_cannot_change_identity_policy_or_original_task_type(env, data):
    bind(env, task_type='writing')
    with pytest.raises(ValueError): env.memory.queue_run('s', 't', data)


def test_existing_entry_source_change_and_pending_image_prevent_recall(env, monkeypatch):
    from easel.image_jobs import ImageJobs
    bind(env); env.memory.queue_run('s', 't', PROPOSAL)
    finish(env)
    with ImageJobs(env.outputs).db(): pass
    monkeypatch.setattr(ImageJobs, 'pending', lambda *args: True)
    with pytest.raises(UnsettledSource): env.memory.settle_run('s', 't')
    monkeypatch.setattr(ImageJobs, 'pending', lambda *args: False)
    env.memory.settle_run('s', 't')
    entry = env.memory.state('one')['entries'][0]; change(env, entry, 'accept')
    finish(env, text='原文已改变')
    assert not env.memory.context('one', '交付文件')['entries']
    with pytest.raises(Conflict): evidence(env.memory, 'one', entry['id'])
