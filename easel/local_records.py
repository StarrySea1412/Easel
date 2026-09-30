"""Small JSON record lists with explicit failures and optimistic concurrency.

Only a missing file is an empty collection. Writers must retain the snapshot
returned by read(); a locked revision check prevents stale read/modify/write
cycles in Web threads and calendar CLI processes from losing another update.
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import tempfile


class RecordError(Exception):
    status_code = 503


class RecordConflict(RecordError):
    status_code = 409


class Records(list):
    def __init__(self, values, path: Path, revision: str | None):
        super().__init__(values)
        self.path = path.resolve()
        self.revision = revision


def _invalid_constant(value):
    raise ValueError('Non-finite JSON number')


def read(path: Path, label: str = '本地记录') -> Records:
    path = Path(path)
    try:
        if path.is_symlink():
            raise RecordError(f'{label}文件是链接，已停止读取和覆盖；请检查保存位置。')
        try:
            raw = path.read_bytes()
        except FileNotFoundError:
            return Records([], path, None)
        values = json.loads(raw.decode('utf-8-sig'), parse_constant=_invalid_constant)
        if not isinstance(values, list) or not all(isinstance(item, dict) for item in values):
            raise ValueError('Expected a list of records')
        return Records(values, path, hashlib.sha256(raw).hexdigest())
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise RecordError(f'{label}文件损坏或格式不受支持，原文件已保留；请从备份恢复后重试。') from exc
    except OSError as exc:
        raise RecordError(f'{label}读取失败，原文件已保留；请检查磁盘和目录权限后重试。') from exc


@contextmanager
def _write_lock(path: Path, label: str):
    lock_path = path.with_name(path.name + '.lock')
    if lock_path.is_symlink():
        raise RecordError(f'{label}锁文件是链接，未写入数据；请检查保存位置。')
    with lock_path.open('a+b') as handle:
        if handle.tell() == 0:
            handle.write(b'0')
            handle.flush()
        handle.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise RecordConflict(f'{label}正在被其他操作保存，本次更改未保存；请稍后重试。') from exc
        try:
            yield
        finally:
            # Closing the handle also releases the lock. An explicit unlock
            # failure must not misreport an already committed write as failed.
            try:
                handle.seek(0)
                if os.name == 'nt':
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle, fcntl.LOCK_UN)
            except OSError:
                pass


def write(path: Path, items: Records, label: str = '本地记录') -> None:
    path = Path(path)
    temporary = None
    try:
        if not isinstance(items, Records) or items.path != path.resolve():
            raise RecordConflict(f'{label}缺少原始版本，本次更改未保存；请刷新后重试。')
        if not all(isinstance(item, dict) for item in items):
            raise ValueError('Expected records')
        raw = json.dumps(items, ensure_ascii=False, indent=2, allow_nan=False).encode('utf-8')
        path.parent.mkdir(parents=True, exist_ok=True)
        with _write_lock(path, label):
            current = read(path, label)
            if current.revision != items.revision:
                raise RecordConflict(f'{label}已被其他操作更新，本次更改未保存；请刷新后重试。')
            fd, name = tempfile.mkstemp(dir=path.parent, prefix='.' + path.name + '.', suffix='.tmp')
            temporary = Path(name)
            with os.fdopen(fd, 'wb') as handle:
                handle.write(raw)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            temporary = None
            items.revision = hashlib.sha256(raw).hexdigest()
    except (OSError, TypeError, ValueError, RecursionError) as exc:
        raise RecordError(f'{label}保存失败，未覆盖原文件；请检查磁盘和目录权限后重试。') from exc
    finally:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
