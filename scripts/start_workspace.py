"""Launch the installed workbench without taking another application's port."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
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


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    ap.add_argument("--data-dir", type=Path)
    ap.add_argument("--port", type=int, default=int(os.environ.get("EASEL_PORT", "7860")))
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args(argv)
    root = args.root.resolve()
    data = (args.data_dir or root / "data").resolve()
    data.mkdir(parents=True, exist_ok=True)
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
    try:
        state = json.loads(state_file.read_text(encoding="utf-8"))
        port, pid = int(state["port"]), int(state["pid"])
        if state["root"] != str(root):
            raise ValueError("Different release")
        result = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command",
            f"(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort {port} -State Listen -ErrorAction SilentlyContinue).OwningProcess"],
            capture_output=True, text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        url = f"http://127.0.0.1:{port}/"
        if str(pid) in result.stdout.split() and ready(url, expected):
            if not args.no_browser:
                webbrowser.open(url)
            print(url)
            return 0
    except (OSError, ValueError, KeyError):
        pass
    logs = data / "logs"
    logs.mkdir(exist_ok=True)
    with (logs / "launch.log").open("ab") as log:
        rc = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-File", str(root / "scripts/gateway.ps1"), "start"], cwd=root, env=env, stdout=log, stderr=log,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).returncode
        if rc:
            raise RuntimeError(f"Gateway startup failed; see {logs / 'launch.log'}")
        port = free_port(args.port)
        env["EASEL_PORT"] = str(port)
        python = root / ".venv/Scripts/python.exe"
        process = subprocess.Popen([str(python), str(root / "web/app.py")], cwd=root, env=env,
            stdin=subprocess.DEVNULL, stdout=log, stderr=log,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
    url = f"http://127.0.0.1:{port}/"
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if ready(url, expected):
            state_file.write_text(json.dumps({"root": str(root), "pid": process.pid, "port": port}), encoding="utf-8")
            if not args.no_browser:
                webbrowser.open(url)
            print(url)
            return 0
        if process.poll() is not None:
            break
        time.sleep(0.5)
    raise RuntimeError(f"Workbench failed to start; see {logs / 'launch.log'}")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError) as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
