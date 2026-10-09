"""Synthetic transcripts: no tools run and no real files are modified."""
import hashlib
import json
from pathlib import Path
import sys
import time
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import chat_execution as execution
from easel.gateway_auth import GatewayCredentials


def test_exact_turn_returns_tool_time_and_returned_diff_without_guessing(tmp_path):
    audits, transcripts = tmp_path / 'audits', tmp_path / 'transcripts'
    transcripts.mkdir()
    trace = transcripts / 'own.jsonl'
    (transcripts / 'sessions.json').write_text(json.dumps({'agent:main:chat': {'sessionId': 'own'}}))
    stamp = time.time() - 20
    call = lambda ident, name, args, ts=stamp: {'timestamp': ts, 'message': {'role': 'assistant', 'content': [
        {'type': 'toolCall', 'id': ident, 'name': name, 'arguments': args}]}}
    result = lambda ident, ts=stamp+2, **patch: {'timestamp': ts, 'message': {'role': 'toolResult', 'toolCallId': ident,
        'isError': False, 'content': [{'type': 'text', 'text': 'token=PRIVATE_OUTPUT'}], **patch}}
    events = [call('edit1', 'edit', {'path': 'outputs/a.md', 'oldText': 'old', 'newText': 'new'}),
        result('edit1', details={'diff': '-old\n+new\n+next'}),
        call('exec1', 'exec', {'command': 'echo token=PRIVATE_COMMAND'}), result('exec1', isError=True),
        call('write1', 'write', {'path': '.env', 'content': 'PRIVATE_FILE'}), result('write1'),
        result('unmatched'), call('future', 'exec', {'command': 'must not show'}, stamp+10)]
    trace.write_text(''.join(json.dumps(event)+'\n' for event in events))
    audit = audits / hashlib.sha256(b'chat').hexdigest()[:24] / 'turn.json'
    audit.parent.mkdir(parents=True)
    audit.write_text(json.dumps({'sessionId': 'chat', 'turnId': 'turn', 'status': 'completed', 'started': stamp-1,
        'finished': stamp+3, '_sources': {str(trace): {'offset': 0, 'digest': hashlib.sha256(b'').hexdigest()}}}))
    value = execution.snapshot('chat', 'turn', audits, transcripts, credentials=GatewayCredentials('none'))
    rows = value['operations']
    assert len(rows) == 3 and rows[0]['added'] == 2 and rows[0]['removed'] == 1
    assert rows[0]['elapsedSeconds'] == 2 and rows[1]['status'] == 'failed'
    assert 'added' not in rows[2] and not rows[2]['output']
    assert 'PRIVATE_' not in json.dumps(value) and 'must not show' not in json.dumps(value)
    assert not execution.snapshot('foreign', 'turn', audits, transcripts)['operations']
    assert not execution.snapshot('chat', 'other', audits, transcripts)['operations']
    with pytest.raises(Exception): execution.snapshot('../chat', 'turn', audits, transcripts)
