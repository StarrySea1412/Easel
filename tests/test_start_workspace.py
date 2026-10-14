"""Launcher port ownership and response identity contracts."""
from pathlib import Path
import socket
import subprocess
import sys
import threading
import json
from types import SimpleNamespace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from start_workspace import free_port, ready
import start_workspace as launcher


def test_occupied_port_uses_other_available_port_without_stopping_owner():
    with socket.socket() as existing:
        existing.bind(("127.0.0.1", 0))
        existing.listen()
        port = existing.getsockname()[1]
        picked = free_port(port)
        assert picked != port
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            pass


@pytest.mark.parametrize("port", [0, -1, 65536])
def test_invalid_port_is_rejected(port):
    with pytest.raises(ValueError):
        free_port(port)


def test_ready_requires_matching_page_and_status_shape():
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"gateway":{},"skills":[]}' if self.path == '/api/status' else b'Easel build')

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        url = f"http://127.0.0.1:{server.server_port}/"
        assert ready(url, b'Easel build')
        assert not ready(url, b'Other build')
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_startup_lock_rejects_parallel_retry_and_releases(tmp_path):
    with launcher.startup_lock(tmp_path):
        with pytest.raises(RuntimeError, match='另一个启动'):
            with launcher.startup_lock(tmp_path):
                pytest.fail('second launcher acquired the same lock')
    with launcher.startup_lock(tmp_path):
        pass


def test_failed_web_child_is_reaped_without_touching_other_processes(monkeypatch):
    process = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
    try:
        assert not launcher.wait_for_web(process, 'http://127.0.0.1:1/', b'expected', timeout=0)
        assert process.poll() is not None
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()


@pytest.mark.parametrize('state_pid,actual_pid,parent,command,html_ok,owned', [
    (21, 21, 10, 'app', True, True),
    (21, 22, 21, 'app', True, True),  # Windows venv redirector
    (21, 22, 20, 'app', True, False),
    (21, 21, 10, 'other', True, False),
    (21, 21, 10, 'app', False, False),
])
def test_restart_requires_saved_pid_listener_command_and_page(tmp_path, monkeypatch,
        state_pid, actual_pid, parent, command, html_ok, owned):
    info = {'pid': actual_pid, 'parentId': parent,
            'commandLine': f'python "{tmp_path / "web/app.py"}"' if command == 'app' else 'python other.py'}
    monkeypatch.setattr(launcher, 'listener_info', lambda _: info)
    monkeypatch.setattr(launcher, 'ready', lambda *_: html_ok)
    assert bool(launcher.verified_instance({'root': str(tmp_path), 'pid': state_pid, 'port': 7863}, tmp_path, b'app')) is owned


def test_declined_migration_only_reuses_existing_server(tmp_path, monkeypatch):
    root = tmp_path / 'root'
    (root / 'web/frontend/dist').mkdir(parents=True)
    (root / 'web/frontend/dist/index.html').write_bytes(b'app')
    data = tmp_path / 'data'
    data.mkdir()
    monkeypatch.setattr(launcher.subprocess, 'Popen', lambda *_a, **_k: pytest.fail('must not start new Web'))
    with pytest.raises(RuntimeError, match='待迁移设置已保留'):
        launcher.main(['--root', str(root), '--data-dir', str(data), '--reuse-only', '--no-browser'])


def test_restart_stops_only_verified_instance_then_starts(tmp_path, monkeypatch):
    root = tmp_path / 'root'
    (root / 'web/frontend/dist').mkdir(parents=True)
    (root / 'web/frontend/dist/index.html').write_bytes(b'app')
    data = tmp_path / 'data'
    data.mkdir()
    (data / 'workbench.json').write_text(json.dumps({'root': str(root), 'port': 7863, 'pid': 21}))
    events = []
    monkeypatch.setattr(launcher, 'verified_instance', lambda *_: {'pid': 21, 'port': 7863})
    monkeypatch.setattr(launcher, 'stop_verified_web', lambda info: events.append(('stop', info['pid'])))
    def gateway_run(*args, **kwargs):
        events.append(('gateway', kwargs['timeout']))
        return SimpleNamespace(returncode=1)
    monkeypatch.setattr(launcher.subprocess, 'run', gateway_run)
    with pytest.raises(RuntimeError, match='Gateway startup failed'):
        launcher.main(['--root', str(root), '--data-dir', str(data), '--restart', '--no-browser'])
    assert events == [('stop', 21), ('gateway', 330)]


def test_unverified_restart_never_stops_a_listener(tmp_path, monkeypatch):
    root = tmp_path / 'root'
    (root / 'web/frontend/dist').mkdir(parents=True)
    (root / 'web/frontend/dist/index.html').write_bytes(b'app')
    data = tmp_path / 'data'
    data.mkdir()
    (data / 'workbench.json').write_text(json.dumps({'root': str(root), 'port': 7863, 'pid': 21}))
    monkeypatch.setattr(launcher, 'verified_instance', lambda *_: None)
    monkeypatch.setattr(launcher, 'listener_info', lambda *_: {'pid': 999})
    monkeypatch.setattr(launcher, 'stop_verified_web', lambda *_: pytest.fail('must not stop foreign process'))
    with pytest.raises(RuntimeError, match='未停止任何服务'):
        launcher.main(['--root', str(root), '--data-dir', str(data), '--restart', '--no-browser'])


@pytest.mark.parametrize('broken_record', [True, False])
def test_restart_never_swallows_record_or_stop_errors(tmp_path, monkeypatch, broken_record):
    root = tmp_path / 'root'
    (root / 'web/frontend/dist').mkdir(parents=True)
    (root / 'web/frontend/dist/index.html').write_bytes(b'app')
    data = tmp_path / 'data'
    data.mkdir()
    (data / 'workbench.json').write_text('{' if broken_record else json.dumps({'root': str(root), 'port': 7863, 'pid': 21}))
    monkeypatch.setattr(launcher, 'verified_instance', lambda *_: {'pid': 21, 'port': 7863})
    monkeypatch.setattr(launcher, 'stop_verified_web', lambda *_: (_ for _ in ()).throw(OSError('stop failed')))
    monkeypatch.setattr(launcher.subprocess, 'run', lambda *_a, **_k: pytest.fail('must not start Gateway after restart failed'))
    with pytest.raises((RuntimeError, OSError)):
        launcher.main(['--root', str(root), '--data-dir', str(data), '--restart', '--no-browser'])


@pytest.fixture
def fresh_start(tmp_path, monkeypatch):
    root = tmp_path / 'source'
    (root / 'web/frontend/dist').mkdir(parents=True)
    (root / 'web/frontend/dist/index.html').write_bytes(b'app')
    data = tmp_path / 'data'
    data.mkdir()
    process = SimpleNamespace(pid=321)
    calls = []
    monkeypatch.setattr(launcher, 'free_port', lambda _: 7889)
    monkeypatch.setattr(launcher, 'wait_for_web', lambda *_a, **_k: True)
    monkeypatch.setattr(launcher, 'listener_info', lambda _: {
        'pid': 321, 'parentId': 20, 'commandLine': f'python "{root / "web/app.py"}"'})
    def popen(command, **kwargs):
        calls.append(('web', command, kwargs))
        return process
    monkeypatch.setattr(launcher.subprocess, 'Popen', popen)
    return root, data, calls


@pytest.mark.parametrize('failure', ['timeout', 'oserror', 'unapproved'])
def test_auxiliary_device_failure_does_not_block_source_web(fresh_start, monkeypatch, capsys, failure):
    root, data, calls = fresh_start
    def run(command, **kwargs):
        calls.append(('run', command, kwargs))
        if command[-1] == 'start':
            return SimpleNamespace(returncode=0)
        assert command[-1] == str(root / 'scripts/initialize_gateway_device.py')
        assert kwargs['timeout'] == 20
        if failure == 'timeout':
            raise subprocess.TimeoutExpired(['private-command-secret'], 20)
        if failure == 'oserror':
            raise OSError('private-path-secret')
        return SimpleNamespace(returncode=1)
    monkeypatch.setattr(launcher.subprocess, 'run', run)
    assert launcher.main(['--root', str(root), '--data-dir', str(data), '--no-browser']) == 0
    assert [kind for kind, *_ in calls] == ['run', 'run', 'web']
    assert json.loads((data / 'workbench.json').read_text())['port'] == 7889
    captured = capsys.readouterr()
    log = (data / 'logs/launch.log').read_text(encoding='utf-8')
    assert '继续启动工作台' in captured.err and '继续启动工作台' in log
    assert 'private-' not in captured.err + log


def test_real_gateway_failure_still_blocks_source_web(fresh_start, monkeypatch):
    root, data, calls = fresh_start
    monkeypatch.setattr(launcher.subprocess, 'run', lambda *_a, **_k: SimpleNamespace(returncode=1))
    with pytest.raises(RuntimeError, match='Gateway startup failed'):
        launcher.main(['--root', str(root), '--data-dir', str(data), '--no-browser'])
    assert calls == []
    assert not (data / 'workbench.json').exists()


@pytest.mark.parametrize('saved_port,expected_port', [(38100, '38100'), ('38100', '38100'),
    ('127.0.0.1:38101', '38101'), ('[::1]:38102', '38102'), (None, None)])
def test_source_gateway_uses_only_local_runtime_endpoint(fresh_start, monkeypatch, saved_port, expected_port):
    root, data, calls = fresh_start
    selected_state = data / 'custom-state'
    selected_state.mkdir()
    (selected_state / 'openclaw.json').write_text(json.dumps({'gateway': {'port': 38103}}))
    settings = {'stateDir': str(selected_state)}
    if saved_port is not None:
        settings['gatewayPort'] = saved_port
    (data / 'runtime-launch.json').write_text(json.dumps(settings))
    for name, value in {
        'EASEL_GATEWAY_HOST': 'other-host.invalid', 'OPENCLAW_GATEWAY_PORT': '44444',
        'EASEL_GATEWAY_PORT': '44445', 'OPENCLAW_GATEWAY_TOKEN': 'other-token',
        'OPENCLAW_GATEWAY_PASSWORD': 'other-password', 'OPENCLAW_CONFIG_PATH': 'other-config',
        'OPENCLAW_STATE_DIR': 'other-state', 'EASEL_OPENCLAW_STATE_DIR': 'other-easel-state',
    }.items():
        monkeypatch.setenv(name, value)
    def run(command, **kwargs):
        calls.append(('run', command, kwargs))
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(launcher.subprocess, 'run', run)
    assert launcher.main(['--root', str(root), '--data-dir', str(data), '--no-browser']) == 0
    assert [kind for kind, *_ in calls] == ['run', 'run', 'web']
    for _, _, kwargs in calls:
        env = kwargs['env']
        assert env['EASEL_GATEWAY_HOST'] == '127.0.0.1'
        assert env['OPENCLAW_STATE_DIR'] == env['EASEL_OPENCLAW_STATE_DIR'] == str(selected_state)
        assert env['OPENCLAW_CONFIG_PATH'] == str(selected_state / 'openclaw.json')
        assert 'OPENCLAW_GATEWAY_TOKEN' not in env and 'OPENCLAW_GATEWAY_PASSWORD' not in env
        for key in ('OPENCLAW_GATEWAY_PORT', 'EASEL_GATEWAY_PORT'):
            if expected_port:
                assert env[key] == expected_port
            else:
                assert key not in env  # Both gateway and helper read this copy's config.
    assert json.loads((selected_state / 'openclaw.json').read_text())['gateway']['port'] == 38103


@pytest.mark.parametrize('invalid', [0, -1, 65536, True, '', 'broken', 1.5])
def test_invalid_runtime_gateway_port_blocks_without_starting_services(fresh_start, monkeypatch, invalid):
    root, data, calls = fresh_start
    (data / 'runtime-launch.json').write_text(json.dumps({'gatewayPort': invalid}))
    monkeypatch.setattr(launcher.subprocess, 'run', lambda *_a, **_k: pytest.fail('invalid port must not start Gateway'))
    with pytest.raises(ValueError, match='保存的网关端口无效'):
        launcher.main(['--root', str(root), '--data-dir', str(data), '--no-browser'])
    assert calls == []
