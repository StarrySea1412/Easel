"""Real-process protocol tests. No model, Gateway, credentials or user data."""
import asyncio
import base64
from concurrent.futures import ThreadPoolExecutor
import gzip
import json
import os
from pathlib import Path
import socket
import signal
import subprocess
import sys
import time
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from easel.runtime_host import (ROOT, RuntimeManager, RuntimeProxy, RuntimeUnavailable,
    ownership, locked, PREFIX, TOKEN_HEADER, CONTEXT_HEADER, configuration_digest)
from easel.runtime_worker import PrivateApplication


FIXTURE = '''
import asyncio, gzip, json, os
from pathlib import Path
from fastapi import FastAPI, Request
from starlette.responses import Response, StreamingResponse
app=FastAPI()
root=Path(os.environ['EASEL_DATA_DIR'])
runs={}
def runtime_busy(): return bool(runs)
@app.post('/run')
async def run(request: Request):
    value=await request.json()
    ident=value['id']
    with (root/'dispatches').open('a') as stream: stream.write(ident+'\\n')
    async def execute():
        try:
            while not (root/'release').exists(): await asyncio.sleep(.025)
            (root/'result').write_text('completed:'+ident)
        finally: runs.pop(ident,None)
    runs[ident]=asyncio.create_task(execute())
    return {'id':ident}
@app.get('/events')
async def events():
    async def stream():
        yield b'event: accepted\\ndata: original\\n\\n'
        while not (root/'result').exists(): await asyncio.sleep(.025)
        yield b'event: done\\ndata: original\\n\\n'
    return StreamingResponse(stream(),media_type='text/event-stream')
@app.get('/context')
async def context(request: Request):
    return {'scheme':request.url.scheme,'peer':request.client.host,'host':request.headers['host'],
            'query':str(request.url.query),'private':any(k.startswith('x-easel-runtime-') for k in request.headers)}
@app.post('/upload')
async def upload(request: Request):
    raw=await request.body()
    return Response(raw,headers={'Content-Type':'application/octet-stream'})
@app.get('/compressed')
async def compressed():
    response=Response(gzip.compress(b'raw bytes unchanged'),headers={'Content-Encoding':'gzip'})
    response.set_cookie('one','1');response.set_cookie('two','2')
    return response
@app.get('/redirect')
async def redirect(): return Response(status_code=303,headers={'Location':'/context'})
'''


def wait_for(predicate, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(.05)
    pytest.fail('condition did not become true')


@pytest.fixture
def manager(tmp_path):
    (tmp_path / 'fixture_backend.py').write_text(FIXTURE, encoding='utf-8')
    environment = {**os.environ, 'EASEL_DATA_DIR': str(tmp_path),
        'EASEL_RUNTIME_APP': 'fixture_backend:app', 'EASEL_PORT': '0',
        'PYTHONPATH': str(tmp_path) + os.pathsep + str(ROOT)}
    for key in ('EASEL_RUNTIME_TOKEN', 'EASEL_RUNTIME_INSTANCE', 'EASEL_RUNTIME_WORKER'):
        environment.pop(key, None)
    instance = RuntimeManager(tmp_path, environment)
    yield instance
    (tmp_path / 'release').touch()
    try:
        wait_for(lambda: not instance.control(instance.read())['busy']) if locked(instance.directory / 'runtime.lock') else None
        instance.stop()
    except RuntimeUnavailable:
        pass


def test_private_auth_scope_and_control_are_not_business_credentials():
    app = FastAPI()
    @app.get('/context')
    async def context(request: Request):
        return {'scheme': request.url.scheme, 'peer': request.client.host,
                'headers': dict(request.headers)}
    state = {'token': 'a' * 64, 'instance': 'identity', 'code': 'digest'}
    wrapped = PrivateApplication(app, state)
    wrapped.server = SimpleNamespace(should_exit=False)
    context = base64.urlsafe_b64encode(json.dumps({'scheme': 'https', 'client': ['203.0.113.4', 123],
        'server': ['easel.example', 443], 'root_path': ''}).encode()).decode()
    with TestClient(wrapped, client=('127.0.0.1', 2000)) as client:
        assert client.get('/context').status_code == 404
        headers = {TOKEN_HEADER.decode(): state['token'], CONTEXT_HEADER.decode(): context}
        result = client.get('/context', headers=headers).json()
        assert result['scheme'] == 'https' and result['peer'] == '203.0.113.4'
        assert not any(k.startswith('x-easel-runtime-') for k in result['headers'])
        assert client.get('/context', headers={TOKEN_HEADER.decode(): state['token']}).status_code == 400
        assert client.get(PREFIX + 'health', headers=headers).json()['instance'] == 'identity'
        wrapped.busy = lambda: True
        assert client.post(PREFIX + 'stop', headers=headers).status_code == 409
        assert not wrapped.draining and not wrapped.server.should_exit
        wrapped.busy = lambda: False
        assert client.post(PREFIX + 'stop', headers=headers).status_code == 200
        assert wrapped.draining and wrapped.server.should_exit
        assert client.get('/context', headers=headers).status_code == 503
    with TestClient(wrapped, client=('203.0.113.4', 2000)) as remote:
        assert remote.get(PREFIX + 'health', headers=headers).status_code == 404


def test_launch_once_reuse_and_private_proxy(manager):
    with ThreadPoolExecutor(3) as pool:
        states = list(pool.map(lambda _: manager.ensure(45), range(3)))
    assert len({value['instance'] for value in states}) == 1
    state = states[0]
    with httpx.Client(trust_env=False) as network:
        assert network.get(f"http://127.0.0.1:{state['port']}/context").status_code == 404
    with TestClient(RuntimeProxy(manager), client=('203.0.113.4', 3456)) as client:
        context = client.get('/context?one=1&one=2', headers={TOKEN_HEADER.decode(): 'forged'}).json()
        assert context == {'scheme': 'http', 'peer': '203.0.113.4', 'host': 'testserver',
                           'query': 'one=1&one=2', 'private': False}
        assert client.get(PREFIX + 'health').status_code == 404
        assert client.post(PREFIX + 'stop').status_code == 404
        payload = bytes(range(256)) * 1024
        assert client.post('/upload', content=payload).content == payload
        compressed = client.get('/compressed')
        assert compressed.content == b'raw bytes unchanged'
        assert len(compressed.headers.get_list('set-cookie')) == 2
        assert client.get('/redirect', follow_redirects=False).status_code == 303
    assert manager.control(state)['running']
    assert manager.ensure()['instance'] == state['instance']


def test_live_probe_failure_configuration_drift_and_legacy_owner_never_spawn(manager, monkeypatch):
    state = manager.ensure()
    monkeypatch.setattr(manager, 'control', lambda *_: (_ for _ in ()).throw(RuntimeUnavailable('probe failed')))
    monkeypatch.setattr(subprocess, 'Popen', lambda *_a, **_k: pytest.fail('must not launch another owner'))
    with pytest.raises(RuntimeUnavailable, match='probe failed'):
        manager.ensure(timeout=.2)
    manager.environment['EASEL_CODEX_ENABLED'] = 'changed'
    with pytest.raises(RuntimeUnavailable, match='启动配置不同'):
        manager.ensure(timeout=.2)
    manager.environment.pop('EASEL_CODEX_ENABLED', None)
    monkeypatch.undo()
    assert manager.stop()['stopped']
    with ownership(manager.directory / 'application.lock'):
        with pytest.raises(RuntimeUnavailable, match='独立启动'):
            manager.ensure()
    assert state['token'] not in configuration_digest({'EASEL_TEST_SECRET': 'secret'}, state['token'])


def test_real_web_process_dies_original_execution_and_stream_survive(manager):
    # Both web processes are real OS children; backend is a third detached owner.
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    manager.environment['EASEL_PORT'] = str(port)
    url = f'http://127.0.0.1:{port}'
    def start_web():
        return subprocess.Popen([sys.executable, '-B', '-m', 'easel.runtime_host', 'serve'],
            cwd=ROOT, env=manager.environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    def ready():
        try:
            return httpx.get(url + '/context', timeout=.5, trust_env=False).status_code == 200
        except httpx.HTTPError:
            return False
    first = start_web()
    second = None
    try:
        wait_for(ready, 40)
        original = manager.read()
        with httpx.Client(trust_env=False, timeout=10) as client:
            assert client.post(url + '/run', json={'id': 'one-turn'}).status_code == 200
            with client.stream('GET', url + '/events') as stream:
                assert next(stream.iter_lines()) == 'event: accepted'
            with pytest.raises(RuntimeUnavailable, match='在途'):
                manager.stop()
            first.kill()
            first.wait(timeout=10)
            assert manager.control(original)['busy']
            second = start_web()
            wait_for(ready, 40)
            assert manager.read()['instance'] == original['instance']
            (manager.data / 'release').touch()
            with client.stream('GET', url + '/events') as stream:
                events = list(stream.iter_lines())
            assert 'event: done' in events
            assert (manager.data / 'result').read_text() == 'completed:one-turn'
            assert (manager.data / 'dispatches').read_text().splitlines() == ['one-turn']
    finally:
        for process in (first, second):
            if process and process.poll() is None:
                process.kill()
                process.wait(timeout=10)


def test_corrupt_identity_never_starts_or_uses_a_pid(tmp_path, monkeypatch):
    manager = RuntimeManager(tmp_path)
    manager.state_file.write_text('{bad')
    monkeypatch.setattr(subprocess, 'Popen', lambda *_a, **_k: pytest.fail('must not launch'))
    with pytest.raises(RuntimeUnavailable, match='记录无法核对'):
        manager.ensure()


def test_execution_owner_death_never_replays_a_paid_request(manager):
    with TestClient(RuntimeProxy(manager)) as client:
        assert client.post('/run', json={'id': 'do-not-resend'}).status_code == 200
    original = manager.read()
    identity = manager.control(original)
    assert identity['busy']
    # This PID was just authenticated as this dedicated fixture's service.
    os.kill(identity['pid'], signal.SIGTERM)
    wait_for(lambda: not locked(manager.directory / 'runtime.lock'))
    assert not (manager.data / 'result').exists()
    replacement = manager.ensure()
    assert replacement['instance'] != original['instance']
    assert not manager.control(replacement)['busy']
    assert (manager.data / 'dispatches').read_text().splitlines() == ['do-not-resend']
    assert not (manager.data / 'result').exists()


def test_server_supervisor_replaces_only_web_observer(monkeypatch):
    import importlib.util
    spec = importlib.util.spec_from_file_location('isolated_supervisor_test', ROOT / 'deployment/138/supervisor.py')
    supervisor = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(supervisor)
    gateway = SimpleNamespace(poll=lambda: None)
    old_web = SimpleNamespace(poll=lambda: 1)
    replacement = SimpleNamespace(poll=lambda: None)
    supervisor.children = [gateway, old_web]
    spawned = []
    monkeypatch.setattr(supervisor, 'start_web', lambda: spawned.append(replacement) or replacement)
    monkeypatch.setattr(supervisor.time, 'sleep', lambda _: setattr(supervisor, 'stopping', True))
    supervisor.supervise_web()
    assert supervisor.children == [gateway, replacement]
    assert spawned == [replacement]


def test_server_supervisor_bounds_bad_configuration_restarts(monkeypatch):
    import importlib.util
    spec = importlib.util.spec_from_file_location('isolated_supervisor_fail_test', ROOT / 'deployment/138/supervisor.py')
    supervisor = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(supervisor)
    gateway = SimpleNamespace(poll=lambda: None)
    failed = SimpleNamespace(poll=lambda: 1)
    supervisor.children = [gateway, failed]
    spawned = []
    monkeypatch.setattr(supervisor, 'start_web', lambda: spawned.append(failed) or failed)
    monkeypatch.setattr(supervisor.time, 'sleep', lambda _: None)
    with pytest.raises(RuntimeError, match='repeatedly failed'):
        supervisor.supervise_web()
    assert len(spawned) == 3
    assert supervisor.children[0] is gateway
