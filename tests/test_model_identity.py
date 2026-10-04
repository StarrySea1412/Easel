"""Synthetic attribution tests: these do not verify real provider execution."""
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from model_identity import latest_observation, model_provider, observation
from tests.test_agent_office import sandbox, append, call, result, snapshot


@pytest.mark.parametrize('provider,model', [
    ('doubao', 'doubao-seed-1-6'), ('deepseek', 'deepseek-chat'), ('qwen', 'qwen3-235b'),
    ('kimi', 'moonshot-v1-8k'), ('glm', 'glm-4.5'), ('minimax', 'MiniMax-M2'),
    ('hunyuan', 'hunyuan-turbos-latest'), ('spark', 'spark-max'), ('wenxin', 'ernie-4.5'),
    ('openai', 'gpt-5'), ('claude', 'claude-sonnet-4'), ('gemini', 'gemini-2.5-pro'),
    ('grok', 'grok-4'), ('mistral', 'mistral-large-latest'),
])
def test_fourteen_explicit_families(provider, model):
    assert model_provider(model) == provider


@pytest.mark.parametrize('model', ['ep-20251002', 'custom-model', 'not-deepseek-chat',
    'gpt-pretend', 'deepseeker', 'openai/deepseek-chat', 'relay/deepseek-chat',
    'a/b/deepseek-chat', 'https://secret.example/key', 'gpt-5?key=secret'])
def test_opaque_aliases_and_conflicting_namespaces_stay_unknown(model):
    assert model_provider(model) == 'unknown'


def test_relay_protocol_is_not_model_brand():
    value = observation({'model': 'deepseek-chat', 'provider': 'openai'}, 1700000000)
    assert value['provider'] == 'deepseek' and value['channel'] == 'openai'
    assert observation({'provider': 'openai-compatible'}, 1700000000)['source'] == 'unknown'
    assert observation({'model': 'ep-123', 'provider': 'doubao'}, 1700000000)['provider'] == 'unknown'


def test_only_dated_assistant_metadata_is_observed():
    assert latest_observation([
        {'timestamp': 1700000000, 'message': {'role': 'user', 'model': 'gpt-5'}},
        {'message': {'role': 'assistant', 'model': 'gpt-5'}},
    ])['source'] == 'unknown'
    events = [{'timestamp': stamp, 'message': {'role': 'assistant', 'model': model}}
              for stamp, model in [(1700000002, 'deepseek-chat'), (1700000000, 'gpt-5')]]
    assert latest_observation(events)['provider'] == 'deepseek'


def test_root_observation_respects_existing_turn_boundary(sandbox):
    import hashlib
    import json
    import time
    append(sandbox['trace'], [{'timestamp': time.time(), 'message': {'role': 'assistant', 'model': 'gpt-5'}}])
    prefix = sandbox['trace'].read_bytes()
    sandbox['record']['_sources'][str(sandbox['trace'])] = {'offset': len(prefix), 'digest': hashlib.sha256(prefix).hexdigest()}
    sandbox['audit_path'].write_text(json.dumps(sandbox['record']), encoding='utf-8')
    assert snapshot(sandbox, live=True)['agents'][0]['observedModel']['source'] == 'unknown'
    append(sandbox['trace'], [{'timestamp': time.time(), 'message': {'role': 'assistant', 'model': 'deepseek-chat', 'provider': 'relay'}}])
    value = snapshot(sandbox, live=True)['agents'][0]['observedModel']
    assert value['provider'] == 'deepseek' and value['channel'] == 'relay'
    assert snapshot(sandbox, live=True, active_turn_id='other')['agents'][0]['observedModel']['source'] == 'unknown'


def test_child_does_not_inherit_parent_or_spawn_configuration(sandbox):
    event = call(args={'model': 'gpt-5'})
    event['message'].update(model='deepseek-chat', provider='relay')
    append(sandbox['trace'], [event, result(payload={'status': 'accepted', 'childSessionKey': 'child', 'model': 'gpt-5'})])
    root, child = snapshot(sandbox, live=True)['agents']
    assert root['observedModel']['provider'] == 'deepseek'
    assert child['observedModel']['source'] == 'unknown'


def test_explicit_other_turn_model_is_not_observed(sandbox):
    import time
    append(sandbox['trace'], [{'timestamp': time.time(), 'turnId': 'foreign-turn',
        'message': {'role': 'assistant', 'model': 'gpt-5'}}])
    assert snapshot(sandbox, live=True)['agents'][0]['observedModel']['source'] == 'unknown'


def test_child_requires_matched_dated_assistant_receipt(sandbox):
    import time
    stamp = time.time() - 20
    append(sandbox['trace'], [call(stamp=stamp), result(stamp=stamp + 1),
        call('list', 'subagents', stamp=stamp + 2), result('list', {'active': [
            {'sessionKey': 'foreign', 'lastAssistantMessage': {'role': 'assistant', 'model': 'gpt-5', 'timestamp': stamp + 3}},
            {'sessionKey': 'agent:main:subagent:child1', 'lastAssistantMessage': {
                'role': 'assistant', 'model': 'claude-sonnet-4', 'provider': 'anthropic', 'timestamp': stamp + 3}},
        ]}, stamp=stamp + 4)])
    value = snapshot(sandbox, live=True)['agents'][1]['observedModel']
    assert value['provider'] == 'claude'
    append(sandbox['trace'], [call('stale', 'subagents', stamp=stamp + 5), result('stale', {'active': [
        {'sessionKey': 'agent:main:subagent:child1', 'model': 'gpt-5', 'lastAssistantMessage': {
            'role': 'assistant', 'model': 'gpt-5', 'timestamp': stamp - 1}},
    ]}, stamp=stamp + 6)])
    assert snapshot(sandbox, live=True)['agents'][1]['observedModel']['provider'] == 'claude'


@pytest.mark.parametrize('identity_key', ['sessionKey', 'sessionId', 'runId', 'agentId', 'agent_id'])
def test_child_rejects_nested_receipt_from_another_identity(sandbox, identity_key):
    import time
    stamp = time.time() - 20
    append(sandbox['trace'], [call(stamp=stamp), result(stamp=stamp + 1),
        call('list', 'subagents', stamp=stamp + 2), result('list', {'active': [
            {'sessionKey': 'agent:main:subagent:child1', 'lastAssistantMessage': {
                'role': 'assistant', 'model': 'gpt-5', 'timestamp': stamp + 3,
                identity_key: 'foreign-identity'}},
        ]}, stamp=stamp + 4)])
    assert snapshot(sandbox, live=True)['agents'][1]['observedModel']['source'] == 'unknown'
