import asyncio
from types import SimpleNamespace

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest
from easel.runtime_limits import Pool, install_limits


def test_capacity_and_idempotent_release():
    pool = Pool('agent', 1)
    lease = pool.acquire()
    with pytest.raises(HTTPException) as error:
        pool.acquire()
    assert error.value.status_code == 429
    assert error.value.headers['Retry-After'] == '5'
    lease.release(); lease.release()
    assert pool.active == 0
    pool.acquire().release()


@pytest.mark.parametrize('phase', ['done', 'error', 'unconfirmed'])
def test_image_admission_follows_durable_queue_terminal_without_legacy_registry(tmp_path, phase):
    import time
    from easel.image_jobs import ImageJobs
    app = FastAPI()
    config = {'IMG_BASE_URL': 'https://fixture.invalid', 'IMG_MODEL': 'fixture', 'IMG_API_KEY': 'synthetic'}
    jobs = ImageJobs(tmp_path)
    @app.post('/api/imagegen')
    async def image():
        return jobs.submit({'prompt': 'isolated synthetic'}, config, request_id='request')
    workspace = SimpleNamespace(app=app, OUTPUTS_DIR=tmp_path, _BG_TASKS=set(),
        LOGIN_PROCESSES={}, check_gateway=lambda: True)
    install_limits(workspace)
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.post('/api/imagegen')
        assert response.status_code == 200, response.text
        identifier = response.json()['jobId']
        assert client.post('/api/imagegen').status_code == 429
        ImageJobs(tmp_path).claim(config, 'isolated-worker')
        ImageJobs(tmp_path).finish(identifier, 'isolated-worker', phase, {'error': None if phase == 'done' else 'isolated failure'})
        deadline = time.monotonic() + 3
        while app.state.server_pools['media'].active and time.monotonic() < deadline:
            time.sleep(.01)
        assert app.state.server_pools['media'].active == 0
        receipt = client.post('/api/imagegen')
        assert receipt.status_code == 200 and receipt.json()['jobId'] == identifier


def test_disconnect_does_not_release_an_active_background_task():
    app = FastAPI()
    tasks = set()
    gate = None
    @app.post('/api/chat/stream')
    async def start():
        nonlocal gate
        gate = asyncio.Event()
        task = asyncio.create_task(gate.wait())
        tasks.add(task)
        task.add_done_callback(tasks.discard)
        return {'running': True}
    @app.post('/release')
    async def stop():
        gate.set()
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        return {}
    @app.post('/api/skill')
    async def fail():
        raise HTTPException(400, 'rejected')
    workspace = SimpleNamespace(app=app, _BG_TASKS=tasks, LOGIN_PROCESSES={}, check_gateway=lambda: True)
    install_limits(workspace)
    with TestClient(app) as client:
        assert client.post('/api/chat/stream').status_code == 200
        assert client.post('/api/chat/stream').status_code == 429
        assert client.post('/api/skill').status_code == 429
        assert client.get('/api/server/readiness').json()['resources']['agent']['active'] == 1
        client.post('/release')
        assert client.post('/api/skill').status_code == 400
        assert app.state.server_pools['agent'].active == 0


def test_cancelled_http_waiter_keeps_executor_slot_until_backend_finishes():
    import threading
    async def scenario():
        app = FastAPI()
        started, finish = threading.Event(), threading.Event()
        def work():
            started.set()
            finish.wait(5)
        @app.post('/api/chat')
        async def chat():
            await asyncio.to_thread(work)
            return {'done': True}
        workspace = SimpleNamespace(app=app, _BG_TASKS=set(), LOGIN_PROCESSES={}, check_gateway=lambda: True)
        install_limits(workspace)
        endpoint = next(route.endpoint for route in app.routes if route.path == '/api/chat')
        request = asyncio.create_task(endpoint())
        assert await asyncio.to_thread(started.wait, 2)
        request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request
        assert app.state.server_pools['agent'].active == 1
        with pytest.raises(HTTPException):
            await endpoint()
        finish.set()
        for _ in range(100):
            if not app.state.server_pools['agent'].active:
                break
            await asyncio.sleep(0.01)
        assert app.state.server_pools['agent'].active == 0
    asyncio.run(scenario())
