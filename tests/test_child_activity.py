"""Child detail reads stay bound to an evidenced parent turn, without RPCs."""
import hashlib
import json
import os
from pathlib import Path
import sys
import time

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import agent_office as office
import child_activity as activity
import app as web

KEY = 'agent:main:subagent:child1'
AGENT = 'subagent:' + hashlib.sha256(KEY.encode()).hexdigest()[:20]


def append(path, events):
    with path.open('a', encoding='utf-8') as stream:
        for event in events:
            stream.write(json.dumps(event) + '\n')


def event(at, role, **data):
    return {'timestamp': at, 'message': {'role': role, **data}}


def call(at, ident='read1', name='read', **args):
    return event(at, 'assistant', content=[{'type': 'toolCall', 'id': ident, 'name': name, 'arguments': args}])


@pytest.fixture
def case(tmp_path):
    sessions, audits, traces = [tmp_path / name for name in ('sessions', 'audits', 'traces')]
    for path in (sessions, audits, traces):
        path.mkdir()
    at = time.time() - 100
    marker = sessions / 'web_chat.json'
    marker.write_text(json.dumps({'turn_id': 'turn1', 'status': 'done'}))
    audit = audits / hashlib.sha256(b'chat').hexdigest()[:24] / 'turn1.json'
    audit.parent.mkdir()
    parent = traces / 'parent.jsonl'
    parent.write_text('')
    audit.write_text(json.dumps({'sessionId': 'chat', 'turnId': 'turn1', 'started': at, 'finished': at + 10,
        'status': 'completed', '_sources': {str(parent): {'offset': 0, 'digest': hashlib.sha256(b'').hexdigest()}}}))
    (traces / 'sessions.json').write_text(json.dumps({'agent:main:chat': {'sessionId': 'parent'},
        KEY: {'sessionId': 'child', 'spawnedBy': 'agent:main:chat'}}))
    append(parent, [call(at + 1, 'spawn', 'sessions_spawn', label='Explore', task='检索页面'),
        event(at + 2, 'toolResult', toolCallId='spawn', isError=False,
              details={'status': 'accepted', 'childSessionKey': KEY, 'runId': 'run1'})])
    child = traces / 'child.jsonl'
    append(child, [event(at + 1.5, 'user', content='开始研究'),
        event(at + 3, 'assistant', content=[{'type': 'thinking', 'thinking': 'PRIVATE_REASONING'},
            {'type': 'text', 'text': '正在检索 password=PRIVATE_PASSWORD'}]),
        call(at + 4, path='src/page.tsx'),
        event(at + 5, 'toolResult', toolCallId='read1', content=[{'type': 'text', 'text': 'file contents token=PRIVATE_TOKEN'}])])
    return dict(sessions=sessions, audits=audits, traces=traces, marker=marker, audit=audit, parent=parent, child=child, at=at)


def read(case, **kwargs):
    return activity.snapshot('chat', 'turn1', AGENT, case['sessions'], case['audits'], case['traces'], **kwargs)


def test_child_operations_progress_and_redaction(case):
    output = read(case)
    assert output['agentId'] == AGENT and len(output['operations']) == 1
    row = output['operations'][0]
    assert row['path'] == 'src/page.tsx' and row['status'] == 'returned'
    assert output['progress'] == ['正在检索 password=[已隐藏]']
    encoded = json.dumps(output)
    assert all(secret not in encoded for secret in ('PRIVATE_PASSWORD', 'PRIVATE_TOKEN', 'PRIVATE_REASONING', KEY))


@pytest.mark.parametrize('field,value', [('sessionId', 'foreign'), ('sessionKey', 'agent:main:subagent:foreign')])
def test_conflicting_child_identity_cannot_attach_foreign_operation(case, field, value):
    append(case['child'], [{**call(case['at'] + 6, 'foreign', path='FOREIGN'), field: value}])
    assert len(read(case)['operations']) == 1


@pytest.mark.parametrize('boundary', ['user', 'run'])
def test_next_activation_is_a_boundary_for_untagged_records(case, boundary):
    at = case['at']
    first = event(at + 6, 'user', content='另一轮') if boundary == 'user' else {**event(at + 6, 'assistant', content='next'), 'runId': 'foreign-run'}
    append(case['child'], [first, call(at + 7, 'foreign', path='FOREIGN')])
    assert len(read(case)['operations']) == 1


def test_history_remains_scoped_after_parent_advances(case):
    case['marker'].write_text(json.dumps({'turn_id': 'turn2', 'status': 'running'}))
    assert len(read(case, live=True, active_turn_id='turn2')['operations']) == 1
    view = office.snapshot('chat', case['sessions'], case['audits'], case['traces'], live=True,
        active_turn_id='turn2', requested_turn_id='turn1')
    assert view['turnId'] == 'turn1' and len(view['agents']) == 2
    assert view['agents'][0]['status'] == 'completed'


def test_read_does_not_assume_parent_completion_ends_child(case):
    append(case['child'], [call(case['at'] + 20, 'later', name='exec', command='echo still-working')])
    output = read(case)
    assert len(output['operations']) == 2
    assert output['operations'][1]['status'] == 'unconfirmed'


@pytest.mark.parametrize('change', ['missing-index', 'foreign-parent', 'invalid-file', 'unmatched-agent', 'missing-turn'])
def test_unavailable_or_foreign_child_fails_closed(case, change):
    index = case['traces'] / 'sessions.json'
    if change == 'missing-index':
        index.write_text(json.dumps({'agent:main:chat': {'sessionId': 'parent'}}))
        assert read(case)['operations'] == []
        return
    if change == 'foreign-parent':
        data = json.loads(index.read_text()); data[KEY]['spawnedBy'] = 'agent:main:foreign'; index.write_text(json.dumps(data))
    if change == 'invalid-file':
        data = json.loads(index.read_text()); data[KEY]['sessionId'] = '../foreign'; index.write_text(json.dumps(data))
        assert read(case)['operations'] == []
        return
    if change == 'missing-turn':
        case['audit'].unlink()
    if change == 'unmatched-agent':
        case['parent'].write_text('')
    with pytest.raises(HTTPException) as exc:
        read(case)
    assert exc.value.status_code in (404, 409)


def test_sensitive_file_output_hidden_and_partial_line_not_evidence(case):
    append(case['child'], [call(case['at'] + 6, 'secret', path='.env'),
        event(case['at'] + 7, 'toolResult', toolCallId='secret', content='PRIVATE_ENV')])
    with case['child'].open('a') as stream:
        stream.write(json.dumps(call(case['at'] + 8, 'unfinished', path='UNFINISHED')))
    output = read(case)
    assert len(output['operations']) == 2
    assert output['operations'][1]['contentHidden'] is True
    assert 'PRIVATE_ENV' not in json.dumps(output)


def test_api_get_is_read_only_and_checks_exact_turn(case, monkeypatch):
    monkeypatch.setattr(web, 'SESSIONS_DIR', case['sessions'])
    monkeypatch.setattr(web, 'OUTPUTS_DIR', case['audits'].parent / 'outputs')
    target = web.OUTPUTS_DIR / '_skill_audits'
    target.parent.mkdir()
    os.rename(case['audits'], target)
    monkeypatch.setattr(web, 'OPENCLAW_SESSIONS_DIR', case['traces'])
    monkeypatch.setattr(web, '_RUNNING_CHAT', {})
    monkeypatch.setattr(web, '_ACTIVE_SKILL_TURNS', {})
    with TestClient(web.app, base_url='http://127.0.0.1:7860', client=('127.0.0.1', 51234)) as client:
        response = client.get('/api/agent-office/child-activity', params={'sessionId': 'chat', 'turnId': 'turn1', 'agentId': AGENT})
        assert response.status_code == 200
        assert len(response.json()['operations']) == 1
        assert client.get('/api/agent-office/child-activity', params={'sessionId': 'foreign', 'turnId': 'turn1', 'agentId': AGENT}).status_code == 404
        assert client.get('/api/agent-office', params={'sessionId': 'chat', 'turnId': 'foreign'}).status_code == 404


def test_bounded_records_are_explicitly_partial(case, monkeypatch):
    monkeypatch.setattr(activity, 'MAX_BYTES', 10)
    output = read(case)
    assert output['operations'] == [] and output['warnings']
