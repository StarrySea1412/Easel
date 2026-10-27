"""Opt-in sleep inhibition while scheduled work is actively executing."""
from __future__ import annotations

import ctypes
import os
import shutil
import subprocess
import sys
import threading
import time


ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001


def _windows_setter():
    if os.name != 'nt':
        return None
    try:
        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        call = kernel32.SetThreadExecutionState
        call.argtypes = [ctypes.c_uint]
        call.restype = ctypes.c_uint
        return call
    except (AttributeError, OSError):
        return None


class _Lease:
    def __init__(self, power: 'TaskPower'):
        self.power = power
        self.released = False
        self.lock = threading.Lock()

    def release(self):
        with self.lock:
            if self.released:
                return
            self.released = True
            self.power._release()


class TaskPower:
    def __init__(self, *, platform=None, windows_setter=None, which=shutil.which,
                 popen=subprocess.Popen, monotonic=time.monotonic, sleep=time.sleep):
        self.platform = platform or sys.platform
        self.windows_setter = windows_setter if windows_setter is not None else _windows_setter()
        self.systemd_inhibit = which('systemd-inhibit') if self.platform.startswith('linux') else None
        self.caffeinate = which('caffeinate') if self.platform == 'darwin' else None
        self.popen = popen
        self.monotonic = monotonic
        self.sleep = sleep
        self.lock = threading.RLock()
        self.enabled = False
        self.claims = 0
        self.native_active = False
        self.child = None
        self.error = ''
        self.retry_after = 0.0

    @property
    def supported(self):
        return bool(self.windows_setter) if self.platform.startswith('win') else bool(
            self.systemd_inhibit if self.platform.startswith('linux') else
            self.caffeinate if self.platform == 'darwin' else False)

    def status(self):
        with self.lock:
            if self.child is not None and self.child.poll() is not None:
                self._close_pipes(self.child)
                self.child = None
                self.native_active = False
                self.error = '系统已结束防休眠请求。'
                self.retry_after = self.monotonic() + 30
            reason = self.error or ('' if self.supported else '此后端主机不支持防休眠。')
            return {'supported': self.supported, 'enabled': self.enabled,
                    'active': self.native_active, 'reason': reason}

    def set_enabled(self, enabled: bool):
        with self.lock:
            self.enabled = bool(enabled)
            self._refresh()
            return self.status()

    def acquire(self):
        with self.lock:
            self.claims += 1
            self._refresh()
            return _Lease(self)

    def _release(self):
        with self.lock:
            self.claims = max(0, self.claims - 1)
            self._refresh()

    def _refresh(self):
        wanted = self.enabled and self.claims > 0 and self.supported
        if wanted and not self.native_active and self.monotonic() >= self.retry_after:
            try:
                self._activate()
                self.native_active = True
                self.error = ''
            except Exception:
                self.error = '系统未能启用防休眠。'
                self.retry_after = self.monotonic() + 30
        elif not wanted and self.native_active:
            try:
                self._deactivate()
                self.native_active = False
                self.error = ''
            except Exception:
                self.error = '系统未能释放防休眠请求。'

    def _activate(self):
        if self.platform.startswith('win'):
            if not self.windows_setter(ES_CONTINUOUS | ES_SYSTEM_REQUIRED):
                raise OSError('SetThreadExecutionState failed')
            return
        if self.platform.startswith('linux'):
            command = [self.systemd_inhibit, '--what=sleep:idle', '--mode=block',
                       '--why=Easel active scheduled task', '--', sys.executable,
                       '-c', 'import sys; sys.stdin.buffer.read()']
        elif self.platform == 'darwin':
            command = [self.caffeinate, '-i', '-w', str(os.getpid())]
        else:
            raise OSError('unsupported platform')
        # EOF binds the Linux inhibitor to its parent even after an abrupt exit.
        child = self.popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                           stderr=subprocess.PIPE)
        self.sleep(0.1)
        if child.poll() is not None:
            if getattr(child, 'stderr', None):
                child.stderr.read(512)
            self._close_pipes(child)
            raise OSError('sleep inhibition helper exited')
        self.child = child

    @staticmethod
    def _close_pipes(child):
        for name in ('stdin', 'stderr'):
            stream = getattr(child, name, None)
            if stream:
                stream.close()

    def _deactivate(self):
        if self.platform.startswith('win'):
            if not self.windows_setter(ES_CONTINUOUS):
                raise OSError('SetThreadExecutionState failed')
            return
        child = self.child
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=2)
        if child is not None:
            if child.poll() is None:
                raise OSError('sleep inhibition helper is still running')
            self._close_pipes(child)
            self.child = None
