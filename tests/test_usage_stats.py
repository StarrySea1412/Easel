"""Usage accounting uses isolated transcript fixtures; never reads real credentials/chats."""
from __future__ import annotations

import asyncio
import json
import sys
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import usage_stats as usage
import app as web


@pytest.fixture
def sandbox(tmp_path):
    project = tmp_path / 'project'
    state = tmp_path / 'easel-profile'
    snapshots = project / 'outputs' / '_sessions'
    transcripts = state / 'agents' / 'main' / 'sessions'
    snapshots.mkdir(parents=True)
    transcripts.mkdir(parents=True)
    return project, state, snapshots, transcripts


def record(event_id, role='assistant', tokens=None, timestamp='2026-09-30T01:00:00Z'):
    message = {'role': role, 'content': 'PRIVATE CONTENT NOT FOR LEDGER',
               'model': 'sample-model', 'provider': 'sample-provider'}
    if tokens is not None:
        message['usage'] = tokens
    return {'id': event_id, 'type': 'message', 'timestamp': timestamp, 'message': message}


def transcript(sandbox, session_id, events):
    _, _, snapshots, transcripts = sandbox
    (snapshots / f'web_{session_id}.json').write_text('{}', encoding='utf-8')
    name = str(uuid.uuid5(usage._SESSION_NS, session_id))
    path = transcripts / f'{name}.jsonl'
    path.write_text('\n'.join(json.dumps(event) for event in events) + '\n', encoding='utf-8')
    return path


def collect(sandbox, session_id='chat1', **kwargs):
    return usage.collect_usage(*sandbox[:3], session_id, **kwargs)


def test_normalization_does_not_double_count_cached_and_reasoning_tokens():
    pi = usage.normalize_usage({'input': 10, 'output': 5, 'cacheRead': 20, 'cacheWrite': 3,
                                'totalTokens': 38, 'reasoning': 2, 'cost': {'total': .002}})
    assert pi['inputTokens'] == 33 and pi['totalTokens'] == 38
    assert pi['reasoningTokens'] == 2 and pi['recordedCostUsd'] == .002
    openai = usage.normalize_usage({'prompt_tokens': 33, 'completion_tokens': 5, 'total_tokens': 38,
        'prompt_tokens_details': {'cached_tokens': 20}, 'completion_tokens_details': {'reasoning_tokens': 2}})
    assert openai['inputTokens'] == 33 and openai['totalTokens'] == 38
    assert openai['recordedCostUsd'] is None and openai['cacheWriteTokens'] is None
    anthropic = usage.normalize_usage({'input_tokens': 10, 'output_tokens': 5,
        'cache_read_input_tokens': 20, 'cache_creation_input_tokens': 3})
    assert anthropic['inputTokens'] == 33 and anthropic['totalTokens'] == 38


def test_unknown_values_are_not_zero_and_partial_coverage_is_explicit(sandbox):
    transcript(sandbox, 'chat1', [record('u1', 'user'), record('a1'),
        record('a2', tokens={'input': 0, 'output': 0, 'cost': {'total': 0}})])
    data = collect(sandbox)
    assert data['session']['totalTokens'] == 0
    assert data['session']['cacheReadTokens'] is None
    assert data['session']['reportedCalls'] == 1 and data['session']['missingCalls'] == 1
    assert data['session']['coverage']['totalTokens'] == 1
    assert data['turns'][0]['calls'][0]['totalTokens'] is None
    assert usage.normalize_usage({'input': -1, 'output': True, 'totalTokens': float('nan')})['totalTokens'] is None


def test_round_session_and_project_aggregation_and_persistent_deduplication(sandbox):
    events = [record('u1', 'user'), record('a1', tokens={'input': 10, 'output': 5}),
              record('u2', 'user', timestamp='2026-09-30T02:00:00Z'),
              record('a2', tokens={'input': 20, 'output': 8}, timestamp='2026-09-30T02:00:01Z')]
    path = transcript(sandbox, 'chat1', events + [events[-1]])
    other = transcript(sandbox, 'chat2', [record('u3', 'user'), record('a3', tokens={'input': 7, 'output': 3})])
    first = collect(sandbox)
    assert first['session']['totalTokens'] == 43 and first['project']['totalTokens'] == 53
    assert first['session']['calls'] == 2 and first['turnCount'] == 2
    assert first['turns'][0]['number'] == 2 and first['turns'][0]['summary']['totalTokens'] == 28
    assert collect(sandbox)['project']['totalTokens'] == 53
    path.unlink()
    other.unlink()
    after = collect(sandbox)
    assert after['project']['totalTokens'] == 53
    ledger_bytes = next((sandbox[2].parent / '_usage').glob('*.sqlite3')).read_bytes()
    assert b'PRIVATE CONTENT' not in ledger_bytes
    assert 'PRIVATE CONTENT' not in json.dumps(after)


def test_duplicate_event_with_later_usage_updates_once(sandbox):
    transcript(sandbox, 'chat1', [record('u1', 'user'), record('a1'),
        record('a1', tokens={'input': 11, 'output': 4})])
    data = collect(sandbox)
    assert data['session']['calls'] == 1 and data['session']['totalTokens'] == 15


def test_http_mapping_and_unrelated_profile_records_are_excluded(sandbox):
    _, _, snapshots, transcripts = sandbox
    (snapshots / 'web_chat1.json').write_text('{}')
    (transcripts / 'sessions.json').write_text(json.dumps({
        'agent:main:chat1': {'sessionId': 'http-session'},
        'agent:main:other-project': {'sessionId': 'unrelated'},
        'agent:main:badpath': {'sessionId': '../escape'},
    }))
    (transcripts / 'http-session.jsonl').write_text(json.dumps(record('a1', tokens={'input': 4, 'output': 5})))
    (transcripts / 'unrelated.jsonl').write_text(json.dumps(record('a2', tokens={'input': 999, 'output': 999})))
    data = collect(sandbox)
    assert data['project']['totalTokens'] == 9 and data['project']['calls'] == 1
    assert data['turns'][0]['unattributed'] is True
    assert collect(sandbox, 'other-project')['session']['totalTokens'] is None
    with pytest.raises(ValueError):
        collect(sandbox, '../../another-project')


def test_malformed_tail_retries_without_erasing_known_usage(sandbox):
    path = transcript(sandbox, 'chat1', [record('a1', tokens={'input': 2, 'output': 3})])
    with path.open('a', encoding='utf-8') as stream:
        stream.write('{"incomplete":')
    data = collect(sandbox)
    assert data['session']['totalTokens'] == 5 and data['issues']
    path.write_text(json.dumps(record('a1')) + '\n' + json.dumps(record('a2', tokens={'input': 3, 'output': 4})))
    updated = collect(sandbox)
    assert updated['session']['totalTokens'] == 12 and not updated['issues']


def test_pagination_preserves_full_totals(sandbox):
    transcript(sandbox, 'chat1', [item for i in range(4) for item in (
        record(f'u{i}', 'user', timestamp=f'2026-09-30T0{i}:00:00Z'),
        record(f'a{i}', tokens={'input': 2, 'output': 3}, timestamp=f'2026-09-30T0{i}:00:01Z'))])
    page = collect(sandbox, limit=2, offset=2)
    assert page['turnCount'] == 4 and len(page['turns']) == 2
    assert [turn['number'] for turn in page['turns']] == [2, 1]
    assert page['session']['totalTokens'] == 20


def test_usage_endpoint_uses_project_paths_and_validates_query(sandbox, monkeypatch):
    monkeypatch.setattr(web, 'PROJECT_ROOT', sandbox[0])
    monkeypatch.setattr(web, 'openclaw_state_dir', lambda: sandbox[1])
    monkeypatch.setattr(web, 'SESSIONS_DIR', sandbox[2])
    transcript(sandbox, 'chat1', [record('a1', tokens={'input': 8, 'output': 2})])
    data = asyncio.run(web.api_usage(sessionId='chat1'))
    assert data['session']['totalTokens'] == 10
    for args in ({'sessionId': '../oops'}, {'limit': 101}, {'offset': -1}):
        with pytest.raises(web.HTTPException) as error:
            asyncio.run(web.api_usage(**args))
        assert error.value.status_code == 400
