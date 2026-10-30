import asyncio
from types import SimpleNamespace

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest
from easel.runtime_limits import Pool, install_limits, queued_chat


def test_chat_queue_is_fifo_and_waiting_stop_does_not_release_running_slot():
    import threading
    async def scenario():
        pool = Pool('agent', 1)
        running = pool.acquire()
        stopped, next_stop = threading.Event(), threading.Event()
        positions = []
        first = asyncio.create_task(pool.acquire_chat(stopped, positions.append))
        second = asyncio.create_task(pool.acquire_chat(next_stop))
        await asyncio.sleep(0.02)
        assert positions == [1] and len(pool.waiters) == 2
        stopped.set()
        assert await first is None
        assert pool.active == 1 and len(pool.waiters) == 1
        with pytest.raises(HTTPException):
            pool.acquire()
        running.release()
        lease = await second
        assert pool.active == 1 and not pool.waiters
        lease.release()
        assert pool.active == 0
    asyncio.run(scenario())


def test_chat_queue_timeout_overflow_and_task_cancellation_cleanup():
    import threading
    async def scenario():
        pool = Pool('agent', 1)
        running = pool.acquire()
        waiting = asyncio.create_task(pool.acquire_chat(threading.Event(), max_waiters=1))
        await asyncio.sleep(0.02)
        with pytest.raises(HTTPException) as error:
            await pool.acquire_chat(threading.Event(), max_waiters=1)
        assert error.value.detail['code'] == 'chat_server_queue_full'
        waiting.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiting
        assert not pool.waiters and pool.active == 1
        with pytest.raises(HTTPException) as error:
            await pool.acquire_chat(threading.Event(), timeout=0)
        assert error.value.detail['code'] == 'chat_server_queue_timeout'
        assert not pool.waiters and pool.active == 1
        running.release()
    asyncio.run(scenario())


def test_only_marked_openclaw_chat_defers_outer_admission():
    async def scenario():
        app = FastAPI()
        @app.post('/api/chat/stream')
        @queued_chat
        async def start(req):
            return {'engine': req.engine}
        workspace = SimpleNamespace(app=app, _BG_TASKS=set(), LOGIN_PROCESSES={}, check_gateway=lambda: True)
        install_limits(workspace)
        endpoint = next(route.endpoint for route in app.routes if route.path == '/api/chat/stream')
        lease = app.state.server_pools['agent'].acquire()
        assert await endpoint(req=SimpleNamespace(engine='openclaw')) == {'engine': 'openclaw'}
        with pytest.raises(HTTPException):
            await endpoint(req=SimpleNamespace(engine='codex'))
        assert app.state.server_pools['agent'].active == 1
        lease.release()
    asyncio.run(scenario())


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


def test_queue_capacity_waits_for_durable_resource_settlement(tmp_path):
    import threading
    import time
    from web import run_ledger
    pool = Pool('agent', 1)
    lease = pool.acquire()
    run_ledger.create(tmp_path, 'held-turn', session_id='chat', session_key='agent:main:chat')
    run_ledger.mark(tmp_path, 'held-turn', status='failed', settled=True, resource_settled=False)
    observed = threading.Event()
    def settled():
        observed.set()
        return (run_ledger.read(tmp_path, 'held-turn') or {}).get('resourceSettled') is True
    lease.watch(settled)
    assert observed.wait(2)
    with pytest.raises(HTTPException):
        pool.acquire()
    run_ledger.mark(tmp_path, 'held-turn', resource_settled=True)
    deadline = time.monotonic() + 3
    while pool.active and time.monotonic() < deadline:
        time.sleep(.01)
    assert pool.active == 0
    lease.release()
    assert pool.active == 0


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
