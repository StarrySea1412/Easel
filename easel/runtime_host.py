"""One durable backend per data directory; web processes only observe/forward.

The backend retains the existing task store and runner ownership. This module
does not enqueue model requests, recover by resending, or create a scheduler.
"""
from __future__ import annotations

import argparse
import asyncio
from contextlib import contextmanager
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request

from easel.paths import data_root

ROOT = Path(__file__).resolve().parents[1]
PREFIX = '/__easel_runtime/'
TOKEN_HEADER = b'x-easel-runtime-token'
CONTEXT_HEADER = b'x-easel-runtime-context'
HOP_HEADERS = {b'connection', b'keep-alive', b'proxy-authenticate', b'proxy-authorization',
               b'te', b'trailer', b'transfer-encoding', b'upgrade'}


class RuntimeUnavailable(RuntimeError):
    pass


@contextmanager
def ownership(path):
    """A live OS lock, never a PID file or an expiring timestamp."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a+b') as handle:
        if handle.tell() == 0:
            handle.write(b'0')
            handle.flush()
        handle.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise RuntimeUnavailable('执行服务仍持有数据目录；未启动第二个后端。') from exc
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_UN)


def locked(path):
    try:
        with ownership(path):
            return False
    except RuntimeUnavailable:
        return True


def code_digest(root=ROOT):
    digest = hashlib.sha256()
    files = [root / 'pyproject.toml']
    for directory in ('easel', 'web', 'scripts', 'deployment/138', 'mcp', 'skills/shared/scripts', 'openclaw'):
        for current, folders, names in os.walk(root / directory):
            folders[:] = [name for name in folders if name not in {
                'node_modules', '__pycache__', '.git', '.venv', 'frontend'}]
            files.extend(Path(current) / name for name in names
                         if Path(name).suffix in {'.py', '.js', '.ts', '.json'})
    # Include every lazy chunk, not just the entry HTML.
    files.extend(p for p in (root / 'web/frontend/dist').rglob('*') if p.is_file())
    for path in sorted(set(files)):
        if path.is_file():
            digest.update(str(path.relative_to(root)).replace('\\', '/').encode())
            digest.update(b'\0')
            digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def configuration_digest(environment, token):
    # Salt with the per-instance private key: even short secrets cannot be
    # guessed from a public, unsalted environment hash. No values are persisted.
    ignored = {'EASEL_RUNTIME_TOKEN', 'EASEL_RUNTIME_INSTANCE', 'EASEL_RUNTIME_WORKER',
               'EASEL_DURABLE_RUNTIME', 'EASEL_HOST', 'EASEL_GATEWAY_STARTUP_TIMEOUT'}
    values = {k: v for k, v in environment.items() if k not in ignored and (
        k.startswith(('EASEL_', 'OPENCLAW_')) or k in {
            'VSCODE_PROXY_URI', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
            'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'PYTHONPATH'})}
    return hmac.new(token.encode(), json.dumps(values, sort_keys=True).encode(), hashlib.sha256).hexdigest()


def _filtered(headers):
    connection = set()
    for key, value in headers:
        if key.lower() == b'connection':
            connection.update(part.strip().lower() for part in value.split(b','))
    return [(k, v) for k, v in headers if k.lower() not in HOP_HEADERS | connection]


def _private_directory(directory):
    if os.name != 'nt':
        directory.chmod(0o700 if directory.is_dir() else 0o600)
        return
    # The source checkout may inherit read access for other Windows users.
    # Protect only this new control directory, never the user's whole data tree.
    import ctypes
    from ctypes import wintypes
    security = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    security.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    security.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                            wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    security.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR)]
    security.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
    security.SetFileSecurityW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_void_p]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    token, sid, descriptor = wintypes.HANDLE(), wintypes.LPWSTR(), ctypes.c_void_p()
    try:
        if not security.OpenProcessToken(kernel.GetCurrentProcess(), 8, ctypes.byref(token)):
            raise ctypes.WinError(ctypes.get_last_error())
        size = wintypes.DWORD()
        security.GetTokenInformation(token, 1, None, 0, ctypes.byref(size))
        buffer = ctypes.create_string_buffer(size.value)
        if not security.GetTokenInformation(token, 1, buffer, size, ctypes.byref(size)):
            raise ctypes.WinError(ctypes.get_last_error())
        pointer = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_void_p))[0]
        if not security.ConvertSidToStringSidW(pointer, ctypes.byref(sid)):
            raise ctypes.WinError(ctypes.get_last_error())
        sddl = f'D:P(A;OICI;FA;;;{sid.value})(A;OICI;FA;;;SY)'
        if not security.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor), None):
            raise ctypes.WinError(ctypes.get_last_error())
        if not security.SetFileSecurityW(str(directory), 0x80000004, descriptor):
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        if token:
            kernel.CloseHandle(token)
        if sid:
            kernel.LocalFree(ctypes.cast(sid, ctypes.c_void_p))
        if descriptor:
            kernel.LocalFree(descriptor)


class RuntimeManager:
    def __init__(self, data=None, environment=None):
        self.data = Path(data or data_root(ROOT)).resolve()
        self.directory = self.data / '.execution-service'
        self.directory.mkdir(parents=True, exist_ok=True)
        _private_directory(self.directory)
        self.state_file = self.directory / 'instance.json'
        for name in ('instance.json', 'service.log'):
            existing = self.directory / name
            if existing.exists():
                _private_directory(existing)
        self.environment = dict(os.environ if environment is None else environment)
        self.environment['EASEL_DATA_DIR'] = str(self.data)

    def read(self):
        try:
            state = json.loads(self.state_file.read_text(encoding='utf-8'))
            if (not isinstance(state, dict) or state.get('schema') != 1
                    or not isinstance(state.get('token'), str) or len(state['token']) != 64
                    or not isinstance(state.get('instance'), str)
                    or state.get('data') != str(self.data)):
                raise ValueError()
            port = state.get('port')
            if port is not None and (type(port) is not int or not 0 < port < 65536):
                raise ValueError()
            return state
        except FileNotFoundError:
            return None
        except (OSError, ValueError, TypeError) as exc:
            raise RuntimeUnavailable('执行服务记录无法核对；未停止或启动任何后端。') from exc

    def write(self, state):
        temporary = self.directory / (secrets.token_hex(12) + '.tmp')
        try:
            with temporary.open('x', encoding='utf-8') as stream:
                if os.name != 'nt':
                    os.chmod(temporary, 0o600)
                json.dump(state, stream)
                stream.flush()
                os.fsync(stream.fileno())
            temporary.replace(self.state_file)
        finally:
            temporary.unlink(missing_ok=True)

    def control(self, state, action='health'):
        if not state or not state.get('port'):
            raise RuntimeUnavailable('执行服务尚未就绪；未重发请求。')
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        request = urllib.request.Request(f"http://127.0.0.1:{state['port']}{PREFIX}{action}",
            headers={TOKEN_HEADER.decode(): state['token']}, method='POST' if action in ('stop', 'shutdown') else 'GET')
        try:
            with opener.open(request, timeout=2) as response:
                value = json.load(response)
            if value.get('instance') != state['instance'] or value.get('code') != state['code']:
                raise ValueError()
            return value
        except urllib.error.HTTPError as exc:
            if exc.code == 409:
                raise RuntimeUnavailable('执行服务有在途请求或运行，请完成或明确停止后再关闭。') from None
            raise RuntimeUnavailable('执行服务身份核验失败；未启动第二个后端。') from None
        except (OSError, ValueError) as exc:
            raise RuntimeUnavailable('执行服务暂不可达；未重启、未重发请求。') from exc

    def _matching(self, state, digest):
        if (state.get('root') != str(ROOT) or state.get('code') != digest
                or state.get('configuration') != configuration_digest(self.environment, state['token'])):
            raise RuntimeUnavailable('现有执行服务的代码或启动配置不同；请空闲时执行 runtime stop 后重新启动。')

    def ensure(self, timeout=90):
        deadline = time.monotonic() + timeout
        # Serialize launch attempts. A timed-out observation is never evidence
        # that the existing service died.
        while True:
            try:
                with ownership(self.directory / 'startup.lock'):
                    return self._ensure_locked(deadline)
            except RuntimeUnavailable as exc:
                if '仍持有数据目录' not in str(exc) or time.monotonic() >= deadline:
                    raise
                time.sleep(.1)

    def _ensure_locked(self, deadline):
        digest = code_digest()
        state = self.read()
        if locked(self.directory / 'runtime.lock'):
            if state is None:
                raise RuntimeUnavailable('执行服务仍在运行但缺少身份记录；未启动第二个后端。')
            self._matching(state, digest)
            while True:
                try:
                    self.control(state)
                    return state
                except RuntimeUnavailable:
                    if time.monotonic() >= deadline or not locked(self.directory / 'runtime.lock'):
                        raise
                    time.sleep(.2)
                    state = self.read() or state
        if locked(self.directory / 'application.lock'):
            raise RuntimeUnavailable('已有独立启动的后端持有数据目录，请先关闭它。')
        token = secrets.token_hex(32)
        state = {'schema': 1, 'instance': secrets.token_hex(16), 'token': token,
                 'root': str(ROOT), 'data': str(self.data), 'code': digest,
                 'configuration': configuration_digest(self.environment, token), 'port': None}
        self.write(state)
        environment = {**self.environment, 'EASEL_RUNTIME_TOKEN': token,
                       'EASEL_RUNTIME_INSTANCE': state['instance'], 'EASEL_RUNTIME_WORKER': '1'}
        options = ({'creationflags': subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS}
                   if os.name == 'nt' else {'start_new_session': True})
        with (self.directory / 'service.log').open('ab') as output:
            process = subprocess.Popen([sys.executable, '-B', '-m', 'easel.runtime_worker'],
                cwd=ROOT, env=environment, stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                close_fds=True, **options)
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeUnavailable('执行服务启动失败，请查看数据目录 .execution-service/service.log。')
            current = self.read()
            if current and current['instance'] == state['instance'] and current.get('port'):
                try:
                    self.control(current)
                    return current
                except RuntimeUnavailable:
                    pass
            time.sleep(.1)
        # Keep the actual spawned handle alive. Never kill it on a probe timeout.
        raise RuntimeUnavailable('执行服务尚未就绪，进程仍保留；稍后重试连接。')

    def stop(self, timeout=45):
        # Serialize with launch before inspecting its lifetime lock.
        with ownership(self.directory / 'startup.lock'):
            return self._stop_locked(timeout)

    def _stop_locked(self, timeout):
        state = self.read()
        if not locked(self.directory / 'runtime.lock'):
            if state and state.get('port') is None:
                raise RuntimeUnavailable('执行服务启动状态尚未核实；未报告已关闭。')
            return {'stopped': True, 'running': False}
        value = self.control(state, 'stop')
        deadline = time.monotonic() + timeout
        while locked(self.directory / 'runtime.lock') and time.monotonic() < deadline:
            time.sleep(.1)
        if locked(self.directory / 'runtime.lock'):
            raise RuntimeUnavailable('执行服务仍在关闭；未强制结束进程。')
        return {**value, 'stopped': True}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


class RuntimeProxy:
    """Pure ASGI streaming bridge, with no backend import in the web process."""
    def __init__(self, manager=None):
        self.manager = manager or RuntimeManager()
        self.state = None
        self.client = None

    async def __call__(self, scope, receive, send):
        from starlette.responses import JSONResponse
        if scope['type'] == 'lifespan':
            return await self.lifespan(receive, send)
        if scope['type'] != 'http':
            return await send({'type': 'websocket.close', 'code': 1008})
        if scope['path'].startswith(PREFIX.rstrip('/')):
            return await JSONResponse({'detail': 'Not found'}, status_code=404)(scope, receive, send)
        if self.client is None:
            return await JSONResponse({'detail': '执行服务未连接。'}, status_code=503)(scope, receive, send)
        started = False
        response = None
        try:
            headers = [(k, v) for k, v in _filtered(scope['headers'])
                       if not k.lower().startswith(b'x-easel-runtime-')]
            context = json.dumps({'scheme': scope['scheme'], 'client': scope.get('client'),
                                  'server': scope.get('server'), 'root_path': scope.get('root_path', '')},
                                 separators=(',', ':')).encode()
            import base64
            headers += [(TOKEN_HEADER, self.state['token'].encode()),
                        (CONTEXT_HEADER, base64.urlsafe_b64encode(context))]
            from httpx import URL
            target = URL(f"http://127.0.0.1:{self.state['port']}").copy_with(
                raw_path=scope.get('raw_path', scope['path'].encode()) +
                (b'?' + scope['query_string'] if scope['query_string'] else b''))

            async def body():
                while True:
                    message = await receive()
                    if message['type'] == 'http.disconnect':
                        raise asyncio.CancelledError()
                    yield message.get('body', b'')
                    if not message.get('more_body', False):
                        break

            request = self.client.build_request(scope['method'], target, headers=headers, content=body())
            response = await self.client.send(request, stream=True, follow_redirects=False)
            await send({'type': 'http.response.start', 'status': response.status_code,
                        'headers': _filtered(response.headers.raw)})
            started = True
            # Raw bytes preserve compression, range responses and download hashes.
            async def forward():
                async for chunk in response.aiter_raw():
                    await send({'type': 'http.response.body', 'body': chunk, 'more_body': True})
                await send({'type': 'http.response.body', 'body': b'', 'more_body': False})

            async def disconnected():
                while (await receive())['type'] != 'http.disconnect':
                    pass

            tasks = [asyncio.create_task(forward()), asyncio.create_task(disconnected())]
            try:
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
        except asyncio.CancelledError:
            raise
        except Exception:
            if started:
                raise  # Close the truncated stream; do not fabricate a terminal event.
            await JSONResponse({'detail': '执行服务暂不可达，请连接原运行；未重发请求。'},
                               status_code=503)(scope, receive, send)
        finally:
            if response is not None:
                await response.aclose()

    async def lifespan(self, receive, send):
        import httpx
        from http.cookiejar import CookieJar, DefaultCookiePolicy
        await receive()
        try:
            self.state = await asyncio.to_thread(self.manager.ensure)
            # A shared reverse proxy forwards each caller's Cookie/Set-Cookie
            # headers, but must never retain a downstream login for other callers.
            cookies = CookieJar(policy=DefaultCookiePolicy(allowed_domains=[]))
            self.client = httpx.AsyncClient(timeout=httpx.Timeout(None, connect=5), trust_env=False,
                limits=httpx.Limits(max_connections=None, max_keepalive_connections=20), cookies=cookies)
        except Exception as exc:
            await send({'type': 'lifespan.startup.failed', 'message': str(exc)})
            return
        await send({'type': 'lifespan.startup.complete'})
        await receive()
        await self.client.aclose()
        self.client = None
        # Closing a web observer never terminates the execution owner.
        await send({'type': 'lifespan.shutdown.complete'})


def main(argv=None):
    parser = argparse.ArgumentParser(description='Easel execution service')
    parser.add_argument('action', choices=('status', 'stop', 'serve'), nargs='?', default='status')
    args = parser.parse_args(argv)
    manager = RuntimeManager()
    try:
        if args.action == 'serve':
            import uvicorn
            uvicorn.run(RuntimeProxy(manager), host=os.environ.get('EASEL_HOST', '0.0.0.0'),
                        port=int(os.environ.get('EASEL_PORT', '7860')), proxy_headers=False, log_level='warning')
        elif args.action == 'stop':
            print(json.dumps(manager.stop(), ensure_ascii=False))
        elif locked(manager.directory / 'runtime.lock'):
            print(json.dumps(manager.control(manager.read()), ensure_ascii=False))
        else:
            print(json.dumps({'running': False}))
        return 0
    except RuntimeUnavailable as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
