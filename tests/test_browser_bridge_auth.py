"""Exercise the browser CLI through the production authentication boundary."""
import io
import json
import time
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from easel import browser_bridge
from easel.browser_bridge_auth import HEADER, MAX_BODY, sign, signature
from easel.browser_runtime import BrowserService, BrowserError
from easel.server_access import AccessStore, ServerAccessMiddleware, password_hash
from web.browser_api import router

PATH = '/api/browser/sessions/owned/agent/tool'


@pytest.fixture
def deployment(tmp_path, monkeypatch):
    access = tmp_path / 'access.json'
    access.write_text(json.dumps({'sessionKey': 'ab' * 32,
        'users': {'operator': password_hash('test-password')}}))
    monkeypatch.setenv('EASEL_ACCESS_FILE', str(access))
    monkeypatch.setenv('EASEL_BROWSER_URL', 'http://127.0.0.1:7880')
    store = AccessStore(access)
    browser = BrowserService(tmp_path / 'outputs')
    app = FastAPI()
    app.include_router(router(browser))
    app.add_middleware(ServerAccessMiddleware, store=store,
                       origins=['http://127.0.0.1:7880', 'https://easel.test'])
    try:
        yield app, store, browser
    finally:
        browser.close()


def client(app, peer='127.0.0.1'):
    return TestClient(app, base_url='http://127.0.0.1:7880', client=(peer, 50000))


def connect_cli(app, monkeypatch):
    http = client(app)
    def local_urlopen(req, timeout):
        response = http.post(req.full_url, content=req.data, headers=dict(req.header_items()))
        if response.status_code != 200:
            raise HTTPError(req.full_url, response.status_code, '', {}, io.BytesIO(response.content))
        return io.BytesIO(response.content)

    monkeypatch.setattr(browser_bridge, 'urlopen', local_urlopen)
    return http


def test_real_cli_authenticates_only_its_local_tool_request(deployment, monkeypatch):
    app, store, browser = deployment
    http = connect_cli(app, monkeypatch)
    assert http.post(PATH, json={'action': 'state'}).status_code == 400
    result = browser_bridge.request('owned', {'action': 'state'})
    assert result['sessionId'] == 'owned' and result['tabs'] == []
    assert browser.browser is None  # A context hint/state check never launches Chromium.
    assert http.post('/api/config', json={}).status_code == 400
    assert http.get('https://easel.test/api/browser/sessions/owned').status_code == 401


def test_authenticated_bridge_opens_real_page_but_keeps_agent_site_control(deployment, monkeypatch):
    app, _, browser = deployment
    connect_cli(app, monkeypatch)
    class Page(BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(b'<title>Bridge integration</title><main>Actual page through server authentication<a href="/next">Next</a></main>')
    site = ThreadingHTTPServer(('127.0.0.1', 0), Page)
    worker = threading.Thread(target=site.serve_forever, daemon=True)
    worker.start()
    url = f'http://127.0.0.1:{site.server_port}'
    browser.allowed_origins.add(url)
    try:
        result = browser_bridge.request('owned', {'action': 'create', 'url': url, 'requestId': 'first-page'})
        snapshot = result['snapshot']
        assert result['job']['state'] == 'completed'
        assert snapshot['title'] == 'Bridge integration' and 'Actual page' in snapshot['text']
        link = next(item for item in snapshot['elements'] if item['name'] == 'Next')
        with pytest.raises(BrowserError, match='尚未允许Agent操作'):
            browser_bridge.request('owned', {'action': 'click', 'requestId': 'no-control',
                'tabId': snapshot['tabId'], 'snapshotId': snapshot['id'], 'ref': link['ref']})
    finally:
        site.shutdown()
        site.server_close()
        worker.join(timeout=2)


@pytest.mark.parametrize('case', ['body', 'session', 'expired', 'future', 'tampered', 'remote', 'origin', 'host', 'other-route', 'method'])
def test_bridge_rejects_forgery_replay_to_other_scope_and_public_calls(deployment, case):
    app, store, _ = deployment
    body = b'{"action":"state"}'
    path = PATH
    token = sign(store.key, path, body)
    headers = {HEADER: token, 'Content-Type': 'application/json'}
    peer, method = '127.0.0.1', 'POST'
    if case == 'body': body = b'{"action":"create"}'
    if case == 'session': path = path.replace('/owned/', '/foreign/')
    if case in ('expired', 'future'):
        issued = int(time.time()) + (-120 if case == 'expired' else 120)
        headers[HEADER] = f'{issued}.{signature(store.key, path, body, issued)}'
    if case == 'tampered': headers[HEADER] += 'x'
    if case == 'remote': peer = '172.18.0.3'
    if case == 'origin': headers['Origin'] = 'https://easel.test'
    if case == 'host': headers['Host'] = 'evil.test'
    if case == 'other-route': path = '/api/config'
    if case == 'method': method = 'GET'
    assert client(app, peer).request(method, path, content=body, headers=headers).status_code == 403


def test_bridge_bounds_body_before_dispatch_and_fails_closed_on_bad_local_config(deployment, monkeypatch):
    app, store, _ = deployment
    body = b'x' * (MAX_BODY + 1)
    assert client(app).post(PATH, content=body, headers={HEADER: sign(store.key, PATH, body)}).status_code == 413
    monkeypatch.setenv('EASEL_ACCESS_FILE', 'missing-access-config')
    with pytest.raises(BrowserError, match='桥接认证不可用'):
        browser_bridge.request('owned', {'action': 'state'})


def test_desktop_cli_keeps_its_existing_unconfigured_auth_behavior(monkeypatch):
    monkeypatch.delenv('EASEL_ACCESS_FILE', raising=False)
    def local_urlopen(req, timeout):
        assert HEADER.lower() not in {key.lower() for key in req.headers}
        return io.BytesIO(b'{"sessionId":"owned"}')
    monkeypatch.setattr(browser_bridge, 'urlopen', local_urlopen)
    assert browser_bridge.request('owned', {'action': 'state'})['sessionId'] == 'owned'
