"""Copy only declared Qizhi outputs into the real session artifact store.

No inference, remote shell, arbitrary URL fetch, or recursive project import.
The original assistant text stays intact; a verified mapping resolves its links.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import uuid
from urllib.parse import unquote, urlsplit

from .artifacts import ArtifactStore, file_path, inspect_file, scope, MAX_FILE
from .harnesses.base import HarnessError
from .harnesses.qizhi import config
from .harnesses.store import write_json
from .qizhi_files import QizhiFiles, output_path

MAX_LINKS = 8
_SYNCING = set()
LINK = re.compile(r'\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"\n]*")?\s*\)')
OUTSIDE = '远端路径不在可下载的 outputs/ 目录内；需在 Qizhi 将原有文件导出到 outputs/ 后同步，无需重新生成。'


def target_identity(env):
    base, project, model, key = config(env)
    return hashlib.sha256(json.dumps([base, project, model, key]).encode()).hexdigest()


def instructions(turn):
    scope(turn)
    directory = 'outputs/easel-' + turn + '/'
    return ('\n\n[Easel 远端文件交付]\n仅在任务需要交付文件时，将实际产物保存到 '
            + directory + '，使用 ASCII 文件名，回复逐项提供 Markdown 相对文件链接。'
            '已有文件可复制导出到该目录，不要重新生成或重复付费。'
            '仅声称已实际写入并检查存在的文件；Easel 会下载原始字节并核验后交付。'
            '不要返回项目根目录绝对路径、sandbox 链接或只写计划而声称完成。')


def references(text, project):
    rows = []
    seen = set()
    visible = re.sub(r'```[\s\S]*?```|`[^`\n]*`', '', text)
    for match in LINK.finditer(visible):
        href = match.group(1) or match.group(2)
        if href in seen:
            continue
        try:
            parsed = urlsplit(href)
        except ValueError:
            continue
        if parsed.scheme or parsed.netloc:
            continue
        if parsed.fragment.startswith('/outputs/'):
            path = 'outputs/' + unquote(parsed.fragment[len('/outputs/'):])
        elif parsed.fragment or parsed.query:
            continue
        else:
            path = unquote(parsed.path)
        if path.startswith(project.rstrip('/') + '/'):
            path = path[len(project.rstrip('/')) + 1:]
        elif path.startswith('./outputs/'):
            path = path[2:]
        elif not path.startswith(('outputs/', '/')):
            continue
        seen.add(href)
        try:
            relative = output_path(path)
            if any(part.startswith(('.', '_')) for part in PurePosixPath(relative).parts[1:]):
                raise HarnessError('成果不能引用远端系统或隐藏文件。')
            row = {'href': href, 'remotePath': relative, 'status': 'pending',
                   'message': '远端文件尚未同步到当前内容库'}
        except HarnessError:
            row = {'href': href, 'status': 'unsupported', 'message': OUTSIDE}
        if len(rows) >= MAX_LINKS:
            row = {'href': href, 'status': 'limited', 'message': '单轮最多同步 8 个文件，请在 Qizhi 打包后交付。'}
        rows.append(row)
        if len(rows) >= 40:
            break
    return rows


def manifest_path(outputs, session, turn):
    scope(session); scope(turn)
    digest = hashlib.sha256((session + '\0' + turn).encode()).hexdigest()
    return Path(outputs) / '_harness' / 'qizhi-deliveries' / (digest + '.json')


def status(outputs, session, turn, text, env):
    _, project, _, _ = config(env)
    source = hashlib.sha256(text.encode()).hexdigest()
    rows = references(text, project)
    try:
        saved = json.loads(manifest_path(outputs, session, turn).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        saved = {}
    if not isinstance(saved, dict):
        saved = {}
    cached = {row['href']: row for row in saved.get('links', []) if isinstance(row, dict) and isinstance(row.get('href'), str)} if saved.get('source') == source and saved.get('target') == target_identity(env) else {}
    for row in rows:
        old = cached.get(row['href'])
        if old and old.get('approvedExport') is True:
            try:
                exported = output_path(old.get('remotePath'))
                expected = old.get('expectedSha256', '')
                if not re.fullmatch(r'[0-9a-f]{64}', expected):
                    raise HarnessError('原文件校验值无效')
                row.update(remotePath=exported, expectedSha256=expected, approvedExport=True,
                           status='pending', message='原文件已导出，尚需同步到当前内容库。')
            except (HarnessError, TypeError):
                continue
        if old and old.get('localPath') and old.get('sha256'):
            try:
                info = inspect_file(outputs, file_path(outputs, old['localPath'])[1])
                if info.get('status') == 'ready' and info.get('contentSha256') == old['sha256']:
                    row.update(status='ready', localPath=old['localPath'], sha256=old['sha256'], message='')
                    continue
            except (ValueError, OSError):
                pass
        if old and row['status'] == 'pending':
            row.update(status='pending', message='远端文件尚未同步或本地文件已变化，请重新检查文件。')
    return {'sessionId': session, 'turnId': turn, 'runtime': 'qizhi', 'source': source,
            'target': target_identity(env), 'links': rows}


async def sync(outputs, session, turn, text, env):
    key = str(manifest_path(outputs, session, turn))
    if key in _SYNCING:
        raise HarnessError('本轮文件正在同步，请稍后重新检查。')
    _SYNCING.add(key)
    try:
        return await _sync(outputs, session, turn, text, env)
    finally:
        _SYNCING.discard(key)


async def _sync(outputs, session, turn, text, env):
    result = status(outputs, session, turn, text, env)
    client = QizhiFiles(env)
    total = 0
    store = ArtifactStore(outputs)
    for row in result['links']:
        if row['status'] != 'pending':
            continue
        if total >= 128 * 1024 * 1024:
            row.update(status='limited', message='本轮文件已达到 128 MiB 同步上限，请分批交付。')
            continue
        relative = row['remotePath']
        destination = Path(outputs) / 'Qizhi' / turn / uuid.uuid4().hex[:12] / PurePosixPath(relative).name
        downloaded = False
        try:
            file_path(outputs, str(destination))
            await asyncio.wait_for(client.download(relative, destination, max_bytes=MAX_FILE), timeout=25)
            downloaded = True
            if destination.stat().st_size == 0:
                raise HarnessError('远端返回空文件，未交付')
            if row.get('expectedSha256') and hashlib.sha256(destination.read_bytes()).hexdigest() != row['expectedSha256']:
                raise HarnessError('原文件哈希不一致，未交付')
            store.bind(session, turn)
            artifact = store.present(session, turn, [{'path': str(destination), 'description': '来自 Qizhi 远端原文件'}], source='qizhi-sync')[0]
            total += destination.stat().st_size
            row.update(status='ready', localPath=artifact['path'], sha256=artifact['contentSha256'], message='')
        except (HarnessError, OSError, ValueError, asyncio.TimeoutError):
            if downloaded:
                destination.unlink(missing_ok=True)
            row.update(status='unavailable', message='远端文件尚未取回；可能已移动、下载受限或连接失败。可重新检查，不会重跑 Agent。')
        write_json(manifest_path(outputs, session, turn), result)
    return result


def public(result):
    return {key: value for key, value in result.items() if key not in ('target', 'source')}
