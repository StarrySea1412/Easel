"""Windows installer phase executor. Uses only Python's standard library.

The EXE first invokes ``setup.ps1 -Phase system`` to obtain Python, then runs
this file with the new venv interpreter. Both entry points share the same eight
PowerShell phase implementations and the persistent install_core state.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from easel import install_core as ic


def redact(text: str, base: Path) -> str:
    """Scrub credentials before *any* output/state/log write, including failures."""
    values = dict(os.environ)
    try:
        for line in (base / ".env").read_text(encoding="utf-8-sig").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                values[key.strip()] = value.strip().strip("\"'")
    except OSError:
        pass
    for key, value in values.items():
        if value and re.search(r"key|token|secret|password|authorization", key, re.I):
            text = text.replace(value, "[REDACTED]")
    text = re.sub(r"(?i)(bearer\s+)[^\s\"']+", r"\1[REDACTED]", text)
    text = re.sub(r"(?i)([\"']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)[\"']?\s*[:=]\s*)[\"']?[^\s,}\"']+", r"\1[REDACTED]", text)
    return text


def phase_command(root: Path, base: Path, phase: str, *,
                  non_interactive: bool, allow_winget: bool) -> list[str]:
    if phase not in {p["id"] for p in ic.PHASES}:
        raise ValueError(f"未知安装阶段：{phase}")
    command = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
               "-File", str(root / "setup.ps1"), "-Phase", phase,
               "-DataDir", str(base)]
    if non_interactive:
        command.append("-NonInteractive")
    if allow_winget:
        command.append("-AllowWinget")
    return command


def execute_phase(root: Path, base: Path, phase: str, *,
                  non_interactive: bool, allow_winget: bool) -> tuple[bool, str]:
    env = dict(os.environ, EASEL_DATA_DIR=str(base), EASEL_ROOT=str(root), PYTHONUTF8="1")
    command = phase_command(root, base, phase, non_interactive=non_interactive,
                            allow_winget=allow_winget)
    # Preserve console Read-Host for the developer entry point only. No secrets
    # entered there pass through the installer log stream.
    interactive = phase == "profile" and not non_interactive
    try:
        # A successful phase may launch the long-lived Gateway. Its inherited
        # stdout must not keep communicate() waiting after PowerShell exits.
        # A temporary file lets wait() observe only the phase root; successful
        # phases deliberately leave their background services running.
        with tempfile.TemporaryFile(mode="w+b") as captured:
            process = subprocess.Popen(command, cwd=root, env=env,
                                       stdout=None if interactive else captured,
                                       stderr=None if interactive else subprocess.STDOUT,
                                       creationflags=(getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                                                      | (getattr(subprocess, "CREATE_NO_WINDOW", 0) if non_interactive else 0)),
                                       start_new_session=os.name != "nt")

            def output_text():
                if interactive:
                    return ""
                captured.seek(0)
                return redact(captured.read().decode("utf-8", errors="replace"), base)

            try:
                process.wait(timeout=3600)
                return process.returncode == 0, output_text() or f"{phase}: exit code {process.returncode}"
            except subprocess.TimeoutExpired:
                terminate_phase_tree(process)
                process.wait(timeout=10)
                return False, output_text() + "\nphase timeout after 3600 seconds"
            except KeyboardInterrupt:
                terminate_phase_tree(process)
                process.wait(timeout=10)
                raise
    except OSError as exc:
        return False, str(exc)


def terminate_phase_tree(process) -> None:
    """Stop only the process tree this installer spawned, before any retry."""
    if os.name == "nt":
        taskkill = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "taskkill.exe"
        try:
            result = subprocess.run([str(taskkill), "/PID", str(process.pid), "/T", "/F"],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15,
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if result.returncode and process.poll() is None:
                raise RuntimeError("安装子进程清理失败；请结束该安装进程后重试。")
        except (OSError, subprocess.TimeoutExpired) as exc:
            # Do not report a cleanup timeout as a transient *installation*
            # error: no automatic retry is safe while a child may still run.
            raise RuntimeError("安装子进程清理失败；请结束该安装进程后重试。") from exc
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if process.poll() is None:
        process.kill()


def installation_version(root: Path, version: str | None = None) -> str:
    manifest = root / "release-manifest.json"
    if manifest.is_file():
        release_version = str(json.loads(manifest.read_text(encoding="utf-8-sig"))["version"])
        if version is not None and version != release_version:
            raise ValueError("安装版本与 release-manifest.json 不一致")
        return release_version
    if version:
        return version
    project = (root / "pyproject.toml").read_text(encoding="utf-8")
    match = re.search(r'^version\s*=\s*"([^"]+)"', project, re.M)
    if not match:
        raise ValueError("无法确定源码版本")
    return "source-" + match.group(1)


@contextmanager
def installation_lock(base: Path):
    """OS lock releases on interruption; unlike a PID file it cannot go stale."""
    base.mkdir(parents=True, exist_ok=True)
    with (base / "install.lock").open("a+b") as handle:
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise RuntimeError("另一个 Easel 安装正在使用此数据目录。") from exc
        try:
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"0")
                handle.flush()
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def run_install(root: Path, base: Path, *, version: str | None = None,
                non_interactive: bool = True, allow_winget: bool = False,
                execute=None, sleep=time.sleep, emit=print) -> int:
    root, base = root.resolve(), base.resolve()
    version = installation_version(root, version)
    executor = execute or execute_phase
    with installation_lock(base):
        state = ic.bind_installation(ic.load_state(base), root, version)
        # Check before system recreates a removed venv; otherwise stale successes
        # would skip the packages and browsers installed inside that environment.
        interpreter = root / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        if not interpreter.is_file():
            for pid in ("pydeps", "chromium", "gateway"):
                state["phases"].pop(pid, None)
        if not (root / "web" / "frontend" / "dist" / "index.html").is_file():
            state["phases"].pop("frontend", None)
        log_path = base / "logs" / "install.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        state["logPath"] = str(log_path)
        ic.save_state(state, base)
        with log_path.open("a", encoding="utf-8") as log:
            def report(message):
                message = redact(message, base)
                log.write(message.rstrip() + "\n")
                log.flush()
                emit(message)

            report(f"Easel {version} | {root} | 日志：{log_path}")
            for phase in ic.PHASES:
                pid = phase["id"]
                # The two cheap environmental checks always re-run. The costly
                # dependency/build stages retain successful checkpoints.
                if not ic.should_run(state, pid) and pid not in ("system", "gateway"):
                    report(f"[{pid}] 已完成，跳过")
                    continue
                attempt = 0
                while True:
                    attempt += 1
                    ic.mark_running(state, pid, base=base)
                    report(f"[{pid}] {phase['title']}（本次第 {attempt} 次）")
                    try:
                        ok, detail = executor(root, base, pid, non_interactive=non_interactive,
                                              allow_winget=allow_winget)
                    except KeyboardInterrupt:
                        ic.mark_result(state, pid, False, "用户中断；重新运行可继续", base=base)
                        report(f"[{pid}] 已中断；保留安装状态")
                        return 130
                    except Exception as exc:  # Preserve recovery state for process launch errors.
                        ok, detail = False, str(exc)
                    detail = redact(detail, base)
                    report(detail)
                    result = ic.mark_result(state, pid, ok, detail[-3000:],
                                            auto_retry=phase["retriable"], base=base,
                                            run_attempt=attempt)
                    if ok:
                        report(f"[{pid}] 完成")
                        break
                    if result["status"] != "retry":
                        report(f"[{pid}] 安装失败；修复后重新运行安装器继续。日志：{log_path}")
                        return 1
                    delay = ic.retry_wait_seconds(attempt)
                    report(f"[{pid}] 瞬时故障，{delay} 秒后重试")
                    sleep(delay)
            report("安装环境和 Web 页面验证通过。模型服务可在 Web 设置中配置。")
            return 0


def verify_web(root: Path, base: Path, *, deadline_seconds: float = 30) -> None:
    """Start the installed app on loopback, verify its actual HTML, stop our PID."""
    index = root / "web" / "frontend" / "dist" / "index.html"
    expected = index.read_bytes()
    if not expected:
        raise RuntimeError("发行前端 index.html 为空")
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    env = dict(os.environ, EASEL_DATA_DIR=str(base), EASEL_ROOT=str(root), PYTHONUTF8="1")
    python = root / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    command = [str(python), "-m", "uvicorn", "web.app:app", "--host", "127.0.0.1",
               "--port", str(port), "--log-level", "warning"]
    with tempfile.TemporaryFile() as output:
        process = subprocess.Popen(command, cwd=root, env=env, stdout=output,
                                   stderr=subprocess.STDOUT,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        try:
            deadline = time.monotonic() + deadline_seconds
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    break
                try:
                    with opener.open(f"http://127.0.0.1:{port}/", timeout=2) as response:
                        if response.status == 200 and response.read(len(expected) + 1) == expected:
                            print("Web 启动和首页 HTTP 验证通过")
                            return
                except (OSError, urllib.error.URLError):
                    pass
                time.sleep(0.25)
            output.seek(0)
            detail = redact(output.read().decode("utf-8", errors="replace"), base)
            raise RuntimeError("Web 启动/首页验证失败：" + detail[-2000:])
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--data-dir", type=Path, default=ic.data_dir())
    parser.add_argument("--version")
    parser.add_argument("--non-interactive", action="store_true")
    parser.add_argument("--allow-winget", action="store_true")
    parser.add_argument("--verify-web", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.verify_web:
            verify_web(args.root.resolve(), args.data_dir.resolve())
            return 0
        return run_install(args.root, args.data_dir, version=args.version,
                           non_interactive=args.non_interactive, allow_winget=args.allow_winget)
    except (OSError, ValueError, RuntimeError) as exc:
        print(redact(str(exc), args.data_dir), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
