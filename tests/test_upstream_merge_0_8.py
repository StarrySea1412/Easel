"""Offline merge contracts: explicit runtime, provider edits and dual skill roots."""
import asyncio
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import app as web


@pytest.fixture
def sandbox(tmp_path, monkeypatch):
    monkeypatch.setenv('EASEL_OPENCLAW_STATE_DIR', str(tmp_path / 'state'))
    monkeypatch.setattr(web, 'DATA_DIR', tmp_path / 'data')
    monkeypatch.setattr(web, 'OUTPUTS_DIR', tmp_path / 'data' / 'outputs')
    monkeypatch.setattr(web, 'ENV_FILE', tmp_path / '.env')
    monkeypatch.setattr(web, 'SKILLS_DIR', tmp_path / 'skills')
    monkeypatch.setattr(web, '_read_env', lambda: {})
    monkeypatch.setattr(web, '_skill_meta_store', lambda: type('Meta', (), {'read': lambda _: {}})())
    return tmp_path


def test_new_install_keeps_openclaw_default(sandbox):
    assert web._harness_settings()['runtime'] == 'openclaw'
    assert web._direct_api_enabled() is False
    assert isinstance(web._model_channels()['channels']['chat']['rows'], list)


def test_explicit_direct_mode_channels_do_not_raise(sandbox):
    web.ENV_FILE.write_text('EASEL_AGENT_RUNTIME=api\nEASEL_DIRECT_API_MODEL=fixture-model\n', encoding='utf-8')
    assert web._direct_api_enabled() is True
    assert isinstance(web._model_channels()['channels']['chat']['rows'], list)


def test_model_change_preserves_other_models_and_custom_names(sandbox):
    path = sandbox / 'state' / 'openclaw.json'
    path.parent.mkdir()
    path.write_text(json.dumps({'models': {'providers': {'fixture': {
        'api': 'openai-completions', 'models': [
            {'id': 'old', 'name': 'old'}, {'id': 'kept', 'name': 'Kept nickname'}]}}}}), encoding='utf-8')
    web._sync_openclaw_chat({'fixture': {'model': 'new', 'protocol': 'openai-responses'}}, {'fixture'}, '')
    saved = json.loads(path.read_text(encoding='utf-8'))['models']['providers']['fixture']
    assert saved['api'] == 'openai-responses'
    assert saved['models'] == [{'id': 'new', 'name': 'new'}, {'id': 'old', 'name': 'old'},
                               {'id': 'kept', 'name': 'Kept nickname'}]


def test_responses_save_round_trip_and_channel_nickname(sandbox):
    result = asyncio.run(web.api_settings_models_save(web.ModelSaveRequest(channel='chat', rows=[
        web.ModelSaveRow(slot='custom', name='fixture', model='model-a',
                         baseUrl='https://fixture.invalid/v1', key='synthetic-fixture-key', protocol='openai-responses')])))
    assert result['ok']
    asyncio.run(web.api_channel_name_save(web.ChannelNameRequest(provider='fixture', name='测试渠道昵称')))
    row = next(row for row in web._model_channels()['channels']['chat']['rows'] if row.get('providerId') == 'fixture')
    assert row['protocol'] == 'openai-responses' and row['channelName'] == '测试渠道昵称'
    target = web._model_health_target('fixture/model-a')
    assert target.protocol == 'openai-responses'


def test_dual_roots_prefer_builtin_and_deduplicate_catalog(sandbox):
    for root, names in [('builtin', ['same', 'new']), ('openclaw', ['same', 'legacy'])]:
        for name in names:
            folder = web.SKILLS_DIR / root / name
            folder.mkdir(parents=True)
            (folder / 'SKILL.md').write_text(f'---\ndescription: {root} {name}\n---\n# Fixture', encoding='utf-8')
    assert web._skill_md_path('same') == web.SKILLS_DIR / 'builtin' / 'same' / 'SKILL.md'
    assert web._skill_md_path('legacy') == web.SKILLS_DIR / 'openclaw' / 'legacy' / 'SKILL.md'
    rows = web.get_skills()
    assert sorted(row['name'] for row in rows) == ['legacy', 'new', 'same']
    assert next(row for row in rows if row['name'] == 'same')['description'] == 'builtin same'


@pytest.mark.parametrize('protocol', ['openai', 'openai-responses'])
def test_responses_transport_does_not_accept_unknown_protocol(protocol):
    assert web._same_transport(protocol, 'openai-responses')
    assert not web._same_transport(protocol, 'unknown-api')
    assert not web._same_transport(protocol, 'anthropic')
