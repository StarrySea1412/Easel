"""Move the outputs tree at startup without splitting legacy output consumers.

The logical DATA_DIR/outputs path remains a directory junction (Windows) or
symlink (Unix). Credentials/config outside outputs never move. Every switch
preserves the previous tree, and a failed switch restores its logical name.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import uuid


def _file(root):
    return Path(root) / '.storage-location.json'


def _read(root):
    try:
        value = json.loads(_file(root).read_text(encoding='utf-8'))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _write(root, value):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    temporary = root / ('.storage-location.' + uuid.uuid4().hex + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(_file(root))


def _link(path):
    path = Path(path)
    return path.is_symlink() or (getattr(path, 'is_junction', lambda: False)()) or (
        os.name == 'nt' and path.exists() and bool(getattr(path.lstat(), 'st_file_attributes', 0) & 0x400))


def _inventory(root, *, hashes=False):
    root = Path(root)
    result = {}
    if not root.exists():
        return result
    for directory, folders, files in os.walk(root, followlinks=False):
        for name in folders + files:
            path = Path(directory) / name
            if _link(path):
                raise ValueError('内容目录含子级链接，不能自动迁移；请先将链接内容整理为普通文件夹')
        for name in files:
            path = Path(directory) / name
            if not path.is_file():
                raise ValueError('内容目录含不支持的特殊文件')
            digest = None
            if hashes:
                with path.open('rb') as handle:
                    checksum = hashlib.sha256()
                    for chunk in iter(lambda: handle.read(1024 * 1024), b''):
                        checksum.update(chunk)
                    digest = checksum.hexdigest()
            result[str(path.relative_to(root))] = (path.stat().st_size, digest)
    return result


def status(root, *, include_size=True):
    root = Path(root)
    config = _read(root)
    logical = root / 'outputs'
    inventory = _inventory(logical.resolve()) if include_size else {}
    return {'logicalPath': str(logical), 'currentPath': str(logical.resolve()),
            'pendingPath': config.get('pendingPath'), 'status': config.get('status', 'ready'),
            'error': config.get('error'), 'requiresRestart': bool(config.get('pendingPath')),
            'backupPath': config.get('backupPath'), 'fileCount': len(inventory),
            'byteCount': sum(value[0] for value in inventory.values()),
            'note': '迁移 outputs 内容及工作记录（含临时登录状态文件）；浏览器会话、持久 Cookie、模型密钥及用户配置保留在原数据位置。旧内容保留备份。'}


def validate(root, value):
    root = Path(root).resolve()
    if not isinstance(value, str) or not value.strip():
        raise ValueError('请输入本地绝对目录路径')
    target = Path(value.strip()).expanduser()
    if not target.is_absolute():
        raise ValueError('保存位置必须是绝对目录路径')
    if os.name == 'nt' and str(target).startswith('\\\\'):
        raise ValueError('目录联接仅支持本地磁盘路径')
    # No shell interpolates these paths; native PowerShell reads them via env.
    if _link(target):
        raise ValueError('目标目录不能是符号链接或目录联接')
    target = target.resolve()
    logical = root / 'outputs'
    current = logical.resolve()
    if target == current:
        raise ValueError('该目录已经是当前保存位置')
    if target == root or target.is_relative_to(root) or root.is_relative_to(target):
        raise ValueError('请选择当前数据目录之外的空文件夹；恢复默认路径需先手动整理保留的备份')
    if target.is_relative_to(current) or current.is_relative_to(target):
        raise ValueError('新旧保存位置不能互相包含')
    if target == Path(target.anchor) or target == Path.home().resolve():
        raise ValueError('不能把磁盘根目录或用户主目录用作内容目录')
    if target.exists() and (not target.is_dir() or any(target.iterdir())):
        raise ValueError('请选择不存在或完全空的目录，避免覆盖其他文件')
    if not target.parent.is_dir():
        raise ValueError('目标父目录不存在，请先创建父目录')
    with tempfile.TemporaryFile(dir=target.parent) as probe:
        probe.write(b'easel-storage-write-test')
        probe.flush()
    inventory = _inventory(current)
    needed = sum(v[0] for v in inventory.values())
    if shutil.disk_usage(target.parent).free < needed + 1024 * 1024:
        raise ValueError('目标磁盘可用空间不足以复制现有内容并保留原目录')
    return target


def schedule(root, path):
    target = validate(root, path)
    config = _read(root)
    config.update(pendingPath=str(target), status='pending_restart', error=None)
    _write(root, config)
    return status(root)


def cancel(root):
    config = _read(root)
    config.update(pendingPath=None, status='ready', error=None)
    _write(root, config)
    return status(root)


def _make_link(source, target):
    if os.name == 'nt':
        command = "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:EASEL_STORAGE_LINK -Target $env:EASEL_STORAGE_TARGET | Out-Null"
        env = dict(os.environ, EASEL_STORAGE_LINK=str(source), EASEL_STORAGE_TARGET=str(target))
        subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command],
                       env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), check=True, timeout=20)
    else:
        source.symlink_to(target, target_is_directory=True)


def apply_pending(root):
    """Call once before application startup accepts any request or write job."""
    root = Path(root).resolve()
    config = _read(root)
    if not config.get('pendingPath'):
        return status(root, include_size=False)
    logical = root / 'outputs'
    backup = root / ('outputs-backup-' + time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:6])
    moved = False
    try:
        target = validate(root, config['pendingPath'])
        current = logical.resolve()
        before = _inventory(current, hashes=True)
        target.mkdir(exist_ok=True)
        if current.exists():
            shutil.copytree(current, target, dirs_exist_ok=True, copy_function=shutil.copy2)
        if before != _inventory(target, hashes=True) or before != _inventory(current, hashes=True):
            raise ValueError('复制校验失败或复制期间源内容发生变化；原目录保持可用，目标副本已保留')
        if logical.exists() or _link(logical):
            logical.rename(backup)
            moved = True
        _make_link(logical, target)
        if logical.resolve() != target:
            raise ValueError('新保存位置的目录联接校验失败')
        config.update(pendingPath=None, status='ready', error=None, backupPath=str(backup) if moved else None,
                      activePath=str(target), changedAt=time.strftime('%Y-%m-%dT%H:%M:%S'))
        _write(root, config)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        # Remove only the newly created link, never recursively delete content.
        if moved:
            if _link(logical):
                if os.name == 'nt' and not logical.is_symlink():
                    os.rmdir(logical)
                else:
                    logical.unlink()
            elif logical.is_dir() and not any(logical.iterdir()):
                logical.rmdir()
            if not logical.exists():
                backup.rename(logical)
        config.update(pendingPath=None, status='failed', error=str(exc)[:600])
        _write(root, config)
    return status(root, include_size=False)
