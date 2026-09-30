"""Daily GUI launcher: hidden process protocol, safe URLs and Unicode WSH entry."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import bootstrapper
import desktop_launcher as desktop


def runtime_files(tmp_path):
    root = tmp_path / "程序 空间 & Easel"
    (root / ".venv/Scripts").mkdir(parents=True)
    (root / ".venv/Scripts/python.exe").touch()
    (root / "scripts").mkdir()
    (root / "scripts/start_workspace.py").touch()
    return root, tmp_path / "用户 数据"


def test_hidden_startup_preserves_unicode_paths_and_returns_only_verified_local_url(tmp_path):
    root, data = runtime_files(tmp_path)
    seen = {}

    def run(argv, **kwargs):
        seen.update(argv=argv, **kwargs)
        return SimpleNamespace(returncode=0, stdout="http://127.0.0.1:48613/\n", stderr="")

    assert desktop.start_workbench(root, data, run=run) == "http://127.0.0.1:48613/"
    assert seen["argv"] == [str(root / ".venv/Scripts/python.exe"), str(root / "scripts/start_workspace.py"),
                            "--root", str(root), "--data-dir", str(data), "--no-browser"]
    assert seen["stdin"] == subprocess.DEVNULL
    assert seen["creationflags"] == getattr(subprocess, "CREATE_NO_WINDOW", 0)
    assert seen["timeout"] >= 360
    assert "shell" not in seen


@pytest.mark.parametrize("output", ["", "https://example.com/", "http://127.0.0.1:0/", "http://127.0.0.1:65536/",
                                    "http://localhost:7860/", "http://127.0.0.1:7860/\nnot ready"])
def test_unexpected_or_remote_output_never_opens_browser(tmp_path, output):
    root, data = runtime_files(tmp_path)
    with pytest.raises(RuntimeError, match="本地工作台地址"):
        desktop.start_workbench(root, data, run=lambda *a, **k: SimpleNamespace(returncode=0, stdout=output, stderr=""))


def test_failed_startup_redacts_credentials_for_retry_panel(tmp_path, monkeypatch):
    root, data = runtime_files(tmp_path)
    monkeypatch.setenv("EASEL_TEST_SECRET", "synthetic-sensitive-value")
    with pytest.raises(RuntimeError) as failure:
        desktop.start_workbench(root, data, run=lambda *a, **k: SimpleNamespace(
            returncode=1, stdout="", stderr="provider failed: synthetic-sensitive-value"))
    assert "synthetic-sensitive-value" not in str(failure.value)
    assert "[REDACTED]" in str(failure.value)


def test_missing_runtime_has_repair_message(tmp_path):
    with pytest.raises(RuntimeError, match="重新运行 Easel 安装器"):
        desktop.start_workbench(tmp_path, tmp_path / "data")


@pytest.mark.parametrize('confirmed,mode,flag', [(True, 'restart', '--restart'), (False, 'reuse', '--reuse-only')])
def test_pending_migration_requires_choice_and_cancel_never_starts_new_web(tmp_path, confirmed, mode, flag):
    root, data = runtime_files(tmp_path)
    data.mkdir()
    (data / '.storage-location.json').write_text(json.dumps({'pendingPath': 'D:/新的 内容'}), encoding='utf-8')
    prompts = []
    assert desktop.choose_start_mode(data, lambda prompt: prompts.append(prompt) or confirmed) == mode
    assert '结束正在进行' in prompts[0] and 'D:/新的 内容' in prompts[0]
    commands = []
    desktop.start_workbench(root, data, restart=confirmed, reuse_only=not confirmed,
        run=lambda command, **kwargs: commands.append(command) or SimpleNamespace(
            returncode=0, stdout='http://127.0.0.1:7863/', stderr=''))
    assert flag in commands[0]


def test_no_pending_storage_does_not_prompt(tmp_path):
    assert desktop.choose_start_mode(tmp_path, lambda *_: pytest.fail('unexpected migration prompt')) == 'normal'


@pytest.mark.skipif(os.name != "nt", reason="Real Windows Script Host/pythonw contract")
def test_vbs_launches_pythonw_with_unicode_and_space_paths_without_console(tmp_path, monkeypatch):
    install = tmp_path / "安装 空间 & 资料"
    root, data = install / "versions/0.2.3", install / "用户 数据"
    root.mkdir(parents=True)
    (root / "scripts").mkdir()
    data.mkdir()
    subprocess.run([sys.executable, "-m", "venv", "--without-pip", str(root / ".venv")], check=True,
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    captured = install / "captured.json"
    (root / "scripts/desktop_launcher.py").write_text(
        "import ctypes,json,sys\nfrom pathlib import Path\n"
        f"Path({str(captured)!r}).write_text(json.dumps({{'args':sys.argv[1:],'console':ctypes.windll.kernel32.GetConsoleWindow()}}),encoding='utf-8')\n",
        encoding="utf-8")
    monkeypatch.setattr(bootstrapper, "USER_DIR", install)
    entry = bootstrapper.write_gui_launcher(root, data)
    assert entry.name == "打开 Easel.vbs"
    assert entry.read_bytes().startswith(b"\xff\xfe")
    result = subprocess.run(["cscript.exe", "//B", "//NoLogo", str(entry)], capture_output=True, timeout=20,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    assert result.returncode == 0, result.stderr
    deadline = time.monotonic() + 15
    while not captured.is_file() and time.monotonic() < deadline:
        time.sleep(0.1)
    record = json.loads(captured.read_text(encoding="utf-8"))
    assert record["args"] == ["--root", str(root), "--data-dir", str(data)]
    assert record["console"] == 0
