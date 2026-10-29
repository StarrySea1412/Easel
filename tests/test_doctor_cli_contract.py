"""Run the actual diagnostic entry with synthetic CLI configuration, never a CLI login."""
from types import SimpleNamespace

import pytest

from easel.commands import doctor


@pytest.fixture
def diagnostic(tmp_path, monkeypatch):
    monkeypatch.setenv('EASEL_DATA_DIR', str(tmp_path))
    monkeypatch.setenv('EASEL_OPENCLAW_STATE_DIR', str(tmp_path / 'state'))
    monkeypatch.setattr(doctor, 'PROJECT_ROOT', tmp_path)
    monkeypatch.setattr(doctor, 'read_settings', lambda *args: {})
    for relative in ('web/frontend/dist/index.html', 'skills/openclaw/example',
                     'openclaw/openclaw.json5', 'scripts/gateway.ps1', 'scripts/gateway.sh'):
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('synthetic fixture', encoding='utf-8')
    for name in ('_python_version_ok', '_venv_available', '_chromium_available', '_gateway_healthy'):
        monkeypatch.setattr(doctor, name, lambda: True)
    monkeypatch.setattr(doctor, '_module_available', lambda *args: True)
    monkeypatch.setattr(doctor, '_openclaw_version', lambda: (2026, 9, 4))
    monkeypatch.setattr(doctor, '_node_version_ok', lambda *args: True)
    monkeypatch.setattr(doctor, '_skills_synced', lambda: (True, ''))
    monkeypatch.setattr('easel.local_agents.summarize_local_agents', lambda: {'installedCount': 0})
    return tmp_path


@pytest.mark.parametrize('primary,command', [
    ('claude-cli/claude-sonnet-4-5', 'claude'),
    ('google-gemini-cli/gemini-2.5-pro', 'gemini'),
])
@pytest.mark.parametrize('env_file', [False, True])
def test_configured_cli_does_not_require_an_api_key(diagnostic, monkeypatch, capsys, primary, command, env_file):
    import json
    config = doctor._openclaw_config_path()
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text(json.dumps({'agents': {'defaults': {'model': {'primary': primary}}}}), encoding='utf-8')
    if env_file:
        (diagnostic / '.env').write_text('ANTHROPIC_API_KEY=REPLACE_ME' + chr(10), encoding='utf-8')
    monkeypatch.setattr(doctor.shutil, 'which', lambda cmd: '/fixture/' + cmd if cmd in ('node', 'openclaw', 'ffmpeg', command) else None)
    assert doctor._env_key_valid() is False
    assert doctor._primary_model_cli_available() == (True, '')
    assert doctor.cmd_doctor(SimpleNamespace()) == 0
    output = capsys.readouterr().out
    assert 'CLI' in output and 'easel ping' in output
    assert 'REPLACE_ME' not in output


def test_missing_cli_still_fails_with_an_unrelated_api_key(diagnostic, monkeypatch):
    import json
    config = doctor._openclaw_config_path()
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text(json.dumps({'agents': {'defaults': {'model': {'primary': 'claude-cli/claude-sonnet-4-5'}}}}))
    (diagnostic / '.env').write_text('ANTHROPIC_API_KEY=synthetic-non-secret-key' + chr(10))
    monkeypatch.setattr(doctor.shutil, 'which', lambda cmd: '/fixture/' + cmd if cmd in ('node', 'openclaw', 'ffmpeg') else None)
    assert doctor.cmd_doctor(SimpleNamespace()) == 1
