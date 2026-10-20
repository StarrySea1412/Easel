"""Session-owned browser pages shared by the UI, Codex tools and local bridge.

Playwright lives on one dedicated event loop. HTTP connections and chat turns
never own its lifetime; cancelling an operation never means rolling back a site.
"""
from __future__ import annotations

import asyncio
import base64
from contextlib import asynccontextmanager
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import threading
import time
from urllib.parse import urlsplit
import uuid

from .browser_observation import OBSERVE, ELEMENT_NAME, READ_FAVICON
from .execution import public_text


class BrowserError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def identity(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,120}', value):
        raise BrowserError('会话或标签标识无效。')
    return value


def origin(url):
    parsed = urlsplit(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
        raise BrowserError('请输入不含账号密码的HTTP或HTTPS地址。')
    try:
        port = parsed.port
    except ValueError:
        raise BrowserError('网页端口无效。') from None
    host = parsed.hostname.lower()
    host = f'[{host}]' if ':' in host else host
    return f'{parsed.scheme}://{host}' + (f':{port}' if port and port != (443 if parsed.scheme == 'https' else 80) else '')


def now():
    return datetime.now(timezone.utc).isoformat()


@asynccontextmanager
async def deadline(seconds):
    """Bound operations on Python 3.10 too (asyncio.timeout requires 3.11)."""
    task = asyncio.current_task()
    expired = False

    def timeout():
        nonlocal expired
        expired = True
        task.cancel()

    timer = asyncio.get_running_loop().call_later(seconds, timeout)
    try:
        yield
    except asyncio.CancelledError:
        if expired:
            raise BrowserError('浏览器操作超时，请重新观察确认页面。', 504) from None
        raise
    finally:
        timer.cancel()


@dataclass
class Tab:
    id: str
    page: object
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    snapshot: dict | None = None
    refs: dict = field(default_factory=dict)
    images: OrderedDict = field(default_factory=OrderedDict)
    logs: deque = field(default_factory=lambda: deque(maxlen=100))
    version: int = 0
    dirty: bool = True
    closed: bool = False
    error: str = ''
    cdp: object = None
    favicon_key: str = ''
    favicon: str = ''
    cast: dict | None = None
    cast_hook: bool = False
    live_observe: object = None


@dataclass
class Session:
    id: str
    context: object = None
    tabs: dict = field(default_factory=dict)
    jobs: OrderedDict = field(default_factory=OrderedDict)
    events: deque = field(default_factory=lambda: deque(maxlen=160))
    control_origins: set = field(default_factory=set)
    popups: deque = field(default_factory=lambda: deque(maxlen=8))
    popup_pending: bool = False
    popup_fallback: tuple | None = None
    touched: float = field(default_factory=time.monotonic)


class BrowserService:
    MAX_SESSIONS = 8
    MAX_TABS = 6
    ACTIONS = {'create', 'navigate', 'back', 'forward', 'reload', 'observe', 'click', 'fill', 'press', 'scroll', 'close', 'resize'}
    MUTATING = {'click', 'fill', 'press'}

    def __init__(self, outputs: Path, *, allowed_origins=None, launch=None, idle_seconds=1800):
        self.outputs = Path(outputs)
        self.root = self.outputs / '_browser'
        configured = allowed_origins if allowed_origins is not None else os.environ.get('EASEL_BROWSER_ALLOWED_ORIGINS', '').split(',')
        self.allowed_origins = {origin(value.strip()) for value in configured if value.strip()}
        self.launch = launch
        self.idle_seconds = idle_seconds
        self.sessions: dict[str, Session] = {}
        self.loop = None
        self.thread = None
        self.browser = None
        self.playwright = None
        self._start_lock = threading.Lock()
        self._browser_lock = asyncio.Lock()
        self._stopped = False

    def _start(self):
        with self._start_lock:
            if self._stopped:
                raise BrowserError('浏览器服务已关闭。', 503)
            if self.loop:
                return
            ready = threading.Event()

            def run():
                # Uvicorn reload/workers can install Windows' Selector policy,
                # which cannot launch Playwright's driver subprocess. Isolate
                # the subprocess-capable loop to this worker, not global policy.
                self.loop = asyncio.ProactorEventLoop() if os.name == 'nt' else asyncio.new_event_loop()
                asyncio.set_event_loop(self.loop)
                ready.set()
                self.loop.run_forever()
                self.loop.close()

            self.thread = threading.Thread(target=run, daemon=True, name='easel-browser-runtime')
            self.thread.start()
            ready.wait(5)
            if not self.loop:
                raise BrowserError('浏览器工作线程无法启动。', 503)

    def submit(self, method, *args, **kwargs):
        self._start()
        return asyncio.run_coroutine_threadsafe(getattr(self, '_' + method)(*args, **kwargs), self.loop)

    def call(self, method, *args, **kwargs):
        return self.submit(method, *args, **kwargs).result(timeout=45)

    def has_pages(self, sid):
        """Checking availability must not start Chromium or allocate a session."""
        identity(sid)
        return (self._folder(sid) / 'tabs.json').is_file()

    async def _tool_result(self, sid, args):
        from .browser_tools import async_tool_call
        return await async_tool_call(self, sid, args)

    async def _bound_tool(self, sid, args, stopped=None):
        from .browser_tools import codex_tool_response
        if isinstance(args, dict) and args.get('action') in self.ACTIONS:
            await self._session(sid)
        if stopped and stopped.is_set():
            raise BrowserError('本轮已结束，浏览器操作未执行。', 409)
        return codex_tool_response(*(await self._tool_result(sid, args)))

    async def _ensure_browser(self):
        async with self._browser_lock:
            await self._launch_browser()

    async def _launch_browser(self):
        if self.browser and self.browser.is_connected():
            return
        if self.browser:
            for session in self.sessions.values():
                session.context = None
                for tab in session.tabs.values():
                    tab.closed, tab.dirty, tab.cast = True, True, None
            self.browser = None
        try:
            if not self.playwright:
                from playwright.async_api import async_playwright
                self.playwright = await async_playwright().start()
            options = {'headless': True, 'timeout': 8000}
            if self.launch:
                self.browser = await self.launch(self.playwright)
            elif endpoint := os.environ.get('EASEL_BROWSER_CDP_ENDPOINT'):
                # The deployment owns the sandboxed sidecar and credentials.
                # Never fall back to launching Chromium in the app container.
                auth = json.loads(Path(os.environ['EASEL_BROWSER_AUTH_FILE']).read_text(encoding='utf-8'))
                if not re.fullmatch(r'[A-Za-z0-9_-]{8,64}', auth.get('username', '')) or not re.fullmatch(
                        r'[A-Za-z0-9_-]{32,128}', auth.get('password', '')):
                    raise ValueError('Invalid browser credential file')
                encoded = base64.b64encode((auth['username'] + ':' + auth['password']).encode()).decode('ascii')
                self.browser = await self.playwright.chromium.connect_over_cdp(
                    endpoint, headers={'Authorization': 'Basic ' + encoded}, timeout=8000)
            else:
                errors = []
                for channel in (None, 'msedge', 'chrome'):
                    try:
                        self.browser = await self.playwright.chromium.launch(**options, **({'channel': channel} if channel else {}))
                        break
                    except Exception as exc:
                        errors.append(str(exc))
                if not self.browser:
                    raise BrowserError('浏览器运行时不可用，请在环境设置中安装或修复浏览器组件。', 503)
        except BrowserError:
            raise
        except Exception:
            raise BrowserError('浏览器运行时无法启动，请检查浏览器组件。', 503) from None

    async def _validate_url(self, url):
        target = origin(url)
        if len(url) > 4096:
            raise BrowserError('网页地址过长。')
        if target in self.allowed_origins:
            return url
        host = urlsplit(url).hostname
        if host == 'localhost' or host.endswith(('.local', '.internal')):
            raise BrowserError('该来源未获准访问。内网或本地预览需先由运行环境配置允许的来源。', 403)
        try:
            addresses = await asyncio.to_thread(socket.getaddrinfo, host, None, type=socket.SOCK_STREAM)
        except (socket.gaierror, ValueError):
            raise BrowserError('网页域名无法解析。') from None
        try:
            private = not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses)
        except ValueError:
            private = True
        if private:
            raise BrowserError('该来源未获准访问。内网或本地预览需先配置允许的来源。', 403)
        return url

    def _folder(self, sid):
        return self.root / hashlib.sha256(sid.encode()).hexdigest()[:24]

    def _persist(self, session):
        path = self._folder(session.id) / 'tabs.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        data = {'tabs': [self._tab_info(tab) for tab in session.tabs.values()], 'events': list(session.events)}
        tmp = path.with_suffix('.tmp')
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
        tmp.replace(path)

    def _event(self, session, action, state, tab_id=None, request_id=None, message=''):
        event = {'id': uuid.uuid4().hex, 'at': now(), 'action': action, 'state': state,
                 'tabId': tab_id, 'requestId': request_id, 'message': public_text(message, limit=500)}
        session.events.append(event)
        self._persist(session)

    async def _session(self, sid):
        identity(sid)
        if sid not in self.sessions:
            for old in list(self.sessions.values()):
                if time.monotonic() - old.touched > self.idle_seconds and not any(job['state'] in ('queued', 'running') for job in old.jobs.values()):
                    if old.context:
                        await old.context.close()
                    del self.sessions[old.id]
            if len(self.sessions) >= self.MAX_SESSIONS:
                raise BrowserError('浏览器会话已达上限，请关闭暂不用的浏览器会话。', 429)
            session = self.sessions[sid] = Session(sid)
            try:
                saved = json.loads((self._folder(sid) / 'tabs.json').read_text(encoding='utf-8'))
                session.events.extend(saved.get('events', [])[-100:])
                pending = {e.get('requestId'): e for e in session.events if e.get('requestId')}
                for request_id, event in pending.items():
                    if event.get('state') in ('queued', 'running'):
                        session.events.append({**event, 'id':uuid.uuid4().hex, 'at':now(), 'state':'interrupted',
                            'message':'后端中断，完成状态未确认；操作不会重放。'})
                for item in saved.get('tabs', [])[-self.MAX_TABS:]:
                    tab = Tab(identity(item['id']), None, closed=True, version=item.get('version',0), error='后端曾中断，页面已断开；重新打开不会重放操作。')
                    tab.snapshot = {'url': item.get('url', ''), 'title': item.get('title', ''), 'id': '', 'version': item.get('version', 0)}
                    session.tabs[tab.id] = tab
            except (OSError, ValueError, KeyError, TypeError):
                pass
        session = self.sessions[sid]
        session.touched = time.monotonic()
        return session

    def _tab_info(self, tab):
        snapshot = tab.snapshot or {}
        closed = tab.closed or not tab.page or tab.page.is_closed()
        return {'id': tab.id, 'url': snapshot.get('url', ''), 'title': snapshot.get('title', '') or '新标签页',
                'version': tab.version, 'closed': bool(closed), 'stale': tab.dirty or bool(closed), 'error': tab.error}

    @staticmethod
    def _job_info(job):
        return {key: value for key, value in job.items() if not key.startswith('_')}

    async def _state(self, sid):
        identity(sid)
        session = await self._session(sid) if sid in self.sessions or self.has_pages(sid) else Session(sid)
        return {'sessionId': sid, 'workspaceId': hashlib.sha256(str(self.outputs.resolve()).encode()).hexdigest()[:20],
                'tabs': [self._tab_info(tab) for tab in session.tabs.values()],
                'snapshots': {tab.id: {**tab.snapshot, 'stale': self._tab_info(tab)['stale']} for tab in session.tabs.values() if tab.snapshot and tab.snapshot.get('id')},
                'jobs': [self._job_info(job) for job in list(session.jobs.values())[-16:]],
                'events': list(session.events)[-80:], 'controlOrigins': sorted(session.control_origins),
                'profile': 'isolated', 'capabilities': ['navigate', 'screenshot', 'dom', 'selection', 'click', 'fill', 'press', 'scroll', 'logs', 'live']}

    async def _control(self, sid, url, enabled):
        session = await self._session(sid)
        site = origin(await self._validate_url(url))
        if enabled:
            session.control_origins.add(site)
        else:
            session.control_origins.discard(site)
        self._event(session, 'agent_control', 'enabled' if enabled else 'disabled', message=site)
        return await self._state(sid)

    def _tab(self, session, tab_id):
        tab = session.tabs.get(identity(tab_id or ''))
        if not tab:
            raise BrowserError('当前会话没有这个浏览器标签。', 404)
        if tab.closed or not tab.page or tab.page.is_closed():
            tab.closed, tab.dirty = True, True
            raise BrowserError('页面已断开，请重新打开；旧操作不会自动重放。', 409)
        return tab

    async def _new_tab(self, session):
        # Keep a bounded reconnect history as users repeatedly close/reopen tabs.
        for tab_id in list(session.tabs):
            if len(session.tabs) < self.MAX_TABS * 2:
                break
            old = session.tabs[tab_id]
            if old.closed:
                del session.tabs[tab_id]
        if sum(not tab.closed for tab in session.tabs.values()) >= self.MAX_TABS:
            raise BrowserError('当前对话最多打开6个浏览器标签。', 429)
        await self._ensure_browser()
        if not session.context:
            session.context = await self.browser.new_context(viewport={'width': 1280, 'height': 800},
                accept_downloads=False, service_workers='block', permissions=[])
        page = await session.context.new_page()
        page.set_default_timeout(10000)
        page.set_default_navigation_timeout(20000)
        tab = Tab(uuid.uuid4().hex, page)
        session.tabs[tab.id] = tab
        # Chromium Fetch pauses *every* redirect hop before sending it.
        # Playwright route.continue_ intentionally skips redirected requests.
        tab.cdp = await session.context.new_cdp_session(page)
        async def guard(event):
            request_id = event['requestId']
            try:
                url = event['request']['url']
                if not url.startswith(('data:', 'blob:', 'about:')):
                    await self._validate_url(url)
                await tab.cdp.send('Fetch.continueRequest', {'requestId':request_id})
            except BrowserError as exc:
                self._event(session, 'network', 'blocked', tab.id, message=str(exc))
                try:
                    await tab.cdp.send('Fetch.failRequest', {'requestId':request_id,'errorReason':'BlockedByClient'})
                except Exception:
                    pass  # The user may have stopped navigation or closed the tab.
            except Exception:
                try:
                    await tab.cdp.send('Fetch.failRequest', {'requestId':request_id,'errorReason':'Failed'})
                except Exception:
                    pass
        tab.cdp.on('Fetch.requestPaused', lambda event: asyncio.create_task(guard(event)))
        await tab.cdp.send('Fetch.enable', {'patterns':[{'urlPattern':'*','requestStage':'Request'}]})
        page.on('console', lambda msg: tab.logs.append({'at': now(), 'kind': 'console', 'level': msg.type, 'text': public_text(msg.text, limit=600)}))
        page.on('pageerror', lambda exc: tab.logs.append({'at': now(), 'kind': 'error', 'text': public_text(str(exc), limit=600)}))
        page.on('response', lambda response: tab.logs.append({'at': now(), 'kind': 'network', 'status': response.status,
                    'url': public_text(response.url, limit=500)}))
        page.on('dialog', lambda dialog: asyncio.create_task(dialog.dismiss()))
        page.on('download', lambda download: asyncio.create_task(download.cancel()))
        # A separate window would bypass the panel's identity and the per-site
        # agent permission, so capture its address and continue in this tab.
        page.on('popup', lambda popup: self._popup_opened(session, popup))
        page.on('framenavigated', lambda frame: setattr(tab, 'dirty', True) if frame == page.main_frame else None)
        return tab

    def _popup_opened(self, session, popup):
        session.popup_pending = True
        asyncio.create_task(self._capture_popup(session, popup))

    async def _capture_popup(self, session, popup):
        """Record a new-window address before the window is closed."""
        url = ''
        try:
            deadline_at = time.monotonic() + 2
            while time.monotonic() < deadline_at:
                try:
                    url = popup.url or ''
                except Exception:
                    url = ''
                if url and url != 'about:blank':
                    break
                await asyncio.sleep(.08)
        finally:
            session.popups.append(url)
            try:
                await popup.close()
            except Exception:
                pass
        # The popup may appear after the click already returned. Continue it in
        # the tab that opened it, but only while that tab has not moved on.
        fallback = session.popup_fallback
        session.popup_fallback = None
        if not fallback or not url or url == 'about:blank':
            return
        tab_id, base_url = fallback
        tab = session.tabs.get(tab_id)
        if not tab or tab.closed or not tab.page or tab.page.is_closed() or tab.page.url != base_url:
            return
        try:
            await self._validate_url(url)
        except BrowserError:
            return
        try:
            async with tab.lock:
                tab.dirty = True
                await tab.page.goto(url, wait_until='domcontentloaded')
                await self._observe(session, tab)
        except Exception:
            pass

    async def _popup_notice(self, session, tab):
        """Continue a new-window link in the current tab; never leave it silent."""
        if not session.popup_pending:
            return ''
        deadline_at = time.monotonic() + 1
        while not session.popups and time.monotonic() < deadline_at:
            await asyncio.sleep(.05)
        session.popup_pending = False
        url = session.popups.popleft() if session.popups else ''
        session.popups.clear()
        if not url or url == 'about:blank':
            return '这个链接会打开新窗口，面板已拦截，但没有取得可打开的地址。'
        try:
            await self._validate_url(url)
        except BrowserError:
            return '这个链接打开了未获准访问的新窗口，已被拦截。'
        session.popup_fallback = None
        tab.dirty = True
        try:
            await tab.page.goto(url, wait_until='domcontentloaded')
        except Exception:
            return '链接默认在新窗口打开，当前标签页打开失败；请用地址栏重试。'
        return '链接默认在新窗口打开，已在当前标签页继续。'

    def _text_ref(self, tab, x, y):
        for item in (tab.snapshot or {}).get('elements', []):
            if item.get('sensitive') or item.get('disabled'):
                continue
            if item['x'] <= x <= item['x'] + item['width'] and item['y'] <= y <= item['y'] + item['height']:
                if item.get('role') in ('textbox', 'combobox') or item.get('tag') in ('input', 'textarea'):
                    return item['ref']
        return ''

    async def _click_point(self, session, tab, x, y):
        session.popups.clear()
        session.popup_pending = False
        hint = self._text_ref(tab, x, y)
        before = tab.page.url
        await self._position_click(tab, x, y)
        # A popup is dispatched by the page's own handler, slightly after the
        # mouse event. Wait only while neither a popup nor a navigation shows.
        deadline_at = time.monotonic() + .35
        while not session.popup_pending and tab.page.url == before and time.monotonic() < deadline_at:
            await asyncio.sleep(.04)
        session.popup_fallback = (tab.id, before)
        notice = await self._popup_notice(session, tab)
        if not notice:
            # Keep a late popup able to continue this click for a short while.
            asyncio.get_running_loop().call_later(3, self._clear_popup_fallback, session, tab.id)
        return notice, hint

    @staticmethod
    def _clear_popup_fallback(session, tab_id):
        fallback = session.popup_fallback
        if fallback and fallback[0] == tab_id:
            session.popup_fallback = None

    @staticmethod
    def _apply_click_hints(job, notice, hint):
        if notice:
            job['notice'] = notice
        if hint:
            job['focusRef'] = hint
            hint_text = '这是输入框：可在元素列表直接填写文字。'
            job['notice'] = f"{job['notice']} {hint_text}" if job.get('notice') else hint_text

    LIVE_KEYS = {'Enter', 'Tab', 'Escape', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'}

    async def _input(self, sid, tab_id, events):
        """Low-latency input for the live view; never waits for a new observation."""
        session = await self._session(sid)
        tab = self._tab(session, tab_id)
        if tab.lock.locked():
            raise BrowserError('页面正在执行另一项操作，请稍后再输入。', 409)
        viewport = tab.page.viewport_size or {'width': 1280, 'height': 800}
        notices, hint = [], ''
        async with tab.lock:
            for event in events:
                kind = event.get('type')
                if kind in ('click', 'move', 'wheel'):
                    x, y = event.get('x'), event.get('y')
                    if kind != 'wheel' or x is not None:
                        if not isinstance(x, (float, int)) or not isinstance(y, (float, int)) or not (0 <= x < viewport['width'] and 0 <= y < viewport['height']):
                            raise BrowserError('输入位置无效，请重新观察页面。')
                if kind == 'click':
                    tab.dirty = True
                    notice, text = await self._click_point(session, tab, x, y)
                    if notice:
                        notices.append(notice)
                    hint = hint or text
                elif kind == 'move':
                    await tab.page.mouse.move(x, y)
                elif kind == 'wheel':
                    delta = max(-1600, min(1600, int(event.get('deltaY') or 0)))
                    if not delta:
                        continue
                    tab.dirty = True
                    await tab.page.mouse.wheel(0, delta)
                elif kind == 'key':
                    key = event.get('key')
                    if key not in self.LIVE_KEYS:
                        raise BrowserError('不支持的按键。')
                    tab.dirty = True
                    await tab.page.keyboard.press(key)
                elif kind == 'text':
                    value = event.get('text')
                    if not isinstance(value, str) or not value or len(value) > 2000:
                        raise BrowserError('输入文字须为2000字以内的非空文本。')
                    tab.dirty = True
                    await tab.page.keyboard.insert_text(value)
                else:
                    raise BrowserError('不支持的实时输入。')
            self._wake_live_observe(session, tab)
        result = {'ok': True, 'tabId': tab.id, 'dirty': tab.dirty}
        if notices:
            result['notice'] = ' '.join(dict.fromkeys(notices))
        if hint:
            result['focusRef'] = hint
            result['notice'] = (result.get('notice', '') + ' 这是输入框：可在元素列表直接填写文字。').strip()
        return result

    def _wake_live_observe(self, session, tab):
        old = tab.live_observe
        if old and not old.done():
            old.cancel()

        async def later():
            try:
                await asyncio.sleep(.9)
                if tab.closed or tab.lock.locked():
                    return
                async with tab.lock:
                    if not tab.closed:
                        await self._observe(session, tab)
            except Exception:
                pass  # A transient navigation must not fail the user's input.

        tab.live_observe = asyncio.create_task(later())

    async def _cast_next(self, sid, tab_id, since=0):
        session = await self._session(sid)
        tab = self._tab(session, tab_id)
        cast = await self._ensure_cast(tab)
        cast['touched'] = time.monotonic()
        if not cast['frame'] or cast['version'] <= int(since or 0):
            return None
        return {'version': cast['version'], 'jpeg': base64.b64encode(cast['frame']).decode('ascii'),
                'width': cast['width'], 'height': cast['height']}

    async def _ensure_cast(self, tab):
        if tab.cast is None:
            tab.cast = {'version': 0, 'frame': b'', 'width': 0, 'height': 0,
                        'touched': time.monotonic(), 'watch': None}
            if not tab.cast_hook:
                tab.cast_hook = True
                tab.cdp.on('Page.screencastFrame', lambda event: self._cast_frame(tab, event))
            viewport = (tab.snapshot or {}).get('viewport') or tab.page.viewport_size or {}
            width, height = viewport.get('width', 1280), viewport.get('height', 800)
            try:
                await tab.cdp.send('Page.startScreencast', {'format': 'jpeg', 'quality': 70,
                    'maxWidth': min(1920, int(width) or 1280), 'maxHeight': min(1600, int(height) or 800),
                    'everyNthFrame': 1})
            except Exception:
                pass
            try:
                shot = await tab.page.screenshot(type='jpeg', quality=65, animations='disabled', timeout=8000)
                tab.cast.update(frame=shot, version=1, width=width, height=height)
            except Exception:
                pass
            tab.cast['watch'] = asyncio.create_task(self._cast_watch(tab))
        return tab.cast

    def _cast_frame(self, tab, event):
        cast = tab.cast
        try:
            raw = base64.b64decode(event.get('data') or '')
        except Exception:
            raw = b''
        if cast is not None and raw:
            meta = event.get('metadata') or {}
            cast['frame'] = raw
            cast['version'] += 1
            cast['width'] = int(meta.get('deviceWidth') or cast['width'] or 0)
            cast['height'] = int(meta.get('deviceHeight') or cast['height'] or 0)
            cast['touched'] = time.monotonic()
        if event.get('sessionId') is not None:
            asyncio.create_task(self._cast_ack(tab, event['sessionId']))

    async def _cast_ack(self, tab, screencast_id):
        try:
            await tab.cdp.send('Page.screencastFrameAck', {'sessionId': screencast_id})
        except Exception:
            pass

    async def _cast_watch(self, tab):
        """Stop an abandoned stream so an idle page is not encoded forever."""
        try:
            while True:
                await asyncio.sleep(5)
                cast = tab.cast
                if cast is None:
                    return
                if tab.closed or not tab.page or tab.page.is_closed():
                    tab.cast = None
                    return
                if time.monotonic() - cast['touched'] > 15:
                    await self._cast_stop(tab)
                    return
        except asyncio.CancelledError:
            return

    async def _cast_stop(self, tab):
        cast, tab.cast = tab.cast, None
        if cast and cast.get('watch'):
            cast['watch'].cancel()
        if tab.cdp:
            try:
                await tab.cdp.send('Page.stopScreencast')
            except Exception:
                pass

    async def _observe(self, session, tab):
        for handle in tab.refs.values():
            await handle.dispose()
        tab.refs.clear()
        handle = await tab.page.evaluate_handle(OBSERVE)
        try:
            data_handle = await handle.get_property('data')
            data = await data_handle.json_value()
            await data_handle.dispose()
            icon_url = data.pop('faviconUrl', '')
            if icon_url != tab.favicon_key:
                tab.favicon_key, tab.favicon = icon_url, ''
                if icon_url:
                    try:
                        tab.favicon = await tab.page.evaluate(READ_FAVICON, icon_url)
                    except Exception:
                        pass  # A site's icon must never fail a page observation.
            data['favicon'] = tab.favicon
            node_list = await handle.get_property('nodes')
            properties = await node_list.get_properties()
            tab.refs = {'e' + index: item.as_element() for index, item in properties.items() if item.as_element()}
            await node_list.dispose()
            shot = await tab.page.screenshot(type='png', animations='disabled', timeout=10000)
            tab.version += 1
            snapshot_id = uuid.uuid4().hex
            data.update(id=snapshot_id, tabId=tab.id, sessionId=session.id, version=tab.version, capturedAt=now(),
                        stale=False, source='browser', text=public_text(data['text'], limit=24000), logs=list(tab.logs)[-40:])
            # Navigation may have happened while collecting evidence; don't label a
            # screenshot from the new document with the previous document's text.
            document = await handle.get_property('document')
            try:
                same_document = await tab.page.evaluate('(doc) => doc === document', document)
            finally:
                await document.dispose()
            if tab.page.url != data['url'] or not same_document:
                raise BrowserError('观察期间页面已跳转，请重新观察。', 409)
            tab.images[snapshot_id] = shot
            while len(tab.images) > 3:
                tab.images.popitem(last=False)
            tab.snapshot, tab.dirty, tab.error = data, False, ''
            self._persist(session)
            return data
        finally:
            await handle.dispose()

    async def _command(self, sid, payload, actor='user'):
        session = await self._session(sid)
        request_id = identity(payload.get('requestId') or '')
        action = payload.get('action')
        if action not in self.ACTIONS:
            raise BrowserError('不支持的浏览器操作。')
        if actor not in ('user', 'agent'):
            raise BrowserError('无效的浏览器调用来源。')
        fingerprint = hashlib.sha256(json.dumps({'payload':payload,'actor':actor}, sort_keys=True).encode()).hexdigest()
        if request_id in session.jobs:
            job = session.jobs[request_id]
            if job['_fingerprint'] != fingerprint:
                raise BrowserError('请求标识已用于其他操作，不会重复执行。', 409)
            if job['_task'] and not job['_task'].done():
                await self._wait_job(session, job)
            return self._job_info(job)
        if action == 'create' and any(job['action']=='create' and job['state'] in ('queued','running') for job in session.jobs.values()):
            raise BrowserError('另一个网页标签正在打开，请等待或取消。', 409)
        if action in self.MUTATING and actor == 'agent':
            tab = self._tab(session, payload.get('tabId'))
            if origin(tab.page.url) not in session.control_origins:
                raise BrowserError('此站点尚未允许Agent操作；请在浏览器面板开启控制，再重新观察后操作。', 403)
        if any(job['state'] in ('queued', 'running') and job.get('tabId') == payload.get('tabId') for job in session.jobs.values()):
            raise BrowserError('这个页面正在执行另一项操作，请等待或取消。', 409)
        while len(session.jobs) >= 60:
            oldest = next(iter(session.jobs))
            if session.jobs[oldest]['state'] in ('queued', 'running'):
                raise BrowserError('浏览器操作队列已满。', 429)
            session.jobs.pop(oldest)
        job = {'id': request_id, 'action': action, 'tabId': payload.get('tabId'), 'state': 'queued', 'createdAt': now(),
               '_fingerprint': fingerprint, '_actor': actor, '_task': None}
        session.jobs[request_id] = job
        job['_task'] = asyncio.create_task(self._execute(session, job, payload, actor))
        await self._wait_job(session, job)
        return self._job_info(job)

    def _settle_cancelled(self, session, job):
        if job['state'] not in ('queued', 'running'):
            return
        job.update(state='cancelled', finishedAt=now(), error='操作已中断，请重新观察。')
        tab = session.tabs.get(job.get('tabId'))
        if tab:
            tab.dirty = True
        self._event(session, job['action'], 'cancelled', job.get('tabId'), job['id'], job['error'])

    async def _wait_job(self, session, job):
        try:
            await asyncio.shield(job['_task'])
        except asyncio.CancelledError:
            if not job['_task'].cancelled():
                raise  # Cancelling an HTTP waiter must not cancel a site action.
            self._settle_cancelled(session, job)

    async def _execute(self, session, job, payload, actor):
        tab = None
        action = job['action']
        try:
            job.update(state='running', startedAt=now())
            self._event(session, action, 'running', job['tabId'], job['id'])
            if action == 'create':
                if payload.get('url'):
                    await self._validate_url(payload['url'])
                tab = await self._new_tab(session)
                job['tabId'] = tab.id
            else:
                tab = self._tab(session, job['tabId'])
            async with tab.lock:
                async with deadline(30):
                    if action == 'resize' or action == 'create' and ('width' in payload or 'height' in payload):
                        width, height = payload.get('width'), payload.get('height')
                        if type(width) is not int or type(height) is not int or not (280 <= width <= 1920 and 240 <= height <= 1600):
                            raise BrowserError('网页尺寸须在280–1920 × 240–1600范围内。')
                        tab.dirty = True
                        await tab.page.set_viewport_size({'width': width, 'height': height})
                    if action in {'create', 'navigate'}:
                        url = payload.get('url') or ('about:blank' if action == 'create' else '')
                        if url != 'about:blank':
                            await self._validate_url(url)
                        tab.dirty = True
                        await tab.page.goto(url, wait_until='domcontentloaded')
                    elif action == 'close':
                        await self._cast_stop(tab)
                        await tab.page.close()
                        tab.closed, tab.dirty = True, True
                    elif action in {'back', 'forward', 'reload'}:
                        tab.dirty = True
                        method = getattr(tab.page, {'back':'go_back','forward':'go_forward','reload':'reload'}[action])
                        await method(wait_until='domcontentloaded')
                    elif action not in {'observe', 'resize'}:
                        if tab.dirty or not tab.snapshot or payload.get('snapshotId') != tab.snapshot['id'] or tab.page.url != tab.snapshot['url']:
                            raise BrowserError('页面证据已过期，请重新观察后操作。', 409)
                        if action == 'scroll':
                            delta = max(-1600, min(1600, int(payload.get('deltaY', 600))))
                            tab.dirty = True
                            await tab.page.mouse.wheel(0, delta)
                            await tab.page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
                        elif action == 'click' and payload.get('x') is not None:
                            x, y = payload.get('x'), payload.get('y')
                            viewport = tab.snapshot['viewport']
                            if actor == 'agent' or not isinstance(x, (float, int)) or not isinstance(y, (float, int)) or not (0 <= x < viewport['width'] and 0 <= y < viewport['height']):
                                raise BrowserError('点击位置无效；Agent需使用观察结果中的元素标识。')
                            tab.dirty = True
                            notice, hint = await self._click_point(session, tab, x, y)
                            self._apply_click_hints(job, notice, hint)
                        else:
                            ref = payload.get('ref')
                            element = tab.refs.get(ref)
                            info = next((item for item in tab.snapshot['elements'] if item['ref'] == ref), None)
                            if not element or not info:
                                raise BrowserError('找不到该元素，请重新观察。', 409)
                            check = await element.evaluate(ELEMENT_NAME)
                            if not check['connected'] or check['name'] != info['name']:
                                raise BrowserError('元素已变化，请重新观察。', 409)
                            if info['sensitive']:
                                raise BrowserError('密码、验证码和支付信息请在受信浏览器中由你手动处理。', 403)
                            tab.dirty = True
                            if action == 'click':
                                session.popups.clear()
                                session.popup_pending = False
                                await element.click()
                                notice = await self._popup_notice(session, tab)
                                self._apply_click_hints(job, notice, '')
                            elif action == 'fill':
                                value = payload.get('text')
                                if not isinstance(value, str) or len(value) > 8000:
                                    raise BrowserError('填写内容必须是8000字以内的文本。')
                                await element.fill(value)
                            elif action == 'press':
                                key = payload.get('key')
                                if key not in {'Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Space', 'Backspace'}:
                                    raise BrowserError('不支持的按键。')
                                await element.press(key)
                    if not tab.closed:
                        await self._observe(session, tab)
                    job.update(state='completed', snapshotId=(tab.snapshot or {}).get('id'))
        except asyncio.CancelledError:
            job.update(state='cancelled', error='操作已中断；网页已发生的动作不会撤销。请重新观察确认页面。')
            if tab and not tab.closed:
                tab.dirty = True
                try:
                    await tab.page.evaluate('() => window.stop()')
                except Exception:
                    pass
        except Exception as exc:
            message = str(exc) if isinstance(exc, BrowserError) else '页面操作未完成，可能超时、跳转或连接中断；请重新观察确认。'
            job.update(state='failed', error=public_text(message, limit=600))
            if tab:
                tab.error = job['error']
                tab.dirty = True
                if isinstance(exc, BrowserError) and exc.status == 409 and not tab.closed:
                    # The refused action never ran. A fresh observation makes
                    # the panel usable again without replaying any site action.
                    try:
                        async with tab.lock:
                            await self._observe(session, tab)
                        job.update(recovered=True, snapshotId=(tab.snapshot or {}).get('id'),
                                   notice='页面已变化，已重新观察；请重试刚才的操作。')
                    except Exception:
                        pass
        finally:
            job['finishedAt'] = now()
            self._event(session, action, job['state'], job.get('tabId'), job['id'], job.get('error', ''))

    async def _position_click(self, tab, x, y):
        """Mouse input lacks ElementHandle.click's navigation auto-wait."""
        requested = False
        loaded = asyncio.get_running_loop().create_future()
        def request_started(request):
            nonlocal requested
            if request.is_navigation_request() and request.frame == tab.page.main_frame:
                requested = True
        def document_loaded():
            if not loaded.done():
                loaded.set_result(True)
        tab.page.on('request', request_started)
        tab.page.on('domcontentloaded', document_loaded)
        try:
            await tab.page.mouse.click(x, y)
            # Let the immediate event handlers/requests run before deciding
            # whether a click triggered navigation. Never repeat the click.
            await asyncio.sleep(.1)
            if requested:
                await asyncio.wait_for(loaded, timeout=20)
        finally:
            tab.page.remove_listener('request', request_started)
            tab.page.remove_listener('domcontentloaded', document_loaded)
            if not loaded.done():
                loaded.cancel()

    async def _cancel(self, sid, request_id):
        session = await self._session(sid)
        job = session.jobs.get(identity(request_id))
        if not job:
            raise BrowserError('操作不存在。', 404)
        if job['state'] in ('queued', 'running'):
            job['_task'].cancel()
            try:
                await job['_task']
            except asyncio.CancelledError:
                # A task cancelled before its coroutine starts has no finally.
                self._settle_cancelled(session, job)
        return self._job_info(job)

    async def _cancel_agents(self, sid):
        session = self.sessions.get(sid)
        if not session:
            return
        for job in list(session.jobs.values()):
            if job.get('_actor') == 'agent' and job['state'] in ('queued', 'running'):
                await self._cancel(sid, job['id'])

    async def _image(self, sid, tab_id, snapshot_id):
        session = await self._session(sid)
        tab = session.tabs.get(identity(tab_id))
        if not tab or snapshot_id not in tab.images:
            raise BrowserError('页面截图已过期，请重新观察。', 404)
        return tab.images[snapshot_id]

    async def _close_session(self, sid):
        session = await self._session(sid)
        for job in session.jobs.values():
            if job['state'] in ('queued', 'running'):
                await self._cancel(sid, job['id'])
        if session.context:
            await session.context.close()
        session.context = None
        for tab in session.tabs.values():
            await self._cast_stop(tab)
            if tab.live_observe and not tab.live_observe.done():
                tab.live_observe.cancel()
            tab.closed, tab.dirty = True, True
            tab.refs.clear()
            tab.images.clear()
        self._event(session, 'close_session', 'completed')
        return await self._state(sid)

    async def _shutdown(self):
        for sid in list(self.sessions):
            await self._close_session(sid)
        if self.browser:
            await self.browser.close()
        if self.playwright:
            await self.playwright.stop()

    def close(self):
        if self.loop and not self._stopped:
            try:
                self.call('shutdown')
            finally:
                self._stopped = True
                self.loop.call_soon_threadsafe(self.loop.stop)
                self.thread.join(timeout=5)
        self._stopped = True
