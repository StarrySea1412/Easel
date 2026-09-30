"""Launch the installed workbench without taking another application's port."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser


def free_port(preferred: int) -> int:
    if not 1 <= preferred <= 65535:
        raise ValueError("Port must be between 1 and 65535")
    with socket.socket() as sock:
        try:
            sock.bind(("127.0.0.1", preferred))
        except OSError:
            sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def ready(url: str, expected: bytes) -> bool:
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(url, timeout=2) as response:
            if response.status != 200 or response.read(len(expected) + 1) != expected:
                return False
        with opener.open(url + "api/status", timeout=4) as response:
            data = json.load(response)
            return response.status == 200 and isinstance(data, dict) and "gateway" in data and "skills" in data
    except (OSError, ValueError):
        return False


@contextmanager
def startup_lock(data: Path):
    with (data / 'workbench-start.lock').open('a+b') as handle:
        if handle.tell() == 0:
            handle.write(b'0')
            handle.flush()
        handle.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise RuntimeError('另一个启动或迁移正在进行，请稍后重试。') from exc
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == 'nt':
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def listener_info(port: int) -> dict | None:
    if not 1 <= port <= 65535:
        return None
    command = ('[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; '
               f'$owner = (Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort {port} '
               '-State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; '
               'if ($owner) { $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $owner); '
               '@{pid=[int]$owner;parentId=[int]$p.ParentProcessId;commandLine=[string]$p.CommandLine} | ConvertTo-Json -Compress }')
    result = subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', command],
        capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=12,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode or not result.stdout.strip():
        return None
    value = json.loads(result.stdout)
    return value if isinstance(value, dict) else None


def owns_web(info: dict, root: Path, expected_pid: int) -> bool:
    # Windows venv's python.exe may be a redirector whose child owns the socket.
    command = str(info.get('commandLine', '')).replace('/', '\\').casefold()
    app = str(root / 'web/app.py').replace('/', '\\').casefold()
    return expected_pid > 0 and expected_pid in (info.get('pid'), info.get('parentId')) and bool(
        re.search(r'(?<!\S)"?' + re.escape(app) + r'"?(?=\s|$)', command))


def verified_instance(state: dict, root: Path, expected: bytes) -> dict | None:
    if not isinstance(state, dict) or state.get('root') != str(root):
        return None
    try:
        port, pid = int(state['port']), int(state['pid'])
        info = listener_info(port)
        if info and owns_web(info, root, pid) and ready(f'http://127.0.0.1:{port}/', expected):
            return dict(info, port=port)
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired):
        pass
    return None


def stop_verified_web(instance: dict) -> None:
    pid = int(instance['pid'])
    result = subprocess.run(['taskkill.exe', '/PID', str(pid), '/T', '/F'], stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, timeout=15, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode:
        raise RuntimeError('工作台进程未能关闭，尚未开始迁移，请稍后重试。')


def stop_owned_child(process) -> None:
    if process.poll() is not None:
        return
    if os.name == 'nt':
        subprocess.run(['taskkill.exe', '/PID', str(process.pid), '/T', '/F'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    else:
        process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def wait_for_web(process, url: str, expected: bytes, *, timeout: float = 60) -> bool:
    success = False
    try:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if ready(url, expected):
                success = True
                return True
            if process.poll() is not None:
                break
            time.sleep(0.5)
        return False
    finally:
        # Only the Web child this call created is cleaned up. A healthy/reused
        # Gateway belongs to the installation and remains available for retry.
        if not success:
            stop_owned_child(process)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    ap.add_argument("--data-dir", type=Path)
    ap.add_argument("--port", type=int, default=int(os.environ.get("EASEL_PORT", "7860")))
    ap.add_argument("--no-browser", action="store_true")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument('--restart', action='store_true')
    mode.add_argument('--reuse-only', action='store_true')
    args = ap.parse_args(argv)
    root = args.root.resolve()
    data = (args.data_dir or root / "data").resolve()
    data.mkdir(parents=True, exist_ok=True)
    with startup_lock(data):
        return launch(root, data, args)


def launch(root: Path, data: Path, args) -> int:
    env = os.environ.copy()
    env.update(EASEL_ROOT=str(root), EASEL_DATA_DIR=str(data), EASEL_HOST="127.0.0.1", PYTHONUTF8="1")
    runtime = data / "runtime-launch.json"
    settings = json.loads(runtime.read_text(encoding="utf-8-sig")) if runtime.is_file() else {}
    env["EASEL_OPENCLAW_STATE_DIR"] = str(settings.get("stateDir") or data / "openclaw")
    env["OPENCLAW_STATE_DIR"] = env["EASEL_OPENCLAW_STATE_DIR"]
    env["OPENCLAW_HOME"] = str(data / "openclaw-home")
    Path(env["OPENCLAW_HOME"]).mkdir(exist_ok=True)
    if settings.get("gatewayPort"):
        env["OPENCLAW_GATEWAY_PORT"] = str(settings["gatewayPort"])
    node_marker = root / ".tools/node-dir.txt"
    node_dir = node_marker.read_text(encoding="utf-8-sig").strip() if node_marker.is_file() else ""
    env["PATH"] = os.pathsep.join((str(root / ".tools/npm"), node_dir, env.get("PATH", "")))
    expected = (root / "web/frontend/dist/index.html").read_bytes()
    # Only reuse a listener owned by the saved child PID, then verify its app.
    state_file = data / "workbench.json"
    if state_file.exists():
        try:
            state = json.loads(state_file.read_text(encoding="utf-8"))
            if not isinstance(state, dict):
                raise ValueError('Invalid startup record')
        except (OSError, ValueError) as exc:
            raise RuntimeError('启动记录无法读取或已损坏，未停止任何服务，也未开始迁移。') from exc
        instance = verified_instance(state, root, expected)
        if instance:
            url = f"http://127.0.0.1:{instance['port']}/"
            if args.restart:
                stop_verified_web(instance)
                state_file.unlink(missing_ok=True)
            else:
                if not args.no_browser:
                    webbrowser.open(url)
                print(url)
                return 0
        elif args.restart:
            try:
                active = listener_info(int(state['port']))
            except (OSError, ValueError, KeyError, subprocess.TimeoutExpired) as exc:
                raise RuntimeError('无法核验已有工作台的归属，未停止任何服务，也未开始迁移。') from exc
            if active:
                raise RuntimeError('无法核验已有工作台的归属，未停止任何服务，也未开始迁移。')
    if args.reuse_only:
        raise RuntimeError('没有可复用的工作台。待迁移设置已保留；请重新启动并确认“重启并迁移”。')
    logs = data / "logs"
    logs.mkdir(exist_ok=True)
    with (logs / "launch.log").open("ab") as log:
        rc = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-File", str(root / "scripts/gateway.ps1"), "start"], cwd=root, env=env, stdout=log, stderr=log,
            timeout=330, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).returncode
        if rc:
            raise RuntimeError(f"Gateway startup failed; see {logs / 'launch.log'}")
        port = free_port(args.port)
        env["EASEL_PORT"] = str(port)
        python = root / ".venv/Scripts/python.exe"
        process = subprocess.Popen([str(python), str(root / "web/app.py")], cwd=root, env=env,
            stdin=subprocess.DEVNULL, stdout=log, stderr=log,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
    url = f"http://127.0.0.1:{port}/"
    if wait_for_web(process, url, expected, timeout=3000 if args.restart else 60):
        try:
            info = listener_info(port)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            stop_owned_child(process)
            raise
        if not info or not owns_web(info, root, process.pid):
            stop_owned_child(process)
            raise RuntimeError('工作台已响应，但无法核验新进程归属，未保存启动记录。')
        try:
            state_file.write_text(json.dumps({"root": str(root), "pid": info['pid'], "launcherPid": process.pid, "port": port}), encoding="utf-8")
        except OSError:
            stop_owned_child(process)
            raise
        if not args.no_browser:
            webbrowser.open(url)
        print(url)
        return 0
    raise RuntimeError(f"Workbench failed to start; see {logs / 'launch.log'}")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
