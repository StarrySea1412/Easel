import json
import sys
import urllib.error
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'skills/shared/scripts'))
import bili_login
import web.app as web


@pytest.mark.parametrize('failure', [urllib.error.URLError('token must not leak'), TimeoutError('private url')])
def test_qr_network_failure_ends_starting_and_reports_safe_message(tmp_path, monkeypatch, failure):
    monkeypatch.setattr(bili_login, '_gen_qr', Mock(side_effect=failure))
    status = tmp_path / 'status.json'
    args = SimpleNamespace(qr_out=str(tmp_path / 'qr.png'), cookie=str(tmp_path / 'cookie.json'), status_file=str(status), timeout=20)
    assert bili_login.cmd_login(args) == 1
    data = json.loads(status.read_text(encoding='utf-8'))
    assert data['state'] == 'error' and data['qr'] == ''
    assert '网络或代理' in data['message']
    assert 'private' not in data['message'] and 'token' not in data['message']
    assert not Path(args.cookie).exists()


def test_qr_marker_includes_real_image_dimensions(tmp_path, monkeypatch):
    monkeypatch.setattr(bili_login, '_gen_qr', lambda: ('https://example.com/mock-login', 'mock-code'))
    monkeypatch.setattr(bili_login, '_poll', lambda code: (86038, {}))
    status = tmp_path / 'status.json'
    args = SimpleNamespace(qr_out=str(tmp_path / 'qr.png'), cookie=str(tmp_path / 'cookie.json'), status_file=str(status), timeout=20)
    statuses = []
    write = bili_login.login_state.write_status
    def capture(*a, **kw):
        write(*a, **kw)
        statuses.append(json.loads(status.read_text(encoding='utf-8')))
    monkeypatch.setattr(bili_login.login_state, 'write_status', capture)
    assert bili_login.cmd_login(args) == 1
    ready = next(row for row in statuses if row['state'] == 'qr_ready')
    assert ready['qrKind'] == 'qr' and ready['qrWidth'] == ready['qrHeight'] > 100
    assert Path(args.qr_out).read_bytes().startswith(bytes.fromhex('89504e47'))
    assert statuses[-1]['state'] == 'expired'
    assert not Path(args.cookie).exists()


def test_login_child_preserves_system_proxy_without_forcing_bilibili_direct(monkeypatch):
    monkeypatch.setattr(web, 'child_env', lambda root: {})
    monkeypatch.delenv('EASEL_PROXY', raising=False)
    monkeypatch.setattr(web.urllib.request, 'getproxies', lambda: {'https': 'http://127.0.0.1:12345'})
    env = web._proxy_env()
    assert env['https_proxy'] == 'http://127.0.0.1:12345'
    assert 'http_proxy' not in env
    assert 'bilibili' not in env['no_proxy']
