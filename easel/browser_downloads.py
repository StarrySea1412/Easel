"""Bounded browser downloads, including a Chromium sidecar on another filesystem."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import time
import unicodedata
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, ProxyHandler, HTTPRedirectHandler, build_opener
import zipfile

from .attachment_refs import attachment_id, attachment_scope

MAX_FILE = 100 * 1024 * 1024
MAX_SESSION = 300 * 1024 * 1024
MAX_TOTAL = 600 * 1024 * 1024
GUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z')
EXTENSIONS = {'.pdf', '.docx', '.pptx', '.xlsx', '.zip', '.png', '.jpg', '.jpeg', '.webp', '.gif',
              '.mp4', '.webm', '.mp3', '.wav', '.m4a', '.txt', '.md', '.csv', '.json', '.srt'}


def safe_source(url):
    parsed = urlsplit(url)
    return urlunsplit((parsed.scheme, parsed.netloc.split('@')[-1], parsed.path, '', ''))[:2000]


def safe_name(value):
    value = ''.join(c for c in value if not unicodedata.category(c).startswith('C'))
    value = re.sub(r'[<>:"/\\|?*]', '_', value).strip(' .')[:160] or 'download'
    if value.split('.')[0].upper() in {'CON', 'PRN', 'AUX', 'NUL', *{f'COM{i}' for i in range(10)}, *{f'LPT{i}' for i in range(10)}}:
        value = '_' + value
    suffix = Path(value).suffix.lower()
    if suffix and suffix not in EXTENSIONS:
        raise ValueError('此文件类型暂不支持自动保存。')
    return value


def validate_file(path, name):
    with path.open('rb') as stream:
        head = stream.read(8192)
    if not head or head.lstrip(b'\xef\xbb\xbf \r\n\t').lower().startswith((b'<!doctype html', b'<html', b'<head', b'<body')):
        raise ValueError('下载内容为空或返回了网页，未作为文件保存。')
    kind = ('.pdf' if head.startswith(b'%PDF-') else '.png' if head.startswith(b'\x89PNG\r\n\x1a\n')
            else '.jpg' if head.startswith(b'\xff\xd8\xff') else '.gif' if head.startswith((b'GIF87a', b'GIF89a'))
            else '.webp' if head[:4] == b'RIFF' and head[8:12] == b'WEBP'
            else '.wav' if head[:4] == b'RIFF' and head[8:12] == b'WAVE'
            else '.mp4' if head[4:8] == b'ftyp' else '.webm' if head.startswith(b'\x1aE\xdf\xa3')
            else '.mp3' if head.startswith(b'ID3') or len(head) > 1 and head[0] == 255 and head[1] & 224 == 224
            else '.zip' if head.startswith(b'PK\x03\x04') else '')
    suffix = Path(name).suffix.lower()
    if not suffix:
        if not kind:
            raise ValueError('无法确认文件类型，请选择有明确格式的下载入口。')
        name += kind
        suffix = kind
    equivalent = {'.jpeg': '.jpg', '.m4a': '.mp4', '.docx': '.zip', '.pptx': '.zip', '.xlsx': '.zip'}
    if suffix in {'.txt', '.md', '.csv', '.json', '.srt'}:
        if b'\x00' in head:
            raise ValueError('文件内容与文本格式不符。')
        head.decode('utf-8-sig')
    elif equivalent.get(suffix, suffix) != kind:
        raise ValueError('文件内容与扩展名不符，未保存为成功下载。')
    if suffix in {'.zip', '.docx', '.pptx', '.xlsx'}:
        with zipfile.ZipFile(path) as archive:
            names = set(archive.namelist())
            required = {'.docx': 'word/document.xml', '.pptx': 'ppt/presentation.xml', '.xlsx': 'xl/workbook.xml'}.get(suffix)
            if len(names) > 10000 or required and (required not in names or '[Content_Types].xml' not in names):
                raise ValueError('压缩包或Office文件结构不符。')
    return name


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_):
        return None


class BrowserDownloads:
    def __init__(self, service):
        self.service = service
        self.cdp = None
        self.temp = tempfile.TemporaryDirectory(prefix='easel-downloads-')
        self.remote = os.environ.get('EASEL_BROWSER_CDP_ENDPOINT', '').rstrip('/')
        self.folder = '/tmp/easel-downloads' if self.remote else self.temp.name
        self.contexts = {}
        self.frames = {}
        self.active = {}
        self.early_progress = {}
        self.changed = asyncio.Event()
        self.tasks = set()
        self.save_lock = asyncio.Lock()

    def spawn(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    async def bind(self, session, tab):
        if not self.cdp:
            self.cdp = await self.service.browser.new_browser_cdp_session()
            self.cdp.on('Browser.downloadWillBegin', lambda event: self.spawn(self.begin(event)))
            self.cdp.on('Browser.downloadProgress', self.progress)
        info = (await tab.cdp.send('Target.getTargetInfo'))['targetInfo']
        context_id = info.get('browserContextId')
        if not context_id:
            raise ValueError('Downloads require an isolated browser context')
        if context_id not in self.contexts:
            await self.cdp.send('Browser.setDownloadBehavior', {'behavior': 'allowAndName',
                'browserContextId': context_id, 'downloadPath': self.folder, 'eventsEnabled': True})
            self.contexts[context_id] = session
        tree = (await tab.cdp.send('Page.getFrameTree'))['frameTree']
        def remember(node):
            self.frames[node['frame']['id']] = (session, tab, context_id)
            for child in node.get('childFrames', []): remember(child)
        remember(tree)
        tab.cdp.on('Page.frameAttached', lambda event: self.frames.update({event['frameId']: (session, tab, context_id)}))

    async def begin(self, event):
        from .browser_runtime import now
        guid = event.get('guid', '')
        owner = self.frames.get(event.get('frameId'))
        if not GUID.fullmatch(guid) or not owner:
            # Browser contexts not registered to Easel never acquire file access.
            return
        session, tab, context_id = owner
        if len(session.downloads) >= 40:
            await self.cdp.send('Browser.cancelDownload', {'guid': guid, 'browserContextId': context_id})
            await self.cleanup(guid)
            self.service._event(session, 'download', 'failed', tab.id, message='当前会话已达40个下载记录上限。')
            return
        record = {'id': guid, 'tabId': tab.id, 'name': 'download', 'state': 'receiving', 'bytes': 0,
                  'sourceUrl': safe_source(tab.page.url), 'createdAt': now()}
        session.downloads.append(record)
        record['name'] = (event.get('suggestedFilename') or 'download')[:180]
        item = self.active[guid] = {'record': record, 'session': session, 'context': context_id, 'started': time.monotonic()}
        item['timer'] = asyncio.get_running_loop().call_later(120, lambda: self.spawn(self.fail(guid, '下载超时，未完成文件已取消。')))
        try:
            record['name'] = safe_name(record['name'])
            if len(self.active) > 2:
                raise ValueError('下载数量已达上限，请完成当前下载或使用新会话。')
            url = event.get('url', '')
            if not url.startswith(('blob:', 'data:')):
                await self.service._validate_url(url)
        except Exception as error:
            await self.fail(guid, str(error) if isinstance(error, ValueError) else '下载来源无法确认。')
            return
        self.service._event(session, 'download', 'receiving', tab.id, message=record['name'])
        self.changed.set()
        early = self.early_progress.pop(guid, None)
        if early: self.progress(early)

    def progress(self, event):
        guid = event.get('guid')
        item = self.active.get(guid)
        if not item:
            if len(self.early_progress) >= 64: self.early_progress.pop(next(iter(self.early_progress)))
            self.early_progress[guid] = event
            return
        record = item['record']
        record['bytes'] = int(event.get('receivedBytes', 0))
        if record['state'] not in {'receiving'}: return
        if max(record['bytes'], event.get('totalBytes', 0)) > MAX_FILE:
            record['state'] = 'cancelling'
            self.spawn(self.fail(guid, '单个文件超过100MB限制，已取消。'))
        elif event.get('state') == 'completed':
            record['state'] = 'saving'
            self.spawn(self.finish(guid))
        elif event.get('state') == 'canceled':
            record['state'] = 'cancelling'
            self.spawn(self.fail(guid, '网页下载已取消或连接中断。'))

    def remote_request(self, guid, method='GET'):
        auth = json.loads(Path(os.environ['EASEL_BROWSER_AUTH_FILE']).read_text(encoding='utf-8'))
        token = base64.b64encode((auth['username'] + ':' + auth['password']).encode()).decode()
        return build_opener(ProxyHandler({}), NoRedirect()).open(Request(
            self.remote + '/easel-downloads/' + guid, method=method, headers={'Authorization': 'Basic ' + token}), timeout=15)

    def copy(self, guid, session, record):
        scope = attachment_scope(session.id)
        folder = self.service.outputs / '_inbox' / scope / ('download-' + guid)
        folder.mkdir(parents=True, exist_ok=True)
        part = folder / '.part'
        try:
            stream = self.remote_request(guid) if self.remote else (Path(self.folder) / guid).open('rb')
            size, digest, started = 0, hashlib.sha256(), time.monotonic()
            with stream, part.open('xb') as output:
                while chunk := stream.read(65536):
                    size += len(chunk)
                    if size > MAX_FILE: raise ValueError('单个文件超过100MB限制。')
                    if time.monotonic() - started > 120: raise ValueError('文件传输超时。')
                    digest.update(chunk)
                    output.write(chunk)
            name = validate_file(part, record['name'])
            own_files = list(self.service.outputs.glob('_inbox/*/download-*/*'))
            total = sum(p.stat().st_size for p in own_files if p.is_file())
            scoped = sum(p.stat().st_size for p in own_files if p.is_file() and p.parent.parent.name == scope)
            if total > MAX_TOTAL or scoped > MAX_SESSION:
                raise ValueError('网页下载存储已达上限，请先整理已有文件。')
            path = folder / name
            part.replace(path)
            relative = path.relative_to(self.service.outputs).as_posix()
            return {'id': attachment_id(scope, relative), 'path': relative, 'name': name}, size, digest.hexdigest()
        finally:
            part.unlink(missing_ok=True)

    async def cleanup(self, guid):
        try:
            if self.remote:
                def remove():
                    with self.remote_request(guid, 'DELETE'): pass
                await asyncio.to_thread(remove)
            else:
                (Path(self.folder) / guid).unlink(missing_ok=True)
                (Path(self.folder) / (guid + '.crdownload')).unlink(missing_ok=True)
        except Exception:
            pass  # Sidecar scratch storage is ephemeral and bounded by its tmpfs.

    async def finish(self, guid):
        from .browser_runtime import now
        item = self.active.get(guid)
        if not item: return
        try:
            async with self.save_lock:
                file, size, digest = await asyncio.to_thread(self.copy, guid, item['session'], item['record'])
            item['record'].update(state='completed', file=file, name=file['name'], bytes=size, sha256=digest, finishedAt=now())
            self.service._event(item['session'], 'download', 'completed', item['record']['tabId'], message=file['name'])
        except Exception as error:
            item['record'].update(state='failed', error=str(error) if isinstance(error, ValueError) else '文件保存失败，请检查下载服务与存储。', finishedAt=now())
            self.service._event(item['session'], 'download', 'failed', item['record']['tabId'], message=item['record']['error'])
        finally:
            item['timer'].cancel()
            self.active.pop(guid, None)
            await self.cleanup(guid)
            self.changed.set()

    async def fail(self, guid, message):
        from .browser_runtime import now
        item = self.active.get(guid)
        if not item: return
        # A completed transport may still be copying into the application.
        if item['record']['state'] == 'saving': return
        self.active.pop(guid, None)
        item['timer'].cancel()
        try:
            await self.cdp.send('Browser.cancelDownload', {'guid': guid, 'browserContextId': item['context']})
        except Exception: pass
        item['record'].update(state='failed', error=message, finishedAt=now())
        self.service._event(item['session'], 'download', 'failed', item['record']['tabId'], message=message)
        await self.cleanup(guid)
        self.changed.set()

    async def wait_started(self, session, tab, before):
        async def wait():
            while True:
                self.changed.clear()
                rows = [r for r in session.downloads if r['id'] not in before and r['tabId'] == tab.id]
                if rows: return rows
                await self.changed.wait()
        return await asyncio.wait_for(wait(), 8)

    async def close_session(self, session):
        for guid, item in list(self.active.items()):
            if item['session'] is session:
                await self.fail(guid, '浏览器会话已关闭，下载中断。')
        for frame, owner in list(self.frames.items()):
            if owner[0] is session: self.frames.pop(frame, None)
        for context, owner in list(self.contexts.items()):
            if owner is session: self.contexts.pop(context, None)

    async def close(self):
        if self.tasks: await asyncio.gather(*self.tasks, return_exceptions=True)
        self.temp.cleanup()
