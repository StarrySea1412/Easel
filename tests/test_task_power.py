import asyncio
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from easel.task_power import ES_CONTINUOUS, ES_SYSTEM_REQUIRED, TaskPower
from easel.task_store import TaskStore

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from task_service import TaskService
import run_ledger


class Child:
    def __init__(self, exit_code=None):
        self.exit_code = exit_code
        self.terminated = False
        self.stderr = None

    def poll(self):
        return 0 if self.terminated else self.exit_code

    def terminate(self):
        self.terminated = True

    def wait(self, timeout=None):
        return self.poll()

    def kill(self):
        self.terminated = True


def test_default_off_has_no_os_side_effects():
    calls = []
    power = TaskPower(platform='win32', windows_setter=lambda flags: calls.append(flags) or 1)
    lease = power.acquire()
    assert power.status() == {'supported': True, 'enabled': False, 'active': False, 'reason': ''}
    lease.release()
    assert calls == []


def test_concurrent_windows_runs_hold_one_request_until_last_release():
    calls = []
    power = TaskPower(platform='win32', windows_setter=lambda flags: calls.append(flags) or 1)
    power.set_enabled(True)
    first = power.acquire()
    second = power.acquire()
    assert calls == [ES_CONTINUOUS | ES_SYSTEM_REQUIRED]
    first.release()
    first.release()
    assert calls == [ES_CONTINUOUS | ES_SYSTEM_REQUIRED]
    second.release()
    assert calls == [ES_CONTINUOUS | ES_SYSTEM_REQUIRED, ES_CONTINUOUS]
    assert not power.status()['active']


def test_disabling_during_a_run_clears_request_immediately():
    calls = []
    power = TaskPower(platform='win32', windows_setter=lambda flags: calls.append(flags) or 1)
    power.set_enabled(True)
    lease = power.acquire()
    value = power.set_enabled(False)
    assert value['enabled'] is False and value['active'] is False
    assert calls == [ES_CONTINUOUS | ES_SYSTEM_REQUIRED, ES_CONTINUOUS]
    lease.release()
    assert len(calls) == 2


def test_linux_inhibitor_lives_only_while_claims_are_active():
    children, commands = [], []

    def popen(command, **_kwargs):
        commands.append(command)
        child = Child()
        children.append(child)
        return child

    power = TaskPower(platform='linux', which=lambda _: '/usr/bin/systemd-inhibit',
                      popen=popen, sleep=lambda _: None)
    power.set_enabled(True)
    first, second = power.acquire(), power.acquire()
    assert power.status()['active'] and len(children) == 1
    assert '--what=sleep:idle' in commands[0]
    first.release()
    assert not children[0].terminated
    second.release()
    assert children[0].terminated and not power.status()['active']


def test_mac_inhibitor_is_bound_to_the_easel_process():
    commands, children = [], []

    def popen(command, **_kwargs):
        commands.append(command)
        child = Child()
        children.append(child)
        return child

    power = TaskPower(platform='darwin', which=lambda _: '/usr/bin/caffeinate',
                      popen=popen, sleep=lambda _: None)
    power.set_enabled(True)
    lease = power.acquire()
    assert power.status()['active']
    assert commands[0][:3] == ['/usr/bin/caffeinate', '-i', '-w']
    lease.release()
    assert children[0].terminated and not power.status()['active']


def test_linux_helper_exits_when_parent_pipe_closes():
    def popen(command, **kwargs):
        # Run the real helper without a system power request on the test host.
        assert kwargs['stdin'] == subprocess.PIPE
        return subprocess.Popen(command[command.index('--') + 1:], **kwargs)

    power = TaskPower(platform='linux', which=lambda _: '/usr/bin/systemd-inhibit',
                      popen=popen)
    power.set_enabled(True)
    lease = power.acquire()
    child = power.child
    try:
        assert child is not None and power.status()['active']
        child.stdin.close()
        assert child.wait(timeout=5) == 0
        assert power.status()['active'] is False
    finally:
        lease.release()
        if child is not None and child.poll() is None:
            child.kill()
            child.wait(timeout=5)


def test_linux_release_failure_keeps_child_for_retry():
    class StubbornChild(Child):
        stubborn = True

        def terminate(self):
            if not self.stubborn:
                super().terminate()

        def wait(self, timeout=None):
            if self.stubborn:
                from subprocess import TimeoutExpired
                raise TimeoutExpired('inhibitor', timeout)
            return self.poll()

        def kill(self):
            if not self.stubborn:
                self.terminated = True

    child = StubbornChild()
    power = TaskPower(platform='linux', which=lambda _: '/usr/bin/systemd-inhibit',
                      popen=lambda *_args, **_kwargs: child, sleep=lambda _: None)
    power.set_enabled(True)
    lease = power.acquire()
    lease.release()
    assert power.status()['active']
    assert power.child is child
    child.stubborn = False
    assert power.set_enabled(False)['active'] is False
    assert power.child is None


def test_failed_native_activation_is_reported_without_claiming_active():
    power = TaskPower(platform='win32', windows_setter=lambda _flags: 0)
    power.set_enabled(True)
    lease = power.acquire()
    status = power.status()
    assert status['enabled'] is True and status['active'] is False
    assert status['reason'] == '系统未能启用防休眠。'
    lease.release()


def test_unsupported_host_rejects_enabling_and_default_is_persisted(tmp_path):
    service = TaskService(SimpleNamespace(OUTPUTS_DIR=tmp_path))
    service.power = TaskPower(platform='unsupported')
    app = FastAPI()
    app.include_router(service.router())
    client = TestClient(app)
    assert client.get('/api/tasks/runtime').json()['enabled'] is False
    assert client.post('/api/tasks/runtime', json={'keepAwake': True}).status_code == 409
    assert service.store.keep_awake_enabled() is False
    assert client.post('/api/tasks/runtime', json={'keepAwake': 'true'}).status_code == 422
    service.store.set_keep_awake_enabled(True)
    assert client.get('/api/tasks/runtime').json()['enabled'] is True
    disabled = client.post('/api/tasks/runtime', json={'keepAwake': False})
    assert disabled.status_code == 200 and disabled.json()['enabled'] is False


def test_runtime_preference_survives_service_recreation_without_activation(tmp_path):
    calls = []
    service = TaskService(SimpleNamespace(OUTPUTS_DIR=tmp_path))
    service.power = TaskPower(platform='win32', windows_setter=lambda flags: calls.append(flags) or 1)
    client = TestClient(FastAPI())
    client.app.include_router(service.router())
    assert client.post('/api/tasks/runtime', json={'keepAwake': True}).json()['enabled'] is True
    restored = TaskService(SimpleNamespace(OUTPUTS_DIR=tmp_path))
    restored.power = TaskPower(platform='win32', windows_setter=lambda flags: calls.append(flags) or 1)
    restarted = TestClient(FastAPI())
    restarted.app.include_router(restored.router())
    assert restarted.get('/api/tasks/runtime').json()['enabled'] is True
    assert calls == []


def test_task_failure_releases_its_power_lease(tmp_path):
    web = SimpleNamespace(OUTPUTS_DIR=tmp_path, run_ledger=run_ledger,
        _run_ledger_root=lambda: tmp_path / '_sessions',
        ChatRequest=lambda **kwargs: SimpleNamespace(**kwargs))
    service = TaskService(web)
    calls = []
    service.power = TaskPower(platform='win32', windows_setter=lambda flags: calls.append(flags) or 1)
    service.power.set_enabled(True)
    service.admit = lambda *_: None
    service.config_hash = lambda: 'config'
    async def fail_to_start(*_args, **_kwargs):
        raise RuntimeError('synthetic dispatch failure')
    web.start_chat_run = fail_to_start
    spec = {'objective':'合成任务目标','modelRef':'test/model',
            'criteria':[{'type':'review','label':'质量','value':''}],
            'maxIterations':1,'maxSeconds':60,'maxTools':1,'maxImages':0}
    goal = service.store.create_goal(spec, session='power-test')
    service.store.change_goal(goal['id'], 'start')
    claimed_goal, run = service.store.claim(service.owner)
    asyncio.run(service.execute(claimed_goal, run))
    assert calls == [ES_CONTINUOUS | ES_SYSTEM_REQUIRED, ES_CONTINUOUS]
    assert service.power.status()['active'] is False


def test_task_cancellation_releases_its_power_lease(tmp_path):
    web = SimpleNamespace(OUTPUTS_DIR=tmp_path, run_ledger=run_ledger,
        _run_ledger_root=lambda: tmp_path / '_sessions',
        ChatRequest=lambda **kwargs: SimpleNamespace(**kwargs))
    service = TaskService(web)
    calls = []
    service.power = TaskPower(platform='win32', windows_setter=lambda flags: calls.append(flags) or 1)
    service.power.set_enabled(True)
    service.store.set_keep_awake_enabled(True)
    service.admit = lambda *_: None
    service.config_hash = lambda: 'config'
    started = asyncio.Event()
    async def start(*_args, **_kwargs):
        started.set()
    web.start_chat_run = start
    spec = {'objective':'合成任务目标','modelRef':'test/model',
            'criteria':[{'type':'review','label':'质量','value':''}],
            'maxIterations':1,'maxSeconds':60,'maxTools':1,'maxImages':0}
    goal = service.store.create_goal(spec, session='power-cancel-test')
    service.store.change_goal(goal['id'], 'start')
    claimed_goal, run = service.store.claim(service.owner)

    async def cancel_active_run():
        task = asyncio.create_task(service.execute(claimed_goal, run))
        await asyncio.wait_for(started.wait(), 2)
        assert service.power.status()['active'] is True
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    asyncio.run(cancel_active_run())
    assert calls == [ES_CONTINUOUS | ES_SYSTEM_REQUIRED, ES_CONTINUOUS]
    assert service.power.status()['active'] is False


def test_service_close_cancels_active_task_and_releases_its_power_lease(tmp_path):
    web = SimpleNamespace(OUTPUTS_DIR=tmp_path, run_ledger=run_ledger,
        _run_ledger_root=lambda: tmp_path / '_sessions',
        ChatRequest=lambda **kwargs: SimpleNamespace(**kwargs))
    service = TaskService(web)
    calls = []
    service.power = TaskPower(platform='win32', windows_setter=lambda flags: calls.append(flags) or 1)
    service.power.set_enabled(True)
    service.store.set_keep_awake_enabled(True)
    service.admit = lambda *_: None
    service.config_hash = lambda: 'config'
    started = asyncio.Event()

    async def start(*_args, **_kwargs):
        started.set()

    web.start_chat_run = start
    spec = {'objective':'合成任务目标','modelRef':'test/model',
            'criteria':[{'type':'review','label':'质量','value':''}],
            'maxIterations':1,'maxSeconds':60,'maxTools':1,'maxImages':0}
    goal = service.store.create_goal(spec, session='power-close-test')
    service.store.change_goal(goal['id'], 'start')
    claimed_goal, run = service.store.claim(service.owner)

    async def close_active_run():
        task = asyncio.create_task(service.execute(claimed_goal, run))
        service.work.add(task)
        await asyncio.wait_for(started.wait(), 2)
        assert service.power.status()['active'] is True
        await service.close()

    asyncio.run(close_active_run())
    assert calls == [ES_CONTINUOUS | ES_SYSTEM_REQUIRED, ES_CONTINUOUS]
    assert service.power.status()['active'] is False
