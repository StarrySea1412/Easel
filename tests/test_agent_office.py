"""Synthetic session traces only; this endpoint must not execute an Agent."""
import hashlib
from datetime import datetime, timezone
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
import app as web


def append(path, events):
    with path.open('a', encoding='utf-8') as stream:
        for event in events:
            stream.write(json.dumps(event, ensure_ascii=False) + '\n')


def call(ident='spawn-1', tool='sessions_spawn', args=None, stamp=None):
    return {'timestamp': stamp or time.time(), 'message': {'role': 'assistant', 'content': [
        {'type': 'toolCall', 'id': ident, 'name': tool, 'arguments': args if args is not None else {
            'task': '核对当前任务', 'label': '核对员', 'env': {'PRIVATE_CONFIG': 'DO_NOT_RETURN'}}}]}}


def result(ident='spawn-1', payload=None, stamp=None, **extra):
    return {'timestamp': stamp or time.time(), 'message': {'role': 'toolResult', 'toolCallId': ident,
            'isError': False, 'content': [{'type': 'text', 'text': json.dumps(payload if payload is not None else {
                'status': 'accepted', 'childSessionKey': 'agent:main:subagent:child1', 'runId': 'run-child1'})}], **extra}}


@pytest.fixture
def sandbox(tmp_path):
    sessions, audits, transcripts = [tmp_path / name for name in ('web-sessions', 'audits', 'transcripts')]
    for directory in (sessions, audits, transcripts):
        directory.mkdir()
    trace = transcripts / 'mapped-own.jsonl'
    trace.write_bytes(b'')
    index = {'agent:main:chat': {'sessionId': 'mapped-own'}, 'agent:main:foreign': {'sessionId': 'foreign'}}
    (transcripts / 'sessions.json').write_text(json.dumps(index), encoding='utf-8')
    marker = sessions / 'web_chat.json'
    marker.write_text(json.dumps({'status': 'running', 'turn_id': 'turn1', 'text': 'DO_NOT_RETURN_ROOT_RESPONSE'}), encoding='utf-8')
    audit_path = audits / hashlib.sha256(b'chat').hexdigest()[:24] / 'turn1.json'
    audit_path.parent.mkdir()
    record = {'sessionId': 'chat', 'turnId': 'turn1', 'started': time.time() - 100, 'status': 'running',
              '_request': '完成当前明确任务 token=PRIVATE_TASK_TOKEN',
              '_specs': {'skill-a': {}, 'skill-b': {}, 'skill-c': {}},
              '_sources': {str(trace): {'offset': 0, 'digest': hashlib.sha256(b'').hexdigest()}}}
    audit_path.write_text(json.dumps(record), encoding='utf-8')
    return {'sessions': sessions, 'audits': audits, 'transcripts': transcripts, 'trace': trace,
            'marker': marker, 'audit_path': audit_path, 'record': record}


def snapshot(sandbox, **kwargs):
    return office.snapshot('chat', sandbox['sessions'], sandbox['audits'], sandbox['transcripts'], **kwargs)


def test_skills_prose_and_unmatched_results_do_not_create_agents(sandbox):
    append(sandbox['trace'], [
        {'message': {'role': 'assistant', 'content': '我正在运行三个子 Agent: alpha beta gamma'}},
        call(tool='exec', args={'command': 'echo fake-agent'}), result(),
        result('unmatched', {'status': 'running', 'agentId': 'not-ours'}),
    ])
    output = snapshot(sandbox, live=True)
    assert len(output['agents']) == 1 and output['agents'][0]['status'] == 'running'
    assert output['coverage']['subagents'] == 'not_observed' and output['links'] == []
    assert 'PRIVATE_TASK_TOKEN' not in json.dumps(output)
    assert 'DO_NOT_RETURN_ROOT_RESPONSE' not in json.dumps(output)


@pytest.mark.parametrize('status', ['accepted', 'ok', 'completed', 'success', 'queued'])
def test_spawn_receipt_confirms_identity_and_parent_but_not_completion(sandbox, status):
    append(sandbox['trace'], [call(), result(payload={'status': status, 'childSessionKey': 'agent:main:subagent:child1'})])
    output = snapshot(sandbox, live=True)
    root, child = output['agents']
    assert root['role'] == 'root' and root['id'] == 'root:chat'
    assert child['parentId'] == root['id'] and child['status'] == 'unknown'
    assert child['task'] == '核对当前任务' and child['name'] == '核对员'
    assert output['links'] == [{'from': root['id'], 'to': child['id']}]
    assert output['coverage']['subagents'] == 'observed'
    serialized = json.dumps(output)
    assert 'DO_NOT_RETURN' not in serialized and 'PRIVATE_CONFIG' not in serialized
    assert 'childSessionKey' not in serialized and 'agent:main:subagent:child1' not in serialized


@pytest.mark.parametrize('status,expected', [('running', 'running'), ('done', 'completed'), ('failed', 'failed'), ('stopped', 'stopped')])
def test_only_explicit_status_reports_for_confirmed_children_update_office(sandbox, status, expected):
    append(sandbox['trace'], [call(), result(), call('list', 'subagents', {'action': 'list'}), result('list', {
        'active': [{'sessionKey': 'agent:main:subagent:child1', 'status': status},
                   {'sessionKey': 'foreign-child', 'status': 'running', 'task': 'FOREIGN_TASK_SECRET'}]})])
    output = snapshot(sandbox, live=True)
    assert len(output['agents']) == 2 and output['agents'][1]['status'] == expected
    assert 'FOREIGN_TASK_SECRET' not in json.dumps(output)


def test_failed_spawn_and_echoed_parent_identity_do_not_create_children(sandbox):
    append(sandbox['trace'], [call(), result(payload={'status': 'failed', 'childSessionKey': 'reserved-not-created'}),
        call('echo'), result('echo', {'status': 'accepted', 'sessionKey': 'agent:main:chat', 'agentId': 'main'})])
    assert len(snapshot(sandbox, live=True)['agents']) == 1


def test_prefix_boundary_excludes_previous_turns_and_foreign_events(sandbox):
    append(sandbox['trace'], [call('old'), result('old', {'status': 'accepted', 'childSessionKey': 'old-child'})])
    prefix = sandbox['trace'].read_bytes()
    sandbox['record']['_sources'][str(sandbox['trace'])] = {'offset': len(prefix), 'digest': hashlib.sha256(prefix).hexdigest()}
    sandbox['audit_path'].write_text(json.dumps(sandbox['record']), encoding='utf-8')
    foreign_call, foreign_result = call('foreign'), result('foreign', {'status': 'accepted', 'childSessionKey': 'FOREIGN_CHILD'})
    foreign_call['sessionId'] = foreign_result['sessionId'] = 'not-our-session'
    append(sandbox['trace'], [foreign_call, foreign_result, call(), result()])
    output = snapshot(sandbox, live=True)
    assert len(output['agents']) == 2
    assert output['agents'][1]['id'] == 'subagent:' + hashlib.sha256(b'agent:main:subagent:child1').hexdigest()[:20]


@pytest.mark.parametrize('live', [False, True])
def test_finished_turn_filters_later_and_undated_same_session_events(sandbox, live):
    ended = time.time() - 50
    append(sandbox['trace'], [call(stamp=ended - 10), result(stamp=ended - 9),
        call('later', stamp=ended + 10), result('later', {'status': 'accepted', 'childSessionKey': 'later-child'}, stamp=ended + 11),
        {'message': call('undated')['message']}, {'message': result('undated', {'status': 'accepted', 'childSessionKey': 'undated-child'})['message']}])
    sandbox['marker'].write_text(json.dumps({'status': 'done', 'turn_id': 'turn1', 'clean_end': True}), encoding='utf-8')
    os.utime(sandbox['marker'], (ended, ended))
    output = snapshot(sandbox, live=live)
    assert output['agents'][0]['status'] == 'completed'
    assert len(output['agents']) == 2 and output['agents'][1]['status'] == 'unknown'


def test_trace_rewrite_and_missing_boundaries_are_not_new_agent_evidence(sandbox):
    sandbox['record']['_sources'][str(sandbox['trace'])] = {'offset': 5, 'digest': 'old-digest'}
    sandbox['audit_path'].write_text(json.dumps(sandbox['record']), encoding='utf-8')
    append(sandbox['trace'], [call(), result()])
    output = snapshot(sandbox, live=True)
    assert len(output['agents']) == 1 and output['warnings']
    sandbox['audit_path'].write_text(json.dumps({'sessionId': 'chat', 'turnId': 'turn1', 'status': 'running'}), encoding='utf-8')
    assert len(snapshot(sandbox, live=True)['agents']) == 1


def test_unrelated_transcripts_and_user_supplied_index_paths_are_never_opened(sandbox, monkeypatch):
    foreign = sandbox['transcripts'] / 'foreign.jsonl'
    foreign.write_text('FOREIGN_PRIVATE_TRACE', encoding='utf-8')
    append(sandbox['trace'], [call(), result()])
    original = Path.open
    def guarded(path, *args, **kwargs):
        assert path != foreign, 'another session trace must never be read'
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'open', guarded)
    assert len(snapshot(sandbox, live=True)['agents']) == 2
    index = sandbox['transcripts'] / 'sessions.json'
    index.write_text(json.dumps({'agent:main:chat': {'sessionId': '../../foreign'}}), encoding='utf-8')
    assert len(snapshot(sandbox, live=True)['agents']) == 1


def test_symlinked_transcript_is_rejected_before_opening(sandbox, monkeypatch):
    original_link, original_open = Path.is_symlink, Path.open
    monkeypatch.setattr(Path, 'is_symlink', lambda path: path == sandbox['trace'] or original_link(path))
    def guarded(path, *args, **kwargs):
        assert path != sandbox['trace'], 'untrusted link must not be opened'
        return original_open(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'open', guarded)
    output = snapshot(sandbox, live=True)
    assert len(output['agents']) == 1 and output['warnings']


def test_another_turns_audit_cannot_supply_tasks_or_child_identity(sandbox):
    append(sandbox['trace'], [call(), result()])
    output = snapshot(sandbox, live=True, active_turn_id='new-turn')
    assert output['turnId'] == 'new-turn' and len(output['agents']) == 1
    assert output['agents'][0]['task'] == ''
    sandbox['record']['sessionId'] = 'foreign'
    sandbox['audit_path'].write_text(json.dumps(sandbox['record']), encoding='utf-8')
    output = snapshot(sandbox, live=True)
    assert len(output['agents']) == 1 and output['agents'][0]['task'] == ''


@pytest.mark.parametrize('session', ['', '../foreign', 'x/y', 'x\\y', '..%2fforeign', 'x' * 121])
def test_invalid_session_identifiers_fail_before_reading(sandbox, monkeypatch, session):
    monkeypatch.setattr(Path, 'open', lambda *args, **kwargs: pytest.fail('invalid input must not read files'))
    with pytest.raises(HTTPException) as error:
        office.snapshot(session, sandbox['sessions'], sandbox['audits'], sandbox['transcripts'])
    assert error.value.status_code == 400


def test_missing_and_corrupt_records_return_unknown_without_guessing(sandbox):
    sandbox['marker'].unlink()
    output = snapshot(sandbox)
    assert output['agents'][0]['status'] == 'unknown' and output['turnId'] is None
    sandbox['marker'].write_text('{invalid', encoding='utf-8')
    output = snapshot(sandbox)
    assert output['warnings'] and output['coverage']['subagents'] == 'not_observed'


def test_trace_permission_errors_are_safe_partial_results(sandbox, monkeypatch):
    original = Path.open
    def blocked(path, *args, **kwargs):
        if path == sandbox['trace']:
            raise PermissionError('PRIVATE_FILESYSTEM_DETAIL')
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'open', blocked)
    output = snapshot(sandbox, live=True)
    assert output['agents'][0]['status'] == 'running' and output['warnings']
    assert 'PRIVATE_FILESYSTEM_DETAIL' not in json.dumps(output)


def test_malformed_events_cannot_crash_or_fabricate_agents(sandbox):
    append(sandbox['trace'], [call(), result(), {'message': {'role': 'toolResult', 'toolCallId': []}},
        call('list', 'subagents', {}), result('list', {'active': [{'sessionKey': 'agent:main:subagent:child1', 'status': {'bad': True}}]})])
    with sandbox['trace'].open('a') as stream:
        stream.write('{bad}\n')
        stream.write('{unfinished')
    output = snapshot(sandbox, live=True)
    assert len(output['agents']) == 2 and output['agents'][1]['status'] == 'unknown'
    assert output['warnings']


def test_trace_size_budget_returns_explicit_limited_coverage(sandbox, monkeypatch):
    monkeypatch.setattr(office, 'MAX_TRACE_BYTES', 64)
    append(sandbox['trace'], [call(), result()])
    output = snapshot(sandbox, live=True)
    assert len(output['agents']) == 1 and output['warnings']
    assert output['coverage']['identityScanLimited'] is True
    assert output['coverage']['observedAgentCount'] == 1


@pytest.mark.parametrize('total', [9, 12, 20, 50, 65, 100])
def test_all_confirmed_identities_survive_office_capacity_and_recent_event_limits(sandbox, total):
    for index in range(total - 1):
        append(sandbox['trace'], [call(f'spawn-{index}'), result(f'spawn-{index}', {
            'status': 'accepted', 'childSessionKey': f'child-{index}'})])
    append(sandbox['trace'], [call('list', 'subagents', {}), result('list', {
        'active': [{'sessionKey': f'child-{index}', 'status': 'running'} for index in range(total - 1)]})])
    output = snapshot(sandbox, live=True)
    assert len(output['agents']) == total and len(output['links']) == total - 1
    assert len({agent['id'] for agent in output['agents']}) == total
    assert all(agent['status'] == 'running' for agent in output['agents'][1:])
    assert output['coverage']['observedAgentCount'] == total
    assert output['coverage']['identityScanLimited'] is False
    assert not output['warnings']
    assert len(output['events']) <= office.MAX_PUBLIC_EVENTS


def test_large_team_still_rejects_invalid_and_unproven_identities_and_deduplicates_receipts(sandbox):
    for index in range(99):
        append(sandbox['trace'], [call(f'spawn-{index}'), result(f'spawn-{index}', {
            'status': 'accepted', 'childSessionKey': f'child-{index}'})])
    for index, invalid in enumerate(['', 'bad identity', 'bad\nidentity', 'x' * 201, [], {}]):
        append(sandbox['trace'], [call(f'invalid-{index}'), result(f'invalid-{index}', {
            'status': 'accepted', 'childSessionKey': invalid})])
    append(sandbox['trace'], [call('duplicate'), result('duplicate', {'status': 'accepted', 'childSessionKey': 'child-98'}),
        result('unmatched', {'status': 'accepted', 'childSessionKey': 'unproven-child'}),
        call('list', 'subagents', {}), result('list', {'active': [
            {'sessionKey': f'foreign-{index}', 'status': 'running'} for index in range(100)
        ] + [{'sessionKey': 'child-98', 'status': 'failed'}]})])
    output = snapshot(sandbox, live=True)
    assert len(output['agents']) == 100
    assert output['agents'][-1]['status'] == 'failed', 'the final known member is updated even after 100 unrelated list items'


def test_trace_event_budget_exposes_partial_identity_count_without_fabricating_missing_members(sandbox, monkeypatch):
    monkeypatch.setattr(office, 'MAX_EVENTS', 10)
    for index in range(20):
        append(sandbox['trace'], [call(f'spawn-{index}'), result(f'spawn-{index}', {
            'status': 'accepted', 'childSessionKey': f'child-{index}'})])
    output = snapshot(sandbox, live=True)
    assert len(output['agents']) == 6
    assert output['coverage']['observedAgentCount'] == 6
    assert output['coverage']['identityScanLimited'] is True
    assert office.TRACE_LIMIT_WARNING in output['warnings']


@pytest.mark.parametrize('extra,status', [
    ({'clean_end': True}, 'completed'),
    ({'error': {'message': 'PRIVATE_FAILURE'}}, 'failed'),
    ({'stop_reason': 'user_stopped'}, 'stopped'),
    ({'clean_end': False}, 'unknown'),
])
@pytest.mark.parametrize('live', [False, True])
def test_root_terminal_states_use_snapshot_evidence_without_repeating_error_text(sandbox, extra, status, live):
    sandbox['marker'].write_text(json.dumps({'status': 'done', 'turn_id': 'turn1', **extra}), encoding='utf-8')
    output = snapshot(sandbox, live=live, active_turn_id='turn1' if live else '')
    assert output['agents'][0]['status'] == status
    assert 'PRIVATE_FAILURE' not in json.dumps(output)


def test_old_terminal_marker_cannot_finish_a_new_active_turn(sandbox):
    sandbox['marker'].write_text(json.dumps({'status': 'done', 'turn_id': 'turn1', 'clean_end': True}), encoding='utf-8')
    output = snapshot(sandbox, live=True, active_turn_id='turn2')
    assert output['turnId'] == 'turn2'
    assert output['agents'][0]['status'] == 'unknown'
    assert output['events'] == [] and len(output['agents']) == 1
    assert '会话轮次正在更新' in output['agents'][0]['evidence']
    sandbox['marker'].write_text(json.dumps({'status': 'running', 'turn_id': 'turn2'}), encoding='utf-8')
    assert snapshot(sandbox, live=True, active_turn_id='turn2')['agents'][0]['status'] == 'running'


@pytest.mark.parametrize('live', [False, True])
@pytest.mark.parametrize('reported,expected,label', [
    ('running', 'unknown', '工作中'), ('thinking', 'unknown', '思考中'), ('waiting', 'unknown', '等待中'),
    ('completed', 'completed', ''), ('failed', 'failed', ''), ('stopped', 'stopped', ''),
])
def test_finished_parent_retains_child_receipt_but_not_unconfirmed_active_state(sandbox, live, reported, expected, label):
    ended = time.time() - 10
    append(sandbox['trace'], [call(stamp=ended - 4), result(stamp=ended - 3),
        call('list', 'subagents', {'action': 'list'}, stamp=ended - 2), result('list', {
            'agents': [{'sessionKey': 'agent:main:subagent:child1', 'status': reported}]}, stamp=ended - 1)])
    sandbox['marker'].write_text(json.dumps({'status': 'done', 'turn_id': 'turn1', 'clean_end': True}), encoding='utf-8')
    os.utime(sandbox['marker'], (ended, ended))
    output = snapshot(sandbox, live=live, active_turn_id='turn1' if live else '')
    root, child = output['agents']
    assert root['status'] == 'completed' and child['status'] == expected
    assert child['name'] == '核对员' and child['task'] == '核对当前任务'
    if label:
        assert f'最近上报为“{label}”' in child['evidence']
        assert '当前状态未确认' in child['evidence']
    else:
        assert '工具回执明确上报' in child['evidence']


def test_finished_parent_does_not_keep_a_running_spawn_receipt_active(sandbox):
    ended = time.time() - 10
    append(sandbox['trace'], [call(stamp=ended - 2), result(payload={
        'status': 'running', 'childSessionKey': 'agent:main:subagent:child1'}, stamp=ended - 1)])
    sandbox['marker'].write_text(json.dumps({'status': 'done', 'turn_id': 'turn1', 'stop_reason': 'user_stopped'}), encoding='utf-8')
    os.utime(sandbox['marker'], (ended, ended))
    root, child = snapshot(sandbox, live=True, active_turn_id='turn1')['agents']
    assert root['status'] == 'stopped' and child['status'] == 'unknown'
    assert '最近上报为“工作中”' in child['evidence']


def test_live_thinking_requires_a_trace_event_and_stale_running_marker_is_unknown(sandbox):
    append(sandbox['trace'], [{'message': {'role': 'assistant', 'content': [{'type': 'thinking', 'thinking': 'PRIVATE_REASONING_NOT_RETURNED'}]}}])
    assert snapshot(sandbox, live=True)['agents'][0]['status'] == 'thinking'
    output = snapshot(sandbox)
    assert output['agents'][0]['status'] == 'unknown'
    assert 'PRIVATE_REASONING_NOT_RETURNED' not in json.dumps(output)


def test_http_endpoint_uses_only_requested_session_and_never_launches_execution(sandbox, monkeypatch):
    class Process:
        def poll(self): return None
    monkeypatch.setattr(web, 'SESSIONS_DIR', sandbox['sessions'])
    monkeypatch.setattr(web, 'OUTPUTS_DIR', sandbox['audits'].parent)
    # Route derives the standard audit subdirectory.
    monkeypatch.setattr(office, '_audit_record', lambda *args: sandbox['record'])
    monkeypatch.setattr(web, 'OPENCLAW_SESSIONS_DIR', sandbox['transcripts'])
    monkeypatch.setattr(web, '_RUNNING_CHAT', {'chat': Process()})
    monkeypatch.setattr(web, '_ACTIVE_SKILL_TURNS', {'chat': 'turn1'})
    monkeypatch.setattr(web.subprocess, 'Popen', lambda *args, **kwargs: pytest.fail('must not start an agent'))
    monkeypatch.setattr(web.subprocess, 'run', lambda *args, **kwargs: pytest.fail('must not run a command'))
    append(sandbox['trace'], [call(), result()])
    client = TestClient(web.app, base_url='http://127.0.0.1:7860', client=('127.0.0.1', 51234))
    response = client.get('/api/agent-office', params={'sessionId': 'chat'})
    assert response.status_code == 200 and response.json()['agents'][0]['status'] == 'running'
    assert len(response.json()['agents']) == 2
    assert client.get('/api/agent-office', params={'sessionId': '../foreign'}).status_code == 400


def test_public_tool_events_expose_call_names_and_return_evidence_without_arguments(sandbox):
    append(sandbox['trace'], [call('exec-call', 'exec', {'command': 'PRIVATE_COMMAND', 'token': 'PRIVATE_TOOL_TOKEN'}),
                             result('exec-call', {'private': 'PRIVATE_TOOL_OUTPUT'})])
    output = snapshot(sandbox, live=True)
    events = output['events']
    assert [event['kind'] for event in events] == ['call', 'result']
    assert [event['status'] for event in events] == ['called', 'returned']
    assert [event['title'] for event in events] == ['调用工具：exec', '工具返回：exec']
    assert all(event['agentId'] == 'root:chat' for event in events)
    assert all(datetime.fromisoformat(event['at']).tzinfo == timezone.utc for event in events)
    assert datetime.fromisoformat(output['observedAt']).tzinfo == timezone.utc
    serialized = json.dumps(events, ensure_ascii=False)
    assert all(secret not in serialized for secret in ('PRIVATE_COMMAND', 'PRIVATE_TOOL_TOKEN', 'PRIVATE_TOOL_OUTPUT', 'exec-call', '成功'))


def test_only_matched_result_with_explicit_error_bit_is_marked_failed(sandbox):
    append(sandbox['trace'], [result('unmatched', {'status': 'failed'}),
        call('bad', 'read', {}), result('bad', {'error': 'PRIVATE_EXCEPTION'}, isError=True),
        call('returned', 'exec', {}), result('returned', {'status': 'failed', 'exitCode': 1})])
    events = snapshot(sandbox, live=True)['events']
    assert len(events) == 4
    assert events[1]['status'] == 'failed' and events[1]['title'] == '工具返回错误：read'
    assert events[3]['status'] == 'returned'
    assert 'PRIVATE_EXCEPTION' not in json.dumps(events)


def test_public_event_list_is_bounded_stable_and_parent_scoped(sandbox):
    append(sandbox['trace'], [call(), result()])
    for index in range(25):
        append(sandbox['trace'], [call(f'tool-{index}', f'tool_{index}', {}), result(f'tool-{index}', {})])
    first = snapshot(sandbox, live=True)['events']
    second = snapshot(sandbox, live=True)['events']
    assert len(first) == 40 and first == second
    assert len({event['id'] for event in first}) == 40
    assert first[0]['title'] == '调用工具：tool_5'
    assert first[-1]['title'] == '工具返回：tool_24'
    assert {event['agentId'] for event in first} == {'root:chat'}


def test_call_records_follow_the_same_turn_and_session_isolation(sandbox):
    append(sandbox['trace'], [call('old', 'old_tool', {}), result('old', {})])
    prefix = sandbox['trace'].read_bytes()
    sandbox['record']['_sources'][str(sandbox['trace'])] = {'offset': len(prefix), 'digest': hashlib.sha256(prefix).hexdigest()}
    sandbox['audit_path'].write_text(json.dumps(sandbox['record']), encoding='utf-8')
    foreign_call, foreign_result = call('foreign', 'foreign_tool', {}), result('foreign', {})
    foreign_call['sessionKey'] = foreign_result['sessionKey'] = 'agent:main:foreign'
    append(sandbox['trace'], [foreign_call, foreign_result, call('current', 'current_tool', {}), result('current', {})])
    events = snapshot(sandbox, live=True)['events']
    assert [event['title'] for event in events] == ['调用工具：current_tool', '工具返回：current_tool']
    assert snapshot(sandbox, live=True, active_turn_id='missing-turn')['events'] == []


def test_missing_event_timestamps_are_omitted_and_invalid_tool_names_are_not_echoed(sandbox):
    append(sandbox['trace'], [{'message': call('odd', 'exec token=PRIVATE_TOKEN', {})['message']},
                             {'message': result('odd', {})['message']}])
    events = snapshot(sandbox, live=True)['events']
    assert len(events) == 2 and all('at' not in event for event in events)
    assert 'PRIVATE_TOKEN' not in json.dumps(events)
    assert events[0]['title'] == '调用工具：未命名工具'


def advance_turn(sandbox):
    prefix = sandbox['trace'].read_bytes()
    record = {**sandbox['record'], 'turnId': 'turn2', '_request': 'NEXT_TURN_PRIVATE_TASK',
              '_sources': {str(sandbox['trace']): {'offset': len(prefix), 'digest': hashlib.sha256(prefix).hexdigest()}}}
    sandbox['audit_path'].with_name('turn2.json').write_text(json.dumps(record), encoding='utf-8')
    sandbox['marker'].write_text(json.dumps({'status': 'running', 'turn_id': 'turn2'}), encoding='utf-8')
    append(sandbox['trace'], [call('next', 'next_turn_tool', {}), result('next', {})])


def assert_updating(output, turn_id):
    assert output['turnId'] == turn_id and output['events'] == [] and output['links'] == []
    assert len(output['agents']) == 1 and output['agents'][0]['status'] == 'unknown'
    assert output['agents'][0]['task'] == '' and output['warnings']
    assert output['source'] == 'local_session_state'
    assert 'NEXT_TURN_PRIVATE_TASK' not in json.dumps(output)


def test_stale_active_turn_cannot_read_new_turn_events_or_use_its_marker(sandbox):
    append(sandbox['trace'], [call(), result()])
    advance_turn(sandbox)
    assert_updating(snapshot(sandbox, live=True, active_turn_id='turn1'), 'turn1')
    current = snapshot(sandbox, live=True, active_turn_id='turn2')
    assert current['turnId'] == 'turn2'
    assert [event['title'] for event in current['events']] == ['调用工具：next_turn_tool', '工具返回：next_turn_tool']


def test_queued_marker_does_not_replace_the_still_active_turn(sandbox):
    append(sandbox['trace'], [call(), result()])
    sandbox['marker'].write_text(json.dumps({'status': 'running', 'turn_id': 'queued-turn'}), encoding='utf-8')
    assert_updating(snapshot(sandbox, live=True, active_turn_id='turn1'), 'turn1')


def test_marker_replacement_during_its_read_invalidates_the_snapshot(sandbox, monkeypatch):
    original = office._read_json
    def replace_after_read(path, *args):
        value = original(path, *args)
        if path == sandbox['marker']:
            advance_turn(sandbox)
        return value
    monkeypatch.setattr(office, '_read_json', replace_after_read)
    assert_updating(snapshot(sandbox, live=True, active_turn_id='turn1'), 'turn1')


@pytest.mark.parametrize('same_turn', [False, True])
def test_marker_change_while_reading_events_discards_sampled_evidence(sandbox, monkeypatch, same_turn):
    append(sandbox['trace'], [call(), result()])
    original = office._events
    sampled = []
    def change_during_read(*args):
        advance_turn(sandbox)
        if same_turn:
            # A terminal save can repeat the turn ID: equality of IDs alone
            # must not certify a snapshot read across different marker files.
            sandbox['marker'].write_text(json.dumps({'status': 'done', 'turn_id': 'turn1', 'clean_end': True}), encoding='utf-8')
        events = original(*args)
        sampled.extend(events)
        return events
    monkeypatch.setattr(office, '_events', change_during_read)
    output = snapshot(sandbox, live=True, active_turn_id='turn1')
    assert any('next_turn_tool' in json.dumps(event) for event in sampled)
    assert_updating(output, 'turn1')


def test_terminal_marker_replaced_during_audit_read_cannot_extend_old_end_time(sandbox, monkeypatch):
    ended = time.time() - 50
    sandbox['marker'].write_text(json.dumps({'status': 'done', 'turn_id': 'turn1', 'clean_end': True}), encoding='utf-8')
    os.utime(sandbox['marker'], (ended, ended))
    original = office._audit_record
    def change_during_read(*args):
        audit = original(*args)
        advance_turn(sandbox)
        return audit
    monkeypatch.setattr(office, '_audit_record', change_during_read)
    assert_updating(snapshot(sandbox), 'turn1')


@pytest.fixture
def office_route(sandbox, monkeypatch):
    class Process:
        exit_code = None
        def poll(self): return self.exit_code
    process = Process()
    monkeypatch.setattr(web, 'SESSIONS_DIR', sandbox['sessions'])
    monkeypatch.setattr(web, 'OUTPUTS_DIR', sandbox['audits'].parent)
    monkeypatch.setattr(web, 'OPENCLAW_SESSIONS_DIR', sandbox['transcripts'])
    monkeypatch.setattr(web, '_RUNNING_CHAT', {'chat': process})
    monkeypatch.setattr(web, '_ACTIVE_SKILL_TURNS', {'chat': 'turn1'})
    original = office._audit_record
    monkeypatch.setattr(office, '_audit_record', lambda directory, *args: original(sandbox['audits'], *args))
    monkeypatch.setattr(web.subprocess, 'Popen', lambda *args, **kwargs: pytest.fail('must not start an agent'))
    monkeypatch.setattr(web.subprocess, 'run', lambda *args, **kwargs: pytest.fail('must not run a command'))
    with TestClient(web.app, base_url='http://127.0.0.1:7860', client=('127.0.0.1', 51234)) as client:
        yield client, process, Process


def test_route_revalidates_execution_after_waiting_for_worker(sandbox, monkeypatch, office_route):
    client, _, process_type = office_route
    original = web.asyncio.to_thread
    async def delayed(function, *args, **kwargs):
        if function is office.snapshot:
            advance_turn(sandbox)
            web._RUNNING_CHAT['chat'] = process_type()
            web._ACTIVE_SKILL_TURNS['chat'] = 'turn2'
        return await original(function, *args, **kwargs)
    monkeypatch.setattr(web.asyncio, 'to_thread', delayed)
    response = client.get('/api/agent-office', params={'sessionId': 'chat'})
    assert response.status_code == 200
    assert_updating(response.json(), None)


@pytest.mark.parametrize('change', ['turn', 'process', 'live'])
def test_route_discards_evidence_if_execution_changes_inside_worker(sandbox, monkeypatch, office_route, change):
    client, process, process_type = office_route
    original = office._events
    def change_during_read(*args):
        # Keep the marker unchanged to prove the independent runtime check is
        # needed even if the filesystem checks succeed in the worker.
        if change == 'turn':
            web._ACTIVE_SKILL_TURNS['chat'] = 'turn2'
        elif change == 'process':
            web._RUNNING_CHAT['chat'] = process_type()
        else:
            process.exit_code = 0
        append(sandbox['trace'], [call('next', 'next_turn_tool', {}), result('next', {})])
        return original(*args)
    monkeypatch.setattr(office, '_events', change_during_read)
    response = client.get('/api/agent-office', params={'sessionId': 'chat'})
    assert response.status_code == 200
    assert_updating(response.json(), None)
