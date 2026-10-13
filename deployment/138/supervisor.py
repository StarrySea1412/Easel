"""Supervise Web/Gateway as child process groups; container restarts failed service."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT), str(ROOT / 'deployment/138')]
from bootstrap_gateway import bootstrap
from easel.openclaw_cmd import openclaw_base_cmd

children = []
stopping = False


def stop(_signal=None, _frame=None):
    global stopping
    stopping = True
    for child in reversed(children):
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass


def ready(url):
    try:
        with urllib.request.urlopen(url, timeout=2) as response:
            return response.status == 200
    except OSError:
        return False


def run():
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    bootstrap()
    children.append(subprocess.Popen(openclaw_base_cmd() + ['--profile', 'easel', 'gateway', 'run',
        '--port', '18789', '--bind', 'loopback'], cwd=ROOT, start_new_session=True))
    deadline = time.monotonic() + 80
    while not ready('http://127.0.0.1:18789/healthz'):
        if stopping or children[0].poll() is not None or time.monotonic() > deadline:
            raise RuntimeError('Gateway failed readiness; see container logs.')
        time.sleep(0.5)
    # New server identity only; the loopback Gateway decides local pairing.
    # Never copy a desktop identity or edit the paired-device store.
    from easel.gateway_auth import resolve_credentials
    from easel.gateway_questions import GatewayClient
    credentials = resolve_credentials()
    auth = {'password': credentials.password} if credentials.mode == 'password' else {'token': credentials.token}
    client = GatewayClient(timeout=10, scopes=['operator.admin'], client_id='cli', client_mode='cli', auth=auth)
    try:
        client.connect()
        if 'operator.admin' not in client.granted_scopes:
            raise RuntimeError('Server CLI device needs approval in its independent Gateway.')
    finally:
        client.close()
    children.append(subprocess.Popen([sys.executable, '-m', 'uvicorn', 'application:app', '--app-dir',
        str(ROOT / 'deployment/138'), '--host', '0.0.0.0', '--port', '7880', '--workers', '1',
        '--no-proxy-headers', '--log-level', 'warning'], cwd=ROOT, start_new_session=True))
    while not stopping:
        if any(child.poll() is not None for child in children):
            raise RuntimeError('Supervised process exited; container restart required.')
        time.sleep(0.5)


if __name__ == '__main__':
    code = 0
    try:
        run()
    except Exception as error:
        print(type(error).__name__ + ': ' + str(error), file=sys.stderr, flush=True)
        code = 1
    finally:
        stop()
        deadline = time.monotonic() + 30
        for child in reversed(children):
            try:
                child.wait(timeout=max(0.1, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait(timeout=3)
    raise SystemExit(code)
