"""Public callers must never inherit the reverse proxy's cookie state."""
from types import SimpleNamespace
import json

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
import httpx
import pytest

from easel.runtime_host import RuntimeProxy
from easel.runtime_worker import PrivateApplication
from easel.server_access import AccessStore, ServerAccessMiddleware, password_hash


@pytest.mark.parametrize('scheme', ['http', 'https'])
def test_proxy_preserves_caller_auth_without_sharing_login_cookies(tmp_path, monkeypatch, scheme):
    access = tmp_path / 'access.json'
    access.write_text(json.dumps({'sessionKey': 'ab' * 32,
        'environment': 'isolated-test' if scheme == 'http' else 'production',
        'users': {name: password_hash('test-password-' + name) for name in ('alice', 'bob')}}))
    backend = FastAPI()
    origin = scheme + '://testserver'
    backend.add_middleware(ServerAccessMiddleware, store=AccessStore(access),
        origins=[origin], test_mode=scheme == 'http')

    @backend.get('/api/identity')
    async def identity(request: Request):
        return {'operator': request.scope['easel.operator']}

    @backend.post('/api/write')
    async def write():
        return {'saved': True}

    state = {'token': 'cd' * 32, 'instance': 'test-instance', 'code': 'test-code', 'port': 12345}
    private = PrivateApplication(backend, state)
    create_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kwargs: create_client(
        transport=httpx.ASGITransport(app=private, client=('127.0.0.1', 10000)), **kwargs))
    proxy = RuntimeProxy(SimpleNamespace(ensure=lambda: state))

    with TestClient(proxy, base_url=origin, follow_redirects=False) as caller:
        assert caller.get('/api/identity').status_code == 401
        login = caller.post('/login', headers={'Origin': origin},
            data={'username': 'alice', 'password': 'test-password-alice'})
        assert login.status_code == 303
        assert 'HttpOnly' in login.headers['set-cookie']
        assert 'SameSite=strict' in login.headers['set-cookie']
        assert ('Secure' in login.headers['set-cookie']) == (scheme == 'https')
        alice_cookie = caller.cookies.get('easel_access')
        assert caller.get('/api/identity').json() == {'operator': 'alice'}

        # A new caller has no cookie. The public transport stays the same.
        caller.cookies.clear()
        anonymous = caller.get('/api/identity')
        assert 'cookie' not in anonymous.request.headers
        assert anonymous.status_code == 401
        assert caller.get('/api/identity', headers={'Cookie': 'easel_access=forged'}).status_code == 401
        assert caller.post('/api/write', headers={'Origin': origin}).status_code == 401

        assert caller.post('/login', headers={'Origin': origin},
            data={'username': 'bob', 'password': 'test-password-bob'}).status_code == 303
        assert caller.get('/api/identity').json() == {'operator': 'bob'}
        assert caller.get('/api/identity', headers={'Cookie': 'easel_access=' + alice_cookie}).json() == {'operator': 'alice'}
        assert caller.post('/api/write').status_code == 403
        assert caller.post('/api/write', headers={'Origin': origin}).status_code == 200
        assert caller.post('/logout', headers={'Origin': origin}).status_code == 303
        assert caller.get('/api/identity').status_code == 401
        assert not list(proxy.client.cookies.jar)
