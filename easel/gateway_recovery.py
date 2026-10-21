"""Deduplicated local gateway recovery. Never stops a healthy/running gateway."""
from __future__ import annotations

import threading
import time


class GatewayRecovery:
    def __init__(self, clock=time.monotonic):
        self._clock = clock
        self._lock = threading.Lock()
        self._state = 'idle'
        self._note = ''
        self._failures = 0
        self._retry_at = 0.0

    def snapshot(self):
        with self._lock:
            return {'state': self._state, 'note': self._note,
                    'retryAfter': max(0, int(self._retry_at - self._clock() + .999))}

    def request(self, healthy, start):
        with self._lock:
            if self._state == 'starting' or self._clock() < self._retry_at:
                return self._snapshot_locked()
            self._state = 'starting'
            self._note = 'OpenClaw 未连接，正在自动启动…'
        threading.Thread(target=self._run, args=(healthy, start), daemon=True,
                         name='easel-gateway-recovery').start()
        return self.snapshot()

    def _snapshot_locked(self):
        return {'state': self._state, 'note': self._note,
                'retryAfter': max(0, int(self._retry_at - self._clock() + .999))}

    def _run(self, healthy, start):
        try:
            if not healthy():
                start()
            ready = healthy()
            note = 'OpenClaw 已连接' if ready else 'OpenClaw 启动后仍未连接，请查看网关日志。'
        except FileNotFoundError:
            ready, note = False, '找不到本机 OpenClaw 或 Node，请在设置中修复运行环境。'
        except TimeoutError:
            ready, note = False, 'OpenClaw 启动超时，稍后自动重试；可在设置中查看网关日志。'
        except Exception:
            ready, note = False, 'OpenClaw 启动失败，请在设置中查看网关日志。'
        with self._lock:
            self._state, self._note = ('connected' if ready else 'failed'), note
            self._failures = 0 if ready else self._failures + 1
            self._retry_at = self._clock() + (5 if ready else min(300, 15 * 2 ** min(self._failures - 1, 5)))
