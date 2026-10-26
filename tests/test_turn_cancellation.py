"""Ordinary isolated cancellation lifecycles; no model or provider requests."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sys
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
import pytest

from easel.image_jobs import ImageJobs, ImageWorker
from easel.task_rules import GoalSpec
from easel.task_store import TaskStore

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import app as web
import run_ledger
from task_service import TaskService

CONFIG = {'IMG_BASE_URL': 'https://fixture.invalid/v1', 'IMG_MODEL': 'fixture', 'IMG_API_KEY': 'isolated-placeholder'}


def image(jobs, turn='first', session='chat', request='one'):
    return jobs.submit({'prompt': '隔离生命周期测试'}, CONFIG, session=session, turn=turn, request_id=request)


def worker(root, runner):
    return ImageWorker(Path(__file__).resolve().parents[1], lambda: root, lambda: CONFIG, lambda: {}, runner=runner)


def active(store):
    spec = GoalSpec(objective='隔离测试：保存实际结果', modelRef='fixture/model', maxImages=1,
                    criteria=[{'type': 'text', 'label': '结果', 'value': '原轮结果'}]).model_dump()
    goal = store.create_goal(spec, session='chat')
    store.change_goal(goal['id'], 'start')
    return store.claim('fixture-worker')


def ledger_for(root, run, settled=True):
    run_ledger.create(root, run['turnId'], session_id=run['sessionId'], session_key=run['sessionId'])
    if settled:
        run_ledger.mark(root, run['turnId'], status='stopped', settled=True, resource_settled=True)


def test_stop_fences_queued_and_late_images_without_affecting_other_work(tmp_path):
    jobs = ImageJobs(tmp_path)
    stopped = image(jobs)
    other = image(jobs, turn='second')
    separate = image(jobs, session='writing')
    studio = jobs.submit({'prompt': '隔离工坊'}, CONFIG)
    jobs.cancel_turn('chat', 'first')
    requested = jobs.get(stopped['jobId'])['cancelRequestedAt']
    restored = ImageJobs(tmp_path)
    restored.cancel_turn('chat', 'first')
    assert restored.get(stopped['jobId'])['cancelRequestedAt'] == requested
    assert restored.get(stopped['jobId'])['phase'] == 'error'
    assert '未提交' in restored.get(stopped['jobId'])['error']
    assert image(restored)['jobId'] == stopped['jobId']
    with pytest.raises(ValueError, match='已停止'):
        image(restored, request='late')
    assert restored.pending_turns('chat') == ['second']
    assert not restored.pending('chat', 'first')
    for value in (other, separate, studio):
        assert restored.get(value['jobId'])['phase'] == 'queued'


def test_cancelled_claim_does_not_reach_generation_even_with_stale_worker_data(tmp_path):
    jobs = ImageJobs(tmp_path)
    value = image(jobs)
    calls = []
    host = worker(tmp_path, lambda *a, **kw: calls.append(a))
    claimed = jobs.claim(CONFIG, host.owner)
    jobs.cancel_turn('chat', 'first')
    assert jobs.pending('chat', 'first')  # Claim is not yet proof of safe release.
    host.run(jobs, claimed, CONFIG)
    assert calls == []
    assert jobs.get(value['jobId'])['phase'] == 'error'
    assert not jobs.pending('chat', 'first')


def test_goal_paused_between_image_claim_and_dispatch_never_calls_generation(tmp_path):
    goal, run = active(TaskStore(tmp_path))
    jobs = ImageJobs(tmp_path)
    value = image(jobs, turn=run['turnId'])
    host = worker(tmp_path, lambda *a, **kw: pytest.fail('generation must not run'))
    claimed = jobs.claim(CONFIG, host.owner)
    TaskStore(tmp_path).change_goal(goal['id'], 'pause')
    host.run(jobs, claimed, CONFIG)
    assert jobs.get(value['jobId'])['phase'] == 'error'


def test_post_dispatch_stop_preserves_real_result_and_never_resubmits(tmp_path):
    jobs = ImageJobs(tmp_path)
    value = image(jobs)
    calls = []
    def provider(cmd, **kw):
        calls.append(cmd)
        jobs.cancel_turn('chat', 'first')
        assert jobs.pending('chat', 'first')
        Image.new('RGB', (12, 16)).save(cmd[cmd.index('--output') + 1])
        return SimpleNamespace(returncode=0)
    host = worker(tmp_path, provider)
    claimed = jobs.claim(CONFIG, host.owner)
    host.run(jobs, claimed, CONFIG)
    result = jobs.get(value['jobId'])
    assert result['phase'] == 'done' and result['cancelRequestedAt']
    assert result['paths'] and result['error'] is None
    assert not jobs.pending('chat', 'first')
    host.run(jobs, claimed, CONFIG)
    assert len(calls) == 1


def test_unknown_dispatched_image_keeps_channel_slot_across_restart(tmp_path):
    jobs = ImageJobs(tmp_path)
    value = image(jobs)
    jobs.claim(CONFIG, 'old-host', now=100)
    assert jobs.dispatch(value['jobId'], 'old-host')
    jobs.cancel_turn('chat', 'first')
    other = image(jobs, turn='second')
    restored = ImageJobs(tmp_path)
    assert restored.claim(CONFIG, 'new-host', now=200) is None
    assert restored.get(value['jobId'])['phase'] == 'unconfirmed'
    assert restored.pending('chat', 'first')
    restored.acknowledge(value['jobId'])
    assert restored.claim(CONFIG, 'new-host', now=201)['jobId'] == other['jobId']


def test_parallel_submission_and_stop_leave_no_queued_work_after_restart(tmp_path):
    def submit_one(n):
        try:
            image(ImageJobs(tmp_path), request=str(n))
        except ValueError as exc:
            assert '已停止' in str(exc)
    with ThreadPoolExecutor(4) as pool:
        pending = [pool.submit(submit_one, n) for n in range(8)]
        pending.append(pool.submit(ImageJobs(tmp_path).cancel_turn, 'chat', 'first'))
        for result in pending:
            result.result()
    assert not ImageJobs(tmp_path).pending('chat', 'first')
    assert ImageJobs(tmp_path).claim(CONFIG, 'restarted') is None


@pytest.mark.parametrize('newer', [105, 1005])
def test_settlement_finds_old_image_beyond_display_limits(tmp_path, newer):
    goal, run = active(TaskStore(tmp_path))
    jobs = ImageJobs(tmp_path)
    value = image(jobs, turn=run['turnId'])
    # Clearly synthetic completed history; no requests were sent.
    with jobs.db() as db:
        original = db.execute('SELECT * FROM jobs WHERE id=?', (value['jobId'],)).fetchone()
        data = json.loads(original['data'])
        for n in range(newer):
            ident = f'{n:032x}'
            copied = {**data, 'jobId': ident, 'requestId': f'history-{n}', 'turnId': 'history'}
            db.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)', (ident, 'chat:history',
                copied['requestId'], original['fingerprint'], original['channel'], original['config'],
                'done', None, 0, original['created'] + n + 1, json.dumps(copied)))
    assert all(j['jobId'] != value['jobId'] for j in jobs.list('chat'))
    root = tmp_path / 'ledger'
    ledger_for(root, run)
    service = TaskService(SimpleNamespace(OUTPUTS_DIR=tmp_path, run_ledger=run_ledger, _run_ledger_root=lambda: root))
    assert asyncio.run(service.settle(run)) is False
    assert jobs.pending_turns('chat') == [run['turnId']]
    assert service.store.get('goals', goal['id'])['status'] == 'active'


def test_recovered_goal_reads_its_snapshot_instead_of_new_chat_output(tmp_path):
    goal, run = active(TaskStore(tmp_path))
    root = tmp_path / 'completed-ledger'
    run_ledger.create(root, run['turnId'], session_id='chat', session_key='chat')
    run_ledger.mark(root, run['turnId'], status='completed', settled=True, resource_settled=True)
    archive = tmp_path / 'old.json'
    latest = tmp_path / 'latest.json'
    archive.write_text(json.dumps({'turn_id': run['turnId'], 'session_id': 'chat', 'text': '原轮结果'}), encoding='utf-8')
    latest.write_text(json.dumps({'turn_id': 'newer', 'text': '新轮结果'}), encoding='utf-8')
    service = TaskService(SimpleNamespace(OUTPUTS_DIR=tmp_path, run_ledger=run_ledger,
        _run_ledger_root=lambda: root, _run_snapshot_file=lambda t: archive, _turn_file=lambda s: latest))
    assert asyncio.run(service.settle(run))
    assert service.store.get('goals', goal['id'])['status'] == 'completed'
    assert json.loads(latest.read_text(encoding='utf-8'))['turn_id'] == 'newer'


@pytest.mark.parametrize('action', ['pause', 'stop', 'cancel', 'budget', 'delete'])
def test_restarted_service_retries_durable_stop_and_retains_unconfirmed_resources(tmp_path, action):
    store = TaskStore(tmp_path)
    goal, run = active(store)
    if action == 'budget':
        store.conclude_budget(goal['id'], '隔离预算已耗尽')
    elif action == 'delete':
        store.delete_session('chat')
    else:
        store.change_goal(goal['id'], action)
    store.finish(run['id'], owner='fixture-worker', state='stopped', resource_settled=False)
    calls = []
    async def stop(req):
        calls.append((req.sessionId, req.turnId))
        return {'stopped': False}
    root = tmp_path / 'ledger'
    runtime = SimpleNamespace(OUTPUTS_DIR=tmp_path, run_ledger=run_ledger, _run_ledger_root=lambda: root,
        _turn_file=lambda s: tmp_path / 'missing.json',
        _CrossProcLock=object, api_chat_stop=stop, StopRequest=SimpleNamespace)
    service = TaskService(runtime)
    asyncio.run(service.tick())
    asyncio.run(service.tick())  # Backoff, rather than an immediate duplicate abort.
    assert calls == [('chat', run['turnId'])]
    assert service.store.running()[0]['state'] == 'unconfirmed'
    assert service.store.claim('restarted') is None
    saved = service.store.get('goals', goal['id'])
    assert saved['status'] == ('cancelled' if action in ('cancel', 'delete') else 'blocked' if action == 'budget' else 'paused')
    assert saved['phase'] == ('budget' if action == 'budget' else 'unconfirmed')
    ledger_for(root, run)
    assert asyncio.run(service.settle(run))
    final = service.store.get('goals', goal['id'])
    assert final['status'] == saved['status']
    assert final['phase'] == ('budget' if action == 'budget' else 'idle')
    if action != 'budget':
        assert '未结算' not in final['reason']


def test_stop_failure_is_saved_and_does_not_hide_goal_state(tmp_path):
    store = TaskStore(tmp_path)
    goal, run = active(store)
    async def stop(req):
        raise RuntimeError('isolated unavailable worker')
    service = TaskService(SimpleNamespace(OUTPUTS_DIR=tmp_path, api_chat_stop=stop, StopRequest=SimpleNamespace))
    app = FastAPI()
    app.include_router(service.router())
    with TestClient(app) as client:
        response = client.post(f"/api/tasks/goals/{goal['id']}/action", json={'action': 'stop'})
    assert response.status_code == 200
    assert response.json()['status'] == 'paused' and response.json()['cancelRequested']
    assert store.running()[0]['turnId'] == run['turnId']


@pytest.mark.parametrize('codex', [False, True])
def test_public_stop_fences_images_before_producer_and_reports_pending(tmp_path, monkeypatch, codex):
    monkeypatch.setattr(web, 'OUTPUTS_DIR', tmp_path)
    jobs = ImageJobs(tmp_path)
    value = image(jobs)
    jobs.claim(CONFIG, 'fixture-worker')
    jobs.dispatch(value['jobId'], 'fixture-worker')
    calls = []
    def stopped(*args):
        assert jobs.get(value['jobId'])['cancelRequestedAt']
        calls.append(True)
        return {'stopped': True}
    monkeypatch.setattr(web, '_codex_service', SimpleNamespace(owns=lambda s: codex,
        snapshot=lambda s: {'turn_id': 'first'}, stop=stopped))
    if not codex:
        async def producer(req):
            return stopped(req)
        monkeypatch.setattr(web, '_stop_chat_producer', producer)
    result = asyncio.run(web.api_chat_stop(web.StopRequest(sessionId='chat', turnId=None if codex else 'first')))
    assert result == {'stopped': False, 'status': 'images_pending'}
    assert calls == [True]


def test_delete_cancels_images_even_after_chat_lease_was_released(tmp_path, monkeypatch):
    jobs = ImageJobs(tmp_path)
    value = image(jobs)
    monkeypatch.setattr(web, 'OUTPUTS_DIR', tmp_path)
    async def producer(req):
        return {'stopped': False, 'status': 'already_finished'}
    monkeypatch.setattr(web, '_stop_chat_producer', producer)
    service = TaskService(SimpleNamespace(OUTPUTS_DIR=tmp_path, api_chat_stop=web.api_chat_stop, StopRequest=web.StopRequest))
    app = FastAPI()
    app.include_router(service.router())
    with TestClient(app) as client:
        result = client.post('/api/tasks/sessions/chat/delete', json={})
    assert result.status_code == 200 and result.json()['stopPending'] is False
    assert jobs.get(value['jobId'])['phase'] == 'error'
