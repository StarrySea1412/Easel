"""Offline model import/save contracts: explicit preview, protocol, isolation and rollback."""
from __future__ import annotations

import asyncio
import copy
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'web'))
import app as web
import local_config_import as lci


@pytest.fixture(autouse=True)
def sandbox(tmp_path, monkeypatch):
    monkeypatch.setenv('HOME', str(tmp_path))
    monkeypatch.setenv('USERPROFILE', str(tmp_path))
    monkeypatch.setenv('EASEL_DATA_DIR', str(tmp_path / 'data'))
    monkeypatch.setenv('EASEL_OPENCLAW_STATE_DIR', str(tmp_path / 'state'))
    monkeypatch.setattr(web, 'ENV_FILE', tmp_path / '.env')
    monkeypatch.setattr(lci, 'HOME_CCSWITCH', tmp_path / '.cc-switch')
    web._IMPORT_PREVIEWS.clear()
    web.ENV_FILE.write_text('OPENAI_BASE_URL=https://old.example/v1\nOPENAI_API_KEY=sk-old-test\n'
                            'OPENAI_MODEL=old-model\nCLAUDE_MODEL=anthropic/legacy\n'
                            'ANTHROPIC_MODEL=official-model\nEASEL_LLM_MODEL=relay-model\n'
                            'OTHER_SECRET=untouched\n', encoding='utf-8')
    oc = web.openclaw_state_dir() / 'openclaw.json'
    oc.parent.mkdir()
    oc.write_text(json.dumps({'models': {'providers': {
        'openai': {'api': 'openai-completions', 'baseUrl': 'https://old.example/v1',
                   'apiKey': 'sk-old-test', 'models': [{'id': 'old-model'}]},
        'anthropic': {'api': 'anthropic-messages', 'baseUrl': 'https://official.example',
                      'apiKey': 'official-old-key', 'models': [{'id': 'official-model'}]},
        'relay': {'api': 'anthropic-messages', 'baseUrl': 'https://relay.example',
                  'apiKey': 'relay-old-key', 'models': [{'id': 'relay-model'}]},
        'custom': {'api': 'openai-completions', 'baseUrl': 'https://custom.example/v1',
                   'apiKey': 'custom-keep-key', 'headers': {'x-special': 'preserve'},
                   'models': [{'id': 'custom-model'}]},
    }}, 'agents': {'defaults': {'model': {'primary': 'openai/old-model'}}}}), encoding='utf-8')
    return tmp_path, oc


def source(tmp_path, protocol='openai', model='incoming-model'):
    p = tmp_path / 'source.json'
    p.write_text(json.dumps({'models': {'providers': {'Chosen': {
        'api': 'anthropic-messages' if protocol == 'anthropic' else 'openai-completions',
        'baseUrl': 'https://incoming.example/v1', 'apiKey': 'sk-incoming-secret-123456',
        'models': [{'id': model}],
    }}}}), encoding='utf-8')
    return p


@pytest.mark.parametrize('base', ['', 'https://old.example/v1'])
def test_authoritative_env_pair_repairs_stale_mirror_on_model_save(sandbox, base):
    _, oc = sandbox
    data = json.loads(oc.read_text())
    data['models']['providers']['openai'].update(baseUrl='https://stale.example/v1', apiKey='stale-key')
    oc.write_text(json.dumps(data))
    result = asyncio.run(web.api_settings_models_save(web.ModelSaveRequest(channel='chat', rows=[
        web.ModelSaveRow(slot='openai', model='new-model', baseUrl=base, key=''),
    ])))
    assert result['ok']
    provider = json.loads(oc.read_text())['models']['providers']['openai']
    assert (provider['baseUrl'], provider['apiKey']) == ('https://old.example/v1', 'sk-old-test')
    assert provider['models'][0] == {'id': 'new-model', 'name': 'new-model'}


def test_stale_mirror_repair_still_rejects_real_base_change(sandbox):
    before = web._model_file_snapshot()
    with pytest.raises(web.HTTPException) as caught:
        asyncio.run(web.api_settings_models_save(web.ModelSaveRequest(channel='chat', rows=[
            web.ModelSaveRow(slot='openai', model='new-model', baseUrl='https://different.example/v1', key=''),
        ])))
    assert caught.value.status_code == 400
    assert web._model_file_snapshot() == before


def test_model_only_save_preserves_local_gateway_auth_and_url(sandbox):
    _, oc = sandbox
    data = json.loads(oc.read_text())
    provider = data['models']['providers']['openai']
    provider.update(baseUrl='http://127.0.0.1:8890/v1', apiKey='gateway-token', headers={'X-Gateway': 'gateway-token'})
    oc.write_text(json.dumps(data))
    asyncio.run(web.api_settings_models_save(web.ModelSaveRequest(channel='chat', rows=[
        web.ModelSaveRow(slot='openai', model='new-model', baseUrl='https://old.example/v1', key=''),
    ])))
    updated = json.loads(oc.read_text())['models']['providers']['openai']
    assert (updated['baseUrl'], updated['apiKey'], updated['headers']) == (
        'http://127.0.0.1:8890/v1', 'gateway-token', {'X-Gateway': 'gateway-token'})


def preview(p, slot='openai'):
    return asyncio.run(web.api_import_preview(web.ImportPreviewRequest(source='openclaw', path=str(p), slot=slot)))


def apply(p, candidate, slot='openai', **patch):
    args = dict(source='openclaw', path=str(p), slot=slot, id=candidate['id'],
                previewToken=candidate.get('previewToken', ''))
    args.update(patch)
    return asyncio.run(web.api_import_apply(web.ImportApplyRequest(**args)))


@pytest.mark.parametrize('slot,protocol,field', [
    ('openai', 'openai', 'OPENAI_MODEL'), ('anthropic', 'anthropic', 'ANTHROPIC_MODEL'),
    ('relay', 'anthropic', 'EASEL_LLM_MODEL'),
])
def test_import_updates_both_files_only_selected_slot_and_reopens(sandbox, slot, protocol, field):
    root, oc = sandbox
    before = json.loads(oc.read_text())
    p = source(root, protocol)
    env_before, oc_before = web.ENV_FILE.read_bytes(), oc.read_bytes()
    candidate = preview(p, slot)['candidates'][0]
    assert candidate['compatible'] and candidate['previewToken']
    assert web.ENV_FILE.read_bytes() == env_before and oc.read_bytes() == oc_before
    result = apply(p, candidate, slot)
    assert result['ok']
    data = json.loads(oc.read_text())
    for name, provider in before['models']['providers'].items():
        if name != slot:
            assert data['models']['providers'][name] == provider
    assert data['agents'] == before['agents']
    selected = data['models']['providers'][slot]
    assert selected['apiKey'] == 'sk-incoming-secret-123456'
    assert selected['models'][0]['id'] == 'incoming-model'
    assert selected['api'] == ('anthropic-messages' if protocol == 'anthropic' else 'openai-completions')
    env = web._read_env()
    assert env[field] == 'incoming-model'
    assert env['CLAUDE_MODEL'] == 'anthropic/legacy' and env['OTHER_SECRET'] == 'untouched'
    reopened = next(row for row in web._model_channels()['channels']['chat']['rows'] if row['slot'] == slot)
    assert reopened['model'] == 'incoming-model' and reopened['baseUrl'] == 'https://incoming.example/v1'
    assert 'sk-incoming-secret-123456' not in json.dumps(result)


def test_no_preview_cannot_apply(sandbox):
    p = source(sandbox[0])
    candidate = lci.read_openclaw(p)[0][0]
    before = web._model_file_snapshot()
    with pytest.raises(web.HTTPException) as caught:
        apply(p, candidate)
    assert caught.value.status_code == 409
    assert before == web._model_file_snapshot()


@pytest.mark.parametrize('change', ['key', 'model', 'protocol'])
def test_preview_refuses_source_drift_with_same_candidate_id(sandbox, change):
    p = source(sandbox[0])
    candidate = preview(p)['candidates'][0]
    data = json.loads(p.read_text())
    row = data['models']['providers']['Chosen']
    if change == 'key':
        row['apiKey'] = 'sk-new-secret-654321'
    elif change == 'model':
        row['models'][0]['id'] = 'different-model'
    else:
        row['api'] = 'anthropic-messages'
    p.write_text(json.dumps(data), encoding='utf-8')
    before = web._model_file_snapshot()
    with pytest.raises(web.HTTPException) as caught:
        apply(p, candidate)
    assert caught.value.status_code == 409
    assert web._model_file_snapshot() == before


@pytest.mark.parametrize('target', ['env', 'openclaw'])
def test_preview_refuses_target_drift(sandbox, target):
    p = source(sandbox[0])
    candidate = preview(p)['candidates'][0]
    changed = web.ENV_FILE if target == 'env' else sandbox[1]
    changed.write_bytes(changed.read_bytes() + b'\n')
    before = web._model_file_snapshot()
    with pytest.raises(web.HTTPException) as caught:
        apply(p, candidate)
    assert caught.value.status_code == 409 and web._model_file_snapshot() == before


@pytest.mark.parametrize('patch', [{'slot': 'relay'}, {'id': 'different'}, {'previewToken': 'invalid'}])
def test_token_binds_selection(sandbox, patch):
    p = source(sandbox[0])
    candidate = preview(p)['candidates'][0]
    with pytest.raises(web.HTTPException) as caught:
        apply(p, candidate, **patch)
    assert caught.value.status_code == 409


def test_token_expires_and_cannot_be_reused(sandbox):
    p = source(sandbox[0])
    candidate = preview(p)['candidates'][0]
    web._IMPORT_PREVIEWS[candidate['previewToken']]['expires'] = 0
    with pytest.raises(web.HTTPException):
        apply(p, candidate)
    candidate = preview(p)['candidates'][0]
    apply(p, candidate)
    with pytest.raises(web.HTTPException):
        apply(p, candidate)


@pytest.mark.parametrize('slot,protocol', [('openai', 'anthropic'), ('relay', 'openai'), ('anthropic', 'openai')])
def test_cross_protocol_candidate_is_disabled(sandbox, slot, protocol):
    p = source(sandbox[0], protocol)
    candidate = preview(p, slot)['candidates'][0]
    assert not candidate['compatible'] and '协议' in candidate['skipReason']
    assert not candidate.get('previewToken')
    with pytest.raises(web.HTTPException):
        apply(p, candidate, slot)


def test_sync_write_then_failure_restores_both_files_and_retry_works(sandbox, monkeypatch):
    p = source(sandbox[0])
    candidate = preview(p)['candidates'][0]
    before = web._model_file_snapshot()
    real_sync = web._sync_openclaw_chat

    def fail(*args):
        real_sync(*args)
        raise OSError('sk-incoming-secret-123456 should never be shown')

    monkeypatch.setattr(web, '_sync_openclaw_chat', fail)
    with pytest.raises(web.HTTPException) as caught:
        apply(p, candidate)
    assert caught.value.status_code == 500 and '已恢复' in caught.value.detail
    assert 'sk-incoming-secret' not in caught.value.detail
    assert web._model_file_snapshot() == before
    monkeypatch.setattr(web, '_sync_openclaw_chat', real_sync)
    assert apply(p, candidate)['ok']


def test_env_write_then_failure_restores_and_does_not_sync(sandbox, monkeypatch):
    p = source(sandbox[0])
    candidate = preview(p)['candidates'][0]
    before = web._model_file_snapshot()
    real_write = web._write_env_direct

    def fail(updates):
        real_write(updates)
        raise PermissionError('secret-data')

    monkeypatch.setattr(web, '_write_env_direct', fail)
    with pytest.raises(web.HTTPException):
        apply(p, candidate)
    assert web._model_file_snapshot() == before


def test_first_configuration_failure_removes_created_files(sandbox, monkeypatch):
    web.ENV_FILE.unlink()
    sandbox[1].unlink()
    p = source(sandbox[0])
    candidate = preview(p)['candidates'][0]
    monkeypatch.setattr(web, '_sync_openclaw_chat', lambda *args: '同步失败：secret-data')
    with pytest.raises(web.HTTPException):
        apply(p, candidate)
    assert not web.ENV_FILE.exists() and not sandbox[1].exists()


def test_save_preserves_unselected_custom_and_can_delete_explicitly(sandbox):
    before = json.loads(sandbox[1].read_text())['models']['providers']['custom']
    req = web.ModelSaveRequest(channel='chat', rows=[web.ModelSaveRow(slot='openai', model='new-model')])
    assert asyncio.run(web.api_settings_models_save(req))['ok']
    assert json.loads(sandbox[1].read_text())['models']['providers']['custom'] == before
    req.deletedProviders = ['custom']
    assert asyncio.run(web.api_settings_models_save(req))['ok']
    assert 'custom' not in json.loads(sandbox[1].read_text())['models']['providers']


def test_official_anthropic_uses_a_saveable_default_url(sandbox, monkeypatch):
    monkeypatch.delenv('ANTHROPIC_BASE_URL', raising=False)
    monkeypatch.delenv('ANTHROPIC_API_KEY', raising=False)
    web.ENV_FILE.write_text('ANTHROPIC_API_KEY=anthropic-test-key\n', encoding='utf-8')
    config = json.loads(sandbox[1].read_text(encoding='utf-8'))
    config['models']['providers'].pop('anthropic')
    sandbox[1].write_text(json.dumps(config), encoding='utf-8')
    rows = web._model_channels()['channels']['chat']['rows']
    anthropic = next(row for row in rows if row['slot'] == 'anthropic')
    assert anthropic['baseUrl'] == 'https://api.anthropic.com'
    result = asyncio.run(web.api_settings_models_save(web.ModelSaveRequest(
        channel='chat', rows=[web.ModelSaveRow(slot='anthropic', model='claude-test-model',
                                               baseUrl=anthropic['baseUrl'])])))
    assert result['ok']
    assert web._read_env()['ANTHROPIC_BASE_URL'] == 'https://api.anthropic.com'


def test_malformed_provider_collection_does_not_break_model_settings(sandbox):
    config = json.loads(sandbox[1].read_text(encoding='utf-8'))
    config['models']['providers'] = []
    sandbox[1].write_text(json.dumps(config), encoding='utf-8')
    web.ENV_FILE.write_text('ANTHROPIC_API_KEY=anthropic-test-key\n', encoding='utf-8')
    rows = web._model_channels()['channels']['chat']['rows']
    assert next(row for row in rows if row['slot'] == 'anthropic')['model'] == 'claude-sonnet-4-6'


def test_save_failure_rolls_back_and_unknown_protocol_rejected(sandbox, monkeypatch):
    before = web._model_file_snapshot()
    monkeypatch.setattr(web, '_sync_openclaw_chat', lambda *args: '同步失败：secret-data')
    with pytest.raises(web.HTTPException) as caught:
        asyncio.run(web.api_settings_models_save(web.ModelSaveRequest(rows=[web.ModelSaveRow(slot='openai', model='new')])) )
    assert 'secret-data' not in caught.value.detail and web._model_file_snapshot() == before
    with pytest.raises(web.HTTPException) as caught:
        asyncio.run(web.api_settings_models_save(web.ModelSaveRequest(rows=[web.ModelSaveRow(slot='openai', protocol='unknown')])) )
    assert caught.value.status_code == 400


@pytest.mark.parametrize('slot', ['openai', 'anthropic', 'relay', 'custom'])
@pytest.mark.parametrize('protocol', ['openai', 'anthropic'])
def test_channel_protocol_survives_save_reload_and_controls_probe_wire_format(sandbox, slot, protocol):
    config = json.loads(sandbox[1].read_text())
    provider = config['models']['providers'][slot]
    provider.pop('headers', None)  # This test exercises standard key authentication.
    model = provider['models'][0]['id']
    provider['models'][0]['api'] = 'anthropic-messages' if protocol == 'openai' else 'openai-completions'
    sandbox[1].write_text(json.dumps(config), encoding='utf-8')
    result = asyncio.run(web.api_settings_models_save(web.ModelSaveRequest(rows=[web.ModelSaveRow(
        slot=slot, name=slot, model=model, baseUrl=provider['baseUrl'],
        key='synthetic-protocol-key', protocol=protocol, primary=True)])))
    assert result['ok']
    saved = json.loads(sandbox[1].read_text())
    assert saved['models']['providers'][slot]['api'] == web._CHAT_APIS[protocol]
    assert 'api' not in saved['models']['providers'][slot]['models'][0]
    for name in set(config['models']['providers']) - {slot}:
        assert saved['models']['providers'][name] == config['models']['providers'][name]
    reopened = web._model_channels()['channels']['chat']['rows']
    row = next(row for row in reopened if row['slot'] == slot and (slot != 'custom' or row['name'] == slot))
    assert row['protocol'] == row['type'] == protocol and row['protocolEditable']
    target = web._model_health_target(f'{slot}/{model}')
    assert target.protocol == protocol
    request = web.model_health.request_body(target, 'offline protocol verification')
    if protocol == 'anthropic':
        assert request.full_url.endswith('/messages') and request.get_header('X-api-key') == 'synthetic-protocol-key'
        assert request.get_header('Authorization') is None
    else:
        assert request.full_url.endswith('/chat/completions')
        assert request.get_header('Authorization') == 'Bearer synthetic-protocol-key'


def test_omitted_protocol_keeps_saved_choice_for_save_and_discovery(sandbox, monkeypatch):
    asyncio.run(web.api_settings_models_save(web.ModelSaveRequest(rows=[web.ModelSaveRow(
        slot='openai', model='old-model', protocol='anthropic')])))
    asyncio.run(web.api_settings_models_save(web.ModelSaveRequest(rows=[web.ModelSaveRow(
        slot='openai', model='old-model')])) )
    assert web._chat_protocol('openai') == 'anthropic'
    seen = []
    monkeypatch.setattr(web, '_discover_models', lambda base, key, protocol: seen.append(protocol) or {'ok': True})
    result = asyncio.run(web.api_models_discover(web.ModelDiscoverRequest(
        slot='openai', baseUrl='https://old.example/v1')))
    assert seen == ['anthropic'] and result['protocol'] == 'anthropic'


def test_unknown_saved_api_is_not_silently_rewritten_as_openai(sandbox):
    config = json.loads(sandbox[1].read_text())
    config['models']['providers']['openai']['api'] = 'openai-responses'
    sandbox[1].write_text(json.dumps(config), encoding='utf-8')
    assert web._model_channels()['channels']['chat']['rows'][0]['protocol'] == 'openai-responses'
    before = web._model_file_snapshot()
    with pytest.raises(web.HTTPException) as caught:
        asyncio.run(web.api_settings_models_save(web.ModelSaveRequest(rows=[web.ModelSaveRow(
            slot='openai', model='old-model')])))
    assert caught.value.status_code == 400 and web._model_file_snapshot() == before


def test_gateway_managed_protocol_change_is_explicitly_blocked(sandbox):
    config = json.loads(sandbox[1].read_text())
    config['models']['providers']['openai']['baseUrl'] = 'http://127.0.0.1:8890/v1'
    sandbox[1].write_text(json.dumps(config), encoding='utf-8')
    row = web._model_channels()['channels']['chat']['rows'][0]
    assert not row['protocolEditable'] and '网关' in row['protocolNote']
    before = web._model_file_snapshot()
    with pytest.raises(web.HTTPException) as caught:
        asyncio.run(web.api_settings_models_save(web.ModelSaveRequest(rows=[web.ModelSaveRow(
            slot='openai', model='old-model', protocol='anthropic')])))
    assert caught.value.status_code == 400 and '网关' in caught.value.detail
    assert web._model_file_snapshot() == before


def test_custom_channel_discovery_uses_its_exact_saved_identity_and_protocol(sandbox, monkeypatch):
    seen = []
    monkeypatch.setattr(web, '_discover_models', lambda base, key, protocol: seen.append((base, key, protocol)) or {'ok': True})
    result = asyncio.run(web.api_models_discover(web.ModelDiscoverRequest(
        slot='custom', baseUrl='https://custom.example/v1')))
    assert result['keySource'] == 'saved'
    assert seen == [('https://custom.example/v1', 'custom-keep-key', 'openai')]


def test_legacy_bulk_list_check_uses_saved_protocol_headers_and_paths(sandbox, monkeypatch):
    from types import SimpleNamespace
    config = json.loads(sandbox[1].read_text())
    config['models']['providers']['openai']['api'] = 'anthropic-messages'
    sandbox[1].write_text(json.dumps(config), encoding='utf-8')
    web.ENV_FILE.write_text('OPENAI_BASE_URL=https://old.example/v1\nOPENAI_API_KEY=synthetic-key\n', encoding='utf-8')
    monkeypatch.setattr(web, '_read_env', lambda: {'OPENAI_BASE_URL': 'https://old.example/v1', 'OPENAI_API_KEY': 'synthetic-key'})
    monkeypatch.setattr(web, '_ssrf_safe', lambda base: True)
    monkeypatch.setattr(web, '_model_health_service', lambda: SimpleNamespace(reserve_legacy=lambda: None))
    requests = []
    class Response:
        status = 200
        def __enter__(self): return self
        def __exit__(self, *_args): pass
    monkeypatch.setattr(web.urllib.request, 'build_opener', lambda *args: SimpleNamespace(
        open=lambda request, **kwargs: requests.append(request) or Response()))
    result = asyncio.run(web.api_models_selftest(web.SelftestRequest(channel='chat')))
    assert result['results'][0]['ok']
    assert len(requests) == 1 and requests[0].full_url == 'https://old.example/v1/models'
    assert requests[0].get_header('X-api-key') == 'synthetic-key'
    assert requests[0].get_header('Authorization') is None


def test_local_gateway_candidate_is_explicitly_unavailable(sandbox):
    config = json.loads(sandbox[1].read_text())
    config['models']['providers']['openai']['baseUrl'] = 'http://127.0.0.1:8890/v1'
    sandbox[1].write_text(json.dumps(config), encoding='utf-8')
    candidate = preview(source(sandbox[0]))['candidates'][0]
    assert not candidate['compatible'] and '网关' in candidate['skipReason']


def test_ccswitch_active_provider_and_responses_are_not_confused():
    cfg = {'config': 'model="m"\nmodel_provider="selected"\n'
           '[model_providers.selected]\nbase_url="https://selected.example/v1"\nwire_api="chat"\n'
           '[model_providers.other]\nbase_url="https://other.example/v1"\nwire_api="responses"'}
    assert lci._cc_protocol('codex', cfg) == 'openai'
    c = lci._candidate('cc-switch', 'test', '', 'sk-test-test-test', 'openai', app_type='codex', cfg=cfg)
    assert c['baseUrl'] == 'https://selected.example/v1'
    cfg['config'] = cfg['config'].replace('model_provider="selected"', 'model_provider="other"')
    assert lci._cc_protocol('codex', cfg) == 'openai-responses'
    assert lci._cc_protocol('gemini', {}) == 'unknown'


@pytest.mark.parametrize('payload', [[], {'models': []}, {'models': {'providers': []}}])
def test_malformed_source_is_reported_without_crashing(sandbox, payload):
    p = sandbox[0] / 'bad.json'
    p.write_text(json.dumps(payload), encoding='utf-8')
    candidates, errors = lci.read_source('openclaw', p)
    assert not candidates
    assert errors or payload == {'models': {'providers': []}}
