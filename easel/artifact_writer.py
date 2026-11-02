"""Bounded, resumable text artifacts; chunks never truncate an existing output."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
from contextlib import contextmanager


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _directory(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.resolve() != path.absolute():
        raise ValueError('不允许符号链接目录')
    return path


def _read(path: Path):
    if path.is_symlink():
        raise ValueError('不允许符号链接文件')
    return json.loads(path.read_text(encoding='utf-8'))


def _atomic(path: Path, data: bytes):
    fd, temporary = tempfile.mkstemp(prefix='.pending-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


@contextmanager
def _lock(path: Path):
    if path.is_symlink():
        raise ValueError('锁路径无效')
    with path.open('a+b') as handle:
        if os.name == 'nt':
            import msvcrt
            handle.seek(0)
            handle.write(b'\0')
            handle.flush()
        else:
            import fcntl
        deadline = time.monotonic() + 3
        while True:
            try:
                if os.name == 'nt':
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise ValueError('文件正在写入，请查询原任务后继续') from None
                time.sleep(.025)
        try:
            yield
        finally:
            if os.name == 'nt':
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def write_artifact(root: Path, session: str, args: dict) -> dict:
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,200}', session):
        raise ValueError('会话身份无效')
    request = args.get('requestId', '')
    if not isinstance(request, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,120}', request):
        raise ValueError('固定请求标识无效')
    scope = digest(session.encode())[:20]
    directory = _directory(root.absolute() / '_artifact_writes' / scope / digest(request.encode())[:32])
    with _lock(directory / 'lock'):
        manifest_path = directory / 'manifest.json'
        operation = args.get('operation')
        if operation == 'begin':
            name = args.get('filename', '')
            if not isinstance(name, str) or not re.fullmatch(r'[\w][\w .-]{0,119}\.(?:html|md|txt|json|csv|svg|css|js)', name, re.I):
                raise ValueError('请使用无目录的文本产物文件名')
            manifest = {'filename': name}
            if manifest_path.exists():
                if _read(manifest_path) != manifest:
                    raise ValueError('原请求的文件名不能修改')
            else:
                _atomic(manifest_path, json.dumps(manifest, ensure_ascii=False).encode())
        if not manifest_path.exists():
            raise ValueError('请先begin创建原请求')
        manifest = _read(manifest_path)
        chunks = []
        for item in sorted(directory.glob('chunk-*.json')):
            if item.name != f'chunk-{len(chunks):04d}.json':
                raise ValueError('分块序号不连续')
            chunk = _read(item)
            if digest(chunk['text'].encode()) != chunk['sha256']:
                raise ValueError('分块摘要不一致')
            chunks.append(chunk['text'])
        committed = directory / 'committed.json'
        if operation == 'append':
            sequence, text = args.get('sequence'), args.get('text')
            if type(sequence) is not int or not 0 <= sequence < 512 or not isinstance(text, str) or not text or len(text) > 3000 or len(text.encode()) > 9000:
                raise ValueError('每块需有序、非空且不超过3000字符/9000字节')
            if sequence < len(chunks):
                if chunks[sequence] != text:
                    raise ValueError('该序号已保存不同内容，不允许覆盖')
            elif sequence != len(chunks) or committed.exists():
                raise ValueError('请从status返回的nextSequence继续，已提交产物不能追加')
            else:
                if sum(len(x.encode()) for x in chunks) + len(text.encode()) > 1024 * 1024:
                    raise ValueError('单个文本产物上限1MiB')
                _atomic(directory / f'chunk-{sequence:04d}.json', json.dumps(
                    {'text': text, 'sha256': digest(text.encode())}, ensure_ascii=False).encode())
                chunks.append(text)
        elif operation not in {'begin', 'status', 'commit'}:
            raise ValueError('未知操作')
        data = ''.join(chunks).encode()
        result = {'ok': True, 'requestId': request, 'nextSequence': len(chunks),
                  'bytes': len(data), 'sha256': digest(data), 'committed': False}
        if operation == 'commit':
            if type(args.get('expectedChunks')) is not int or not chunks or args['expectedChunks'] != len(chunks):
                raise ValueError('提交分块数量不匹配')
            output = _directory(root.absolute() / 'outputs' / 'artifacts' / scope)
            target = output / manifest['filename']
            # Persist the full candidate before atomically linking it into place.
            # link is no-clobber, including another request's concurrently created file.
            candidate = directory / 'assembled'
            _atomic(candidate, data)
            try:
                os.link(candidate, target)
            except FileExistsError:
                if target.is_symlink() or target.read_bytes() != data:
                    raise ValueError('同名成品已存在且内容不同，请保留原文件') from None
            _atomic(committed, json.dumps({'path': str(target), 'sha256': digest(data)}).encode())
        if committed.exists():
            receipt = _read(committed)
            target = Path(receipt['path'])
            if target.is_symlink() or not target.is_file() or digest(target.read_bytes()) != receipt['sha256'] or receipt['sha256'] != result['sha256']:
                raise ValueError('成品与原提交摘要不一致')
            result.update(committed=True, path=str(target))
        return result


if __name__ == '__main__':
    try:
        arguments = json.loads(sys.stdin.buffer.read(24000))
        result = write_artifact(Path(os.environ.get('EASEL_DATA_DIR', 'data')), sys.argv[1], arguments)
        print(json.dumps(result, ensure_ascii=False))
    except (ValueError, OSError, KeyError, TypeError):
        print(json.dumps({'ok': False, 'error': '写入未通过校验；查询原requestId的status，核对序号、内容、空间和同名文件后继续，不要清空原成品。'}, ensure_ascii=False))
        sys.exit(1)
