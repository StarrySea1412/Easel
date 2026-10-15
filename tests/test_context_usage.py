"""Context snapshots remain separate from cumulative/billable usage."""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from context_usage import collect_context


@pytest.fixture
def state(tmp_path):
    native = tmp_path / 'state'
    web = tmp_path / 'web'
    web.mkdir()
    (web / 'web_chat1.json').write_text('{}')
    sessions = native / 'agents/main/sessions'
    sessions.mkdir(parents=True)
    config = {'agents': {'defaults': {'model': {'primary': 'p/m'}}},
              'models': {'providers': {'p': {'apiKey': 'secret-never-export', 'models': [
                  {'id': 'm', 'contextWindow': 100000}, {'id': 'next', 'contextWindow': 200000}]}}}}
    (native / 'openclaw.json').write_text(json.dumps(config))
    report = {'source': 'run', 'model': 'm', 'provider': 'p', 'workspaceDir': '/private',
              'systemPrompt': {'chars': 400, 'projectContextChars': 80},
              'skills': {'promptChars': 40, 'entries': [{'name': 'secret-skill'}]},
              'tools': {'listChars': 20, 'schemaChars': 200, 'entries': [
                  {'name': 'exec', 'schemaChars': 120}, {'name': 'mcp__test', 'schemaChars': 80}]}}
    entry = {'totalTokens': 1000, 'inputTokens': 999999, 'totalTokensFresh': True,
             'modelProvider': 'p', 'model': 'm', 'updatedAt': 1792000000000, 'systemPromptReport': report}
    def save(value=entry):
        (sessions / 'sessions.json').write_text(json.dumps({'agent:main:web:chat1': value}))
    save()
    return native, web, entry, save


def test_snapshot_and_non_overlapping_estimates_do_not_expose_prompts(state):
    native, web, _, _ = state
    value = collect_context(native, web, 'chat1')
    assert value['usedTokens'] == 1000 and value['capacity'] == 100000
    assert value['usageSource'] == 'runtime' and value['stale'] is False
    assert value['breakdownStatus'] == 'estimated'
    parts = {p['key']: p['tokens'] for p in value['breakdown']}
    assert parts == dict(messages=850, system_tools=35, mcp_tools=20, system_prompt=65, skills=10, other=20)
    assert sum(parts.values()) == 1000
    assert abs(sum(p['percent'] for p in value['breakdown']) - 100) < .01
    for secret in ('secret-never-export', 'secret-skill', '/private', '999999'):
        assert secret not in json.dumps(value)


def test_model_switch_uses_new_capacity_without_reusing_old_occupancy(state):
    native, web, _, _ = state
    value = collect_context(native, web, 'chat1', 'p/next')
    assert value['capacity'] == 200000
    assert value['usedTokens'] is None and value['usageSource'] == 'model_changed'
    assert all(p['tokens'] is None for p in value['breakdown'])


@pytest.mark.parametrize('patch', [
    {'systemPromptReport': {}},
    {'systemPromptReport': {'source': 'estimate'}},
    {'systemPromptReport': {'source': 'run', 'provider': 'other', 'model': 'm'}},
])
def test_missing_or_different_report_never_fabricates_breakdown(state, patch):
    native, web, entry, save = state
    save({**entry, **patch})
    value = collect_context(native, web, 'chat1')
    assert value['usedTokens'] == 1000
    assert value['breakdownStatus'] == 'unavailable'
    assert all(p['percent'] is None for p in value['breakdown'])


def test_inconsistent_estimated_overhead_is_not_rescaled_into_fake_percentages(state):
    native, web, entry, save = state
    save({**entry, 'totalTokens': 1})
    value = collect_context(native, web, 'chat1')
    assert value['breakdownStatus'] == 'inconsistent'
    assert all(p['percent'] is None for p in value['breakdown'])


def test_unknown_context_never_uses_cumulative_totals_or_backfills_an_old_call(state):
    native, web, _, save = state
    save({})
    calls = [{'timestamp': '2026-10-14', 'inputTokens': 300, 'provider': 'p', 'model': 'm'},
             {'timestamp': '2026-10-15', 'inputTokens': None, 'provider': 'p', 'model': 'm'}]
    read = lambda: {'session': {'totalTokens': 9000000}, 'turns': [{'calls': calls}]}
    assert collect_context(native, web, 'chat1', usage_reader=read)['usedTokens'] is None
    calls[-1]['inputTokens'] = 500
    value = collect_context(native, web, 'chat1', usage_reader=read)
    assert value['usedTokens'] == 500 and value['usageSource'] == 'last_request'
    assert value['stale'] is True and value['breakdownStatus'] == 'unavailable'


def test_fresh_session_has_known_config_budget_without_claiming_zero_tokens(state):
    native, web, _, _ = state
    value = collect_context(native, web, 'new-chat')
    assert value['capacity'] == 100000 and value['usedTokens'] is None


def test_foreign_runtime_entry_is_not_read_without_a_project_marker(state):
    native, web, _, _ = state
    (web / 'web_chat1.json').unlink()
    assert collect_context(native, web, 'chat1')['usedTokens'] is None


@pytest.mark.parametrize('value', [True, -1, 1.5, '100', 10**15])
def test_invalid_counts_stay_unknown(state, value):
    native, web, entry, save = state
    save({**entry, 'totalTokens': value})
    assert collect_context(native, web, 'chat1')['usedTokens'] is None


@pytest.mark.parametrize('session', ['../chat1', '', 'chat/1', 'x' * 121])
def test_session_path_traversal_and_invalid_ids_are_rejected(state, session):
    native, web, _, _ = state
    with pytest.raises(ValueError):
        collect_context(native, web, session)


def test_corrupt_metadata_fails_as_an_unavailable_read(state):
    native, web, _, _ = state
    (native / 'openclaw.json').write_text('{bad')
    with pytest.raises(OSError):
        collect_context(native, web, 'chat1')


def test_unknown_model_identity_does_not_attach_a_snapshot_to_selected_model(state):
    native, web, entry, save = state
    save({**entry, 'modelProvider': '', 'model': '', 'systemPromptReport': {}})
    value = collect_context(native, web, 'chat1', 'p/m')
    assert value['capacity'] == 100000 and value['usedTokens'] is None
    assert value['usageSource'] == 'model_changed'
