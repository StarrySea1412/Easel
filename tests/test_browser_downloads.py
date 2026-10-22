"""Real browser file transfers; no platform accounts or model calls."""
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import time

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from easel.browser_runtime import BrowserService
from easel.browser_downloads import safe_name, validate_file
from web.browser_api import router

PDF = b'%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'
PAGE = '''<title>网页文件验收</title><main><h1>已生成文件</h1>
<a href="/report.pdf" download>下载报告 PDF</a>
<button onclick="const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob(['actual generated text'],{type:'text/plain'}));a.download='生成结果.txt';a.click()">下载生成文件</button>
<a href="/error.pdf" download>下载失效文件</a>
<a href="/setup.exe" download>Download installer</a>
<a href="/next">普通页面</a><button onclick="document.querySelector('h1').textContent='导出菜单已打开'">导出菜单</button>
</main>'''


@pytest.fixture(scope='module')
def site():
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def do_GET(self):
            file = self.path in {'/report.pdf', '/error.pdf', '/setup.exe'}
            body = (PDF if self.path == '/report.pdf' else b'<html><body>Sign in required</body></html>'
                    if self.path == '/error.pdf' else b'MZ-not-an-allowed-download' if self.path == '/setup.exe'
                    else PAGE.encode())
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream' if file else 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            if file: self.send_header('Content-Disposition', 'attachment; filename="' + self.path[1:] + '"')
            self.end_headers()
            self.wfile.write(body)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f'http://127.0.0.1:{server.server_port}'
    server.shutdown(); server.server_close(); thread.join(timeout=2)


@pytest.fixture
def browser(tmp_path, site):
    service = BrowserService(tmp_path / 'outputs', allowed_origins=[site])
    yield service
    service.close()


def command(service, action, **extra):
    import uuid
    return service.call('command', 'owner', {'requestId': uuid.uuid4().hex, 'action': action, **extra})


def open_page(service, site):
    job = command(service, 'create', url=site)
    assert job['state'] == 'completed', job
    state = service.call('state', 'owner')
    return job['tabId'], state['snapshots'][job['tabId']]


def wait_downloads(service, count=1):
    until = time.monotonic() + 12
    while time.monotonic() < until:
        rows = service.call('state', 'owner')['downloads']
        if len(rows) >= count and all(r['state'] in {'completed', 'failed'} for r in rows): return rows
        time.sleep(.05)
    pytest.fail(f'Download did not settle: {rows}')


def selected(snapshot, name):
    return next(e['ref'] for e in snapshot['elements'] if e['name'] == name)


def test_recognize_and_save_http_and_blob_files_with_ownership_and_restart(browser, site):
    tab, snapshot = open_page(browser, site)
    assert '下载报告 PDF' in [e['name'] for e in snapshot['downloadCandidates']]
    assert '普通页面' not in [e['name'] for e in snapshot['downloadCandidates']]
    job = command(browser, 'download', tabId=tab, snapshotId=snapshot['id'], ref=selected(snapshot, '下载报告 PDF'))
    assert job['state'] == 'completed', job
    first = wait_downloads(browser)[0]
    assert first['state'] == 'completed', first
    assert first['sha256'] == hashlib.sha256(PDF).hexdigest() and first['bytes'] == len(PDF)
    assert (browser.outputs / first['file']['path']).read_bytes() == PDF
    snapshot = browser.call('state', 'owner')['snapshots'][tab]
    assert command(browser, 'click', tabId=tab, snapshotId=snapshot['id'], ref=selected(snapshot, '下载生成文件'))['state'] == 'completed'
    second = wait_downloads(browser, 2)[1]
    assert second['state'] == 'completed', second
    assert (browser.outputs / second['file']['path']).read_text() == 'actual generated text'
    assert second['name'] == '生成结果.txt'
    app = FastAPI(); app.include_router(router(browser))
    with TestClient(app) as http:
        route = '/api/browser/sessions/owner/downloads/' + first['id'] + '/file'
        assert http.get(route).content == PDF
        assert 'attachment' in http.get(route).headers['content-disposition']
        assert http.get(route.replace('/owner/', '/foreign/')).status_code == 404
    outputs = browser.outputs
    browser.close()
    restored = BrowserService(outputs, allowed_origins=[site])
    try:
        assert restored.call('state', 'owner')['downloads'][0]['sha256'] == first['sha256']
        assert Path(restored.call('download_file', 'owner', first['id'])).read_bytes() == PDF
        assert restored.browser is None, 'Reading saved receipts must not relaunch the browser'
    finally:
        restored.close()


@pytest.mark.parametrize('name', ['下载失效文件', 'Download installer'])
def test_html_errors_and_executables_never_become_completed_files(browser, site, name):
    tab, snapshot = open_page(browser, site)
    command(browser, 'download', tabId=tab, snapshotId=snapshot['id'], ref=selected(snapshot, name))
    row = wait_downloads(browser)[0]
    assert row['state'] == 'failed' and 'file' not in row, row
    assert not list(browser.outputs.glob('_inbox/*/download-*/*'))


def test_direct_file_navigation_is_saved_and_not_misreported_as_page_failure(browser, site):
    job = command(browser, 'create', url=site + '/report.pdf')
    assert job['state'] == 'completed', job
    assert wait_downloads(browser)[0]['state'] == 'completed'


def test_agent_download_still_requires_site_control_and_returns_actual_file_receipt(browser, site):
    from easel.browser_runtime import BrowserError
    tab, snapshot = open_page(browser, site)
    args = {'action': 'download', 'requestId': 'agent-download', 'tabId': tab,
            'snapshotId': snapshot['id'], 'ref': selected(snapshot, '下载报告 PDF')}
    with pytest.raises(BrowserError, match='尚未允许Agent'):
        browser.call('tool_result', 'owner', args)
    browser.call('control', 'owner', site, True)
    result, _ = browser.call('tool_result', 'owner', args)
    assert result['job']['state'] == 'completed'
    wait_downloads(browser)
    state, _ = browser.call('tool_result', 'owner', {'action': 'state'})
    assert state['downloads'][0]['file']['path'].startswith('_inbox/')
    assert state['downloads'][0]['sha256'] == hashlib.sha256(PDF).hexdigest()
    again, _ = browser.call('tool_result', 'owner', args)
    assert again['job']['id'] == 'agent-download' and len(again['downloads']) == 1


def test_user_can_download_selected_file_after_fencing_idle_agent_and_resume_invalidates_old_refs(browser, site):
    tab, snapshot = open_page(browser, site)
    taken = browser.call('takeover', 'owner', tab, True)
    assert taken['tabs'][0]['userControl'] and not taken['snapshots'][tab]['stale']
    job = command(browser, 'download', tabId=tab, snapshotId=snapshot['id'], ref=selected(snapshot, '下载报告 PDF'))
    assert job['state'] == 'completed', job
    assert wait_downloads(browser)[0]['state'] == 'completed'
    before = browser.call('state','owner')['snapshots'][tab]
    resumed = browser.call('takeover','owner',tab,False)
    assert resumed['snapshots'][tab]['id'] != before['id']
    stale = command(browser,'download',tabId=tab,snapshotId=before['id'],ref=selected(before,'下载报告 PDF'))
    assert stale['state']=='failed' and '过期' in stale['error']


def test_filename_and_content_validation(tmp_path):
    assert '/' not in safe_name('../../报告.pdf') and '\\' not in safe_name('..\\报告.pdf')
    assert safe_name('CON.txt') == '_CON.txt'
    with pytest.raises(ValueError): safe_name('malware.bat')
    file = tmp_path / 'part'
    file.write_bytes(PDF)
    assert validate_file(file, 'download') == 'download.pdf'
    with pytest.raises(ValueError): validate_file(file, 'picture.png')
    file.write_bytes(b'')
    with pytest.raises(ValueError): validate_file(file, 'empty.txt')


@pytest.mark.parametrize('limit', ['MAX_FILE', 'MAX_SESSION', 'MAX_TOTAL'])
def test_download_limits_do_not_leave_success_or_partial_files(browser, site, monkeypatch, limit):
    import easel.browser_downloads as module
    monkeypatch.setattr(module, limit, 16)
    tab, snapshot = open_page(browser, site)
    command(browser, 'download', tabId=tab, snapshotId=snapshot['id'], ref=selected(snapshot, '下载报告 PDF'))
    row = wait_downloads(browser)[0]
    assert row['state'] == 'failed' and 'file' not in row, row
    assert not list(browser.outputs.glob('_inbox/*/download-*/*'))


def test_export_menu_is_not_a_completed_file_and_normal_links_are_not_download_actions(browser, site):
    tab, snapshot = open_page(browser, site)
    ordinary = command(browser, 'download', tabId=tab, snapshotId=snapshot['id'], ref=selected(snapshot, '普通页面'))
    assert ordinary['state'] == 'failed' and '不是已识别' in ordinary['error']
    command(browser, 'observe', tabId=tab)
    snapshot = browser.call('state', 'owner')['snapshots'][tab]
    menu = command(browser, 'download', tabId=tab, snapshotId=snapshot['id'], ref=selected(snapshot, '导出菜单'))
    assert menu['state'] == 'failed' and '未检测到文件下载' in menu['error']
    assert browser.call('state', 'owner')['downloads'] == []


def test_receipt_source_omits_signed_query_and_interrupted_download_never_replays(tmp_path):
    from easel.browser_downloads import safe_source
    assert safe_source('https://example.com/files?token=private#secret') == 'https://example.com/files'
    service = BrowserService(tmp_path)
    folder = service._folder('owner');folder.mkdir(parents=True)
    (folder/'tabs.json').write_text(json.dumps({'downloads':[{'id':'old','state':'receiving'}]}))
    try:
        state = service.call('state', 'owner')
        assert state['downloads'][0]['state'] == 'failed'
        assert service.browser is None
    finally: service.close()
