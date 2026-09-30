"""Exercise the actual SSE supervisor with isolated files and a fake CLI process."""
import asyncio
import io
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import app as web
import skill_audit


@pytest.mark.parametrize('failure', ['begin', 'finish', 'transport'])
def test_audit_and_transport_failures_close_stream_and_release_locks(tmp_path, monkeypatch, failure):
    saved, calls, cross_locks = [], [], []

    class CrossLock:
        def __init__(self, key):
            self.acquired = False
            self.releases = 0
            cross_locks.append(self)

        def acquire(self, timeout):
            self.acquired = True
            return True

        def release(self):
            self.releases += 1
            self.acquired = False

    class Process:
        def __init__(self, *args, **kwargs):
            calls.append('spawn')
            self.stdout = io.StringIO('The complete isolated response.\n')

        def poll(self):
            return 0

    def begin(*args):
        calls.append('begin')
        if failure == 'begin':
            raise RuntimeError('injected audit initialization failure')
        return {'test_context': True}

    def finish(*args):
        calls.append('finish')
        if failure == 'finish':
            raise RuntimeError('injected audit persistence failure')

    def transport(*args):
        calls.append('transport')
        if failure == 'transport':
            raise RuntimeError('injected transport discovery failure')
        return 'cli'

    monkeypatch.setattr(skill_audit, 'begin', begin)
    monkeypatch.setattr(skill_audit, 'finish', finish)
    monkeypatch.setattr(web, '_resolve_transport', transport)
    monkeypatch.setattr(web, '_chat_message', lambda req: req.message)
    monkeypatch.setattr(web, '_selected_skill_specs', lambda req: {})
    monkeypatch.setattr(web, '_heal_openclaw_session', lambda key: None)
    monkeypatch.setattr(web, '_save_turn', lambda *args: saved.append(args))
    monkeypatch.setattr(web, '_job_event_file', lambda turn: tmp_path / 'events' / (turn + '.jsonl'))
    monkeypatch.setattr(web, '_CrossProcLock', CrossLock)
    monkeypatch.setattr(web, 'openclaw_base_cmd', lambda: ['fake-openclaw'])
    monkeypatch.setattr(web, '_proxy_env', lambda: {})
    monkeypatch.setattr(web, 'question_bridge_supported', None)
    monkeypatch.setattr(web, 'GatewayClient', None)
    monkeypatch.setattr(web, '_notify_email_web_turn', None)
    monkeypatch.setattr(web.subprocess, 'Popen', Process)
    monkeypatch.setattr(web, 'OUTPUTS_DIR', tmp_path / 'outputs')
    monkeypatch.setattr(web, 'OPENCLAW_SESSIONS_DIR', tmp_path / 'transcripts')
    monkeypatch.setattr(web, 'SHARED_RAW_STREAM', tmp_path / 'absent-raw.jsonl')
    monkeypatch.setattr(web, 'DEBUG_DIR', tmp_path / 'debug')
    monkeypatch.setattr(web, '_RUNNING_CHAT', {})
    monkeypatch.setattr(web, '_STOPPED_CHAT', set())
    monkeypatch.setattr(web, '_BG_TASKS', set())

    async def scenario():
        lock = asyncio.Lock()
        monkeypatch.setattr(web, '_session_lock', lambda key: lock)
        response = await web.api_chat_stream(web.ChatRequest(
            message='isolated prompt', sessionId='audit-stream', turnId='turn1'))

        async def consume():
            return [event async for event in response.body_iterator]

        events = await asyncio.wait_for(consume(), timeout=5)
        # Let the supervisor completion callback retrieve unexpected exceptions.
        await asyncio.sleep(0)
        assert not lock.locked()
        assert len(cross_locks) == 1
        assert not cross_locks[0].acquired
        assert cross_locks[0].releases == 1
        assert 'audit-stream' not in web._RUNNING_CHAT
        assert not web._BG_TASKS
        done = [event for event in events if event['event'] == 'done']
        assert len(done) == 1
        assert json.loads(done[0]['data']) == {'sessionKey': 'audit-stream'}
        if failure == 'transport':
            assert 'spawn' not in calls
        else:
            assert 'spawn' in calls
            tokens = ''.join(json.loads(event['data']) for event in events if event['event'] == 'token')
            assert 'The complete isolated response.' in tokens
            assert any(turn[1] == 'done' and 'The complete isolated response.' in turn[2] for turn in saved)
            assert any('执行核验' in json.loads(event['data']) for event in events if event['event'] == 'activity')
        assert ('finish' in calls) == (failure == 'finish')

    asyncio.run(scenario())
