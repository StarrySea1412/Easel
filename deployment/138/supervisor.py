"""Restart web observers independently; retain the single execution owner."""
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
    # A full container stop explicitly closes the durable owner. Ordinary web
    # crashes never reach this path and therefore do not interrupt its runs.
    from easel.runtime_host import RuntimeManager, RuntimeUnavailable
    manager = RuntimeManager()
    try:
        state = manager.read()
        if state and state.get('port'):
            manager.control(state, 'shutdown')
    except RuntimeUnavailable:
        pass  # Do not substitute an unverified PID kill for the private handshake.
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


def start_web():
    return subprocess.Popen([sys.executable, '-m', 'uvicorn', 'application:app', '--app-dir',
        str(ROOT / 'deployment/138'), '--host', '0.0.0.0', '--port', '7880', '--workers', '1',
        '--no-proxy-headers', '--log-level', 'warning'], cwd=ROOT, start_new_session=True,
        env={**os.environ, 'EASEL_DURABLE_RUNTIME': '1', 'EASEL_PORT': '7880'})


def supervise_web():
    failures = []
    while not stopping:
        if children[0].poll() is not None:
            raise RuntimeError('Gateway exited; container restart required.')
        if children[1].poll() is not None:
            now = time.monotonic()
            failures = [at for at in failures if now - at < 60]
            if len(failures) >= 3:
                raise RuntimeError('Web repeatedly failed; inspect runtime identity/configuration before retrying.')
            failures.append(now)
            children[1] = start_web()
        time.sleep(.5)


def check_children():
    for name, child in zip(('Gateway', 'Web'), children):
        code = child.poll()
        if code is not None:
            # Never log command arguments: they can contain credentials.
            raise RuntimeError(f'Supervised {name} process pid={child.pid} exited with code={code}; '
                               'container restart required. Check kernel OOM logs for code=-9.')


def gateway_startup_timeout():
    value = int(os.environ.get('EASEL_GATEWAY_STARTUP_TIMEOUT', '300'))
    if not 30 <= value <= 900:
        raise ValueError('EASEL_GATEWAY_STARTUP_TIMEOUT must be between 30 and 900 seconds.')
    return value


def wait_gateway_ready(deadline):
    while not ready('http://127.0.0.1:18789/healthz'):
        check_children()
        if stopping or time.monotonic() >= deadline:
            raise RuntimeError('Gateway failed readiness before startup deadline; see container logs.')
        time.sleep(0.5)


def run():
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    startup_timeout = gateway_startup_timeout()
    bootstrap()
    children.append(subprocess.Popen(openclaw_base_cmd() + ['--profile', 'easel', 'gateway', 'run',
        '--port', '18789', '--bind', 'loopback'], cwd=ROOT, start_new_session=True))
    deadline = time.monotonic() + startup_timeout
    wait_gateway_ready(deadline)
    # New server identity only; the loopback Gateway decides local pairing.
    # Never copy a desktop identity or edit the paired-device store.
    from easel.gateway_auth import resolve_credentials
    from easel.gateway_questions import GatewayClient
    credentials = resolve_credentials()
    auth = {'password': credentials.password} if credentials.mode == 'password' else {'token': credentials.token}
    # HTTP liveness precedes completion of native startup sidecars. Retry only
    # that explicit transient response, never pairing/authentication failures.
    while True:
        client = GatewayClient(timeout=10, scopes=['operator.admin'], client_id='cli', client_mode='cli', auth=auth)
        try:
            client.connect()
            if 'operator.admin' not in client.granted_scopes:
                raise RuntimeError('Server CLI device needs approval in its independent Gateway.')
            break
        except Exception as error:
            if ('startup-sidecars' not in str(error) or stopping
                    or children[0].poll() is not None or time.monotonic() >= deadline):
                raise
            time.sleep(0.5)
        finally:
            client.close()
    children.append(start_web())
    supervise_web()


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
