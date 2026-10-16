"""Context snapshots remain separate from cumulative/billable usage."""
import json
import sys
import sqlite3
import hashlib
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


def test_glm_reference_does_not_mislabel_default_session_budget_or_mutate_config(state):
    native, web, entry, save = state
    config_path = native / 'openclaw.json'
    config = json.loads(config_path.read_text())
    config['agents']['defaults']['model']['primary'] = 'p/glm-5.3'
    config['models']['providers']['p']['models'] = [{'id': 'glm-5.3'}]
    config_path.write_text(json.dumps(config))
    before = config_path.read_bytes()
    save({**entry, 'model': 'glm-5.3', 'contextTokens': 200000})
    value = collect_context(native, web, 'chat1')
    assert value['capacity'] == 1048576 and value['capacitySource'] == 'official_reference'
    assert value['recordedLimit'] == 200000 and value['configuredWindow'] is None
    assert value['contextReference']['url'].startswith('https://docs.bigmodel.cn/')
    assert config_path.read_bytes() == before


def test_user_window_and_explicit_runtime_limit_override_reference(state):
    native, web, _, _ = state
    path = native / 'openclaw.json'
    config = json.loads(path.read_text())
    config['models']['providers']['p']['models'] = [{'id': 'glm-5.3', 'contextWindow': 262144}]
    path.write_text(json.dumps(config))
    value = collect_context(native, web, 'chat1', 'p/glm-5.3')
    assert value['capacity'] == 262144 and value['capacitySource'] == 'model_config'
    assert value['recordedLimit'] is None and value['usedTokens'] is None
    config['agents']['defaults']['contextTokens'] = 131072
    path.write_text(json.dumps(config))
    value = collect_context(native, web, 'chat1', 'p/glm-5.3')
    assert value['capacity'] == 131072 and value['capacitySource'] == 'runtime_config'
    assert value['configuredWindow'] == 262144 and value['configuredLimit'] == 131072


def test_unknown_alias_never_inherits_glm_family_window(state):
    native, web, entry, save = state
    save({**entry, 'model': 'glm-5.3-custom', 'contextTokens': 200000})
    value = collect_context(native, web, 'chat1', 'p/glm-5.3-custom')
    assert value['capacity'] == 200000 and value['capacitySource'] == 'session_snapshot'
    assert value['contextReference'] is None


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


def sqlite_entry(native, entry, key='agent:main:chat1'):
    path = native / 'agents/main/agent/openclaw-agent.sqlite'
    path.parent.mkdir(exist_ok=True)
    with sqlite3.connect(path) as db:
        db.execute('CREATE TABLE IF NOT EXISTS session_nodes(session_key TEXT PRIMARY KEY,entry_json TEXT)')
        db.execute('INSERT INTO session_nodes VALUES(?,?)', (key, json.dumps(entry)))
    return path


def test_sqlite_current_entry_wins_over_legacy_and_does_not_mutate_database(state):
    native, web, entry, _ = state
    current = {**entry, 'totalTokens': 2000, 'skillsSnapshot': {'prompt': 'x' * 40, 'skills': [{'name': 'private-skill'}]}}
    path = sqlite_entry(native, current)
    sqlite_entry(native, {**entry, 'totalTokens': 999999}, 'agent:main:foreign')
    before = hashlib.sha256(path.read_bytes()).digest()
    value = collect_context(native, web, 'chat1')
    assert value['runtimeStore'] == 'sqlite' and value['usedTokens'] == 2000
    assert value['skills']['promptChars'] == 40 and value['skills']['listedCount'] == 1
    assert value['skills']['availableCount'] == 1
    assert 'private-skill' not in json.dumps(value)
    assert hashlib.sha256(path.read_bytes()).digest() == before


def test_migrated_store_never_resurrects_deleted_legacy_or_foreign_sessions(state):
    native, web, entry, _ = state
    sqlite_entry(native, entry, 'agent:main:foreign')
    value = collect_context(native, web, 'chat1')
    assert value['usedTokens'] is None and value['runtimeStore'] == 'sqlite'
    assert value['skills']['promptChars'] is None
    (web / 'web_chat1.json').unlink()
    assert collect_context(native, web, 'chat1')['runtimeStore'] == 'none'


def test_failed_session_still_knows_skill_catalog_without_claiming_actual_occupancy(state, tmp_path):
    native, web, _, _ = state
    sqlite_entry(native, {'skillsSnapshot': {'prompt': 'x' * 400, 'skills': [{}, {}]}})
    skills = tmp_path / 'skills'
    (skills / 'own').mkdir(parents=True)
    (skills / 'own/SKILL.md').write_text('Full body must not be counted' * 100)
    value = collect_context(native, web, 'chat1', skills_dir=skills)
    part = next(p for p in value['breakdown'] if p['key'] == 'skills')
    assert value['usedTokens'] is None and value['breakdownStatus'] == 'partial'
    assert part['chars'] == 400 and part['tokens'] == 100 and part['percent'] is None
    assert value['skills']['installedCount'] == 1 and value['skills']['availableCount'] == 2
    assert value['skills']['listedCount'] is None and value['skills']['source'] == 'session_skills'


def test_partial_report_retains_skill_and_workspace_facts_but_no_fake_residual(state):
    native, web, entry, save = state
    report = {**entry['systemPromptReport'], 'tools': {}}
    save({**entry, 'systemPromptReport': report})
    value = collect_context(native, web, 'chat1')
    parts = {p['key']: p for p in value['breakdown']}
    assert value['breakdownStatus'] == 'partial'
    assert parts['skills']['tokens'] == 10 and parts['other']['tokens'] == 20
    assert parts['messages']['tokens'] is None and parts['system_tools']['tokens'] is None


def test_report_can_show_character_counts_before_a_usage_total_arrives(state):
    native, web, entry, save = state
    save({**entry, 'totalTokens': None})
    value = collect_context(native, web, 'chat1')
    assert value['usedTokens'] is None and value['breakdownStatus'] == 'partial'
    assert next(p for p in value['breakdown'] if p['key'] == 'skills')['chars'] == 40
    assert all(p['percent'] is None for p in value['breakdown'])


def test_conflicting_total_preserves_known_characters_without_false_percentages(state):
    native, web, entry, save = state
    save({**entry, 'totalTokens': 1})
    value = collect_context(native, web, 'chat1')
    assert value['breakdownStatus'] == 'inconsistent'
    assert next(p for p in value['breakdown'] if p['key'] == 'skills')['chars'] == 40
    assert all(p['percent'] is None for p in value['breakdown'])


def test_model_switch_keeps_labeled_previous_total_and_cached_skill_facts_separate(state):
    native, web, entry, save = state
    save({**entry, 'skillsSnapshot': {'prompt': 'x' * 40, 'skills': [{}]}})
    value = collect_context(native, web, 'chat1', 'p/next')
    assert value['usedTokens'] is None and value['previousSnapshot']['usedTokens'] == 1000
    assert value['previousSnapshot']['modelRef'] == 'p/m' and value['capacity'] == 200000
    assert value['skills']['source'] == 'session_skills'
    assert all(p['percent'] is None for p in value['breakdown'])


def test_unreadable_migrated_metadata_is_explained_without_reading_legacy(state):
    native, web, _, _ = state
    path = native / 'agents/main/agent/openclaw-agent.sqlite'
    path.parent.mkdir()
    path.write_bytes(b'corrupt')
    value = collect_context(native, web, 'chat1')
    assert value['usedTokens'] is None and value['readWarning']


def test_fresh_session_lists_local_skills_without_adding_unloaded_bodies_to_total(state, tmp_path):
    native, web, _, _ = state
    skills = tmp_path / 'skills'
    (skills / 'own').mkdir(parents=True)
    (skills / 'own/SKILL.md').write_text('x' * 10000)
    value = collect_context(native, web, 'fresh', skills_dir=skills)
    assert value['usedTokens'] is None and all(p['tokens'] is None for p in value['breakdown'])
    assert value['skills']['installedCount'] == 1 and value['skills']['promptChars'] is None


def test_cached_prompt_uses_runtime_utf16_character_convention(state):
    native, web, _, save = state
    save({'skillsSnapshot': {'prompt': '技能😀', 'skills': []}})
    value = collect_context(native, web, 'chat1')
    assert value['skills']['promptChars'] == 4
    assert next(p for p in value['breakdown'] if p['key'] == 'skills')['chars'] == 4


def test_last_request_total_cannot_allocate_a_different_prompt_snapshot(state):
    native, web, entry, save = state
    save({**entry, 'totalTokens': None})
    usage = lambda: {'turns': [{'calls': [{'timestamp': '2026-10-15', 'inputTokens': 300, 'provider': 'p', 'model': 'm'}]}]}
    value = collect_context(native, web, 'chat1', usage_reader=usage)
    assert value['usedTokens'] == 300 and value['usageSource'] == 'last_request'
    assert value['breakdownStatus'] == 'partial'
    assert all(p['percent'] is None for p in value['breakdown'])
    assert next(p for p in value['breakdown'] if p['key'] == 'skills')['chars'] == 40
