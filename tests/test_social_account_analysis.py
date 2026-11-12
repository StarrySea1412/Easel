"""Explicit-account analytics: synthetic subprocesses, no platform requests."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

spec = importlib.util.spec_from_file_location('_account_analysis_fixture', Path(__file__).with_name('test_social_accounts.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
isolated, web, ready = fixture.isolated, fixture.web, fixture.ready
from easel.social_accounts import AccountError, PLATFORMS
from social_accounts_api import SocialAccountService
from social_account_analysis import AccountAnalysis
from content_analysis import Store
from content_analysis_sync import live_contents


def result(value):
    return SimpleNamespace(returncode=0, stdout='runner diagnostic\n' + json.dumps(value))


@pytest.fixture
def setup(isolated, monkeypatch):
    service = SocialAccountService(web)
    reader = AccountAnalysis(service)
    calls = []
    return service, reader, calls


@pytest.mark.parametrize('platform', sorted(PLATFORMS))
def test_seven_platforms_capture_only_selected_profile_and_keep_default_untouched(setup, monkeypatch, platform):
    service, reader, calls = setup
    a = ready(service.store, 'A', platform)
    b = ready(service.store, 'B', platform, 'b' * 24 if platform == 'xiaohongshu' else '67890')
    external = a['externalAccountId']
    def execute(command, **options):
        calls.append((command, options))
        assert a['accountId'] in ' '.join(command) and b['accountId'] not in ' '.join(command)
        if 'whoami' in command:
            for action in ('login', 'logout', 'check', 'analyze'):
                with pytest.raises(AccountError):
                    service.store.reserve(a['accountId'], action)
            with pytest.raises(AccountError):
                service.store.admit([fixture.target(a)], 'e' * 32)
            assert next(row for row in service.store.list() if row['accountId'] == a['accountId'])['busy']
            return result({'loggedIn': True, 'externalAccountId': external, 'name': 'A'})
        assert options['data_root'] == web.DATA_DIR / 'social-accounts' / a['accountId']
        return result({'platform': platform, 'loggedIn': True, 'accountId': external, 'followers': 13,
                       'cookie': 'never expose', 'notes': [{'id': 'work-a', 'metrics': {'views': 3}}]})
    monkeypatch.setattr(service, 'execute', execute)
    value = reader.collect(a['accountId'])
    assert value['account']['status'] == 'ready'
    assert value['sync']['overview']['followers'] == 13
    assert 'cookie' not in json.dumps(value)
    assert len(calls) == 2
    assert service.store.get(b['accountId'])['status'] == 'ready'
    assert reader.read(b['accountId'])['report'] is None
    assert not (web.OUTPUTS_DIR / '_analytics' / 'active.json').exists()
    assert bool(value['report']) is (platform in {'xiaohongshu', 'douyin', 'bilibili'})
    if value['report']:
        assert value['report']['account']['accountId'] == external
        assert value['report']['account']['accountId'] != a['accountId']
        assert value['report']['quality']['identity'] == 'live_verified'


@pytest.mark.parametrize('phase,identity,expected', [
    ('whoami', {'loggedIn': False}, 'login_required'),
    ('whoami', {'loggedIn': True, 'externalAccountId': 'b' * 24}, 'identity_changed'),
    ('fetch', {'loggedIn': False}, 'login_required'),
    ('fetch', {'loggedIn': True, 'accountId': 'b' * 24, 'notes': []}, 'identity_changed'),
    ('fetch', {'loggedIn': True, 'notes': []}, 'unverified'),
    ('fetch', {'loggedIn': True, 'accountId': 'a' * 24, 'notes': [{'id': 'bad', 'accountId': 'wrong'}]}, 'error'),
])
def test_invalid_identity_keeps_old_report_and_does_not_touch_other_account(setup, monkeypatch, phase, identity, expected):
    service, reader, calls = setup
    a = ready(service.store)
    store = Store(web.OUTPUTS_DIR / '_analytics' / 'workbench')
    store.ingest({'platform': a['platform'], 'accountId': a['externalAccountId'], 'contents': [{'id': 'old', 'title': 'retained'}]})
    def execute(command, **options):
        calls.append(command)
        return result(identity if (('whoami' in command) == (phase == 'whoami')) else
                      {'loggedIn': True, 'externalAccountId': a['externalAccountId'], 'name': 'A'})
    monkeypatch.setattr(service, 'execute', execute)
    with pytest.raises(AccountError):
        reader.collect(a['accountId'])
    assert service.store.get(a['accountId'])['status'] == expected
    assert [c['id'] for c in reader.read(a['accountId'])['report']['contents']] == ['old']
    if phase == 'whoami':
        assert len(calls) == 1


@pytest.mark.parametrize('change', ['data', 'outputs', 'generation'])
def test_inflight_scope_change_discards_result(setup, monkeypatch, tmp_path, change):
    service, reader, _ = setup
    a = ready(service.store)
    original_output = web.OUTPUTS_DIR
    def execute(command, **options):
        if 'whoami' in command:
            return result({'loggedIn': True, 'externalAccountId': a['externalAccountId'], 'name': 'A'})
        if change == 'data':
            monkeypatch.setattr(web, 'DATA_DIR', tmp_path / 'new-data')
        elif change == 'outputs':
            monkeypatch.setattr(web, 'OUTPUTS_DIR', tmp_path / 'new-outputs')
        else:
            service.store.recover()
        return result({'loggedIn': True, 'accountId': a['externalAccountId'], 'notes': [{'id': 'must-not-write'}]})
    monkeypatch.setattr(service, 'execute', execute)
    with pytest.raises(AccountError):
        reader.collect(a['accountId'])
    assert Store(original_output / '_analytics' / 'workbench').accounts() == []
    assert not (web.DATA_DIR / 'social-accounts' / a['accountId'] / 'outputs' / '_analytics').exists()


def test_router_requires_bound_identity_and_read_is_passive(setup, monkeypatch):
    service, reader, _ = setup
    a = service.store.create('not connected')
    monkeypatch.setattr(service, 'execute', lambda *args, **kwargs: pytest.fail('unexpected process'))
    app = FastAPI()
    app.include_router(service.router())
    with TestClient(app) as client:
        value = client.get('/api/social-accounts/' + a['accountId'] + '/analysis')
        assert value.status_code == 200 and value.json()['sync']['status'] == 'logged_out'
        assert client.post('/api/social-accounts/' + a['accountId'] + '/analysis').status_code == 409
        assert client.get('/api/social-accounts/not-an-id/analysis').status_code == 404


def test_live_mapping_preserves_explicit_comparison_fields_without_guessing():
    items, _ = live_contents({'notes': [{'id': 'one', 'period': 'lifetime', 'paid': False,
                                       'advancedMetrics': {'completions': 12}}]}, 'A')
    assert items[0]['paid'] is False and items[0]['period'] == 'lifetime'
    assert items[0]['advancedMetrics'] == {'completions': 12}
    unknown, _ = live_contents({'notes': [{'id': 'two'}]}, 'A')
    assert unknown[0]['period'] == 'unknown' and 'paid' not in unknown[0]


def test_execute_scopes_all_collector_side_effects_to_account_root(setup, monkeypatch):
    service, _, _ = setup
    monkeypatch.setattr(web, '_publish_env', lambda: {'EASEL_DATA_DIR': 'default', 'EASEL_ROOT': 'source'})
    received = {}
    def run(command, **kwargs):
        received.update(kwargs)
        return result({'loggedIn': True})
    monkeypatch.setattr(web.publish_followup, 'run_process', run)
    service.execute(['synthetic'], data_root=web.DATA_DIR / 'social-accounts' / ('a' * 32))
    assert received['env']['EASEL_DATA_DIR'].endswith('a' * 32)
    assert received['env']['EASEL_ANALYTICS_MANAGED'] == '1'
    assert received['env']['EASEL_CALENDAR_AUTORECORD'] == '0'


def test_summary_preserves_zero_and_omits_private_extra_fields():
    summary = AccountAnalysis.summary({'followers': 0, 'likes': None, 'secret': 'excluded',
                                       'metrics': [{'label': '播放', 'value': 0, 'vs': None}]})
    assert summary['followers'] == 0 and summary['likes'] is None
    assert summary['metrics'][0]['value'] == '0' and 'secret' not in summary
