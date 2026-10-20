"""Real isolated Chromium, HTTP and UI-tool state. No models or user profiles."""
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import time
import json
import asyncio
import base64
import os
from urllib.request import urlopen

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from easel.browser_runtime import BrowserService, BrowserError
from easel.attachment_refs import attachment_id, attachment_scope
from web.browser_api import router


PAGE = '''<!doctype html><html><head><title>真实浏览器验收</title></head><body>
<nav>站点导航</nav><main><h1>浏览器测试页</h1><p id="result">尚未操作</p>
<label for="name">姓名</label><input id="name"><button id="apply" onclick="document.querySelector('#result').textContent='你好，'+document.querySelector('#name').value">应用姓名</button>
<a href="/next">下一页</a><a href="/next" target="_blank">新窗口链接</a><label for="password">密码</label><input id="password" type="password">
<div style="height:1400px">长页内容</div><p>页面末尾</p></main>
<script>console.log('fixture ready');</script></body></html>'''


@pytest.mark.skipif(os.name != 'nt', reason='Windows event loop compatibility')
def test_playwright_starts_under_uvicorn_selector_policy(tmp_path):
    policy = asyncio.get_event_loop_policy()
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    service = BrowserService(tmp_path / 'selector')
    try:
        service.call('ensure_browser')
        assert service.browser.is_connected()
        assert isinstance(asyncio.get_event_loop_policy(), asyncio.WindowsSelectorEventLoopPolicy)
    finally:
        service.close()
        asyncio.set_event_loop_policy(policy)


@pytest.fixture(scope='module')
def site():
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            if self.path == '/favicon.png':
                body = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=')
                self.send_response(200)
                self.send_header('Content-Type', 'image/png')
                self.end_headers()
                self.wfile.write(body)
                return
            if self.path == '/icon-page':
                body = b'<title>Page icon</title><link rel="icon" href="/favicon.png"><main>Icon fixture</main>'
            elif self.path == '/probe-count':
                body = str(getattr(self.server, 'denied_hits', 0)).encode()
            elif self.path == '/denied':
                self.server.denied_hits = getattr(self.server, 'denied_hits', 0) + 1
                body = b'private response must not reach the browser'
            elif self.path == '/redirect':
                self.send_response(302)
                self.send_header('Location', f'http://localhost:{self.server.server_port}/denied')
                self.end_headers()
                return
            elif self.path == '/redirect-chain':
                self.send_response(302)
                self.send_header('Location', '/redirect')
                self.end_headers()
                return
            elif self.path == '/guard':
                body = f'<title>Guard</title><main>guard fixture<img src="http://localhost:{self.server.server_port}/denied"></main>'.encode()
            else:
                body = ('<title>下一页</title><main>已进入第二页<a href="/">返回</a></main>' if self.path == '/next' else PAGE).encode('utf-8')
            if self.path == '/slow':
                time.sleep(2)
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f'http://127.0.0.1:{server.server_port}'
    server.shutdown()
    server.server_close()
    thread.join(timeout=3)


@pytest.fixture
def browser(tmp_path, site):
    service = BrowserService(tmp_path / 'outputs', allowed_origins=[site])
    yield service
    service.close()


def command(service, action, tab=None, snapshot=None, actor='user', request=None, **args):
    payload = {'requestId': request or __import__('uuid').uuid4().hex, 'action': action, **args}
    if tab:
        payload['tabId'] = tab
    if snapshot:
        payload['snapshotId'] = snapshot
    return service.call('command', 'owner', payload, actor=actor)


def current(service, tab):
    return service.call('state', 'owner')['snapshots'][tab]


def ref(snapshot, name):
    return next(item['ref'] for item in snapshot['elements'] if item['name'] == name)


def test_real_navigation_dom_screenshot_and_verified_actions(browser, site):
    opened = command(browser, 'create', url=site)
    assert opened['state'] == 'completed', opened
    tab = opened['tabId']
    shot = current(browser, tab)
    assert shot['title'] == '真实浏览器验收' and '尚未操作' in shot['text']
    assert '站点导航' not in shot['text']
    png = browser.call('image', 'owner', tab, shot['id'])
    assert png.startswith(b'\x89PNG') and len(png) > 1000
    assert shot['headings'][0]['text'] == '浏览器测试页'
    assert any(row['kind'] == 'console' for row in shot['logs'])
    filled = command(browser, 'fill', tab, shot['id'], ref=ref(shot, '姓名'), text='Easel')
    assert filled['state'] == 'completed', filled
    after_fill = current(browser, tab)
    assert after_fill['id'] != shot['id'] and after_fill['version'] > shot['version']
    clicked = command(browser, 'click', tab, after_fill['id'], ref=ref(after_fill, '应用姓名'))
    assert clicked['state'] == 'completed', clicked
    assert '你好，Easel' in current(browser, tab)['text']
    shot = current(browser, tab)
    link = next(el for el in shot['elements'] if el['name']=='下一页')
    clicked = command(browser, 'click', tab, shot['id'], x=link['x']+link['width']/2, y=link['y']+link['height']/2)
    assert clicked['state']=='completed', clicked
    assert current(browser, tab)['url'] == site + '/next'
    assert command(browser, 'back', tab)['state'] == 'completed'
    assert current(browser, tab)['url'] == site + '/'
    assert command(browser, 'forward', tab)['state'] == 'completed'
    assert current(browser, tab)['title'] == '下一页'
    assert command(browser, 'reload', tab)['state'] == 'completed'


def test_identity_stale_refs_permissions_and_request_idempotency(browser, site):
    opened = command(browser, 'create', url=site, request='open-once')
    assert command(browser, 'create', url=site, request='open-once') == opened
    assert len(browser.call('state', 'owner')['tabs']) == 1
    tab = opened['tabId']
    shot = current(browser, tab)
    assert browser.call('state', 'other')['tabs'] == []
    with pytest.raises(BrowserError):
        browser.call('image', 'other', tab, shot['id'])
    with pytest.raises(BrowserError, match='请求标识'):
        command(browser, 'create', url=site+'/next', request='open-once')
    with pytest.raises(BrowserError, match='尚未允许'):
        command(browser, 'click', tab, shot['id'], actor='agent', ref=ref(shot, '应用姓名'))
    browser.call('control', 'owner', site, True)
    outcome = command(browser, 'fill', tab, shot['id'], actor='agent', ref=ref(shot, '姓名'), text='Agent')
    assert outcome['state'] == 'completed'
    stale = command(browser, 'click', tab, shot['id'], ref=ref(shot, '应用姓名'))
    assert stale['state'] == 'failed' and '过期' in stale['error']
    observed = command(browser, 'observe', tab)
    assert observed['state'] == 'completed'
    shot = current(browser, tab)
    sensitive = command(browser, 'fill', tab, shot['id'], ref=ref(shot, '密码'), text='not-a-real-secret')
    assert sensitive['state'] == 'failed' and '手动' in sensitive['error']
    events = browser.call('state', 'owner')['events']
    assert 'not-a-real-secret' not in str(events)


def test_cancel_keeps_job_terminal_and_requires_fresh_observation(browser, site):
    opened = command(browser, 'create', url=site)
    tab = opened['tabId']
    future = browser.submit('command', 'owner', {'requestId':'slow-nav','action':'navigate','tabId':tab,'url':site+'/slow'})
    until = time.monotonic() + 5
    while time.monotonic() < until:
        jobs = browser.call('state', 'owner')['jobs']
        if any(job['id'] == 'slow-nav' and job['state'] == 'running' for job in jobs):
            break
        time.sleep(.02)
    result = browser.call('cancel', 'owner', 'slow-nav')
    assert result['state'] == 'cancelled'
    assert future.result(timeout=5)['state'] == 'cancelled'
    assert current(browser, tab)['stale']
    assert command(browser, 'observe', tab)['state'] == 'completed'
    assert not current(browser, tab)['stale']


def test_early_cancel_and_empty_state_reads_do_not_leak_slots(browser):
    for i in range(20):
        assert browser.call('state',f'empty-{i}')['tabs'] == []
    assert browser.sessions == {}
    async def race():
        task = asyncio.create_task(browser._command('owner',{'action':'create','requestId':'early'}))
        await asyncio.sleep(0)
        cancelled = await browser._cancel('owner','early')
        return cancelled, await task
    result = asyncio.run_coroutine_threadsafe(race(),browser.loop).result(timeout=5)
    assert all(job['state']=='cancelled' for job in result)
    assert browser.browser is None


def test_close_refresh_reconnect_and_restart_never_replay_site_actions(browser, site):
    opened = command(browser, 'create', url=site)
    tab = opened['tabId']
    assert current(browser, tab)['id'] == current(browser, tab)['id'], 'read state never navigates or captures again'
    assert command(browser, 'close', tab)['state'] == 'completed'
    assert browser.call('state', 'owner')['tabs'][0]['closed']
    browser.close()
    recovered = BrowserService(browser.outputs, allowed_origins=[site])
    try:
        state = recovered.call('state', 'owner')
        assert state['tabs'][0]['closed'] and state['snapshots'] == {}
        assert recovered.browser is None, 'reading recovered metadata must not launch a browser or replay navigation'
    finally:
        recovered.close()


def test_private_urls_fail_before_browser_launch(browser):
    for url in ('file:///etc/passwd', 'http://169.254.169.254/', 'https://u:p@example.com', 'http://localhost:1/'):
        result = command(browser, 'create', url=url)
        assert result['state'] == 'failed'
    assert browser.browser is None


def test_actual_subresource_and_redirect_guards(browser, site):
    assert command(browser, 'create', url=site+'/guard')['state'] == 'completed'
    assert any(e['state'] == 'blocked' for e in browser.call('state','owner')['events'])
    command(browser, 'create', url=site+'/redirect')
    command(browser, 'create', url=site+'/redirect-chain')
    with urlopen(site+'/probe-count') as response:
        assert response.read() == b'0', 'blocked target must never receive a request'


def test_bound_agent_tool_uses_ui_page_and_returns_real_visual_input(browser, site):
    from easel.browser_tools import tool_call
    job = command(browser, 'create', url=site)
    tab = job['tabId']
    shot = current(browser,tab)
    result, _ = tool_call(browser, 'owner', {'action':'observe','requestId':'agent-observe','tabId':tab})
    assert result['snapshot']['tabId'] == tab
    assert result['snapshot']['version'] > shot['version']
    shot = current(browser,tab)
    response = browser.call('bound_tool','owner',{'action':'image','tabId':tab,'snapshotId':shot['id']})
    assert response['success'] and response['contentItems'][1]['type'] == 'inputImage'
    assert response['contentItems'][1]['imageUrl'].startswith('data:image/png;base64,iVBOR')
    with pytest.raises(BrowserError, match='固定requestId'):
        tool_call(browser,'owner',{'action':'reload','tabId':tab})
    with pytest.raises(BrowserError, match='其他会话'):
        tool_call(browser,'owner',{'action':'state','sessionId':'other'})
    with pytest.raises(BrowserError):
        tool_call(browser,'other',{'action':'image','tabId':tab,'snapshotId':shot['id']})
    stopped=threading.Event(); stopped.set()
    with pytest.raises(BrowserError,match='本轮已结束'):
        browser.call('bound_tool','owner',{'action':'create','requestId':'never-create'},stopped)
    assert len(browser.call('state','owner')['tabs']) == 1


def test_http_agent_tool_and_script_use_existing_session(browser, site, monkeypatch):
    from easel import browser_bridge
    app=FastAPI(); app.include_router(router(browser))
    with TestClient(app) as client:
        def local_urlopen(req, timeout):
            from io import BytesIO
            response=client.post(req.full_url.replace(browser_bridge.service_url(),''),content=req.data,headers={'Content-Type':'application/json'})
            assert response.status_code == 200, response.text
            return BytesIO(response.content)
        monkeypatch.setattr(browser_bridge,'urlopen',local_urlopen)
        job=browser_bridge.request('owner',{'action':'create','requestId':'bridge-open','url':site})['job']
        result=browser_bridge.request('owner',{'action':'image','tabId':job['tabId'],'snapshotId':job['snapshotId']})
        assert (browser.outputs/result['image']['path']).read_bytes().startswith(b'\x89PNG')
        assert 'snapshotId' in result and 'imagePath' in result
        denied=client.post('/api/browser/sessions/owner/agent/tool',json={'action':'click','requestId':'denied','tabId':job['tabId'],'snapshotId':job['snapshotId'],'ref':'e0'})
        assert denied.status_code == 403
        for target in ('https://example.com','http://user:pass@localhost:7860','http://192.168.0.1:7860'):
            monkeypatch.setenv('EASEL_BROWSER_URL',target)
            with pytest.raises(BrowserError):
                browser_bridge.service_url()


def test_http_routes_and_screenshot_attachment_use_chat_ownership(browser, site):
    app = FastAPI()
    app.include_router(router(browser))
    with TestClient(app) as client:
        body = {'requestId':'http-open','action':'create','url':site}
        job = client.post('/api/browser/sessions/owner/commands', json=body).json()
        assert job['state'] == 'completed', job
        tab, shot_id = job['tabId'], job['snapshotId']
        path = f'/api/browser/sessions/owner/tabs/{tab}/snapshots/{shot_id}'
        assert client.get(path+'/image').headers['content-type'] == 'image/png'
        file = client.post(path+'/attachment').json()['file']
        scope = attachment_scope('owner')
        assert file['path'].startswith('_inbox/'+scope+'/browser-')
        assert file['id'] == attachment_id(scope, file['path'])
        assert (browser.outputs/file['path']).read_bytes().startswith(b'\x89PNG')
        assert client.get(path.replace('/owner/','/other/')+'/image').status_code == 404
        assert client.delete('/api/browser/sessions/owner').json()['tabs'][0]['closed']


def test_viewport_reflows_real_page_and_invalidates_old_element_refs(browser, site):
    opened = command(browser, 'create', url=site, width=590, height=760)
    tab = opened['tabId']
    before = current(browser, tab)
    assert before['viewport']['width'] == 590 and before['viewport']['height'] == 760
    resized = command(browser, 'resize', tab, width=337, height=650)
    assert resized['state'] == 'completed'
    after = current(browser, tab)
    assert after['viewport']['width'] == 337 and after['viewport']['height'] == 650
    assert after['id'] != before['id']
    stale = command(browser, 'click', tab, before['id'], ref=ref(before, '应用姓名'))
    assert stale['state'] == 'failed' and '过期' in stale['error']
    invalid = command(browser, 'resize', tab, width=100, height=650)
    assert invalid['state'] == 'failed'
    assert current(browser, tab)['viewport']['width'] == 337


def test_site_icon_is_a_bounded_raster_from_the_guarded_browser_not_a_remote_ui_url(browser, site):
    opened = command(browser, 'create', url=site+'/icon-page')
    assert opened['state'] == 'completed'
    icon = current(browser, opened['tabId'])['favicon']
    assert icon.startswith('data:image/png;base64,')
    assert base64.b64decode(icon.split(',',1)[1]).startswith(b'\x89PNG')
    missing = command(browser, 'navigate', opened['tabId'], url=site+'/')
    assert missing['state'] == 'completed'
    assert current(browser, opened['tabId'])['favicon'] == ''


def test_new_window_link_continues_in_current_tab(browser, site):
    opened = command(browser, 'create', url=site)
    tab = opened['tabId']
    shot = current(browser, tab)
    link = next(el for el in shot['elements'] if el['name'] == '新窗口链接')
    clicked = command(browser, 'click', tab, shot['id'], x=link['x'] + link['width'] / 2, y=link['y'] + link['height'] / 2)
    assert clicked['state'] == 'completed', clicked
    # The popup event can arrive just after the click returns: the fallback
    # continues it in this tab and the page still moves, never silently.
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and current(browser, tab)['url'] != site + '/next':
        time.sleep(.1)
    assert current(browser, tab)['url'] == site + '/next'
    notice = clicked.get('notice', '')
    assert not notice or '当前标签页' in notice


def test_click_on_text_field_offers_element_fill(browser, site):
    opened = command(browser, 'create', url=site)
    tab = opened['tabId']
    shot = current(browser, tab)
    field = next(el for el in shot['elements'] if el['name'] == '姓名')
    clicked = command(browser, 'click', tab, shot['id'], x=field['x'] + 5, y=field['y'] + 5)
    assert clicked['state'] == 'completed', clicked
    assert clicked.get('focusRef') == field['ref']
    assert '输入框' in clicked.get('notice', '')


def test_refused_stale_action_observes_again_without_replaying(browser, site):
    opened = command(browser, 'create', url=site)
    tab = opened['tabId']
    shot = current(browser, tab)
    command(browser, 'fill', tab, shot['id'], ref=ref(shot, '姓名'), text='Easel')
    stale = command(browser, 'click', tab, shot['id'], ref=ref(shot, '应用姓名'))
    assert stale['state'] == 'failed' and '过期' in stale['error']
    assert stale.get('recovered') is True and stale.get('snapshotId')
    snap = current(browser, tab)
    assert snap['id'] == stale['snapshotId'] and snap['stale'] is False
    assert '你好' not in snap['text'], 'the refused click must not be replayed'


def test_live_input_types_and_clicks_without_waiting_for_observation(browser, site):
    opened = command(browser, 'create', url=site)
    tab = opened['tabId']
    shot = current(browser, tab)
    field = next(el for el in shot['elements'] if el['name'] == '姓名')
    apply = next(el for el in shot['elements'] if el['name'] == '应用姓名')
    result = browser.call('input', 'owner', tab, [
        {'type': 'click', 'x': field['x'] + 5, 'y': field['y'] + 5},
        {'type': 'text', 'text': '实时输入'},
        {'type': 'click', 'x': apply['x'] + 5, 'y': apply['y'] + 5},
    ])
    assert result['ok'] and result['tabId'] == tab
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if '你好，实时输入' in current(browser, tab)['text']:
            break
        time.sleep(.1)
    assert '你好，实时输入' in current(browser, tab)['text']


def test_live_cast_returns_jpeg_frames_and_stops_after_close(browser, site):
    opened = command(browser, 'create', url=site)
    tab = opened['tabId']
    frame = None
    deadline = time.monotonic() + 6
    while time.monotonic() < deadline:
        frame = browser.call('cast_next', 'owner', tab, 0)
        if frame:
            break
        time.sleep(.1)
    assert frame and frame['jpeg']
    raw = base64.b64decode(frame['jpeg'])
    assert raw.startswith(b'\xff\xd8') and len(raw) > 500
    assert browser.call('cast_next', 'owner', tab, frame['version']) is None
    assert command(browser, 'close', tab)['state'] == 'completed'


def test_any_failed_action_on_a_live_page_reobserves_instead_of_leaving_it_stale(browser, site):
    opened = command(browser, 'create', url=site)
    tab = opened['tabId']
    shot = current(browser, tab)
    refused = command(browser, 'fill', tab, shot['id'], ref=ref(shot, '密码'), text='not-a-real-secret')
    assert refused['state'] == 'failed' and '手动' in refused['error']
    assert refused.get('recovered') is True and refused.get('snapshotId')
    assert '已自动重新观察' in refused.get('notice', '')
    assert refused.get('moved') is False
    fresh = current(browser, tab)
    assert fresh['id'] == refused['snapshotId'] and fresh['stale'] is False
    # The recovered snapshot is directly usable, without a manual observe.
    names = [item['name'] for item in fresh['elements']]
    assert '姓名' in names
    clicked = command(browser, 'click', tab, fresh['id'], ref=ref(fresh, '应用姓名'))
    assert clicked['state'] == 'completed', clicked
