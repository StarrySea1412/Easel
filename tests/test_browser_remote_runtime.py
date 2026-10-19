"""Deployment CDP authentication and fail-closed connection behavior."""
import asyncio
import base64
import json
from types import SimpleNamespace

import pytest

from easel.browser_runtime import BrowserError, BrowserService


@pytest.mark.parametrize('failure', [None, 'unavailable', 'invalid-auth'])
def test_sidecar_authentication_never_falls_back_to_local_launch(tmp_path, monkeypatch, failure):
    endpoint = 'http://browser:18801'
    password = 'test-only-secret-' * 3
    auth = tmp_path / 'browser-auth.json'
    auth.write_text(json.dumps({'username': 'easel-browser', 'password': password}))
    monkeypatch.setenv('EASEL_BROWSER_CDP_ENDPOINT', endpoint)
    monkeypatch.setenv('EASEL_BROWSER_AUTH_FILE', str(auth))
    calls = []
    connected = SimpleNamespace(is_connected=lambda: True)

    async def connect(url, *, headers, timeout):
        calls.append(url)
        assert headers == {'Authorization': 'Basic ' + base64.b64encode(
            ('easel-browser:' + password).encode()).decode()}
        assert timeout == 8000
        if failure == 'unavailable':
            raise RuntimeError('internal error containing ' + password)
        return connected

    async def local_launch(**_):
        pytest.fail('Remote deployment must never launch a local browser')

    service = BrowserService(tmp_path)
    service.playwright = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=connect, launch=local_launch))
    if failure == 'invalid-auth':
        auth.write_text('{}')
    if failure:
        with pytest.raises(BrowserError) as raised:
            asyncio.run(service._launch_browser())
        assert raised.value.status == 503
        assert password not in str(raised.value)
        assert service.browser is None
    else:
        asyncio.run(service._launch_browser())
        asyncio.run(service._launch_browser())
        assert service.browser is connected
    assert calls == ([] if failure == 'invalid-auth' else [endpoint])
