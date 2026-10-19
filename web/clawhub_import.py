"""Download pinned official archives as files only; never execute install hooks."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import shutil
import stat
import tempfile
import zipfile

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from web.clawhub import ClawHubClient, ORIGIN
from easel.imported_skills import installed, local_name

MAX_ZIP = 8 * 1024 * 1024
MAX_EXPANDED = 32 * 1024 * 1024
MAX_FILES = 256


class ImportRequest(BaseModel):
    owner: str = Field(pattern=r'^[a-z0-9][a-z0-9_.-]{0,99}$')
    version: str = Field(min_length=1, max_length=128, pattern=r'^[A-Za-z0-9][A-Za-z0-9._+-]*$')


def unpack(data: bytes) -> dict[str, bytes]:
    """Inspect every entry before writing, including duplicates and Unix symlinks."""
    if len(data) > MAX_ZIP:
        raise ValueError('技能压缩包超过8MiB，未导入')
    result, names, size = {}, set(), 0
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_FILES:
                raise ValueError('技能文件过多，未导入')
            for info in entries:
                name = info.filename.rstrip('/')
                path = PurePosixPath(name)
                mode = info.external_attr >> 16
                if (not name or path.is_absolute() or '\\' in info.orig_filename or ':' in name
                        or any(ord(c) < 32 for c in info.orig_filename)
                        or any(p in ('', '.', '..') or p.startswith('.') or p.rstrip(' .') != p for p in name.split('/'))
                        or stat.S_ISLNK(mode) or (stat.S_IFMT(mode) and not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)))
                        or len(name) > 240 or name.casefold() in names or info.flag_bits & 1):
                    raise ValueError('技能压缩包包含不安全路径或特殊文件，未导入')
                names.add(name.casefold())
                if info.is_dir():
                    continue
                size += info.file_size
                if info.file_size > 8 * 1024 * 1024 or size > MAX_EXPANDED:
                    raise ValueError('技能解压体积过大，未导入')
                result[name] = archive.read(info)
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError) as exc:
        raise ValueError('技能压缩包无法读取，未导入') from exc
    if 'SKILL.md' not in result:
        raise ValueError('技能压缩包缺少根目录SKILL.md，未导入')
    if len(result['SKILL.md']) > 1024 * 1024:
        raise ValueError('技能说明过大，未导入')
    try:
        if not result['SKILL.md'].decode('utf-8-sig').strip():
            raise ValueError('技能说明为空，未导入')
    except UnicodeDecodeError as exc:
        raise ValueError('技能说明不是UTF-8，未导入') from exc
    return result


class SkillImporter:
    def __init__(self, data: Path, bundled: Path, client=None):
        self.data, self.bundled = data, bundled
        self.client = client or ClawHubClient()
        self.lock = asyncio.Lock()

    async def download(self, slug: str, version: str):
        try:
            async with httpx.AsyncClient(transport=self.client._transport, trust_env=False,
                    follow_redirects=False, timeout=httpx.Timeout(30, connect=5)) as client:
                async with client.stream('GET', ORIGIN + '/api/v1/download', params={'slug': slug, 'version': version}) as r:
                    if r.status_code == 429:
                        raise HTTPException(429, 'ClawHub下载限流，请稍后重试')
                    if r.status_code != 200:
                        raise HTTPException(502, 'ClawHub技能下载失败，请重试')
                    if r.headers.get('content-type', '').split(';')[0].strip() not in ('application/zip', 'application/octet-stream'):
                        raise HTTPException(502, 'ClawHub没有返回技能压缩包')
                    chunks, size = [], 0
                    async for chunk in r.aiter_bytes():
                        size += len(chunk)
                        if size > MAX_ZIP:
                            raise HTTPException(413, '技能压缩包超过8MiB，未导入')
                        chunks.append(chunk)
                    return b''.join(chunks)
        except httpx.TimeoutException:
            raise HTTPException(504, 'ClawHub下载超时，请重试') from None
        except httpx.RequestError:
            raise HTTPException(502, '无法连接ClawHub下载服务，请重试') from None

    async def import_skill(self, slug: str, owner: str, version: str):
        detail = await self.client.detail(slug, owner)
        actual = detail['skill']
        if actual['version'] != version:
            raise HTTPException(409, '技能版本已更新，请刷新详情后重新选择')
        moderation = detail.get('moderation') or {}
        if moderation.get('isMalwareBlocked') or moderation.get('isSuspicious'):
            raise HTTPException(409, 'ClawHub已标记该技能存在风险，无法直接导入选择')
        name = local_name(owner, slug)
        async with self.lock:
            current = installed(self.data).get(name)
            if current:
                if current.get('version') != version:
                    raise HTTPException(409, '已安装其他版本，保留原文件；请先在技能库核对版本')
                return {'name': name, 'displayName': current.get('displayName', slug), 'version': version, 'alreadyInstalled': True}
            if (self.bundled / name).exists():
                raise HTTPException(409, '技能名称与内置技能冲突，未导入')
            archive = await asyncio.wait_for(self.download(slug, version), timeout=40)
            try:
                files = await asyncio.to_thread(unpack, archive)
                return await asyncio.to_thread(self.store, name, actual, files, archive)
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from None
            except OSError:
                raise HTTPException(503, '技能文件无法保存，未选中；请检查磁盘或目录权限后重试') from None

    def store(self, name, skill, files, archive):
        root = self.data / 'clawhub-skills'
        if root.is_symlink():
            raise ValueError('技能目录不可用，未导入')
        root.mkdir(parents=True, exist_ok=True)
        target = root / name
        if target.exists() or target.is_symlink():
            raise ValueError('技能目录已存在，保留原文件，未覆盖')
        staging = Path(tempfile.mkdtemp(prefix='.import-', dir=root))
        try:
            for path, body in files.items():
                dest = staging / path
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(body)
                dest.chmod(0o600)
            receipt = {'source': 'clawhub', 'owner': skill['ownerHandle'], 'slug': skill['slug'],
                'version': skill['version'], 'displayName': skill['displayName'],
                'archiveSha256': hashlib.sha256(archive).hexdigest(),
                'importedAt': datetime.now(timezone.utc).isoformat(),
                'files': {path: hashlib.sha256(body).hexdigest() for path, body in files.items()}}
            (staging / '.clawhub-source.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')
            staging.rename(target)
            return {'name': name, 'displayName': skill['displayName'], 'version': skill['version'], 'alreadyInstalled': False}
        finally:
            if staging.exists():
                shutil.rmtree(staging)


def create_router(data, bundled):
    service = SkillImporter(data, bundled)
    router = APIRouter()

    @router.post('/api/clawhub/skills/{slug}/import')
    async def import_skill(slug: str, body: ImportRequest):
        try:
            return await service.import_skill(slug, body.owner, body.version)
        except asyncio.TimeoutError:
            raise HTTPException(504, '技能导入超时，请重试') from None

    return router
