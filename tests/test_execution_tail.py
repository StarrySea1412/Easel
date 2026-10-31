"""A turn without tool frames still records operations from its transcript."""
import asyncio
import hashlib
import io
import json
import sys
import time
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import app as web
import skill_audit
from easel.execution_store import read_snapshot


@pytest.mark.parametrize('native', [False, True], ids=['cli', 'native-without-tool-frames'])
def test_transcript_only_turn_adopts_operations_into_the_journal(tmp_path, monkeypatch, native):
    outputs, transcripts = tmp_path / 'outputs', tmp_path / 'transcripts'
    transcripts.mkdir(parents=True)
    session, turn = 'tail-session', 'turn-tail'
    started = time.time() - 5
    events = [
        {'timestamp': started + 1, 'message': {'role': 'assistant', 'content': [
            {'type': 'toolCall', 'id': 'call1', 'name': 'tool_call',
             'arguments': {'id': 'web_search', 'args': {'query': '林雄'}}}]}},
        {'timestamp': started + 2, 'message': {'role': 'toolResult', 'toolCallId': 'call1', 'isError': True,
            'details': {'status': 'error', 'error': 'web_search is disabled'},
            'content': [{'type': 'text', 'text': 'web_search is disabled'}]}},
    ]
    trace = transcripts / 'own.jsonl'
    trace.write_text(''.join(json.dumps(event) + '\n' for event in events), encoding='utf-8')
    (transcripts / 'sessions.json').write_text(
        json.dumps({'agent:main:' + session: {'sessionId': 'own'}}), encoding='utf-8')
    audit = outputs / '_skill_audits' / hashlib.sha256(session.encode()).hexdigest()[:24] / f'{turn}.json'
    audit.parent.mkdir(parents=True)
    audit.write_text(json.dumps({
        'sessionId': session, 'turnId': turn, 'started': started, 'status': 'running',
        '_sources': {str(trace): {'offset': 0, 'digest': hashlib.sha256(b'').hexdigest()}}}),
        encoding='utf-8')

    class Credentials:
        mode, token, password = 'none', '', ''

        def environment(self, base):
            return dict(base or {})

        def headers(self):
            return {}

    class CrossLock:
        def __init__(self, key):
            self.cancel_event = None
            self.acquired = False

        def acquire(self, timeout):
            self.acquired = True
            return True

        def release(self):
            self.acquired = False

    processes = []

    class Process:
        def __init__(self, *args, **kwargs):
            self.finished = not native
            self.observed_while_running = False
            self.stdout = self.native_stdout() if native else io.StringIO('isolated answer\n')
            if native:
                self.on_tool = kwargs['on_tool']
            processes.append(self)

        def native_stdout(self):
            time.sleep(0.3)
            self.observed_while_running = bool(read_snapshot(outputs, session, turn).get('operations'))
            self.finished = True
            yield 'isolated answer\n'

        def poll(self):
            return 0 if self.finished else None

        def wait(self, timeout=None):
            return 0

        def terminate(self):
            return None

        def kill(self):
            return None

    monkeypatch.setattr(web, 'OUTPUTS_DIR', outputs)
    monkeypatch.setattr(web, 'OPENCLAW_SESSIONS_DIR', transcripts)
    monkeypatch.setattr(web, '_resolve_transport', lambda key: 'cli')
    monkeypatch.setattr(web, '_chat_message', lambda req, *, suffix='': req.message + suffix)
    monkeypatch.setattr(web, '_selected_skill_specs', lambda req: {})
    monkeypatch.setattr(web, '_heal_openclaw_session', lambda key: None)
    monkeypatch.setattr(web, 'SESSIONS_DIR', tmp_path / 'sessions')
    monkeypatch.setattr(web, '_job_event_file', lambda value: tmp_path / 'events' / (value + '.jsonl'))
    monkeypatch.setattr(web, '_CrossProcLock', CrossLock)
    monkeypatch.setattr(web, 'openclaw_base_cmd', lambda: ['fake-openclaw'])
    monkeypatch.setattr(web, '_proxy_env', lambda: {})
    monkeypatch.setattr(web, 'question_bridge_supported', None)
    monkeypatch.setattr(web, 'GatewayClient', None)
    monkeypatch.setattr(web, '_notify_email_web_turn', None)
    monkeypatch.setattr(web.subprocess, 'Popen', Process)
    monkeypatch.setattr(web, '_native_agent_client', lambda credentials: object() if native else None)
    monkeypatch.setattr('easel.gateway_agent.GatewayAgentProc', Process)
    monkeypatch.setattr(web, '_channel_labels', lambda: {})
    monkeypatch.setattr(web, 'SHARED_RAW_STREAM', tmp_path / 'absent-raw.jsonl')
    monkeypatch.setattr(web, 'DEBUG_DIR', tmp_path / 'debug')
    monkeypatch.setattr(web, '_RUNNING_CHAT', {})
    monkeypatch.setattr(web, '_STOPPED_CHAT', set())
    monkeypatch.setattr(web, '_BG_TASKS', set())
    monkeypatch.setattr(web, '_ACTIVE_SKILL_TURNS', {})
    monkeypatch.setattr(web, 'EXECUTION_TAIL_SECONDS', 0.05)
    monkeypatch.setattr(web, 'gateway_credentials', Credentials)
    monkeypatch.setattr(web, '_chat_agent_runtime', lambda req: {})
    monkeypatch.setattr(skill_audit, 'begin', lambda *args, **kwargs: {'record': {}, 'before': {}, 'sources': {}})
    monkeypatch.setattr(skill_audit, 'finish', lambda *args: None)

    async def scenario():
        monkeypatch.setattr(web, '_session_lock', lambda key: asyncio.Lock())
        response = await web.api_chat_stream(web.ChatRequest(
            message='isolated prompt', sessionId=session, turnId=turn))

        async def consume():
            return [event async for event in response.body_iterator]

        events = await asyncio.wait_for(consume(), timeout=10)
        await asyncio.sleep(0)
        assert [event['event'] for event in events if event['event'] == 'done']
        published = [json.loads(event['data']) for event in events if event['event'] == 'execution']
        assert any(value['operations'] for value in published)
        if native:
            assert processes[0].observed_while_running

    asyncio.run(scenario())
    saved = read_snapshot(outputs, session, turn)
    rows = saved.get('operations', [])
    assert [(row['name'], row['kind'], row['status']) for row in rows] == [('web_search', 'search', 'failed')]
    assert rows[0]['query'] == '林雄'
    timeline = [entry for entry in saved.get('timeline', []) if entry['type'] == 'operation']
    assert [entry['operationId'] for entry in timeline] == [rows[0]['id']]
