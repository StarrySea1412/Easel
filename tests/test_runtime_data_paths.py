"""Installed release paths and credential-free installer verification (offline)."""

from __future__ import annotations

import json
import importlib.util
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from easel.commands import doctor
from easel.paths import child_env, data_root


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def test_data_root_keeps_source_default_and_passes_explicit_data(tmp_path, monkeypatch):
    monkeypatch.delenv("EASEL_DATA_DIR", raising=False)
    monkeypatch.delenv("EASEL_ROOT", raising=False)
    assert data_root(tmp_path) == tmp_path
    data = tmp_path / "persistent data"
    monkeypatch.setenv("EASEL_DATA_DIR", str(data))
    assert data_root(PROJECT_ROOT) == data
    env = child_env(PROJECT_ROOT)
    assert env["EASEL_ROOT"] == str(PROJECT_ROOT)
    assert env["EASEL_DATA_DIR"] == str(data)
    assert Path(env["EASEL_PYTHON"]).is_file()


def test_child_env_selects_python_for_skill_subprocesses(tmp_path, monkeypatch):
    monkeypatch.delenv("EASEL_PYTHON", raising=False)
    assert child_env(tmp_path)["EASEL_PYTHON"] == sys.executable
    monkeypatch.setenv("EASEL_PYTHON", str(tmp_path / "missing-python"))
    assert child_env(tmp_path)["EASEL_PYTHON"] == sys.executable
    explicit = tmp_path / "configured-python.exe"
    explicit.write_bytes(b"fixture")
    monkeypatch.setenv("EASEL_PYTHON", str(explicit))
    assert child_env(tmp_path)["EASEL_PYTHON"] == str(explicit)


def test_doctor_reads_data_config_not_version_config(tmp_path, monkeypatch):
    code, data = tmp_path / "version", tmp_path / "data"
    code.mkdir()
    data.mkdir()
    monkeypatch.setattr(doctor, "PROJECT_ROOT", code)
    monkeypatch.setenv("EASEL_DATA_DIR", str(data))
    (code / ".env").write_text("ANTHROPIC_API_KEY=synthetic-code-key\n", encoding="utf-8")
    assert doctor._env_key_valid() is False
    (data / ".env").write_text("ANTHROPIC_API_KEY=synthetic-data-key\n", encoding="utf-8")
    assert doctor._env_key_valid() is True


def test_cli_web_and_output_helpers_share_persistent_data(tmp_path):
    """Fresh process avoids module constants and never reads the user's config."""
    data = tmp_path / "persistent data"
    profile = data / "profiles" / "account"
    profile.mkdir(parents=True)
    (profile / "identity.md").write_text("Synthetic profile", encoding="utf-8")
    state = tmp_path / "openclaw"
    env = os.environ.copy()
    env.update(EASEL_ROOT=str(PROJECT_ROOT), EASEL_DATA_DIR=str(data),
               EASEL_OPENCLAW_STATE_DIR=str(state), USERPROFILE=str(tmp_path / "home"),
               HOME=str(tmp_path / "home"))
    script = r'''
import json
from easel import cli, persona
from easel.commands import skill
from web import app
from skills.shared.scripts import output_paths
from skills.shared.scripts import calendar_ops
import importlib
assert persona.list_personas() == ["account"]
assert persona.load_profile_text("account") == "Synthetic profile"
assert cli.PROFILES_DIR == skill.PROFILES_DIR == app.PROFILES_DIR
assert app.OUTPUTS_DIR == output_paths.OUTPUTS_DIR
assert app.ENV_FILE == app.DATA_DIR / ".env"
assert app.OPENCLAW_SESSIONS_DIR == __import__('pathlib').Path(__import__('os').environ['EASEL_OPENCLAW_STATE_DIR']) / 'agents' / 'main' / 'sessions'
app._write_env_direct({"IMG_MODEL": "test-model"})
assert app._read_env()["IMG_MODEL"] == "test-model"
target = output_paths.validate_output_path("outputs/installation-check/result.txt", create_parent=True)
target.write_text("synthetic output", encoding="utf-8")
assert target == app.OUTPUTS_DIR / "installation-check" / "result.txt"
assert app._proxy_env()["EASEL_DATA_DIR"] == str(app.DATA_DIR)
assert calendar_ops.DEFAULT_DATA == app.OUTPUTS_DIR / "_schedule.json"
assert calendar_ops.PROJECT_ROOT == app.PROJECT_ROOT
for module_name in (
    "skills.shared.scripts.account_stats", "skills.shared.scripts.douyin_publish",
    "skills.shared.scripts.weixin_mp_stats", "skills.shared.scripts.xhs_comment",
    "skills.shared.scripts.xhs_publish", "skills.shared.scripts.bili_login",
    "skills.shared.scripts.manifest", "skills.openclaw.skill-data-tracker.scripts.track",
    "skills.openclaw.skill-publish-log.scripts.log", "skills.openclaw.skill-publish-analytics.scripts.analyze",
):
    assert importlib.import_module(module_name).PROJECT_ROOT == app.DATA_DIR, module_name
print(json.dumps({"profiles": str(app.PROFILES_DIR), "output": str(target)}))
'''
    result = subprocess.run([sys.executable, "-c", script], cwd=PROJECT_ROOT, env=env,
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    assert Path(json.loads(result.stdout)["profiles"]) == profile.parent
    assert (data / ".env").read_text(encoding="utf-8").count("IMG_MODEL=test-model") == 1


@pytest.fixture
def ready_doctor(tmp_path, monkeypatch):
    """No tools, gateway, browser, credentials, or network are accessed."""
    monkeypatch.setattr(doctor, "PROJECT_ROOT", tmp_path)
    for relative in ("web/frontend/dist/index.html", "openclaw/openclaw.json5",
                     "scripts/gateway.ps1", "scripts/gateway.sh", "skills/openclaw/example"):
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("fixture", encoding="utf-8")
    monkeypatch.setattr(doctor, "_python_version_ok", lambda: True)
    monkeypatch.setattr(doctor, "_venv_available", lambda: True)
    monkeypatch.setattr(doctor, "_openclaw_version", lambda: (2026, 9, 4))
    monkeypatch.setattr(doctor, "_node_version_ok", lambda strict: True)
    monkeypatch.setattr(doctor.shutil, "which", lambda command: command)
    monkeypatch.setattr(doctor, "_module_available", lambda module: True)
    monkeypatch.setattr(doctor, "_chromium_available", lambda: True)
    monkeypatch.setattr(doctor, "_gateway_healthy", lambda: True)
    monkeypatch.setattr(doctor, "_skills_synced", lambda: (True, ""))


def test_install_doctor_defers_only_credentials(ready_doctor, monkeypatch, capsys):
    def unexpected_auth_access():
        pytest.fail("Installer verification must not read model credentials")
    monkeypatch.setattr(doctor, "_env_key_valid", unexpected_auth_access)
    monkeypatch.setattr(doctor, "_primary_model_routable", unexpected_auth_access)
    assert doctor.cmd_doctor(SimpleNamespace(install_mode=True)) == 0
    assert "Web 设置" in capsys.readouterr().out


@pytest.mark.parametrize("check", ["_gateway_healthy", "_chromium_available", "_venv_available"])
def test_install_doctor_still_fails_runtime_requirements(ready_doctor, monkeypatch, check):
    monkeypatch.setattr(doctor, check, lambda: False)
    assert doctor.cmd_doctor(SimpleNamespace(install_mode=True)) == 1


def test_normal_doctor_still_checks_credentials(ready_doctor, monkeypatch):
    monkeypatch.setattr(doctor, "_env_key_valid", lambda: False)
    monkeypatch.setattr(doctor, "_primary_model_routable", lambda: (False, "fixture"))
    assert doctor.cmd_doctor(SimpleNamespace()) == 1


@pytest.mark.parametrize("relative", [
    "skills/shared/scripts/ai_image.py", "skills/shared/scripts/ai_video.py",
    "skills/shared/scripts/ai_music.py", "skills/shared/scripts/voice_clone.py",
    "skills/openclaw/ecom-details-image/scripts/generate_image.py",
])
def test_media_loaders_use_data_config_without_stale_version_fallback(tmp_path, monkeypatch, relative):
    monkeypatch.syspath_prepend(str(PROJECT_ROOT / "skills/shared/scripts"))
    spec = importlib.util.spec_from_file_location("media_data_path_test", PROJECT_ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setenv("EASEL_DATA_DIR", str(data))
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".env").write_text("IMG_MODEL=stale-model\n", encoding="utf-8")
    assert module.find_default_env_file() is None
    (data / ".env").write_text("IMG_MODEL=data-model\n", encoding="utf-8")
    assert module.find_default_env_file() == data / ".env"


def test_model_registry_uses_data_config_and_explicit_path_wins(tmp_path, monkeypatch):
    from skills.shared.scripts import model_registry
    data = tmp_path / "data"
    data.mkdir()
    (data / ".env").write_text("INSTALL_TEST_MODEL=persistent\n", encoding="utf-8")
    alternate = tmp_path / "alternate.env"
    alternate.write_text("INSTALL_TEST_MODEL=explicit\n", encoding="utf-8")
    monkeypatch.setenv("EASEL_DATA_DIR", str(data))
    monkeypatch.delenv("INSTALL_TEST_MODEL", raising=False)
    assert model_registry.read_env_file()["INSTALL_TEST_MODEL"] == "persistent"
    assert model_registry.read_env_file(alternate)["INSTALL_TEST_MODEL"] == "explicit"


@pytest.mark.skipif(os.name != "nt", reason="Windows gateway PowerShell entry point")
@pytest.mark.parametrize("owned, expected", [(False, 1), (True, 0)])
def test_gateway_checks_profile_before_accepting_healthy_port(tmp_path, owned, expected):
    source = (PROJECT_ROOT / "scripts/gateway.ps1").read_text(encoding="utf-8-sig")
    mock_process = "[pscustomobject]@{ ProcessId = 123 }" if owned else "$null"
    mocks = f'''
function Test-Gateway {{ return $true }}
function Get-GatewayProcess {{ return {mock_process} }}
function Start-Process {{ throw 'Must not launch a process during this check' }}
function Stop-Process {{ throw 'Must not stop a process during this check' }}
'''
    assert "gateway run --force" not in source
    source = source.replace("switch ($args[0]) {", mocks + "\nswitch ($args[0]) {")
    script = tmp_path / "gateway-check.ps1"
    script.write_text(source, encoding="utf-8-sig")
    result = subprocess.run(["powershell.exe", "-NoProfile", "-File", str(script), "start"],
                            capture_output=True, timeout=15)
    assert result.returncode == expected
    assert b"Must not" not in result.stdout + result.stderr


@pytest.mark.skipif(os.name != "nt", reason="Windows gateway PowerShell entry point")
@pytest.mark.parametrize("profile_argument, command_port, owned", [
    ("easel", 37289, True), ('"easel"', 37289, True), ("'easel'", 37289, True),
    ("easel-other", 37289, False), ('"easel-other"', 37289, False), ("other", 37289, False),
    ("easel", 37290, False), ("easel", None, False),
])
def test_gateway_restart_only_stops_exact_easel_profile(tmp_path, profile_argument, command_port, owned):
    source = (PROJECT_ROOT / "scripts/gateway.ps1").read_text(encoding="utf-8-sig")
    mocks = '''
function Test-Gateway { return $true }
function Get-CimInstance {
    return [pscustomobject]@{ ProcessId = 123; CommandLine = $env:EASEL_TEST_GATEWAY_COMMAND }
}
function Start-Process { throw 'Must not launch a real process' }
function Start-Sleep { }
function Stop-Process {
    param([int]$Id, [switch]$Force)
    if ($Id -ne 123) { throw 'Must not stop another process' }
    Write-Output 'STOPPED_MOCK_123'
}
'''
    source = source.replace("switch ($args[0]) {", mocks + "\nswitch ($args[0]) {")
    script = tmp_path / "gateway-restart-check.ps1"
    script.write_text(source, encoding="utf-8-sig")
    env = dict(os.environ, OPENCLAW_GATEWAY_PORT="37289", EASEL_TEST_GATEWAY_COMMAND=(
        'node "C:\\synthetic\\openclaw\\openclaw.mjs" --profile '
        + profile_argument + ' gateway run --bind loopback' + (f' --port {command_port}' if command_port else '')))
    result = subprocess.run(["powershell.exe", "-NoProfile", "-File", str(script), "restart"],
                            env=env, capture_output=True, timeout=15)
    assert (b"STOPPED_MOCK_123" in result.stdout) is owned
    assert result.returncode == (0 if owned else 1)
    assert b"Must not" not in result.stdout + result.stderr
