import json
from pathlib import Path
import sqlite3
import time

from PIL import Image
import zstandard

from easel.artifacts import ArtifactStore
from easel.chat_projection import project_injected, present_payloads
from easel.session_trace import database_path


def test_background_injection_restores_actual_files_without_rewriting_original_run(tmp_path):
    sessions = tmp_path / 'main/sessions'; sessions.mkdir(parents=True)
    database = database_path(sessions); database.parent.mkdir()
    root = tmp_path / 'outputs'; topic = root / '主题'; topic.mkdir(parents=True)
    Image.new('RGB', (12, 18)).save(topic / '图.png')
    (topic / 'page.html').write_text('<h1>真实文件</h1>', encoding='utf-8')
    events = [
        ('own', 0, {'id': 'ordinary', 'timestamp': time.time()-10, 'message': {'role': 'assistant', 'model': 'text-model', 'content': 'ordinary answer'}}),
        ('own', 1, {'id': 'injected', 'timestamp': time.time()-5, 'message': {'role': 'assistant', 'model': 'gateway-injected',
            'content': [{'type': 'text', 'text': '[直接交付]\n![图片](/api/media/主题/图.png) [页面](/api/media/主题/page.html) [缺失](/api/media/主题/no.png) sk-testprivatesecret'}]}}),
        ('foreign', 0, {'id': 'foreign', 'timestamp': time.time()-3, 'message': {'role': 'assistant', 'model': 'gateway-injected', 'content': 'foreign secret'}}),
    ]
    with sqlite3.connect(database) as db:
        db.executescript('CREATE TABLE session_nodes(session_key TEXT,current_session_id TEXT);'
            'CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT,event_zstd BLOB,event_utf8_bytes INTEGER);')
        db.execute('INSERT INTO session_nodes VALUES(?,?)', ('agent:main:chat', 'own'))
        for sid, seq, event in events:
            raw = json.dumps(event).encode()
            db.execute('INSERT INTO transcript_events VALUES(?,?,?,?,?)', (sid, seq, None, zstandard.ZstdCompressor().compress(raw), len(raw)))
    projected = project_injected(root, sessions, 'chat')
    assert len(projected['messages']) == 1
    message = projected['messages'][0]
    assert '直接交付' in message['content'] and 'sk-testprivatesecret' not in message['content']
    assert projected['warnings'] and message['source'] == 'gateway-injected'
    snapshot = ArtifactStore(root).snapshot('chat')
    assert len(snapshot['artifacts']) == 2
    assert all(a['turnId'] == message['turnId'] for a in snapshot['artifacts'])
    project_injected(root, sessions, 'chat')
    assert ArtifactStore(root).snapshot('chat') == snapshot
    assert project_injected(root, sessions, 'unknown')['messages'] == []
    # The reader never mutates or claims a new final state for the original run.
    with sqlite3.connect(database) as db:
        assert db.execute('SELECT COUNT(*) FROM transcript_events').fetchone()[0] == 3


def test_only_successful_structured_local_payloads_are_presented_without_prose(tmp_path):
    root = tmp_path / 'outputs'; root.mkdir()
    Image.new('RGB', (16, 16)).save(root / 'actual.png')
    payloads = [{'mediaUrl': str(root / 'actual.png')}, {'mediaUrls': ['/api/media/actual.png']},
                {'isError': True, 'mediaUrl': '/api/media/no.png'},
                {'mediaUrl': 'https://example.test/api/media/foreign.png'},
                {'mediaUrl': '/api/media/../outside'}, {'text': 'I generated a picture'}]
    assert len(present_payloads(root, 'chat', 'turn', payloads, 'run1')) == 2
    snapshot = ArtifactStore(root).snapshot('chat')
    assert len(snapshot['artifacts']) == 1 and len(snapshot['events']) == 1
    assert snapshot['artifacts'][0]['source'] == 'gateway-payload'
