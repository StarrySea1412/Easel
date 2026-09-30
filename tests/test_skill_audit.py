"""Isolated transcript fixtures; never inspect real chats or invoke providers."""
import json
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import skill_audit as audit

SPECS = {'demo': {'scripts': ['scripts/run.py'], 'requirements': ['可读产物']}}


def evidence(command='python /skills/demo/scripts/run.py', ident='call', success=True):
    return [
        {'message': {'role': 'assistant', 'content': [{'type': 'toolCall', 'id': ident,
            'name': 'exec', 'arguments': {'command': command}}]}},
        {'message': {'role': 'toolResult', 'toolCallId': ident, 'isError': not success,
                     'content': 'report.txt'}},
    ]


def append(path, events):
    with path.open('a', encoding='utf-8') as stream:
        for event in events:
            stream.write(json.dumps(event) + '\n')


@pytest.fixture
def setup(tmp_path):
    outputs, sessions = tmp_path / 'outputs', tmp_path / 'sessions'
    outputs.mkdir()
    sessions.mkdir()
    (sessions / 'sessions.json').write_text(json.dumps({'agent:main:web:chat': {'sessionId': 'mapped'}}))
    return outputs, sessions, sessions / 'mapped.jsonl'


def test_lifecycle_only_appended_current_session_and_private_fields(setup):
    outputs, sessions, path = setup
    append(path, evidence(ident='old'))
    context = audit.begin(outputs, sessions, 'chat', 'turn1', SPECS, 'private request')
    assert audit.records(outputs / '_skill_audits', 'chat')[0]['status'] == 'running'
    append(sessions / 'other.jsonl', evidence(ident='other'))
    first = audit.finish(outputs, sessions, context, 'reply', 'interrupted')
    assert first['invocation'][0]['status'] == 'not_observed'
    context = audit.begin(outputs, sessions, 'chat', 'turn2', SPECS, 'private request')
    append(path, evidence())
    (outputs / 'report.txt').write_text('report')
    result = audit.finish(outputs, sessions, context, 'reply', 'completed')
    assert result['invocation'][0]['status'] == 'executed'
    assert result['quality']['artifacts'] == [{'path': 'report.txt', 'kind': 'text'}]
    public = audit.records(outputs / '_skill_audits', 'chat')[0]
    assert not any(key.startswith('_') for key in public)
    stored = json.loads(audit.audit_path(outputs / '_skill_audits', 'chat', 'turn2').read_text(encoding='utf-8'))
    assert stored['_request'] == 'private request' and stored['_response'] == 'reply'


@pytest.mark.parametrize('mode', ['truncate', 'rewrite', 'late_mapping', 'partial'])
def test_replaced_or_late_mapped_history_is_not_evidence(setup, mode):
    outputs, sessions, path = setup
    if mode == 'late_mapping':
        (sessions / 'sessions.json').write_text('{}')
    append(path, evidence())
    if mode == 'partial':
        with path.open('a') as stream:
            stream.write('{')
    context = audit.begin(outputs, sessions, 'chat', 'turn', SPECS, '')
    if mode in ('truncate', 'rewrite'):
        path.write_text('' if mode == 'truncate' else ' ')
        append(path, evidence(ident='new'))
    elif mode == 'late_mapping':
        (sessions / 'sessions.json').write_text(json.dumps({'web:chat': {'sessionId': 'mapped'}}))
    else:
        append(path, evidence())
    result = audit.finish(outputs, sessions, context, 'reply', 'completed')
    assert result['invocation'][0]['status'] == 'not_observed'


def test_new_transcript_filters_copied_history(setup):
    outputs, sessions, path = setup
    context = audit.begin(outputs, sessions, 'chat', 'turn', SPECS, '')
    old = evidence(ident='old')
    for event in old:
        event['timestamp'] = '2020-01-01T00:00:00Z'
    append(path, old + evidence(ident='undated'))
    assert audit.finish(outputs, sessions, context, 'reply', 'completed')['invocation'][0]['status'] == 'not_observed'
    new = evidence(ident='new')
    for event in new:
        event['timestamp'] = time.time()
    append(path, new)
    result = audit.finish(outputs, sessions, context, 'reply', 'stopped')
    assert result['status'] == 'stopped'
    assert result['invocation'][0]['status'] == 'executed'


@pytest.mark.parametrize('command', [
    'echo "claimed; python /skills/demo/scripts/run.py"',
    'python -c "print(\'/skills/demo/scripts/run.py\')"',
    'python /skills/other/scripts/run.py', 'python scripts/run.py',
    'python /skills/demo/scripts/../../other/scripts/run.py',
])
def test_mentions_and_ambiguous_scripts_do_not_count(command):
    assert audit.invocation_evidence(evidence(command), SPECS)[0][0]['status'] == 'not_observed'


def test_loaded_attempted_failed_and_success_are_distinct():
    loaded = evidence()
    loaded[0]['message']['content'][0].update(name='read', arguments={'path': '/skills/demo/SKILL.md'})
    assert audit.invocation_evidence(loaded, SPECS)[0][0]['status'] == 'loaded'
    assert audit.invocation_evidence(evidence()[:1], SPECS)[0][0]['status'] == 'attempted'
    assert audit.invocation_evidence(evidence(success=False), SPECS)[0][0]['status'] == 'attempted'
    running = evidence()
    running[1]['message']['details'] = {'status': 'running'}
    assert audit.invocation_evidence(running, SPECS)[0][0]['status'] == 'attempted'


def test_artifacts_require_change_reference_and_valid_image(setup):
    outputs, _, _ = setup
    (outputs / 'old.txt').write_text('old')
    before = audit.snapshot(outputs)
    (outputs / 'unrelated.txt').write_text('other session')
    (outputs / 'bad.png').write_bytes(b'broken image')
    quality = audit.assess(outputs, before, 'old.txt bad.png', '', SPECS, '')
    assert quality['status'] == 'issues_found'
    assert [a['path'] for a in quality['artifacts']] == ['bad.png']
    assert quality['checks'][-1]['status'] == 'unverified'


def test_invalid_identifiers_rejected_before_write(setup):
    outputs, sessions, _ = setup
    with pytest.raises(Exception) as caught:
        audit.begin(outputs, sessions, '../escape', 'turn', SPECS, '')
    assert caught.value.status_code == 400
    assert not (outputs / '_skill_audits').exists()
