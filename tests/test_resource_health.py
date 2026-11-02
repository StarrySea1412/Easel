import asyncio
import threading

import pytest
from fastapi import HTTPException

from easel.resource_health import MIB, memory_snapshot
from easel import resource_health
from easel.runtime_limits import Pool


def test_cgroup_limit_and_host_headroom_both_constrain_admission(tmp_path):
    cgroup = tmp_path / 'cgroup'; cgroup.mkdir()
    meminfo = tmp_path / 'meminfo'
    (cgroup / 'memory.current').write_text(str(2900 * MIB))
    (cgroup / 'memory.max').write_text(str(3072 * MIB))
    (cgroup / 'memory.events').write_text('low 0\nmax 31\noom 1\noom_kill 1\n')
    meminfo.write_text('MemTotal: 10000000 kB\nMemAvailable: 2000000 kB\n')
    result = memory_snapshot(cgroup, meminfo)
    assert result['state'] == 'pressure' and result['oomKills'] == 1
    assert result['headroomBytes'] == 172 * MIB
    (cgroup / 'memory.current').write_text(str(1000 * MIB))
    assert memory_snapshot(cgroup, meminfo)['state'] == 'available'
    meminfo.write_text('MemTotal: 10000000 kB\nMemAvailable: 100000 kB\n')
    assert memory_snapshot(cgroup, meminfo)['state'] == 'pressure'


def test_unlimited_and_unavailable_cgroup_do_not_invent_memory_capacity(tmp_path):
    (tmp_path / 'memory.current').write_text('1048576')
    (tmp_path / 'memory.max').write_text('max')
    assert memory_snapshot(tmp_path, tmp_path / 'missing')['state'] == 'unknown'
    directory = tmp_path / 'memory'; directory.mkdir()
    (directory / 'memory.usage_in_bytes').write_text(str(1000 * MIB))
    (directory / 'memory.limit_in_bytes').write_text(str(3072 * MIB))
    result = memory_snapshot(tmp_path, tmp_path / 'missing')
    assert result['source'] == 'cgroup-v1' and result['state'] == 'available'


def test_pressure_before_dispatch_does_not_leak_slots_or_waiters():
    pressure = threading.Event()
    def guard():
        if pressure.is_set():
            raise HTTPException(503, {'code': 'server_memory_pressure'})
    async def scenario():
        pool = Pool('agent', 1, guard)
        running = pool.acquire()
        waiting = asyncio.create_task(pool.acquire_chat(threading.Event()))
        await asyncio.sleep(.02)
        assert len(pool.waiters) == 1
        pressure.set()
        running.release()
        with pytest.raises(HTTPException) as error:
            await waiting
        assert error.value.detail['code'] == 'server_memory_pressure'
        assert pool.active == 0 and not pool.waiters
        with pytest.raises(HTTPException):
            pool.acquire()
        assert pool.active == 0
        pressure.clear()
        pool.acquire().release()
    asyncio.run(scenario())


def test_memory_admission_rejects_before_the_route_can_start_work(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from types import SimpleNamespace
    from easel.runtime_limits import install_limits
    calls = []
    app = FastAPI()
    @app.post('/api/chat')
    async def chat():
        calls.append('dispatched')
        return {'done': True}
    install_limits(SimpleNamespace(app=app, _BG_TASKS=set(), LOGIN_PROCESSES={}, check_gateway=lambda: True))
    monkeypatch.setattr(resource_health, 'memory_snapshot', lambda: {'state':'pressure'})
    with TestClient(app) as client:
        response = client.post('/api/chat')
        assert response.status_code == 503
        assert response.headers['Retry-After'] == '15'
        assert response.json()['detail']['code'] == 'server_memory_pressure'
        assert not calls and app.state.server_pools['agent'].active == 0
