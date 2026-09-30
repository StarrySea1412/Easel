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
