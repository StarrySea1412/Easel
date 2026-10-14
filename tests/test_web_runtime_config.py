import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from easel.runtime_limits import install_limits
from easel.web_runtime_config import PLUGIN_PATH, configure_web_runtime, configure_browser_runtime
from easel import web_runtime_config


def test_defaults_add_pinned_provider_without_mutating_input():
    original = {'tools': {'toolSearch': False}, 'models': {'secretFixture': 'never-print'}}
    result, changes = configure_web_runtime(original)
    assert original == {'tools': {'toolSearch': False}, 'models': {'secretFixture': 'never-print'}}
    assert result['tools']['web']['search'] == {'provider': 'duckduckgo', 'enabled': True}
    assert result['plugins']['load']['paths'] == [PLUGIN_PATH]
    assert result['plugins']['entries']['duckduckgo']['enabled'] is True
    assert result['models'] == original['models']
    assert changes and 'never-print' not in json.dumps(changes)
    same, repeated = configure_web_runtime(result)
    assert same == result and repeated == []


def test_remote_browser_is_authenticated_and_keeps_operator_policy():
    auth = {'username': 'test-browser', 'password': 'x' * 48}
    original = {'browser': {'defaultProfile': 'custom', 'ssrfPolicy': {'allowedHostnames': ['example.com']},
                            'profiles': {'custom': {'cdpUrl': 'http://localhost:1234'}}}, 'secret': 'preserved'}
    result, changes = configure_browser_runtime(original, auth)
    assert result['browser']['defaultProfile'] == 'custom'
    assert result['browser']['profiles']['custom'] == original['browser']['profiles']['custom']
    assert result['browser']['profiles']['easel']['attachOnly'] is True
    assert result['browser']['ssrfPolicy'] == {'allowedHostnames': ['example.com', 'browser']}
    assert original['browser']['ssrfPolicy']['allowedHostnames'] == ['example.com']
    assert result['secret'] == 'preserved' and 'x' * 48 not in str(changes)
    assert configure_browser_runtime(result, auth)[1] == []
    disabled = {'browser': {'enabled': False}}
    assert configure_browser_runtime(disabled, auth) == (disabled, [])
    with pytest.raises(ValueError):
        configure_browser_runtime({}, {'username': 'test-browser', 'password': 'too-short'})


@pytest.mark.parametrize('original', [
    {'tools': {'web': {'search': {'provider': 'brave', 'enabled': True}}}},
    {'tools': {'web': {'search': {'enabled': False}}}},
    {'plugins': {'enabled': False}},
    {'plugins': {'entries': {'duckduckgo': {'enabled': False}}}},
    {'plugins': {'deny': ['duckduckgo']}},
    {'plugins': {'allow': ['browser']}},
])
def test_operator_provider_disabled_or_restrictive_policy_survives(original):
    result, changes = configure_web_runtime(original)
    assert result == original and changes == []


def test_explicit_migration_changes_only_search_and_plugin_selection():
    original = {'tools': {'toolSearch': True, 'web': {'search': {'enabled': False, 'timeoutSeconds': 20}}},
        'plugins': {'allow': ['browser'], 'load': {'paths': ['/existing']},
                    'entries': {'browser': {'enabled': True}}},
        'browser': {'noSandbox': False, 'headless': False}, 'gateway': {'nativeIdentity': 'preserved'}}
    result, changes = configure_web_runtime(original, enable_search=True, allow_plugin=True)
    assert result['tools']['toolSearch'] is True
    assert result['tools']['web']['search']['timeoutSeconds'] == 20
    assert result['plugins']['allow'] == ['browser', 'duckduckgo']
    assert result['plugins']['load']['paths'] == ['/existing', PLUGIN_PATH]
    assert result['browser'] == original['browser'] and result['gateway'] == original['gateway']
    assert original['tools']['web']['search']['enabled'] is False
    assert original['plugins']['allow'] == ['browser']
    assert changes


def test_cli_writes_separate_candidate_and_never_exposes_config_values(tmp_path):
    live, candidate = tmp_path / 'live.json', tmp_path / 'candidate.json'
    live.write_text(json.dumps({'secretFixture': 'NEVER_PRINT', 'tools': {'web': {'search': {'enabled': False}}}}))
    before = live.read_bytes()
    result = subprocess.run([sys.executable, '-m', 'easel.web_runtime_config', '--input', str(live),
        '--output', str(candidate), '--enable-search'], capture_output=True, text=True, check=True)
    assert live.read_bytes() == before and candidate.exists()
    assert 'NEVER_PRINT' not in result.stdout + result.stderr
    assert json.loads(result.stdout)['liveConfigModified'] is False
    assert json.loads(candidate.read_text())['tools']['web']['search']['enabled'] is True
    again = subprocess.run([sys.executable, '-m', 'easel.web_runtime_config', '--input', str(live),
        '--output', str(live)], capture_output=True, text=True)
    assert again.returncode != 0 and live.read_bytes() == before


def test_server_capabilities_only_exist_after_server_installation():
    local = FastAPI()
    with TestClient(local) as client:
        assert client.get('/api/server/readiness').status_code == 404
    workspace = SimpleNamespace(app=local, _BG_TASKS=set(), LOGIN_PROCESSES={}, check_gateway=lambda: True)
    install_limits(workspace)
    with TestClient(local) as client:
        result = client.get('/api/server/readiness')
        assert result.status_code == 200
        assert result.json()['deployment'] == {'mode': 'server', 'readOnlyRoot': True,
            'environmentInstall': False, 'storageMigration': False}


def test_cli_creates_secret_candidate_with_private_mode_from_first_open(tmp_path, monkeypatch, capsys):
    live, candidate = tmp_path / 'live.json', tmp_path / 'candidate.json'
    live.write_text(json.dumps({'secretFixture': 'NEVER_PRINT'}), encoding='utf-8')
    original_open = os.open
    opened = []

    def capture_open(path, flags, mode=0o777, **kwargs):
        opened.append((Path(path), flags, mode))
        return original_open(path, flags, mode, **kwargs)

    monkeypatch.setattr(web_runtime_config.os, 'open', capture_open)
    monkeypatch.setattr(sys, 'argv', ['web_runtime_config', '--input', str(live), '--output', str(candidate)])
    web_runtime_config.main()
    assert opened == [(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)]
    assert json.loads(candidate.read_text(encoding='utf-8'))['secretFixture'] == 'NEVER_PRINT'
    assert 'NEVER_PRINT' not in capsys.readouterr().out
    if os.name == 'posix':
        assert candidate.stat().st_mode & 0o777 == 0o600

    before = candidate.read_bytes()
    with pytest.raises(FileExistsError):
        web_runtime_config.main()
    assert candidate.read_bytes() == before
