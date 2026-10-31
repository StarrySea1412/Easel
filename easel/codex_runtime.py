"""Private loopback App Server lifetime, independent of a web observer.

Only the audited native CLI is launched. Closing a client detaches observation;
it never kills a running turn. A persisted instance id binds recovery to the
same authenticated server, not merely to a reused port or process id.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import queue
import secrets
import socket
import subprocess
import threading
import time
from types import SimpleNamespace
from urllib.parse import urlsplit

import websocket

from .codex_client import CodexClient, CodexError, runtime_info
from .local_records import _write_lock, RecordConflict


class SocketClient(CodexClient):
    def __init__(self, record, token):
        self._setup(record['version'])
        self.runtime_instance = record['instance']
        self.socket = websocket.create_connection(record['url'], timeout=3,
            suppress_origin=True, http_proxy_host=None,
            header=['Authorization: Bearer ' + token])
        self.socket.settimeout(1)
        # Existing service code uses poll to test its connection, not native PID.
        self.proc = SimpleNamespace(poll=lambda: 1 if self._closed.is_set() else None)
        threading.Thread(target=self._read_socket, daemon=True, name='easel-codex-ws').start()
        self._initialize()

    def send(self, payload):
        with self._lock:
            if self._closed.is_set():
                raise CodexError('Codex观察连接已关闭；原轮次不会自动重发。')
            try:
                self.socket.send(json.dumps(payload, ensure_ascii=False))
            except (OSError, websocket.WebSocketException) as exc:
                raise CodexError('Codex观察连接中断；原轮次仍需核对。') from exc

    def _read_socket(self):
        try:
            while not self._closed.is_set():
                try:
                    value = self.socket.recv()
                except websocket.WebSocketTimeoutException:
                    continue
                if not value:
                    break
                if not isinstance(value, str) or len(value.encode('utf-8')) > 8_000_000:
                    raise CodexError('Codex事件格式或大小无效。')
                self._dispatch(json.loads(value))
        except (OSError, ValueError, queue.Full, CodexError, websocket.WebSocketException):
            pass
        finally:
            self._transport_ended()

    def close(self):
        self._closed.set()
        self.socket.close(timeout=1)


class CodexRuntime:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.record_path = self.root / 'runtime.json'
        self.token_path = self.root / 'capability.token'
        self.process = None

    @staticmethod
    def _fingerprint(info):
        home = os.environ.get('EASEL_CODEX_HOME') or os.environ.get('CODEX_HOME') or ''
        return hashlib.sha256(json.dumps({'command': info['command'], 'version': info['version'],
            'home': str(Path(home).expanduser().resolve()) if home else ''}, sort_keys=True).encode()).hexdigest()

    def _load(self, info, expected):
        record = json.loads(self.record_path.read_text(encoding='utf-8'))
        url = urlsplit(record.get('url', ''))
        if (record.get('schema') != 1 or record.get('root') != str(self.root)
                or record.get('fingerprint') != self._fingerprint(info)
                or record.get('version') != info['version']
                or type(record.get('pid')) is not int or record['pid'] <= 0
                or not isinstance(record.get('instance'), str) or len(record['instance']) != 32
                or url.scheme != 'ws' or url.hostname != '127.0.0.1' or not url.port
                or url.username or url.password or url.path or url.query or url.fragment
                or expected is not None and record['instance'] != expected):
            raise CodexError('Codex独立运行身份或配置变化，未重建或接管原轮次。')
        token = self.token_path.read_text(encoding='utf-8').strip()
        if len(token) < 40:
            raise CodexError('Codex独立连接凭据损坏，未重建原运行。')
        return record, token

    @staticmethod
    def _alive(pid):
        if os.name == 'nt':
            import ctypes
            from ctypes import wintypes
            kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel.OpenProcess.restype = wintypes.HANDLE
            kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            handle = kernel.OpenProcess(0x1000, False, pid)
            if not handle:
                return ctypes.get_last_error() != 87  # Invalid PID; access denial remains unknown/alive.
            try:
                result = wintypes.DWORD()
                return not kernel.GetExitCodeProcess(handle, ctypes.byref(result)) or result.value == 259
            finally:
                kernel.CloseHandle(handle)
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True

    def _start(self, info):
        # The lock serializes creation. A failed existing connection is never
        # interpreted as permission to create another server beside a live run.
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        token = secrets.token_urlsafe(48)
        descriptor = os.open(self.token_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            stream.write(token)
        record = {'schema': 1, 'root': str(self.root), 'version': info['version'],
            'fingerprint': self._fingerprint(info), 'instance': secrets.token_hex(16),
            'url': f'ws://127.0.0.1:{port}'}
        env = os.environ.copy()
        if env.get('EASEL_CODEX_HOME'):
            env['CODEX_HOME'] = str(Path(env['EASEL_CODEX_HOME']).expanduser().resolve())
        flags = ({'creationflags': subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP}
                 if os.name == 'nt' else {'start_new_session': True})
        try:
            log_fd = os.open(self.root / 'server.log', os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(log_fd, 'ab') as log:
                self.process = subprocess.Popen(info['command'] + ['app-server', '--listen', record['url'],
                    '--ws-auth', 'capability-token', '--ws-token-file', str(self.token_path)],
                    cwd=self.root, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, **flags)
            record['pid'] = self.process.pid
            descriptor = os.open(self.record_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
                json.dump(record, stream)
                stream.flush()
                os.fsync(stream.fileno())
            deadline = time.monotonic() + 20
            while self.process.poll() is None and time.monotonic() < deadline:
                try:
                    return SocketClient(record, token)
                except (OSError, websocket.WebSocketException):
                    time.sleep(.1)
            raise CodexError('Codex独立服务未就绪；没有发送模型请求。')
        except Exception:
            # Only the exact child owned by this constructor may be terminated.
            if self.process is not None and self.process.poll() is None:
                self.process.terminate()
                self.process.wait(timeout=10)
            self.record_path.unlink(missing_ok=True)
            self.token_path.unlink(missing_ok=True)
            raise

    def connect(self, cwd=None, *, expected=None):
        try:
            with _write_lock(self.root / 'owner', 'Codex独立连接'):
                info = runtime_info()
                if not self.record_path.exists():
                    if expected is not None or self.token_path.exists():
                        raise CodexError('原Codex运行连接缺失，未另建执行器或重发原轮次。')
                    return self._start(info)
                record, token = self._load(info, expected)
                try:
                    return SocketClient(record, token)
                except (OSError, websocket.WebSocketException):
                    if expected is not None or self._alive(record['pid']):
                        raise
                    # Both the failed endpoint and an absent OS process are
                    # required. Never kill or replace a merely slow live server.
                    self.record_path.replace(self.root / 'previous-runtime.json')
                    self.token_path.unlink()
                    return self._start(info)
        except (OSError, ValueError, RecordConflict, websocket.WebSocketException) as exc:
            raise CodexError('Codex独立连接不可核对；原任务未重发。') from exc

    def connect_original(self, state):
        instance = state.get('nativeRuntime')
        if not isinstance(instance, str) or not instance:
            raise CodexError('原轮次没有独立运行身份，不能接管活跃执行。')
        return self.connect(expected=instance)
