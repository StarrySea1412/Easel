"""Offline saving and reopening of per-model context budgets, with isolated config."""
import asyncio
import copy
import json
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import app as web


@pytest.fixture
def config(tmp_path, monkeypatch):
    state = tmp_path / 'state'
    state.mkdir()
    monkeypatch.setenv('EASEL_OPENCLAW_STATE_DIR', str(state))
    monkeypatch.setenv('EASEL_DATA_DIR', str(tmp_path / 'data'))
    monkeypatch.setattr(web, 'DATA_DIR', tmp_path / 'data')
    monkeypatch.setattr(web, 'ENV_FILE', tmp_path / '.env')
    web.ENV_FILE.write_text('OPENAI_BASE_URL=https://example.test/v1\nOPENAI_API_KEY=test-private-key\nOPENAI_MODEL=first\n', encoding='utf-8')
    value = {'models': {'providers': {
        'openai': {'api': 'openai-completions', 'baseUrl': 'https://example.test/v1',
                   'apiKey': 'test-private-key', 'headers': {'X-Test': 'keep'}, 'models': [
                       {'id': 'first', 'name': 'First', 'contextWindow': 32768, 'maxTokens': 4096, 'reasoning': True},
                       {'id': 'second', 'name': 'Second', 'contextWindow': 65536, 'maxTokens': 8192}]},
        'untouched': {'api': 'anthropic-messages', 'apiKey': 'keep-private-key', 'models': [{'id': 'other'}]}}},
        'agents': {'defaults': {'model': {'primary': 'openai/first'}}}}
    path = state / 'openclaw.json'
    path.write_text(json.dumps(value), encoding='utf-8')
    return path, copy.deepcopy(value)


def save(**patch):
    return asyncio.run(web.api_settings_models_save(web.ModelSaveRequest(channel='chat', rows=[
        web.ModelSaveRow(slot='openai', model=patch.pop('model', 'first'), **patch)])))


def test_budget_roundtrip_preserves_credentials_and_other_models(config):
    path, before = config
    response = save(contextWindow=131072)
    after = json.loads(path.read_text(encoding='utf-8'))
    provider = after['models']['providers']['openai']
    assert provider['models'][0] == {**before['models']['providers']['openai']['models'][0], 'contextWindow': 131072}
    assert provider['models'][1] == before['models']['providers']['openai']['models'][1]
    assert (provider['apiKey'], provider['headers']) == ('test-private-key', {'X-Test': 'keep'})
    assert after['agents'] == before['agents']
    assert after['models']['providers']['untouched'] == before['models']['providers']['untouched']
    row = next(row for row in response['channels']['chat']['rows'] if row['slot'] == 'openai')
    assert row['contextWindow'] == 131072
    assert 'test-private-key' not in json.dumps(response)


def test_switching_and_clearing_only_affects_selected_model(config):
    path, before = config
    response = save(model='second')
    assert next(row for row in response['channels']['chat']['rows'] if row['slot'] == 'openai')['contextWindow'] == 65536
    save(model='second', contextWindow=None)
    models = json.loads(path.read_text(encoding='utf-8'))['models']['providers']['openai']['models']
    assert 'contextWindow' not in models[0] and models[0]['maxTokens'] == 8192
    assert models[1] == before['models']['providers']['openai']['models'][0]
    response = save(model='first')
    assert next(row for row in response['channels']['chat']['rows'] if row['slot'] == 'openai')['contextWindow'] == 32768


def test_new_model_does_not_inherit_other_models_budget(config):
    path, _ = config
    save(model='new-model')
    first = json.loads(path.read_text(encoding='utf-8'))['models']['providers']['openai']['models'][0]
    assert first == {'id': 'new-model', 'name': 'new-model'}


@pytest.mark.parametrize('value', [0, 1023, 10000001, 1.5, True, '131072'])
def test_invalid_budget_is_rejected_before_writing(config, value):
    path, _ = config
    before = path.read_bytes(), web.ENV_FILE.read_bytes()
    with pytest.raises(ValidationError):
        save(contextWindow=value)
    assert (path.read_bytes(), web.ENV_FILE.read_bytes()) == before


@pytest.mark.parametrize('patch', [{'contextWindow': 2048}, {'model': '', 'contextWindow': 131072}])
def test_budget_below_output_limit_or_without_model_rejects_transaction(config, patch):
    before = web._model_file_snapshot()
    with pytest.raises(web.HTTPException) as error:
        save(**patch)
    assert error.value.status_code == 400
    assert web._model_file_snapshot() == before


def test_context_change_rolls_back_when_sync_fails(config, monkeypatch):
    before = web._model_file_snapshot()
    sync = web._sync_openclaw_chat
    def fail_after_write(*args):
        sync(*args)
        return '同步失败'
    monkeypatch.setattr(web, '_sync_openclaw_chat', fail_after_write)
    with pytest.raises(web.HTTPException) as error:
        save(contextWindow=131072)
    assert error.value.status_code == 500
    assert web._model_file_snapshot() == before
