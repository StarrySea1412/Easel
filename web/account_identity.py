"""Last confirmed display identity, separate from live authentication evidence."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import uuid
from urllib.parse import urlsplit


def display_identity(value: dict) -> dict:
    name = value.get('name')
    avatar = value.get('avatar')
    if not isinstance(name, str):
        name = ''
    if not isinstance(avatar, str):
        avatar = ''
    try:
        url = urlsplit(avatar)
        if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password:
            avatar = ''
    except ValueError:
        avatar = ''
    result = {'name': name.strip()[:100], 'avatar': avatar[:4096]}
    account_id = value.get('accountId')
    if isinstance(account_id, str) and account_id and len(account_id) <= 200:
        result['accountId'] = account_id
    return result


def merge_identity(previous: dict, current: dict) -> dict:
    previous, current = display_identity(previous), display_identity(current)
    changed = (previous.get('accountId') and current.get('accountId')
               and previous['accountId'] != current['accountId'])
    renamed = previous['name'] and current['name'] and previous['name'] != current['name']
    if changed or renamed:
        return current
    return {key: current.get(key) or previous.get(key, '') for key in set(previous) | set(current)}


class AccountIdentityStore:
    def __init__(self, root: Path):
        self.root = root

    def _path(self, platform: str, suffix: str) -> Path:
        if not re.fullmatch(r'[a-z][a-z0-9-]{0,63}', platform):
            raise ValueError('Invalid account platform')
        return self.root / (platform + suffix)

    def _write(self, path: Path, value: str) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
        try:
            temporary.write_text(value, encoding='utf-8')
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def key(self, platform: str, credential: Path | None, *, cookie: bool = False) -> str:
        try:
            epoch = self._path(platform, '.epoch').read_text(encoding='utf-8')
        except OSError:
            epoch = ''
        signature = [str(self.root.resolve()), platform, epoch]
        if credential is not None:
            signature.append(str(credential.resolve()))
            try:
                stat = credential.stat()
                signature.extend([stat.st_dev, stat.st_ino])
                if cookie:
                    signature.extend([stat.st_mtime_ns, stat.st_size])
            except OSError:
                signature.append('missing')
        return hashlib.sha256(json.dumps(signature).encode()).hexdigest()

    def read(self, platform: str, key: str) -> dict:
        try:
            value = json.loads(self._path(platform, '.json').read_text(encoding='utf-8'))
            if not isinstance(value, dict) or value.get('identityKey') != key:
                return {}
            identity = display_identity(value)
            if not identity['name'] and not identity['avatar']:
                return {}
            at = value.get('checkedAt')
            return {**identity, 'identityKey': key, 'loggedIn': True, 'verified': False,
                    'authState': 'unknown',
                    **({'checkedAt': at} if type(at) in (int, float) and 0 <= at < float('inf') else {})}
        except (OSError, ValueError):
            return {}

    def save(self, platform: str, key: str, value: dict) -> None:
        identity = display_identity(value)
        if not identity['name'] and not identity['avatar']:
            return
        try:
            self._write(self._path(platform, '.json'), json.dumps(
                {**identity, 'identityKey': key, 'checkedAt': value['checkedAt']}, ensure_ascii=False))
        except OSError:
            pass  # A display cache failure cannot change the live authentication result.

    def clear(self, platform: str, *, rotate: bool = False) -> None:
        if rotate:
            self._write(self._path(platform, '.epoch'), uuid.uuid4().hex)
        self._path(platform, '.json').unlink(missing_ok=True)
