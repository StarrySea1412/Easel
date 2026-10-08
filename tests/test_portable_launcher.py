"""Portable ZIP boundaries: relocation, empty data, and exact process ownership."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys

import pytest


_spec = importlib.util.spec_from_file_location("portable_launcher", Path(__file__).parents[1] / "scripts/portable_launcher.py")
launcher = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = launcher
_spec.loader.exec_module(launcher)


@pytest.fixture
def bundle(tmp_path):
    root = tmp_path / "中文 Easel 便携包"
    root.mkdir()
    manifest = {"schemaVersion": 1, "kind": launcher.KIND, "app": "app", "data": "data",
                "version": "0.2.6", "sourceCommit": "a" * 40, "runtime": dict(launcher.LAYOUT)}
    (root / "portable-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    for name, value in launcher.LAYOUT.items():
        path = root / value
        if name == "browserPath":
            path.mkdir(parents=True)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"runtime placeholder; never execute in unit tests")
    for relative, content in {
        "web/frontend/dist/index.html": "Easel page",
        "web/app.py": "# app",
        "skills/openclaw/card-quote/SKILL.md": "# Quote cards",
        "skills/shared/scripts/tool.py": "print('isolated')",
        "openclaw/workspace/AGENTS.md": "# Project instructions",
    }.items():
        path = root / "app" / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    return launcher.load_bundle(root)


def process_record(bundle, name, *, pid, created="2026-10-08T00:00:00.0000000Z", port=None):
    port = port or (37881 if name == "gateway" else 7881)
    executable = str(bundle.runtime["node" if name == "gateway" else "python"])
    command = [executable, str(bundle.runtime["openclaw"]), "--profile", "easel", "gateway", "run", "--port", str(port)] \
        if name == "gateway" else [executable, "-B", "-s", str(bundle.app / "web/app.py")]
    info = {"pid": pid, "parentId": 20, "created": created, "executable": executable,
            "commandLine": subprocess.list2cmdline(command)}
    return {"port": port, "rootProcess": dict(info), "listenerProcess": dict(info)}


def save_services(bundle, services):
    identity = {"schemaVersion": 1, "bundleId": "b" * 32, "root": str(bundle.root)}
    state = {"schemaVersion": 1, "bundleId": identity["bundleId"], "root": str(bundle.root), "services": services}
    launcher._write_json(bundle.data / launcher.IDENTITY_FILE, identity)
    launcher._write_json(bundle.data / launcher.STATE_FILE, state)
    return identity, state


def observed_services(services):
    return {"processes": {rec["rootProcess"]["pid"]: rec["rootProcess"] for rec in services.values()},
            "listeners": {rec["port"]: rec["listenerProcess"]["pid"] for rec in services.values()}}


@pytest.mark.parametrize("field,value", [
    ("python", "../python.exe"), ("node", "C:/host/node.exe"),
    ("openclaw", "runtime/../../global/openclaw.mjs"), ("browserPath", "\\\\server\\browser"),
])
def test_manifest_rejects_paths_outside_fixed_runtime(bundle, field, value):
    manifest = dict(bundle.manifest, runtime={**bundle.manifest["runtime"], field: value})
    launcher._write_json(bundle.root / "portable-manifest.json", manifest)
    with pytest.raises(ValueError):
        launcher.load_bundle(bundle.root)


def test_missing_python_never_falls_back_to_host(bundle, monkeypatch):
    bundle.runtime["python"].unlink()
    monkeypatch.setattr(launcher.subprocess, "Popen", lambda *a, **kw: pytest.fail("must not run host Python"))
    with pytest.raises(ValueError, match="缺少 python"):
        launcher.load_bundle(bundle.root)


def test_environment_ignores_host_keys_paths_and_login_home(bundle):
    env = launcher.isolated_env(bundle, {
        "PATH": r"C:\host\Python;C:\host\Node", "SystemRoot": r"C:\Windows",
        "HOME": r"C:\host\user", "USERPROFILE": r"C:\host\user", "APPDATA": "host-config",
        "ANTHROPIC_API_KEY": "host-secret", "OPENAI_API_KEY": "host-secret-2",
        "OPENCLAW_CONFIG_PATH": "host-openclaw.json", "OPENCLAW_GATEWAY_TOKEN": "other-gateway-token",
        "EASEL_OPENCLAW_WORKSPACE": "host-workspace", "PYTHONHOME": "host-python",
        "PYTHONPATH": "host-inject", "NODE_OPTIONS": "--require host-inject.js",
        "EASEL_RAW_STREAM_PATH": "host-output", "HTTP_PROXY": "http://127.0.0.1:8888",
    })
    for key in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENCLAW_GATEWAY_TOKEN", "PYTHONHOME", "PYTHONPATH", "NODE_OPTIONS"):
        assert key not in env
    assert "C:\\host" not in env["PATH"]
    assert env["HOME"] == env["USERPROFILE"] == str(bundle.data / "home")
    assert env["OPENCLAW_CONFIG_PATH"] == str(bundle.config)
    assert env["OPENCLAW_NO_AUTO_UPDATE"] == "1"
    assert env["EASEL_OPENCLAW_ENTRY"] == str(bundle.runtime["openclaw"])
    assert env["EASEL_NODE_EXECUTABLE"] == str(bundle.runtime["node"])
    assert env["EASEL_PYTHON"] == str(bundle.runtime["python"])
    assert env["PYTHONDONTWRITEBYTECODE"] == "1"
    assert env["PLAYWRIGHT_BROWSERS_PATH"] == str(bundle.runtime["browserPath"])
    assert env["HTTP_PROXY"] == "http://127.0.0.1:8888"
    assert "127.0.0.1" in env["NO_PROXY"]


def test_empty_bundle_initializes_without_subprocess_or_download(bundle, monkeypatch):
    monkeypatch.setattr(launcher.subprocess, "run", lambda *a, **kw: pytest.fail("initialization must not install"))
    monkeypatch.setattr(launcher.subprocess, "Popen", lambda *a, **kw: pytest.fail("initialization must not install"))
    identity, port = launcher.initialize(bundle, {}, gateway_port=37881)
    config = launcher._read_json(bundle.config)
    assert config["gateway"]["port"] == port == 37881
    assert config["gateway"]["bind"] == "loopback"
    assert config["gateway"]["auth"] == {"mode": "none"}
    assert config["agents"]["defaults"]["workspace"] == str(bundle.workspace)
    assert config["memory"]["search"]["enabled"] is False
    assert "apiKey" not in json.dumps(config)
    assert "ANTHROPIC_API_KEY=\n" in (bundle.data / ".env").read_text(encoding="utf-8")
    assert (bundle.workspace / "skills/card-quote/SKILL.md").is_file()
    assert (bundle.workspace / "shared/scripts/tool.py").is_file()
    assert "EASEL_DATA_DIR" in (bundle.workspace / "AGENTS.md").read_text(encoding="utf-8")
    assert identity["managedConfig"]["workspace"] == str(bundle.workspace)
    assert not (bundle.workspace / "outputs").exists()  # no NTFS-specific junction


def test_relocation_rebinds_managed_paths_and_preserves_user_secrets(bundle, tmp_path):
    identity, _ = launcher.initialize(bundle, {}, gateway_port=37881)
    config = launcher._read_json(bundle.config)
    config["models"] = {"providers": {"private": {"apiKey": "my-local-secret", "baseUrl": "https://provider.example"}}}
    config["gateway"]["auth"] = {"mode": "token", "token": "user-gateway-secret"}
    launcher._write_json(bundle.config, config)
    (bundle.data / ".env").write_text("OPENAI_API_KEY=never-overwrite\n", encoding="utf-8")
    moved = tmp_path / "移动后 新位置"
    bundle.root.rename(moved)
    new_bundle = launcher.load_bundle(moved)
    updated, _ = launcher.initialize(new_bundle, identity, gateway_port=37881)
    saved = launcher._read_json(new_bundle.config)
    assert updated["bundleId"] == identity["bundleId"]
    assert saved["agents"]["defaults"]["workspace"] == str(new_bundle.workspace)
    assert saved["models"] == config["models"]
    assert saved["gateway"]["auth"] == config["gateway"]["auth"]
    assert (new_bundle.data / ".env").read_text(encoding="utf-8") == "OPENAI_API_KEY=never-overwrite\n"
    context = (new_bundle.workspace / "CONTEXT.md").read_text(encoding="utf-8")
    assert str(new_bundle.root) in context and str(bundle.root) not in context


def test_relocation_does_not_change_custom_external_workspace(bundle, tmp_path):
    identity, _ = launcher.initialize(bundle, {}, gateway_port=37881)
    config = launcher._read_json(bundle.config)
    config["agents"]["defaults"]["workspace"] = str(tmp_path / "my-existing-work")
    launcher._write_json(bundle.config, config)
    before = bundle.config.read_bytes()
    with pytest.raises(RuntimeError, match="自定义工作目录"):
        launcher.initialize(bundle, identity, gateway_port=37881)
    assert bundle.config.read_bytes() == before


def test_member_external_workspace_is_preserved_and_not_started(bundle, tmp_path):
    identity, _ = launcher.initialize(bundle, {}, gateway_port=37881)
    config = launcher._read_json(bundle.config)
    config["agents"]["list"] = [{"id": "writer", "workspace": str(tmp_path / "external-member")}]
    launcher._write_json(bundle.config, config)
    before = bundle.config.read_bytes()
    with pytest.raises(RuntimeError, match="成员使用了包外"):
        launcher.initialize(bundle, identity, gateway_port=37881)
    assert bundle.config.read_bytes() == before


def test_reinitialization_preserves_modified_skill_and_user_instructions(bundle):
    identity, _ = launcher.initialize(bundle, {}, gateway_port=37881)
    skill = bundle.workspace / "skills/card-quote/SKILL.md"
    instructions = bundle.workspace / "AGENTS.md"
    skill.write_text("my local skill", encoding="utf-8")
    instructions.write_text("my personal rules", encoding="utf-8")
    identity["sourceVersion"] = "previous-version"
    launcher.initialize(bundle, identity, gateway_port=37881)
    assert skill.read_text(encoding="utf-8") == "my local skill"
    assert instructions.read_text(encoding="utf-8") == "my personal rules"


def test_occupied_port_uses_independent_port_without_touching_listener():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        assert launcher.available_port(port) != port
        with pytest.raises(RuntimeError, match="自定义端口"):
            launcher.available_port(port, strict=True)
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            pass


def test_first_web_port_is_dynamic_and_saved_to_this_data_identity(bundle, monkeypatch):
    identity, _ = save_services(bundle, {})
    monkeypatch.setattr(launcher, "available_port", lambda *a, **kw: pytest.fail("fresh copies must not choose a shared default"))
    port, changed = launcher.select_web_port(bundle, identity)
    assert 0 < port < 65536 and not changed
    assert launcher._read_json(bundle.data / launcher.IDENTITY_FILE)["webPort"] == port
    assert not launcher.browser_storage_notice(identity)


def test_stop_and_restart_preserve_web_origin(bundle, monkeypatch):
    identity, _ = save_services(bundle, {})
    port, _ = launcher.select_web_port(bundle, identity)
    monkeypatch.setattr(launcher.subprocess, "run", lambda *a, **kw: pytest.fail("no services were started by this test"))
    launcher.stop(bundle)
    saved = launcher._read_json(bundle.data / launcher.IDENTITY_FILE)
    original = launcher.available_port
    requested = []
    def choose(preferred, **kwargs):
        requested.append(preferred)
        return original(preferred, **kwargs)
    monkeypatch.setattr(launcher, "available_port", choose)
    restarted, changed = launcher.select_web_port(bundle, saved)
    assert restarted == port and not changed
    assert requested == [port]  # Never fall back to 7860 because it became free.


def test_two_fresh_copies_get_independent_web_ports(bundle, tmp_path):
    second_root = tmp_path / "另一个 Easel 副本"
    shutil.copytree(bundle.root, second_root)
    second = launcher.load_bundle(second_root)
    first_identity, _ = launcher.initialize(bundle, {}, gateway_port=37881)
    second_identity, _ = launcher.initialize(second, {}, gateway_port=37882)
    assert first_identity["bundleId"] != second_identity["bundleId"]
    first_port, _ = launcher.select_web_port(bundle, first_identity)
    with socket.socket() as first_listener:
        first_listener.bind(("127.0.0.1", first_port))
        first_listener.listen()
        second_port, changed = launcher.select_web_port(second, second_identity)
        assert second_port != first_port and not changed
        assert launcher._read_json(bundle.data / launcher.IDENTITY_FILE)["webPort"] == first_port
        assert launcher._read_json(second.data / launcher.IDENTITY_FILE)["webPort"] == second_port
        with socket.create_connection(("127.0.0.1", first_port), timeout=1):
            pass


def test_web_port_conflict_keeps_foreign_listener_and_explains_browser_storage(bundle, monkeypatch):
    identity, _ = save_services(bundle, {})
    previous, _ = launcher.select_web_port(bundle, identity)
    monkeypatch.setattr(launcher.subprocess, "run", lambda *a, **kw: pytest.fail("must not stop a port owner"))
    with socket.socket() as foreign:
        foreign.bind(("127.0.0.1", previous))
        foreign.listen()
        selected, changed = launcher.select_web_port(bundle, identity)
        assert changed and selected != previous
        with socket.create_connection(("127.0.0.1", previous), timeout=1):
            pass
    saved = launcher._read_json(bundle.data / launcher.IDENTITY_FILE)
    assert saved["webPort"] == selected
    assert saved["webPortChange"] == {"from": previous, "to": selected}
    notice = launcher.browser_storage_notice(saved)
    assert str(previous) in notice and str(selected) in notice
    assert "浏览器草稿" in notice and "无法自动迁移" in notice and "对话备份" in notice
    assert launcher.status(bundle)["browserStorageNotice"] == notice


@pytest.mark.parametrize("invalid", [0, -1, 65536, True, "7860"])
def test_invalid_persisted_web_port_is_rejected_without_touching_a_process(bundle, invalid, monkeypatch):
    identity, _ = save_services(bundle, {})
    identity["webPort"] = invalid
    launcher._write_json(bundle.data / launcher.IDENTITY_FILE, identity)
    monkeypatch.setattr(launcher.subprocess, "run", lambda *a, **kw: pytest.fail("must not stop or inspect processes"))
    with pytest.raises(RuntimeError, match="保存的工作台端口无效"):
        launcher.status(bundle)


@pytest.mark.parametrize("field,replacement", [
    ("created", "2026-10-08T01:00:00Z"), ("pid", 1000),
    ("executable", r"C:\different\python.exe"), ("commandLine", "python other.py"),
])
def test_pid_reuse_or_different_command_never_grants_ownership(bundle, field, replacement):
    record = process_record(bundle, "web", pid=721)
    actual = dict(record["rootProcess"], **{field: replacement})
    assert not launcher.matches_process(record["rootProcess"], actual)
    assert not launcher.service_owned(record, {"processes": {721: actual}, "listeners": {7881: 721}})


def test_tampered_record_cannot_claim_another_program(bundle):
    record = process_record(bundle, "web", pid=721)
    record["rootProcess"]["executable"] = r"C:\host\python.exe"
    save_services(bundle, {"web": record})
    with pytest.raises(RuntimeError, match="不属于"):
        launcher._state(bundle)


def test_correct_interpreter_cannot_claim_another_script(bundle):
    record = process_record(bundle, "web", pid=721)
    record["rootProcess"]["commandLine"] = subprocess.list2cmdline([str(bundle.runtime["python"]), "unrelated.py"])
    save_services(bundle, {"web": record})
    with pytest.raises(RuntimeError, match="不属于"):
        launcher._state(bundle)


def test_foreign_listener_is_never_stopped(bundle, monkeypatch):
    record = process_record(bundle, "web", pid=721)
    save_services(bundle, {"web": record})
    monkeypatch.setattr(launcher, "snapshot", lambda *a, **kw: {"processes": {}, "listeners": {7881: 990}})
    monkeypatch.setattr(launcher.subprocess, "run", lambda *a, **kw: pytest.fail("must not taskkill"))
    result = launcher.stop(bundle)
    assert result["ok"] and result["stopped"] == []
    assert "未操作对方" in result["message"]


def test_stop_uses_only_verified_current_bundle_processes(bundle, monkeypatch):
    services = {"web": process_record(bundle, "web", pid=721),
                "gateway": process_record(bundle, "gateway", pid=722)}
    save_services(bundle, services)
    observed = observed_services(services)
    monkeypatch.setattr(launcher, "snapshot", lambda *a, **kw: observed)
    commands = []
    def run(command, **kwargs):
        commands.append(command)
        return subprocess.CompletedProcess(command, 0)
    monkeypatch.setattr(launcher.subprocess, "run", run)
    result = launcher.stop(bundle)
    assert result["stopped"] == ["web", "gateway"]
    assert [cmd[cmd.index("/PID") + 1] for cmd in commands] == ["721", "722"]
    assert launcher._read_json(bundle.data / launcher.STATE_FILE)["services"] == {}


def test_stop_can_reap_owned_partial_start_without_a_listener(bundle, monkeypatch):
    record = process_record(bundle, "gateway", pid=722)
    record["listenerProcess"] = None
    save_services(bundle, {"gateway": record})
    observed = {"processes": {722: record["rootProcess"]}, "listeners": {}}
    monkeypatch.setattr(launcher, "snapshot", lambda *a, **kw: observed)
    commands = []
    def run(command, **kwargs):
        commands.append(command)
        assert kwargs["env"]["USERPROFILE"] == str(bundle.data / "home")
        return subprocess.CompletedProcess(command, 0)
    monkeypatch.setattr(launcher.subprocess, "run", run)
    assert launcher.stop(bundle)["stopped"] == ["gateway"]
    assert commands[0][commands[0].index("/PID") + 1] == "722"


def test_moved_copy_does_not_stop_still_running_original(bundle, tmp_path, monkeypatch):
    services = {"web": process_record(bundle, "web", pid=721)}
    save_services(bundle, services)
    observed = observed_services(services)
    moved = tmp_path / "第二个便携副本"
    bundle.root.rename(moved)
    new_bundle = launcher.load_bundle(moved)
    monkeypatch.setattr(launcher, "snapshot", lambda *a, **kw: observed)
    monkeypatch.setattr(launcher.subprocess, "run", lambda *a, **kw: pytest.fail("must not stop original"))
    with pytest.raises(RuntimeError, match="原解压目录"):
        launcher.stop(new_bundle)


def test_status_requires_owned_listener_for_both_services(bundle, monkeypatch):
    services = {"web": process_record(bundle, "web", pid=721),
                "gateway": process_record(bundle, "gateway", pid=722)}
    save_services(bundle, services)
    observed = observed_services(services)
    monkeypatch.setattr(launcher, "snapshot", lambda *a, **kw: observed)
    assert launcher.status(bundle)["running"] is True
    observed["listeners"][37881] = 990
    assert launcher.status(bundle)["running"] is False


def test_repeated_start_reuses_only_own_healthy_pair(bundle, monkeypatch):
    services = {"web": process_record(bundle, "web", pid=721),
                "gateway": process_record(bundle, "gateway", pid=722)}
    save_services(bundle, services)
    monkeypatch.setattr(launcher, "snapshot", lambda *a, **kw: observed_services(services))
    monkeypatch.setattr(launcher, "_http_ready", lambda *a, **kw: True)
    monkeypatch.setattr(launcher, "initialize", lambda *a, **kw: pytest.fail("must not reinitialize"))
    monkeypatch.setattr(launcher.subprocess, "Popen", lambda *a, **kw: pytest.fail("must not spawn duplicate"))
    result = launcher.start(bundle, no_browser=True)
    assert result["reused"] and result["url"] == "http://127.0.0.1:7881/"
    assert launcher._read_json(bundle.data / launcher.IDENTITY_FILE)["webPort"] == 7881


def test_logs_redact_bundle_credentials(bundle):
    launcher.initialize(bundle, {}, gateway_port=37881)
    (bundle.data / ".env").write_text("OPENAI_API_KEY=private-model-key\n", encoding="utf-8")
    config = launcher._read_json(bundle.config)
    config["gateway"]["auth"] = {"mode": "token", "token": "private-gateway-token"}
    launcher._write_json(bundle.config, config)
    launcher.log(bundle, "failed: private-model-key and private-gateway-token")
    text = bundle.log_path.read_text(encoding="utf-8")
    assert "private-model-key" not in text and "private-gateway-token" not in text
    assert "[REDACTED]" in text


def test_failed_config_validation_preserves_config_and_uses_exact_bundled_node(bundle, monkeypatch):
    launcher.initialize(bundle, {}, gateway_port=37881)
    before = bundle.config.read_bytes()
    calls = []
    monkeypatch.setattr(launcher.subprocess, "run", lambda command, **kw: subprocess.CompletedProcess(command, 0))
    class FailedProcess:
        returncode = 1
        def wait(self, **kwargs):
            return self.returncode
    def popen(command, **kwargs):
        calls.append((command, kwargs))
        kwargs["stdout"].write(b"configuration failed")
        return FailedProcess()
    monkeypatch.setattr(launcher.subprocess, "Popen", popen)
    with pytest.raises(RuntimeError, match="配置验证失败"):
        launcher.validate_config(bundle, launcher.isolated_env(bundle, {}))
    assert calls[0][0] == [str(bundle.runtime["node"]), str(bundle.runtime["openclaw"]), "--profile", "easel", "config", "validate"]
    assert bundle.config.read_bytes() == before


def test_failed_web_launch_cleans_only_gateway_created_this_attempt(bundle, monkeypatch):
    monkeypatch.setattr(launcher, "validate_config", lambda *a: None)
    gateway = process_record(bundle, "gateway", pid=722)
    observed = observed_services({"gateway": gateway})
    monkeypatch.setattr(launcher, "snapshot", lambda *a, **kw: observed)
    def launch(bundle, state, name, command, env, port, **kwargs):
        assert command[0] == str(bundle.runtime["node" if name == "gateway" else "python"])
        assert env["EASEL_DATA_DIR"] == str(bundle.data)
        if name == "web":
            assert command == [str(bundle.runtime["python"]), "-B", "-s", str(bundle.app / "web/app.py")]
            raise RuntimeError("web-start-failed")
        state["services"][name] = gateway
    monkeypatch.setattr(launcher, "_launch_service", launch)
    stopped = []
    monkeypatch.setattr(launcher, "_stop_service", lambda bundle, record, observed: stopped.append(record) or True)
    with pytest.raises(RuntimeError, match="web-start-failed"):
        launcher.start(bundle, no_browser=True)
    assert stopped == [gateway]
    assert launcher._read_json(bundle.data / launcher.STATE_FILE)["services"] == {}


@pytest.mark.skipif(os.name != "nt", reason="Windows process identity integration")
def test_snapshot_timeout_has_actionable_message_without_powershell_command(bundle, monkeypatch):
    def timeout(command, **kwargs):
        assert kwargs["timeout"] == 30
        raise subprocess.TimeoutExpired(command, 30)
    monkeypatch.setattr(launcher.subprocess, "run", timeout)
    with pytest.raises(RuntimeError) as error:
        launcher.snapshot(bundle, ports=[37881, 7881])
    assert "进程状态超时" in str(error.value)
    assert "未停止任何程序" in str(error.value)
    assert "Get-CimInstance" not in str(error.value)


def test_native_windows_and_chromium_cache_paths_do_not_use_distribution(bundle):
    env = launcher.isolated_env(bundle, {"SystemRoot": r"C:\Windows"})
    assert env["SystemDrive"] == Path(r"C:\Windows").drive
    assert env["CHROME_LOG_FILE"] == str(bundle.data / "logs/chromium.log")


@pytest.mark.skipif(os.name != "nt", reason="Windows process identity integration")
def test_windows_snapshot_reads_real_child_identity_in_isolated_home(bundle):
    launcher.prepare_directories(bundle)
    process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"],
                               creationflags=launcher.FLAGS)
    try:
        observed = launcher.snapshot(bundle, pids=[process.pid])
        own = observed["processes"][process.pid]
        assert own["created"] and own["commandLine"]
        assert launcher._same_path(own["executable"], sys.executable)
        assert own["pid"] == process.pid
    finally:
        process.terminate()
        process.wait(timeout=5)
