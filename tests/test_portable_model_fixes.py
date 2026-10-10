import asyncio
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'web')]
import app as web
import channel_profiles
import local_config_import as imports
from image_errors import image_failure
from model_health import Target, request_body, dispatch


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    state = tmp_path / 'state'; state.mkdir()
    data = tmp_path / 'data'; data.mkdir()
    monkeypatch.setenv('EASEL_OPENCLAW_STATE_DIR', str(state))
    monkeypatch.setattr(web, 'DATA_DIR', data)
    monkeypatch.setattr(web, 'ENV_FILE', tmp_path / '.env')
    monkeypatch.setattr(imports, 'resolve_source', lambda *_: (None, 'not installed'))
    initial = {'models': {'providers': {'existing': {'api': 'openai-completions', 'baseUrl': 'https://old.invalid/v1', 'apiKey': 'old-fixture', 'models': [{'id': 'old-model'}]}}},
        'agents': {'defaults': {'model': {'primary': 'existing/old-model'}}}}
    (state / 'openclaw.json').write_text(json.dumps(initial), encoding='utf-8')
    return state, data, initial


@pytest.mark.parametrize('default', [False, True])
def test_quick_add_preserves_other_providers_and_stores_label(isolated, default):
    state, data, before = isolated
    result = asyncio.run(web.api_settings_models_add(web.ModelAddRequest(name='中文渠道', baseUrl='https://new.invalid/v1', apiKey='new-fixture-key', model='gpt-test', protocol='openai-responses', makeDefault=default)))
    config = json.loads((state / 'openclaw.json').read_text(encoding='utf-8'))
    provider = result['provider']
    assert config['models']['providers']['existing'] == before['models']['providers']['existing']
    assert config['models']['providers'][provider]['api'] == 'openai-responses'
    assert config['agents']['defaults']['model']['primary'] == (f'{provider}/gpt-test' if default else 'existing/old-model')
    assert channel_profiles.labels(web)[provider]['name'] == '中文渠道'
    assert next(row for row in result['channels']['chat']['rows'] if row['name'] == provider)['channelName'] == '中文渠道'
    assert channel_profiles.labels(web)[provider]['source'] == 'manual'
    assert 'new-fixture-key' not in json.dumps(result)
    assert 'new-fixture-key' not in (data / 'channel-names.json').read_text(encoding='utf-8')


def test_saved_channel_name_does_not_require_direct_probe_support(isolated, monkeypatch):
    state, _, before = isolated
    before['models']['providers']['existing']['headers'] = {'X-Custom-Auth': 'fixture-custom-header'}
    before['models']['providers']['existing'].pop('apiKey')
    (state / 'openclaw.json').write_text(json.dumps(before), encoding='utf-8')
    monkeypatch.setattr(web, '_model_health_target', lambda _: None)
    channel_profiles.save(web, 'existing', '自定义鉴权渠道')
    assert channel_profiles.labels(web)['existing']['name'] == '自定义鉴权渠道'
    before['models']['providers']['existing']['headers']['X-Custom-Auth'] = 'changed'
    (state / 'openclaw.json').write_text(json.dumps(before), encoding='utf-8')
    assert channel_profiles.labels(web)['existing']['name'] == '未命名渠道'


def test_magpie_uses_explicit_protocols_and_models_and_skips_sessions(tmp_path):
    path = tmp_path / 'providers.json'
    path.write_text(json.dumps({'providers': [
        {'id': 'relay', 'name': '我的 Magpie', 'chat': 'https://relay.invalid/v1', 'responses': 'https://relay.invalid/v1', 'key': 'fixture-magpie-key', 'models': ['a', 'b']},
        {'id': 'oauth', 'anthropic': 'https://other.invalid', 'key': '', 'refresh_token': 'private-session'},
        {'id': 'header', 'chat': 'https://header.invalid/v1', 'key': 'fixture-key', 'headers': {'X-Auth': 'private'}}]}), encoding='utf-8')
    rows, errors = imports.read_magpie(path)
    assert not errors and len(rows) == 6
    assert {(r['protocol'], r['model']) for r in rows if r['compatible']} == {('openai', 'a'), ('openai', 'b'), ('openai-responses', 'a'), ('openai-responses', 'b')}
    assert len({r['id'] for r in rows}) == 6
    assert not rows[-1]['compatible'] and not rows[-2]['compatible']


@pytest.mark.parametrize('raw,code', [('HTTP 503: no_available_account', 'provider_no_account'), ('无法连接接口：[WinError 10060]', 'connection_failed'), ('ModuleNotFoundError: output_paths', 'runtime_dependency'), ('HTTP 401', 'authentication'), ('HTTP 429', 'rate_limited'), ('HTTP 502', 'provider_unavailable')])
def test_image_failure_classifies_and_redacts(raw, code):
    failure = image_failure(raw + ' https://host.invalid/v1?key=private-fixture Bearer private-fixture', key='private-fixture')
    assert failure['errorCode'] == code
    assert 'private-fixture' not in str(failure) and 'https://' not in failure['errorDetail']
    assert 'Traceback' not in failure['error']


def test_responses_probe_uses_responses_contract():
    target = Target('relay/model', 'relay', 'model', 'openai-responses', 'https://fixture.invalid/v1', 'fixture')
    request = request_body(target, 'hello', b'fake-png')
    payload = json.loads(request.data)
    assert request.full_url.endswith('/responses') and 'messages' not in payload
    assert payload['input'][0]['content'][1]['type'] == 'input_image'
    class Response:
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def read(self, _): return json.dumps({'output': [{'content': [{'type': 'output_text', 'text': 'hello'}]}]}).encode()
    class Opener:
        def open(self, *_args, **_kwargs): return Response()
    assert dispatch(target, 'hello', 'text', Opener())['ok']
