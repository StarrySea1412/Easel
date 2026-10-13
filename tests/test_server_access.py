import base64
import hashlib
import hmac
import json
from pathlib import Path
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from easel.server_access import AccessStore, ServerAccessMiddleware, password_hash, password_matches, COOKIE


@pytest.fixture
def server(tmp_path):
    path = tmp_path / 'access.json'
    path.write_text(json.dumps({'sessionKey': 'ab' * 32, 'environment': 'production',
        'users': {'operator': password_hash('test-strong-password')}}))
    store = AccessStore(path)
    app = FastAPI()
    app.add_middleware(ServerAccessMiddleware, store=store, origins=['https://easel.test'])
    @app.get('/api/files')
    def files():
        return {'actual': 'private file'}
    @app.post('/api/config')
    def config():
        return {'saved': True}
    return TestClient(app, base_url='https://easel.test', follow_redirects=False), store


def test_passwords_use_salted_hashes_and_validate_only_the_actual_password():
    first, second = password_hash('gaoji'), password_hash('gaoji')
    assert first != second and 'gaoji' not in first
    assert password_matches('gaoji', first)
    assert not password_matches('wrong', first)
    assert not password_matches('gaoji', 'malformed')


def test_login_enforces_origin_and_cookie_auth_covers_all_api_methods(server):
    client, store = server
    assert client.get('/api/files').status_code == 401
    assert client.get('/').headers['location'] == '/login'
    assert client.post('/login', data={'username': 'operator', 'password': 'test-strong-password'}).status_code == 403
    result = client.post('/login', headers={'Origin': 'https://easel.test'},
        data={'username': 'operator', 'password': 'test-strong-password'})
    assert result.status_code == 303
    cookie = result.headers['set-cookie']
    assert 'Secure' in cookie and 'HttpOnly' in cookie and 'SameSite=strict' in cookie
    assert client.get('/api/files').json() == {'actual': 'private file'}
    assert client.post('/api/config').status_code == 403
    assert client.post('/api/config', headers={'Origin': 'https://evil.test'}).status_code == 403
    assert client.post('/api/config', headers={'Origin': 'https://easel.test'}).status_code == 200
    assert client.post('/logout', headers={'Origin': 'https://easel.test'}).status_code == 303
    assert client.get('/api/files').status_code == 401


def test_forged_expired_or_removed_user_cookies_are_not_authorized(server):
    client, store = server
    valid = store.token('operator')
    assert store.identity(valid) == 'operator'
    assert store.identity(valid + 'x') is None
    content = base64.urlsafe_b64encode(json.dumps(['operator', int(time.time()) - 1]).encode()).decode()
    expired = content + '.' + hmac.new(store.key, content.encode(), hashlib.sha256).hexdigest()
    assert store.identity(expired) is None
    store.users.pop('operator')
    assert store.identity(valid) is None


def test_bad_login_is_throttled_and_payload_is_bounded(server):
    client, store = server
    for _ in range(8):
        assert client.post('/login', headers={'Origin': 'https://easel.test'}, data={'username': 'operator', 'password': 'wrong'}).status_code == 401
    assert client.post('/login', headers={'Origin': 'https://easel.test'}, data={'username': 'operator', 'password': 'wrong'}).status_code == 429
    assert client.post('/login', headers={'Origin': 'https://easel.test'}, content='x' * 4097).status_code == 413
    assert client.post('/login', headers={'Origin': 'https://easel.test'}, content='a=1&b=2&c=3&d=4&e=5').status_code == 400


def test_isolated_test_credentials_cannot_be_used_by_production_middleware(tmp_path):
    path = tmp_path / 'access.json'
    path.write_text(json.dumps({'sessionKey': 'ab' * 32, 'environment': 'isolated-test', 'users': {'gaojitest': password_hash('gaoji')}}))
    store = AccessStore(path)
    with pytest.raises(ValueError, match='environment'):
        ServerAccessMiddleware(FastAPI(), store=store, origins=[], test_mode=False)
    app = FastAPI()
    app.add_middleware(ServerAccessMiddleware, store=store, origins=['http://testserver'], test_mode=True)
    client = TestClient(app, follow_redirects=False)
    result = client.post('/login', headers={'Origin': 'http://testserver'}, data={'username': 'gaojitest', 'password': 'gaoji'})
    assert result.status_code == 303 and 'Secure' not in result.headers['set-cookie']


def test_login_rejects_bad_host_duplicate_fields_and_insecure_transport(server):
    client, _ = server
    assert client.get('/login', headers={'Host': 'evil.test'}).status_code == 400
    assert client.get('http://easel.test/login').status_code == 400
    assert client.post('/login', headers={'Origin': 'https://easel.test'},
                       content='username=a&username=b&password=x').status_code == 400
