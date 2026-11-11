"""Daily per-account snapshot worker so growth windows have a real baseline.

`较昨日 / 较上周 / 较上月 / 较去年` compare the current reading with the newest
snapshot that is *at least* N days old. If snapshots are only written when the
user happens to open the analytics page, those windows stay null forever — and
worse, two refreshes minutes apart look like a "day" comparison. This worker
re-runs the same read-only collectors at most once per platform per local day,
only for platforms whose login was confirmed, and only writes a snapshot that
carries a platform account id.

It never logs in, never publishes, and never touches content. Failures are
recorded and retried with a bounded number of attempts per day.
"""
from __future__ import annotations

from datetime import datetime
import json
import logging
import os
from pathlib import Path
import threading
import time

log = logging.getLogger(__name__)

MAX_ATTEMPTS_PER_DAY = 3
STATE_VERSION = 1


class SnapshotService:
    """One bounded worker per Web process; state lives on disk so restarts resume."""

    def __init__(self, root: Path, *, platforms, logged_in, collect,
                 interval: float = 1800, initial_delay: float = 120, now=time.time):
        self.root = Path(root)
        self.platforms = tuple(platforms)
        self.logged_in = logged_in
        self.collect = collect
        self.interval = interval
        self.initial_delay = initial_delay
        self.now = now
        self.stop_event = threading.Event()
        self.wake_event = threading.Event()
        self.lock = threading.RLock()
        self.thread = None

    # ---- state ----
    @property
    def state_path(self) -> Path:
        return self.root / 'state.json'

    def _today(self, ts: float) -> str:
        return datetime.fromtimestamp(ts).strftime('%Y-%m-%d')

    def read_state(self) -> dict:
        try:
            raw = json.loads(self.state_path.read_text(encoding='utf-8'))
        except FileNotFoundError:
            return {'version': STATE_VERSION, 'platforms': {}}
        except (OSError, ValueError):
            # A corrupt state file must not stop collection; treat it as empty.
            return {'version': STATE_VERSION, 'platforms': {}}
        if not isinstance(raw, dict) or not isinstance(raw.get('platforms'), dict):
            return {'version': STATE_VERSION, 'platforms': {}}
        return raw

    def _write_state(self, state: dict) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        # 临时文件名带 pid：固定名会让同时写状态的进程抢同一路径（WinError 32），
        # 与 account_stats._atomic_write_text 同一条教训。
        temporary = self.state_path.with_name(f'{self.state_path.name}.{os.getpid()}.tmp')
        payload = json.dumps(state, ensure_ascii=False, indent=2)
        temporary.write_text(payload, encoding='utf-8')
        temporary.replace(self.state_path)

    def status(self) -> dict:
        """Read-only view for the analytics page: when did each platform last collect."""
        state = self.read_state()
        return {
            'platforms': {
                name: {key: entry.get(key) for key in ('day', 'at', 'attempts', 'error')}
                for name, entry in state['platforms'].items() if isinstance(entry, dict)
            },
            'intervalSeconds': int(self.interval),
        }

    # ---- lifecycle ----
    def start(self) -> None:
        if self.thread and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._loop, daemon=True,
                                       name='easel-analytics-snapshot')
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        self.wake_event.set()
        if self.thread:
            self.thread.join(timeout=20)

    def _loop(self) -> None:
        # The first check waits: a Web process that only serves a request or two
        # (tests, CLI usage) must not start a browser.
        if self.stop_event.wait(self.initial_delay):
            return
        while not self.stop_event.is_set():
            self.wake_event.clear()
            try:
                self.tick()
            except Exception:  # noqa: BLE001 - a broken collector must not kill the worker
                log.warning('analytics snapshot tick failed', exc_info=True)
            self.wake_event.wait(self.interval)

    # ---- work ----
    def due(self, platform: str, state: dict, today: str) -> bool:
        entry = state['platforms'].get(platform)
        if not isinstance(entry, dict):
            return True
        if entry.get('day') == today:
            # Already collected (or gave up) for this local day.
            return False
        attempts = entry.get('attempts')
        if type(attempts) is int and attempts >= MAX_ATTEMPTS_PER_DAY and entry.get('attemptDay') == today:
            return False
        return True

    def tick(self) -> int:
        """Collect every due, logged-in platform. Returns how many succeeded."""
        today = self._today(self.now())
        done = 0
        with self.lock:
            state = self.read_state()
        for platform in self.platforms:
            if self.stop_event.is_set():
                break
            with self.lock:
                if not self.due(platform, state, today):
                    continue
            try:
                logged = self.logged_in(platform)
            except Exception:  # noqa: BLE001
                logged = False
            if not logged:
                continue
            try:
                recorded = self.collect(platform)
            except Exception as exc:  # noqa: BLE001
                with self.lock:
                    state = self.read_state()
                    entry = state['platforms'].get(platform)
                    entry = dict(entry) if isinstance(entry, dict) else {}
                    attempts = entry.get('attempts') if entry.get('attemptDay') == today else 0
                    entry.update(attemptDay=today, attempts=(attempts if type(attempts) is int else 0) + 1,
                                 error=str(exc)[:300])
                    state['platforms'][platform] = entry
                    self._write_state(state)
                continue
            with self.lock:
                state = self.read_state()
                entry = state['platforms'].get(platform)
                entry = dict(entry) if isinstance(entry, dict) else {}
                if recorded:
                    state['platforms'][platform] = {
                        'day': today, 'at': int(self.now()), 'attempts': 0, 'error': '',
                        'recorded': True,
                    }
                    done += 1
                else:
                    # collect 返回 False 多为瞬时原因（网络失败、子进程退出码非零），
                    # 与抛异常同等对待：计入当日尝试次数，让 due() 允许重试；
                    # 若直接标 day=今天，一次网络抖动就烧掉整天，日/周基线会断档。
                    attempts = entry.get('attempts') if entry.get('attemptDay') == today else 0
                    entry.update(attemptDay=today, attempts=(attempts if type(attempts) is int else 0) + 1,
                                 error='采集完成但未能写入快照（登录态或账号归属核验未通过）')
                    state['platforms'][platform] = entry
                self._write_state(state)
        return done
