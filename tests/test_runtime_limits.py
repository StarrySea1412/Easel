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
