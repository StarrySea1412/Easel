"""Cross-process browser-profile ownership, adapted from upstream Easel.

The lock file remains in place; deleting it would let processes lock different
inodes. Never remove Chromium's own locks while its owner may still be alive.
"""
from __future__ import annotations

import os
import time
from pathlib import Path


class ProfileLock:
    def __init__(self, profile: Path):
        self.path = profile / '.easel.lock'
        self.fd: int | None = None

    def acquire(self, timeout_s: float = 20) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + timeout_s
        while True:
            descriptor = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
            try:
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.fd = descriptor
                return
            except OSError as exc:
                os.close(descriptor)
                if time.monotonic() >= deadline:
                    raise TimeoutError('此账号的浏览器目录正在使用，请关闭登录或发布窗口后重试') from exc
                time.sleep(min(0.1, max(0, deadline - time.monotonic())))

    def release(self) -> None:
        descriptor, self.fd = self.fd, None
        if descriptor is None:
            return
        try:
            if os.name == 'nt':
                import msvcrt
                os.lseek(descriptor, 0, os.SEEK_SET)
                msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)


class LockedContext:
    def __init__(self, context, lock: ProfileLock):
        self._context, self._lock = context, lock

    def __getattr__(self, name):
        return getattr(self._context, name)

    def close(self, *args, **kwargs):
        try:
            return self._context.close(*args, **kwargs)
        finally:
            self._lock.release()


def launch_locked(profile: Path, launch):
    lock = ProfileLock(profile)
    lock.acquire()
    try:
        return LockedContext(launch(), lock)
    except BaseException:
        lock.release()
        raise
