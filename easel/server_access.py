"""Authenticated shared-workspace access, enabled only by the server entrypoint."""
from __future__ import annotations

import base64
import asyncio
import hashlib
import hmac
import html
import ipaddress
import json
from pathlib import Path
import secrets
import threading
import time
import urllib.parse

from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, RedirectResponse
from .browser_bridge_auth import HEADER as BRIDGE_HEADER, MAX_BODY as BRIDGE_MAX_BODY, TOOL_PATH, verify as verify_bridge

COOKIE = 'easel_access'
LIFETIME = 12 * 60 * 60


def password_hash(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1)
    return 'scrypt$16384$' + base64.b64encode(salt).decode() + '$' + base64.b64encode(digest).decode()


def password_matches(password: str, encoded: str) -> bool:
    try:
        kind, cost, salt, expected = encoded.split('$')
        if kind != 'scrypt' or cost != '16384' or len(password) > 1024:
            return False
        digest = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt), n=16384, r=8, p=1)
        return hmac.compare_digest(digest, base64.b64decode(expected))
    except (ValueError, TypeError):
        return False


class AccessStore:
    def __init__(self, path: Path):
        value = json.loads(path.read_text(encoding='utf-8'))
        self.key = bytes.fromhex(value['sessionKey'])
        if len(self.key) < 32:
            raise ValueError('Server session key must contain at least 32 random bytes.')
        self.users = value['users']
        self.environment = value.get('environment', 'production')
        if self.environment not in {'production', 'isolated-test'}:
            raise ValueError('Unknown credential environment.')
        if not self.users or not all(isinstance(v, str) and v.startswith('scrypt$16384$') for v in self.users.values()):
            raise ValueError('Server users require password hashes.')
        self.dummy = password_hash(secrets.token_urlsafe(24))
        self.failures: dict[str, tuple[int, float]] = {}
        self.lock = threading.Lock()

    def token(self, username: str) -> str:
        content = base64.urlsafe_b64encode(json.dumps([username, int(time.time()) + LIFETIME]).encode()).decode()
        return content + '.' + hmac.new(self.key, content.encode(), hashlib.sha256).hexdigest()

    def identity(self, token: str | None) -> str | None:
        try:
            content, signature = (token or '').split('.')
            if not hmac.compare_digest(signature, hmac.new(self.key, content.encode(), hashlib.sha256).hexdigest()):
                return None
            username, expiry = json.loads(base64.urlsafe_b64decode(content))
            return username if username in self.users and isinstance(expiry, int) and time.time() < expiry else None
        except (ValueError, TypeError, KeyError):
            return None

    def login(self, username: str, password: str, peer: str) -> tuple[str | None, int]:
        # Bounded process-local throttling, in addition to the single-worker service.
        with self.lock:
            now = time.monotonic()
            self.failures = {key: value for key, value in self.failures.items() if value[1] > now}
            count, _ = self.failures.get(peer, (0, now + 300))
            if count >= 8:
                return None, 429
            if len(self.failures) >= 4096 and peer not in self.failures:
                return None, 429
            self.failures[peer] = (count + 1, now + 300)
        valid = password_matches(password, self.users.get(username, self.dummy)) and username in self.users
        with self.lock:
            if valid:
                self.failures.pop(peer, None)
        return (self.token(username), 200) if valid else (None, 401)


def login_page(message: str = '') -> HTMLResponse:
    return HTMLResponse('''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Easel · 登录</title>
<style>*{box-sizing:border-box}body{margin:0;background:#f7f7f8;color:#242427;font:15px system-ui;min-height:100dvh;display:grid;place-items:center;padding:24px}main{width:min(360px,100%);background:#fff;border:1px solid #e5e5e8;border-radius:18px;padding:30px}h1{margin:0 0 26px;font-size:24px}label{display:block;margin:16px 0 6px}input{width:100%;padding:11px;border:1px solid #d5d5db;border-radius:8px;font:inherit}button{width:100%;margin-top:24px;padding:12px;background:#242427;color:white;border:0;border-radius:9px;font:inherit;cursor:pointer}input:focus-visible,button:focus-visible{outline:2px solid #5794db;outline-offset:2px}.error{color:#b73d3d;font-size:13px;margin-top:16px}</style></head>
<body><main><h1>Easel</h1><form method="post" action="/login"><label for="username">账号</label><input id="username" name="username" required maxlength="120" autocomplete="username"><label for="password">密码</label><input id="password" name="password" type="password" required maxlength="1024" autocomplete="current-password"><button type="submit">登录工作台</button></form>''' +
        ('<p class="error" role="alert">' + html.escape(message) + '</p>' if message else '') + '</main></body></html>',
        headers={'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"})


class ServerAccessMiddleware:
    def __init__(self, app, store: AccessStore, origins: list[str], test_mode: bool = False):
        self.app, self.store, self.origins, self.test_mode = app, store, set(origins), test_mode
        self.authorities = {urllib.parse.urlsplit(origin).netloc for origin in origins}
        if (store.environment == 'isolated-test') != test_mode:
            raise ValueError('Credential environment does not match the server deployment mode.')

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        request = Request(scope, receive)
        path = request.url.path
        peer = (scope.get('client') or ('unknown',))[0]
        if request.headers.get(BRIDGE_HEADER):
            # Only the same-host CLI may authenticate one exact tool request.
            # Public HTTPS/cookie access and all other endpoints stay unchanged.
            try:
                local = ipaddress.ip_address(peer).is_loopback
            except ValueError:
                local = False
            if (not local or request.method != 'POST' or not TOOL_PATH.fullmatch(path)
                    or request.headers.get('origin') or request.headers.get('host') not in self.authorities):
                return await JSONResponse({'detail': '本机浏览器桥接认证无效。'}, status_code=403)(scope, receive, send)
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > BRIDGE_MAX_BODY:
                    return await JSONResponse({'detail': '浏览器操作参数过长。'}, status_code=413)(scope, receive, send)
            raw = bytes(body)
            if not verify_bridge(self.store.key, path, raw, request.headers[BRIDGE_HEADER]):
                return await JSONResponse({'detail': '本机浏览器桥接认证无效或已过期。'}, status_code=403)(scope, receive, send)
            delivered = False

            async def replay():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {'type': 'http.request', 'body': raw, 'more_body': False}
                return await receive()

            return await self.app(scope, replay, send)
        forwarded = request.headers.get('x-forwarded-proto')
        # The Compose app port is private. Trust forwarding only from its nginx network.
        secure = request.url.scheme == 'https' or forwarded == 'https'
        if path == '/health/live' and peer in {'127.0.0.1', '::1'} and request.method == 'GET':
            return await JSONResponse({'live': True})(scope, receive, send)
        if request.headers.get('host') not in self.authorities:
            return await JSONResponse({'detail': 'Invalid host.'}, status_code=400)(scope, receive, send)
        if not secure and not self.test_mode:
            return await JSONResponse({'detail': 'HTTPS is required.'}, status_code=400)(scope, receive, send)
        if path == '/login':
            if request.method == 'GET':
                response = login_page()
            elif request.method == 'POST':
                if request.headers.get('origin') not in self.origins:
                    response = JSONResponse({'detail': '登录来源无效。'}, status_code=403)
                else:
                    # Avoid unbounded form parsing, including chunked requests.
                    raw = bytearray()
                    async for chunk in request.stream():
                        raw.extend(chunk)
                        if len(raw) > 4096:
                            return await JSONResponse({'detail': '登录信息过长。'}, status_code=413)(scope, receive, send)
                    try:
                        form = urllib.parse.parse_qs(raw.decode('utf-8', errors='replace'), max_num_fields=4)
                    except ValueError:
                        return await JSONResponse({'detail': '登录信息无效。'}, status_code=400)(scope, receive, send)
                    if any(len(values) != 1 for values in form.values()):
                        return await JSONResponse({'detail': '登录信息无效。'}, status_code=400)(scope, receive, send)
                    username, password = form.get('username', [''])[0], form.get('password', [''])[0]
                    token, status = await asyncio.to_thread(self.store.login, username, password, peer)
                    if token:
                        response = RedirectResponse('/', status_code=303)
                        response.set_cookie(COOKIE, token, max_age=LIFETIME, httponly=True,
                            secure=not self.test_mode, samesite='strict', path='/')
                        response.headers['Cache-Control'] = 'no-store'
                    else:
                        response = login_page('尝试过多，请稍后重试。' if status == 429 else '账号或密码错误。')
                        response.status_code = status
            else:
                response = JSONResponse({'detail': 'Method not allowed'}, status_code=405)
            return await response(scope, receive, send)
        identity = self.store.identity(request.cookies.get(COOKIE))
        if not identity:
            response = JSONResponse({'detail': '请先登录工作台。'}, status_code=401) if path.startswith('/api/') else RedirectResponse('/login', status_code=303)
            return await response(scope, receive, send)
        if request.method not in {'GET', 'HEAD', 'OPTIONS'} and request.headers.get('origin') not in self.origins:
            return await JSONResponse({'detail': '请求来源无效。'}, status_code=403)(scope, receive, send)
        if path == '/logout' and request.method == 'POST':
            response = RedirectResponse('/login', status_code=303)
            response.delete_cookie(COOKIE, path='/')
            return await response(scope, receive, send)
        scope['easel.operator'] = identity
        return await self.app(scope, receive, send)
