"""Credential-free checkpoints shared by the image host and its CLI child.

The OS lock survives a dead Web observer and is released when the image child
exits. Recovery can query or download an accepted task, never submit it again.
"""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import time
from .atomic_files import replace


class CheckpointBusy(Exception):
    pass


def channel_digest(base, key):
    return hashlib.sha256(json.dumps([base, key]).encode()).hexdigest()


def file_digest(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


class ImageCheckpoint:
    def __init__(self, identity):
        self.identity = identity
        if not re.fullmatch(r'[a-f0-9]{32}', identity['jobId']):
            raise ValueError('图片任务标识无效')
        if not all(re.fullmatch(r'[a-f0-9]{64}', identity[k]) for k in ('binding', 'channel')):
            raise ValueError('图片任务来源无效')
        self.output = Path(identity['output'])
        if not self.output.is_absolute() or self.output.stem != identity['jobId']:
            raise ValueError('图片任务输出无效')
        self.directory = self.output.parent.parent / '_artifacts' / 'image-provider-receipts'
        self.path = self.directory / (identity['jobId'] + '.json')

    @classmethod
    def for_job(cls, outputs, row):
        data = json.loads(row['data'])
        binding = hashlib.sha256(json.dumps([row['id'], row['fingerprint'], row['config']]).encode()).hexdigest()
        return cls({'schema': 1, 'jobId': row['id'], 'binding': binding, 'channel': row['config'],
                    'model': data['model'], 'n': data['n'],
                    'output': str(Path(outputs) / 'AI生图' / (row['id'] + '.png'))})

    def _directory(self):
        if any(p.is_symlink() for p in (self.path, self.directory, self.directory.parent, self.output.parent)):
            raise ValueError('图片任务记录路径无效')
        self.directory.mkdir(parents=True, exist_ok=True)

    def read(self):
        if any(p.is_symlink() for p in (self.path, self.directory, self.directory.parent, self.output.parent)):
            raise ValueError('图片任务记录路径无效')
        if not self.path.exists():
            return None
        if self.path.stat().st_size > 128 * 1024:
            raise ValueError('图片任务记录过大')
        data = json.loads(self.path.read_text(encoding='utf-8'))
        if not isinstance(data, dict) or any(data.get(k) != v for k, v in self.identity.items()):
            raise ValueError('图片任务记录与原请求不符')
        if data.get('stage') not in ('submitting', 'accepted', 'downloading', 'saved', 'failed', 'abandoned'):
            raise ValueError('图片任务记录状态无效')
        task = data.get('taskId')
        if task is not None and (not isinstance(task, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}', task)):
            raise ValueError('供应商任务标识无效')
        return data

    def write(self, **values):
        self._directory()
        current = self.read() or self.identity
        data = {**current, **values, 'updatedAt': time.time()}
        descriptor, name = tempfile.mkstemp(prefix=self.path.stem + '-', suffix='.tmp', dir=self.directory)
        try:
            with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
                json.dump(data, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            replace(name, self.path)
        finally:
            Path(name).unlink(missing_ok=True)

    def saved(self, paths):
        if len(paths) != self.identity['n']:
            raise ValueError('供应商返回图片数量与请求不符，未标记交付完成')
        files = []
        for value in paths:
            path = Path(value)
            if path.is_symlink() or path.parent.resolve() != self.output.parent.resolve() or not path.name.startswith(self.output.stem):
                raise ValueError('图片文件与原任务不符')
            files.append({'name': path.name, 'sha256': file_digest(path)})
        self.write(stage='saved', files=files)

    def saved_files(self, data):
        files = data.get('files')
        if not isinstance(files, list) or len(files) != self.identity['n']:
            raise ValueError('图片文件记录不完整')
        result = []
        for item in files:
            if not isinstance(item, dict) or not isinstance(item.get('sha256'), str) or not re.fullmatch(r'[a-f0-9]{64}', item['sha256']):
                raise ValueError('图片文件校验记录无效')
            name = item.get('name')
            if not isinstance(name, str) or Path(name).name != name or not name.startswith(self.output.stem):
                raise ValueError('图片文件记录路径无效')
            path = self.output.parent / name
            if path.is_symlink() or file_digest(path) != item['sha256']:
                raise ValueError('已保存图片发生变化，请核对原任务')
            result.append(path)
        if len(set(result)) != len(result):
            raise ValueError('图片文件记录重复')
        return result

    @contextmanager
    def lock(self):
        self._directory()
        lock_path = self.path.with_suffix('.lock')
        if lock_path.is_symlink():
            raise ValueError('图片任务锁路径无效')
        with lock_path.open('a+b') as stream:
            if os.name == 'nt':
                import msvcrt
                stream.seek(0, 2)
                if stream.tell() == 0:
                    stream.write(b'0'); stream.flush()
                stream.seek(0)
                try:
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                except OSError as exc:
                    raise CheckpointBusy() from exc
            else:
                import fcntl
                try:
                    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError as exc:
                    raise CheckpointBusy() from exc
            try:
                yield
            finally:
                if os.name == 'nt':
                    stream.seek(0)
                    msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(stream, fcntl.LOCK_UN)
