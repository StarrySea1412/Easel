"""Offline installer execution tests; no tool installation or global config writes."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

import pytest

from easel import install_core as ic
from easel import install_runner as runner


ROOT = Path(__file__).resolve().parents[1]
POWERSHELL = shutil.which("powershell.exe")


@pytest.fixture
def installation(tmp_path):
    root = tmp_path / "version 1"
    root.mkdir()
    (root / "pyproject.toml").write_text('[project]\nversion = "1.0"\n', encoding="utf-8")
    (root / "setup.ps1").write_text("# test stub", encoding="utf-8")
    interpreter = root / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    interpreter.parent.mkdir(parents=True)
    interpreter.write_text("stub", encoding="utf-8")
    dist = root / "web" / "frontend" / "dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text("<html>ok</html>", encoding="utf-8")
    return root, tmp_path / "data"


def test_all_phases_executed_and_resume_skips_installs(installation):
    root, base = installation
    calls = []

    def execute(root, base, phase, **kwargs):
        calls.append((phase, kwargs))
        return True, "success"

    assert runner.run_install(root, base, execute=execute, emit=lambda _: None) == 0
    assert [p for p, _ in calls] == [p["id"] for p in ic.PHASES]
    assert all(not kw["allow_winget"] and kw["non_interactive"] for _, kw in calls)
    assert ic.overall(ic.load_state(base))["status"] == "done"
    calls.clear()
    assert runner.run_install(root, base, execute=execute, emit=lambda _: None) == 0
    assert [p for p, _ in calls] == ["system", "gateway"]


def test_deferred_browser_is_installed_on_next_full_run(installation):
    root, base = installation
    calls, deferred_output, full_output = [], [], []
    gateway_deferrals = []

    def execute(r, b, phase, **kwargs):
        calls.append(phase)
        if phase == "gateway":
            gateway_deferrals.append(bool(kwargs.get("defer_browser")))
        return True, "success"

    assert runner.run_install(root, base, defer_browser=True, execute=execute,
                              emit=deferred_output.append) == 0
    assert calls == [phase["id"] for phase in ic.PHASES if phase["id"] != "chromium"]
    browser = ic.load_state(base)["phases"]["chromium"]
    assert browser["status"] == "skipped"
    assert browser.get("deferred") is True
    assert "平台浏览器未安装" in browser["detail"]
    assert gateway_deferrals == [True]
    assert "基础" in deferred_output[-1]

    calls.clear()
    assert runner.run_install(root, base, execute=execute, emit=full_output.append) == 0
    assert calls == ["system", "chromium", "gateway"]
    browser = ic.load_state(base)["phases"]["chromium"]
    assert browser["status"] == "ok"
    assert not browser.get("deferred")
    assert gateway_deferrals == [True, False]
    assert full_output[-1] != deferred_output[-1]
    assert "完整" in full_output[-1]


def test_failed_browser_can_be_explicitly_deferred_without_repeating_dependencies(installation):
    root, base = installation
    calls = []

    def execute(r, b, phase, **kwargs):
        calls.append(phase)
        return (False, "Access denied") if phase == "chromium" else (True, "success")

    assert runner.run_install(root, base, execute=execute, emit=lambda _: None) == 1
    assert ic.load_state(base)["phases"]["chromium"]["status"] == "failed"
    calls.clear()

    assert runner.run_install(root, base, defer_browser=True, execute=execute,
                              emit=lambda _: None) == 0
    assert calls == ["system", "profile", "skills", "gateway"]
    phases = ic.load_state(base)["phases"]
    assert phases["chromium"]["status"] == "skipped"
    assert phases["chromium"].get("deferred") is True
    assert all(phases[phase["id"]]["status"] == "ok"
               for phase in ic.PHASES if phase["id"] != "chromium")


def test_deferring_browser_does_not_downgrade_an_installed_browser(installation):
    root, base = installation
    calls, output = [], []
    gateway_deferrals = []

    def execute(r, b, phase, **kwargs):
        calls.append(phase)
        if phase == "gateway":
            gateway_deferrals.append(bool(kwargs.get("defer_browser")))
        return True, "success"

    assert runner.run_install(root, base, execute=execute, emit=lambda _: None) == 0
    calls.clear()
    assert runner.run_install(root, base, defer_browser=True, execute=execute,
                              emit=output.append) == 0
    assert calls == ["system", "gateway"]
    browser = ic.load_state(base)["phases"]["chromium"]
    assert browser["status"] == "ok"
    assert not browser.get("deferred")
    assert gateway_deferrals == [False, False]
    assert "完整" in output[-1]


@pytest.mark.parametrize("failed_phase", ["pydeps", "gateway"])
def test_deferring_browser_does_not_hide_other_phase_failures(installation, failed_phase):
    root, base = installation
    calls, output = [], []

    def execute(r, b, phase, **kwargs):
        calls.append(phase)
        return (False, "Access denied") if phase == failed_phase else (True, "success")

    assert runner.run_install(root, base, defer_browser=True, execute=execute,
                              emit=output.append) == 1
    expected = [phase["id"] for phase in ic.PHASES if phase["id"] != "chromium"]
    assert calls == expected[:expected.index(failed_phase) + 1]
    state = ic.load_state(base)
    assert state["phases"][failed_phase]["status"] == "failed"
    assert ic.overall(state)["status"] == "failed"
    assert failed_phase in output[-1] and "失败" in output[-1]


def test_new_version_reexecutes_all_stages(installation):
    root, base = installation
    seen = []
    execute = lambda r, b, p, **kw: (seen.append(p) is None, "ok")
    runner.run_install(root, base, version="1", execute=execute, emit=lambda _: None)
    seen.clear()
    runner.run_install(root, base, version="2", execute=execute, emit=lambda _: None)
    assert seen == [p["id"] for p in ic.PHASES]


def test_missing_venv_invalidates_dependencies(installation):
    root, base = installation
    seen = []
    execute = lambda r, b, p, **kw: (seen.append(p) is None, "ok")
    runner.run_install(root, base, execute=execute, emit=lambda _: None)
    interpreter = root / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    interpreter.unlink()
    seen.clear()
    runner.run_install(root, base, execute=execute, emit=lambda _: None)
    assert seen == ["system", "pydeps", "chromium", "gateway"]


def test_transient_budget_then_manual_resume(installation):
    root, base = installation
    calls, waits = [], []

    def failure(r, b, phase, **kw):
        calls.append(phase)
        return (False, "ETIMEDOUT") if phase == "pydeps" else (True, "ok")

    assert runner.run_install(root, base, execute=failure, sleep=waits.append, emit=lambda _: None) == 1
    assert waits == [10, 30]
    assert calls == ["system", "openclaw", "pydeps", "pydeps", "pydeps"]
    assert ic.load_state(base)["phases"]["pydeps"]["status"] == "failed"
    calls.clear()

    def recovered(r, b, phase, **kw):
        calls.append(phase)
        return True, "ok"

    assert runner.run_install(root, base, execute=recovered, emit=lambda _: None) == 0
    assert "openclaw" not in calls
    assert "frontend" in calls


def test_permanent_error_stops_and_secrets_never_persist(installation, monkeypatch):
    root, base = installation
    base.mkdir()
    (base / ".env").write_text("OPENAI_API_KEY=topsecret\n", encoding="utf-8")
    output = []

    def failure(r, b, phase, **kw):
        return False, "Access denied timeout OPENAI_API_KEY=topsecret Authorization: Bearer hidden"

    assert runner.run_install(root, base, execute=failure, emit=output.append) == 1
    log = (base / "logs" / "install.log").read_text(encoding="utf-8")
    state = (base / "install-state.json").read_text(encoding="utf-8")
    assert "topsecret" not in log + state + "".join(output)
    assert "hidden" not in log + state + "".join(output)
    assert ic.load_state(base)["phases"]["system"]["attempts"] == 1


def test_interruption_keeps_recoverable_state(installation):
    root, base = installation

    def interrupted(*a, **kw):
        raise KeyboardInterrupt

    assert runner.run_install(root, base, execute=interrupted, emit=lambda _: None) == 130
    assert ic.load_state(base)["phases"]["system"]["status"] == "failed"


def test_manifest_version_must_match(installation):
    root, _ = installation
    (root / "release-manifest.json").write_text(json.dumps({"version": "1.1"}), encoding="utf-8")
    assert runner.installation_version(root) == "1.1"
    with pytest.raises(ValueError, match="不一致"):
        runner.installation_version(root, "1.2")


def test_command_arguments_have_no_shell_interpolation(installation):
    root, base = installation
    command = runner.phase_command(root, base, "profile", non_interactive=True, allow_winget=False)
    assert command[command.index("-File") + 1] == str(root / "setup.ps1")
    assert "-NonInteractive" in command
    assert "-AllowWinget" not in command


def test_phase_timeout_cleans_owned_tree_before_returning(installation, monkeypatch):
    root, base = installation
    events = []

    class Child:
        returncode = 1

        def wait(self, timeout):
            events.append(("wait", timeout))
            if timeout == 3600:
                raise subprocess.TimeoutExpired("test", timeout)
            return 1

    child = Child()
    def launch(*args, **kwargs):
        assert kwargs['stdout'] is not subprocess.PIPE
        kwargs['stdout'].write(b'last child output')
        return child
    monkeypatch.setattr(runner.subprocess, "Popen", launch)
    monkeypatch.setattr(runner, "terminate_phase_tree", lambda process: events.append(("cleanup", process)))
    ok, detail = runner.execute_phase(root, base, "pydeps", non_interactive=True, allow_winget=False)
    assert not ok and "timeout" in detail and "last child output" in detail
    assert events == [("wait", 3600), ("cleanup", child), ("wait", 10)]


def test_successful_phase_returns_while_background_child_keeps_stdout(installation, monkeypatch, tmp_path):
    root, base = installation
    # Launch a real descendant inheriting stdout, like Start-Process Gateway.
    # It waits for the test's explicit release file rather than sleeping for a
    # guessed duration; the parent phase has already exited successfully.
    release = tmp_path / 'release-child'
    alive = tmp_path / 'child-alive'
    finished = tmp_path / 'child-finished'
    child = tmp_path / 'background.py'
    child.write_text('import pathlib,sys,time\na,r,f=map(pathlib.Path,sys.argv[1:])\na.write_text("alive")\nlimit=time.monotonic()+12\nwhile not r.exists() and time.monotonic()<limit: time.sleep(.05)\nf.write_text("finished")\n', encoding='utf-8')
    parent = tmp_path / 'phase.py'
    parent.write_text('import subprocess,sys\nsubprocess.Popen(sys.argv[1:])\nprint("phase complete API_KEY=test-sensitive-value",flush=True)\n', encoding='utf-8')
    monkeypatch.setattr(runner, 'phase_command', lambda *args, **kwargs: [sys.executable, str(parent), sys.executable, str(child), str(alive), str(release), str(finished)])
    monkeypatch.setattr(runner, 'terminate_phase_tree', lambda p: pytest.fail('successful phase must not kill Gateway'))
    started = time.monotonic()
    try:
        ok, detail = runner.execute_phase(root, base, 'baseline', non_interactive=True, allow_winget=False)
        assert ok and 'phase complete' in detail
        assert 'test-sensitive-value' not in detail and '[REDACTED]' in detail
        assert time.monotonic() - started < 5
        deadline = time.monotonic() + 2
        while not alive.exists() and time.monotonic() < deadline:
            time.sleep(.02)
        assert alive.exists() and not finished.exists()
    finally:
        release.touch()
        deadline = time.monotonic() + 3
        while not finished.exists() and time.monotonic() < deadline:
            time.sleep(.05)


def test_phase_interrupt_cleans_tree_and_preserves_interrupt(installation, monkeypatch):
    root, base = installation
    events = []
    class Child:
        def wait(self, timeout):
            events.append(timeout)
            if timeout == 3600:
                raise KeyboardInterrupt()
            return 1
    child = Child()
    monkeypatch.setattr(runner.subprocess, 'Popen', lambda *args, **kwargs: child)
    monkeypatch.setattr(runner, 'terminate_phase_tree', lambda process: events.append('cleanup'))
    with pytest.raises(KeyboardInterrupt):
        runner.execute_phase(root, base, 'pydeps', non_interactive=True, allow_winget=False)
    assert events == [3600, 'cleanup', 10]


def test_parallel_installation_cannot_take_lock(installation):
    _, base = installation
    with runner.installation_lock(base):
        with pytest.raises(RuntimeError, match="另一个"):
            with runner.installation_lock(base):
                pass


def _ps_literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def _ps_functions(body):
    """Load only function ASTs, never execute setup's real entry point."""
    preamble = "$tokens=$null; $errors=$null\n"
    preamble += f"$ast=[System.Management.Automation.Language.Parser]::ParseFile({_ps_literal(ROOT / 'setup.ps1')}, [ref]$tokens, [ref]$errors)\n"
    preamble += "if ($errors.Count) { throw ($errors | Out-String) }\n"
    preamble += "$ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false) | ForEach-Object { Invoke-Expression $_.Extent.Text }\n"
    return subprocess.run([POWERSHELL, "-NoProfile", "-NonInteractive", "-Command", preamble + body],
                          capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20)


@pytest.mark.skipif(not POWERSHELL, reason="Windows PowerShell required")
def test_setup_phase_syntax_and_default_winget_gate():
    result = _ps_functions("$AllowWinget=$false\ntry { Ensure-Command 'easel-nonexistent-command-for-test' 'never.install' 'manual' } catch { exit 7 }\nexit 0")
    assert result.returncode == 7, result.stdout + result.stderr


@pytest.mark.skipif(not POWERSHELL, reason="Windows PowerShell required")
def test_release_frontend_uses_dist_without_npm(installation):
    root, base = installation
    dist = root / "web" / "frontend" / "dist"
    dist.mkdir(parents=True, exist_ok=True)
    (dist / "index.html").write_text("<html>ok</html>", encoding="utf-8")
    result = _ps_functions(f"$Root={_ps_literal(root)}\n$Manifest=@{{version='1'}}\nfunction npm {{ throw 'npm must not execute' }}\nInvoke-frontend")
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.skipif(not POWERSHELL, reason="Windows PowerShell required")
def test_existing_profile_is_validated_without_overwriting(installation, tmp_path):
    root, base = installation
    base.mkdir()
    (base / ".env").write_text("OPENAI_API_KEY=fake\n", encoding="utf-8")
    profile = tmp_path / "openclaw-profile"
    profile.mkdir()
    config = profile / "openclaw.json"
    original = '{"models":{"custom":"untouched"}}'
    config.write_text(original, encoding="utf-8")
    result = _ps_functions(f"$Root={_ps_literal(root)}\n$DataDir={_ps_literal(base)}\n$env:EASEL_OPENCLAW_STATE_DIR={_ps_literal(profile)}\n"
                           "function openclaw { if (($args -join ' ') -ne '--profile easel config validate') { throw 'unexpected config mutation' }; $global:LASTEXITCODE=0 }\nInvoke-profile")
    assert result.returncode == 0, result.stdout + result.stderr
    assert config.read_text(encoding="utf-8") == original


@pytest.mark.skipif(not POWERSHELL, reason="Windows PowerShell required")
def test_profile_failure_keeps_pending_config_then_resume_commits(installation, tmp_path):
    root, base = installation
    base.mkdir()
    (base / ".env").write_text("# models configured later\n", encoding="utf-8")
    profile = tmp_path / "openclaw-profile"
    pending = profile / "openclaw.easel-install-pending.json"
    final = profile / "openclaw.json"
    body = f"$Root={_ps_literal(root)}\n$DataDir={_ps_literal(base)}\n$env:EASEL_OPENCLAW_STATE_DIR={_ps_literal(profile)}\n$NonInteractive=$true\n"
    body += r'''
function openclaw {
    $global:LASTEXITCODE=0
    if ($args -contains 'onboard' -and $args -notcontains '--help') {
        [System.IO.File]::WriteAllText($env:OPENCLAW_CONFIG_PATH, '{"new":true}')
    }
    if ($args -contains 'validate' -and $global:breakValidation) { $global:LASTEXITCODE=1 }
}
$global:breakValidation=$true
try { Invoke-profile } catch { }
'''
    body += f"if (Test-Path -LiteralPath {_ps_literal(final)}) {{ throw 'partial config published' }}\n"
    body += f"if (-not (Test-Path -LiteralPath {_ps_literal(pending)})) {{ throw 'pending config missing' }}\n"
    body += "$global:breakValidation=$false\nInvoke-profile\n"
    result = _ps_functions(body)
    assert result.returncode == 0, result.stdout + result.stderr
    assert final.is_file() and not pending.exists()


def test_web_verifier_checks_html_and_stops_only_its_process(installation, monkeypatch):
    root, base = installation
    expected = (root / "web" / "frontend" / "dist" / "index.html").read_bytes()

    class Child:
        stopped = False

        def poll(self):
            return None

        def terminate(self):
            self.stopped = True

        def wait(self, **kwargs):
            return 0

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def read(self, count):
            return expected

    class Opener:
        def open(self, url, **kwargs):
            assert url.startswith("http://127.0.0.1:")
            return Response()

    child = Child()
    command = []

    def launch(argv, **kwargs):
        command.extend(argv)
        assert kwargs["env"]["EASEL_DATA_DIR"] == str(base)
        return child

    monkeypatch.setattr(runner.subprocess, "Popen", launch)
    monkeypatch.setattr(runner.urllib.request, "build_opener", lambda *a: Opener())
    runner.verify_web(root, base)
    assert "web.app:app" in command and "127.0.0.1" in command
    assert child.stopped


@pytest.mark.skipif(not POWERSHELL, reason="Windows PowerShell required")
def test_no_python_bootstrap_failure_still_writes_state_and_log(installation):
    root, base = installation
    shutil.copyfile(ROOT / "setup.ps1", root / "setup.ps1")
    # Empty PATH guarantees the first Git check fails before any system install.
    env = dict(os.environ, PATH="", EASEL_DATA_DIR=str(base))
    result = subprocess.run([POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                             "-File", str(root / "setup.ps1"), "-NonInteractive"], env=env,
                            capture_output=True, timeout=20)
    assert result.returncode == 1
    state = ic.load_state(base)
    assert state["phases"]["system"]["status"] == "failed"
    assert state["installation"]["version"] == "source-1.0"
    assert (base / "logs" / "install.log").is_file()


@pytest.mark.skipif(not POWERSHELL, reason="Windows junctions required")
@pytest.mark.parametrize("migration_allowed,fail_relink", [(True, False), (False, False), (True, True)])
def test_workspace_migration_retargets_only_explicit_old_junction(tmp_path, migration_allowed, fail_relink):
    old = tmp_path / "old repo"
    data = tmp_path / "data"
    workspace = tmp_path / "workspace"
    for directory in (old / "outputs", data / "outputs", workspace):
        directory.mkdir(parents=True)
    (old / "outputs" / "existing.txt").write_text("original data", encoding="utf-8")
    (data / "outputs" / "existing.txt").write_text("copied data", encoding="utf-8")
    link = workspace / "outputs"
    body = f"New-Item -ItemType Junction -Path {_ps_literal(link)} -Target {_ps_literal(old / 'outputs')} | Out-Null\n"
    body += f"$env:EASEL_INSTALL_MIGRATE_FROM={_ps_literal(old if migration_allowed else tmp_path / 'unknown')}\n"
    if fail_relink:
        body += f"$script:refusedTarget={_ps_literal(data / 'outputs')}\n"
        body += "function New-Item { param($ItemType,$Path,$Target,$ErrorAction) if ($Target -eq $script:refusedTarget) { throw 'simulated link failure' }; Microsoft.PowerShell.Management\\New-Item -ItemType $ItemType -Path $Path -Target $Target }\n"
    body += f"try {{ Ensure-WorkspaceLink {_ps_literal(link)} {_ps_literal(data / 'outputs')} 'outputs' {_ps_literal(workspace)} }} catch {{ exit 7 }}\n"
    result = _ps_functions(body)
    assert result.returncode == (0 if migration_allowed and not fail_relink else 7), result.stdout + result.stderr
    assert link.resolve() == (data / "outputs" if migration_allowed and not fail_relink else old / "outputs").resolve()
    assert (old / "outputs" / "existing.txt").read_text(encoding="utf-8") == "original data"
    assert (data / "outputs" / "existing.txt").read_text(encoding="utf-8") == "copied data"


@pytest.mark.skipif(not POWERSHELL, reason="Windows PowerShell required")
def test_gateway_restarts_when_installation_changes_and_reuses_same_version(installation):
    root, base = installation
    base.mkdir()
    actions = base / "actions.txt"
    body = f"$Root={_ps_literal(root)}\n$DataDir={_ps_literal(base)}\n$Manifest=@{{version='1'}}\n$Python='Test-Python'\n$script:actionsFile={_ps_literal(actions)}\n"
    body += "function openclaw { $global:LASTEXITCODE=0 }\nfunction Test-Python { $global:LASTEXITCODE=0 }\n"
    body += "function powershell { $args[-1] | Add-Content -LiteralPath $script:actionsFile; $global:LASTEXITCODE=0 }\n"
    body += "Invoke-gateway\nInvoke-gateway\n$Manifest.version='2'\nInvoke-gateway\n"
    result = _ps_functions(body)
    assert result.returncode == 0, result.stdout + result.stderr
    assert actions.read_text().splitlines() == ["restart", "start", "restart"]


@pytest.mark.skipif(not POWERSHELL, reason="Windows PowerShell required")
def test_chat_slot_models_and_relay_provider_are_separate(tmp_path):
    import sys
    result_file = tmp_path / "provider.json"
    body = f"$Python={_ps_literal(sys.executable)}\n$script:resultFile={_ps_literal(result_file)}\n"
    body += "$values=@{ANTHROPIC_MODEL='official-model'; EASEL_LLM_MODEL='relay-model'; CLAUDE_MODEL='openai/legacy'}\n"
    body += "if ((Resolve-SetupModel $values 'ANTHROPIC_MODEL' 'anthropic') -ne 'official-model') { exit 3 }\n"
    body += "if ((Resolve-SetupModel $values 'EASEL_LLM_MODEL' 'relay') -ne 'relay-model') { exit 4 }\n"
    body += "if ((Resolve-SetupModel @{CLAUDE_MODEL='anthropic/legacy'} 'EASEL_LLM_MODEL' 'anthropic') -ne 'legacy') { exit 5 }\n"
    body += "function OpenClaw-ConfigBatch($Operations) { ConvertTo-Json -InputObject @($Operations) -Depth 20 | Set-Content -LiteralPath $script:resultFile -Encoding UTF8 }\n"
    body += "Write-AnthropicProvider 'https://relay.example.com' 'fixture-secret' 'api-key' '2023-06-01' 'relay' 'relay-model'\n"
    result = _ps_functions(body)
    assert result.returncode == 0, result.stdout + result.stderr
    operations = json.loads(result_file.read_text(encoding="utf-8-sig"))
    assert operations[0]["path"] == "models.providers.relay"
    assert operations[0]["value"]["api"] == "anthropic-messages"
    assert operations[0]["value"]["models"][0]["id"] == "relay-model"
