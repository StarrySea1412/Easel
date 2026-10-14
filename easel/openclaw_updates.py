"""Read the selected runtime and bounded official OpenClaw release information."""
from __future__ import annotations

import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.request import Request, urlopen

from easel.openclaw_cmd import openclaw_base_cmd

VERSION = re.compile(r'^\d{4}\.\d{1,2}\.\d{1,2}(?:-[A-Za-z0-9.-]+)?$')
REGISTRY = 'https://registry.npmjs.org/openclaw/latest'
_cache: dict = {}
_notes_cache: dict = {}
_lock = threading.Lock()


def version_key(value: str) -> tuple:
    core, _, suffix = value.partition('-')
    return (*map(int, core.split('.')), not bool(suffix), suffix)


def _read_public(url: str, limit: int) -> str:
    with urlopen(Request(url, headers={'User-Agent': 'Easel-version-check/1'}), timeout=8) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError('Official response exceeds the size limit')
    return data.decode('utf-8')


def installed_runtime() -> dict:
    try:
        command = openclaw_base_cmd()
        entry = Path(command[-1]).resolve()
        package = entry.parent / 'package.json'
        value = json.loads(package.read_text(encoding='utf-8'))
        version = value.get('version', '')
        if value.get('name') != 'openclaw' or not VERSION.fullmatch(version):
            raise ValueError('Invalid installed package metadata')
        return {'installedVersion': version, 'installedPath': str(entry), 'installedState': 'ok'}
    except FileNotFoundError:
        return {'installedVersion': None, 'installedPath': None, 'installedState': 'missing'}
    except (OSError, ValueError, IndexError):
        return {'installedVersion': None, 'installedPath': None, 'installedState': 'unknown'}


def update_info(refresh=False) -> dict:
    installed = installed_runtime()
    with _lock:
        if not refresh and _cache and time.monotonic() - _cache['time'] < 900:
            return _with_update(installed, _cache['value'])
        result = {'latestVersion': None, 'latestState': 'unavailable', 'releaseUrl': None,
                  'registryUrl': REGISTRY, 'checkedAt': int(time.time()),
                  'releases': [], 'notesState': 'unavailable', 'notesTruncated': False}
        try:
            value = json.loads(_read_public(REGISTRY, 262144))
            latest = value.get('version', '')
            if not VERSION.fullmatch(latest):
                raise ValueError('Invalid official version')
            result.update(latestVersion=latest, latestState='ok',
                          releaseUrl=f'https://github.com/openclaw/openclaw/releases/tag/v{latest}')
        except Exception:
            result['latestError'] = '官方最新版本暂时无法查询，请稍后重新检测。'
        _cache.update(time=time.monotonic(), value=result)
        return _with_update(installed, result)


def _with_update(installed: dict, result: dict) -> dict:
    current, latest = installed.get('installedVersion'), result.get('latestVersion')
    return {**installed, **result, 'updateAvailable': bool(current and latest and version_key(latest) > version_key(current))}


def release_notes() -> dict:
    result = update_info()
    latest = result.get('latestVersion')
    if not latest:
        return result
    current = result.get('installedVersion')
    if current and version_key(current) >= version_key(latest):
        return {**result, 'notesState': 'empty'}
    cache_key = (current, latest)
    with _lock:
        cached = _notes_cache.get(cache_key)
        if cached and time.monotonic() - cached['time'] < 900:
            return {**result, **cached['value']}
    try:
        base = f'https://raw.githubusercontent.com/openclaw/openclaw/v{latest}/'
        index = _read_public(base + 'CHANGELOG.md', 262144)
        versions = list(dict.fromkeys(re.findall(r'\[(\d{4}\.\d{1,2}\.\d{1,2})\]\(CHANGELOG/', index)))
        result['rangeIncomplete'] = current not in versions
        versions = [version for version in versions if version_key(version) <= version_key(latest)
                    and (not current or version_key(version) > version_key(current))]
        versions.sort(key=version_key, reverse=True)
        if not versions:
            raise ValueError('Official release index has no applicable entries')
        result['notesTruncated'] = len(versions) > 8
        def read_release(version):
            source = base + f'CHANGELOG/{version}.md'
            try:
                text = _read_public(source, 1048576)
                return {'version': version, 'sourceUrl': source, 'text': text[:14000], 'truncated': len(text) > 14000}
            except Exception:
                return {'version': version, 'sourceUrl': source, 'text': '', 'truncated': False, 'unavailable': True}
        with ThreadPoolExecutor(max_workers=4) as executor:
            releases = list(executor.map(read_release, versions[:8]))
        failed = any(release.get('unavailable') for release in releases)
        result.update(releases=releases, notesState='partial' if failed else 'ok')
    except Exception:
        result.update(notesState='unavailable', notesError='官方更新记录暂时无法读取；不能据版本号判断更新收益。')
    with _lock:
        _notes_cache.clear()
        _notes_cache[cache_key] = {'time': time.monotonic(), 'value': {key: result[key] for key in
            ('releases', 'notesState', 'notesTruncated', 'rangeIncomplete', 'notesError') if key in result}}
    return result
