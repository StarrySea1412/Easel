"""Read-only SQLite adapter fixtures, including compressed and foreign events."""
import hashlib
import json
from pathlib import Path
import sqlite3
import time
import zstandard
import pytest
from easel import session_trace as trace


@pytest.fixture
def database(tmp_path):
    sessions = tmp_path / 'main' / 'sessions'; sessions.mkdir(parents=True)
    path = trace.database_path(sessions); path.parent.mkdir()
    with sqlite3.connect(path) as db:
        db.executescript('CREATE TABLE session_nodes(session_key TEXT,current_session_id TEXT);'
            'CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT,event_zstd BLOB,event_utf8_bytes INTEGER);'
            'CREATE TABLE transcript_event_identities(session_id TEXT,seq INTEGER,event_id TEXT);'
            'CREATE TABLE transcript_rewrite_watermarks(session_id TEXT,generation INTEGER);')
        db.execute('INSERT INTO session_nodes VALUES(?,?)', ('agent:main:own', 'mapped-own'))
        db.execute('INSERT INTO session_nodes VALUES(?,?)', ('agent:main:foreign', 'mapped-foreign'))
    def append(sid, seq, event, compressed=False):
        raw = json.dumps(event).encode()
        with sqlite3.connect(path) as db:
            db.execute('INSERT INTO transcript_events VALUES(?,?,?,?,?)', (sid, seq, None if compressed else raw.decode(), zstandard.ZstdCompressor().compress(raw) if compressed else None, len(raw)))
            db.execute('INSERT INTO transcript_event_identities VALUES(?,?,?)', (sid, seq, f'{sid}-{seq}'))
    return sessions, path, append


def test_compressed_scoped_events_exclude_old_foreign_future_and_mismatched_turn(database):
    sessions, path, append = database; stamp = time.time()-20
    event = lambda text, ts=stamp+2, **patch: {'timestamp': ts, 'message': {'role': 'assistant', 'content': text}, **patch}
    append('mapped-own', 0, event('history', stamp-5))
    checkpoint = trace.capture(sessions, 'own')
    append('mapped-own', 1, event('compressed'), True)
    append('mapped-own', 2, event('plain'))
    append('mapped-foreign', 0, event('PRIVATE_FOREIGN'))
    append('mapped-own', 3, event('future', stamp+10))
    append('mapped-own', 4, event('wrong turn', turnId='other'))
    audit = {'sessionId': 'own', 'turnId': 'turn', 'started': stamp, '_sqlite': checkpoint}
    before = hashlib.sha256(path.read_bytes()).digest()
    events = trace.read_events(sessions, 'own', audit, finished=stamp+5)
    assert [e['message']['content'] for e in events] == ['compressed', 'plain']
    assert trace.has_session(sessions, 'own') and not trace.has_session(sessions, 'absent')
    assert hashlib.sha256(path.read_bytes()).digest() == before
    assert not trace.read_events(sessions, 'own', audit)


def test_rewrites_invalid_anchors_and_decompression_bombs_are_not_evidence(database):
    sessions, path, append = database; stamp = time.time()-20
    append('mapped-own', 0, {'timestamp': stamp-1})
    checkpoint = trace.capture(sessions, 'own')
    append('mapped-own', 1, {'timestamp': stamp+1, 'message': {'content': 'later'}})
    with sqlite3.connect(path) as db:
        db.execute('UPDATE transcript_event_identities SET event_id=? WHERE session_id=? AND seq=0', ('replacement', 'mapped-own'))
    warnings=set(); audit={'started':stamp,'_sqlite':checkpoint}
    assert not trace.read_events(sessions,'own',audit,live=True,warnings=warnings) and warnings
    checkpoint=trace.capture(sessions,'own')
    with sqlite3.connect(path) as db:
        db.execute('INSERT INTO transcript_rewrite_watermarks VALUES(?,?)',('mapped-own',2))
    assert not trace.read_events(sessions,'own',{'started':stamp,'_sqlite':checkpoint},live=True)
    bomb=zstandard.ZstdCompressor().compress(b'x'*(trace.MAX_EVENT+1))
    with sqlite3.connect(path) as db:
        db.execute('INSERT INTO transcript_events VALUES(?,?,?,?,?)',('mapped-own',2,None,bomb,100))
    warnings=set()
    events=trace.read_events(sessions,'own',{'started':stamp},live=True,warnings=warnings)
    assert len(events)==1 and any('解码上限' in warning for warning in warnings)


def test_new_session_generation_requires_exact_fresh_session_header(database):
    sessions, path, append = database; stamp = time.time()-10
    checkpoint = trace.capture(sessions, 'own')
    append('mapped-own', 0, {'type': 'session', 'id': 'mapped-own', 'timestamp': stamp+1})
    append('mapped-own', 1, {'timestamp': stamp+2, 'message': {'role': 'assistant', 'content': 'new'}})
    with sqlite3.connect(path) as db:
        db.execute('INSERT INTO transcript_rewrite_watermarks VALUES(?,?)', ('mapped-own', 'initial-generation'))
    events = trace.read_events(sessions, 'own', {'started': stamp, '_sqlite': checkpoint}, live=True)
    assert len(events) == 2
    assert not trace.read_events(sessions, 'own', {'started': stamp+2, '_sqlite': checkpoint}, live=True)
