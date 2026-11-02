"""Shutdown joins, admission fencing and truthful interrupted receipts."""
import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import threading
from types import SimpleNamespace

import pytest

from easel import runtime_shutdown as shutdown
from easel.runtime_host import RuntimeManager, RuntimeUnavailable

ROOT = Path(__file__).resolve().parents[1]


def supervisor():
    spec = importlib.util.spec_from_file_location('shutdown_supervisor', ROOT / 'deployment/138/supervisor.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_container_budget_covers_ordered_owner_observer_and_native_gateway_exit():
    import yaml
    app = yaml.safe_load((ROOT / 'deployment/138/compose.yaml').read_text())['services']['app']
    assert int(app['stop_grace_period'][:-1]) == shutdown.CONTAINER_STOP_SECONDS
    assert shutdown.GATEWAY_EXIT_SECONDS > 325
    assert (shutdown.DRAIN_SECONDS + shutdown.RUNTIME_EXIT_SECONDS + shutdown.GATEWAY_EXIT_SECONDS
        + shutdown.OBSERVER_EXIT_SECONDS + 10) < shutdown.CONTAINER_STOP_SECONDS


def test_supervisor_waits_for_owner_before_signalling_dependencies(tmp_path, monkeypatch):
    module = supervisor()
    manager = SimpleNamespace(directory=tmp_path, read=lambda: {'port': 1})
    order = []
    running = [True]
    manager.control = lambda state, action: order.append(action)
    monkeypatch.setattr('easel.runtime_host.RuntimeManager', lambda: manager)
    monkeypatch.setattr('easel.runtime_host.locked', lambda _: running[0])
    def settle(_):
        assert order == ['shutdown']
        order.append('owner-receipt-saved')
        running[0] = False
    monkeypatch.setattr(module.time, 'sleep', settle)
    module.children = [object(), object()]
    monkeypatch.setattr(module, 'terminate', lambda child, timeout, name: order.append((name, timeout)) or True)
    assert module.shutdown_children()
    assert order == ['shutdown', 'owner-receipt-saved',
        ('Web observer', shutdown.OBSERVER_EXIT_SECONDS), ('Gateway', shutdown.GATEWAY_EXIT_SECONDS)]


def test_repeated_stop_signals_do_not_repeat_handshakes_or_kill_children(monkeypatch):
    module = supervisor()
    monkeypatch.setattr(RuntimeManager, 'control', lambda *_: pytest.fail('I/O inside signal handler'))
    module.stop(); module.stop()
    assert module.stopping


def test_failed_live_owner_handshake_never_reports_clean_drain(tmp_path, monkeypatch):
    module = supervisor()
    manager = SimpleNamespace(directory=tmp_path, read=lambda: {'port': 1},
        control=lambda *_: (_ for _ in ()).throw(RuntimeUnavailable('fixture')))
    monkeypatch.setattr('easel.runtime_host.RuntimeManager', lambda: manager)
    monkeypatch.setattr('easel.runtime_host.locked', lambda _: True)
    assert module.shutdown_children() is False


def test_drain_keeps_inflight_image_until_saved_and_leaves_next_image_queued(tmp_path):
    from PIL import Image
    from easel.image_jobs import ImageJobs, ImageWorker
    from easel.artifacts import ArtifactStore
    config = {'IMG_BASE_URL': 'https://fixture.invalid/v1', 'IMG_MODEL': 'fixture', 'IMG_API_KEY': 'unused'}
    jobs = ImageJobs(tmp_path / 'outputs')
    first = jobs.submit({'prompt': 'fixture'}, config, session='image-chat', turn='image-turn', request_id='one')
    second = jobs.submit({'prompt': 'fixture'}, config, session='image-chat', turn='image-turn', request_id='two')
    entered, release, done = threading.Event(), threading.Event(), threading.Event()
    calls = []
    def provider(cmd, **kwargs):
        calls.append('one')
        entered.set()
        assert release.wait(5)
        Image.new('RGB', (16, 16)).save(cmd[cmd.index('--output') + 1])
        return SimpleNamespace(returncode=0)
    worker = ImageWorker(ROOT, lambda: jobs.outputs, lambda: config, lambda: {}, runner=provider)
    web = SimpleNamespace(_image_worker=lambda: worker, _task_service=SimpleNamespace(loop=None, closing=False),
        _CHAT_JOBS={}, _RUNNING_CHAT={}, _BG_TASKS=set(), _DIRECT_CHAT_TASKS=set(), _HARNESS_TASKS=set(),
        _codex_service=SimpleNamespace(active={}), _ANALYTICS_TASKS={})
    web._task_service.work = set()
    claimed = jobs.claim(config, worker.owner)
    worker.active.add(claimed['jobId'])
    def run():
        try: worker.run(jobs, claimed, config)
        finally: done.set()
    thread = threading.Thread(target=run)
    thread.start()
    try:
        assert entered.wait(5)
        shutdown.begin(web)
        assert shutdown.active(web) and worker.tick() is None
        assert jobs.get(second['jobId'])['phase'] == 'queued'
    finally:
        release.set()
        thread.join(5)
    assert done.is_set() and not shutdown.active(web)
    assert jobs.get(first['jobId'])['phase'] == 'done'
    assert jobs.get(second['jobId'])['phase'] == 'queued' and calls == ['one']
    assert len(ArtifactStore(jobs.outputs).snapshot('image-chat')['artifacts']) == 1


@pytest.mark.parametrize('runtime,user_stop,completed', [
    ('openclaw', False, False), ('openclaw', True, False),
    ('api', False, False), ('api', True, False),
    ('openclaw', False, True), ('api', False, True)])
def test_cancelled_chat_on_shutdown_keeps_original_receipt_and_never_claims_success(
        tmp_path, monkeypatch, runtime, user_stop, completed):
    from web import app as web
    import office_controls
    import chat_recovery
    from alternate_chat import start as alternate_start
    outputs = tmp_path / 'outputs'
    monkeypatch.setattr(web, 'OUTPUTS_DIR', outputs)
    monkeypatch.setattr(web, 'SESSIONS_DIR', tmp_path / 'sessions')
    monkeypatch.setattr(web, '_run_ledger_root', lambda: tmp_path / 'ledger')
    monkeypatch.setattr(web, '_chat_backend', lambda _: runtime)
    monkeypatch.setattr(web._codex_service, 'bind', lambda *a, **k: None)
    monkeypatch.setattr(web, '_chat_role_contract', lambda *_: None)
    monkeypatch.setattr(web, '_chat_message', lambda *a, **k: 'fixture' + k.get('suffix', ''))
    monkeypatch.setattr(web, '_selected_skill_specs', lambda *_: [])
    monkeypatch.setattr(office_controls, 'require_model_override', lambda *a, **k: {})
    monkeypatch.setattr(web, '_chat_provider_key', lambda *_: 'fixture')
    monkeypatch.setattr(web, '_chat_agent_runtime', lambda *_: {})
    monkeypatch.setattr(web, 'gateway_credentials', lambda: None)
    monkeypatch.setattr(web, '_SERVICE_SHUTTING_DOWN', True, raising=False)
    monkeypatch.setattr(web, '_STOPPED_CHAT', {'shutdown-session'} if user_stop else set())
    for name in ('_BG_TASKS', '_DIRECT_CHAT_TASKS', '_HARNESS_TASKS'):
        monkeypatch.setattr(web, name, set())
    for name in ('_CHAT_JOBS', '_RUNNING_CHAT', '_ACTIVE_SKILL_TURNS'):
        monkeypatch.setattr(web, name, {})
    monkeypatch.setattr(web, '_CrossProcLock', lambda *_: SimpleNamespace(acquired=False, release=lambda: None))
    monkeypatch.setattr(chat_recovery, 'settle_resources', lambda *a, **k: {'provider': False, 'browser': True})
    released = []
    async def on_done(): released.append(True)

    async def exercise():
        entered = asyncio.Event()
        async def wait(*a, **k):
            entered.set()
            await asyncio.Event().wait()
        monkeypatch.setattr(web.app.state, 'server_pools', {'agent': SimpleNamespace(acquire_chat=wait)}, raising=False)
        req = web.ChatRequest(message='fixture', sessionId='shutdown-session', turnId='shutdown-turn',
            modelRef='fixture/model' if runtime == 'openclaw' else None)
        if runtime == 'api':
            monkeypatch.setattr(web, 'read_settings', lambda *_: {})
            monkeypatch.setattr(web, '_harness_settings', lambda: {})
            monkeypatch.setattr(web, 'api_config', lambda _: ('https://fixture.invalid', 'model', 'unused'))
            monkeypatch.setattr(web, '_direct_chat_content', lambda _: ('fixture', ''))
            async def produce(*args, lifecycle, **kwargs):
                lifecycle.before_dispatch()
                lifecycle.text.append('retained partial text')
                entered.set()
                await asyncio.Event().wait()
            monkeypatch.setattr(web, '_run_direct_chat', produce)
            result = await alternate_start(web, req, runtime, {}, observe=False, on_done=on_done)
        else:
            result = await web.start_chat_run(req, observe=False, on_done=on_done)
        await asyncio.wait_for(entered.wait(), 5)
        before = None
        if completed:
            web._save_turn('web:' + req.sessionId, 'done', 'committed completed answer', {
                'turn_id': req.turnId, 'clean_end': True, 'stopped': False})
            web.run_ledger.mark(tmp_path / 'ledger', req.turnId, status='completed', settled=True)
            before = web._run_snapshot_file(req.turnId).read_bytes()
        await shutdown.close_chat_tasks(web)
        assert result['turnId'] == 'shutdown-turn'
        record = web.run_ledger.read(tmp_path / 'ledger', req.turnId)
        marker = json.loads(web._run_snapshot_file(req.turnId).read_text(encoding='utf-8'))
        if completed:
            assert record['status'] == 'completed' and record['settled'] is True
            assert web._run_snapshot_file(req.turnId).read_bytes() == before
            assert not web._CHAT_JOBS and not web._BG_TASKS
            return
        assert record['status'] == ('stopped' if user_stop else 'unknown')
        assert record['settled'] is user_stop
        assert marker.get('stopped') is user_stop
        if not user_stop:
            assert record['resourceSettled'] is False and not released
            assert record['error']['code'] == marker['error']['code'] == 'execution_service_shutdown'
            assert record['stopReason'] == 'service_shutdown'
        if runtime == 'api':
            assert marker['text'] == 'retained partial text'
        assert not web._CHAT_JOBS and not web._BG_TASKS
    asyncio.run(exercise())
