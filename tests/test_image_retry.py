"""Isolated retry contracts. No network calls or real image generation."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
import pytest

from easel.artifact_api import router
from easel.image_jobs import ImageJobs, ImageWorker
from easel.task_rules import GoalSpec
from easel.task_store import TaskStore
from easel.xhs_cards import XhsCards

CONFIG = {'IMG_BASE_URL': 'https://fixture.invalid/v1', 'IMG_MODEL': 'fixture-image', 'IMG_API_KEY': 'synthetic-key'}


def failure(jobs, job, stage='failed'):
    with jobs.db() as db:
        row = db.execute('SELECT * FROM jobs WHERE id=?', (job['jobId'],)).fetchone()
        data = json.loads(row['data'])
        data.update(dispatchAt=1, error='synthetic provider failure')
        db.execute("UPDATE jobs SET status='error',data=? WHERE id=?", (json.dumps(data), job['jobId']))
        jobs.checkpoint(row).write(stage=stage)


def submit(jobs, **kwargs):
    return jobs.submit({'prompt': '合成测试图片', **kwargs}, CONFIG, session='chat', turn='turn', request_id='fixed')


@pytest.mark.parametrize('stage', ['failed', 'incomplete'])
def test_parallel_retry_is_one_new_attempt_with_original_reference_model_and_checkpoint(tmp_path, stage):
    jobs = ImageJobs(tmp_path)
    original = submit(jobs, mode='img2img', referenceId='a' * 32, maskId='b' * 32)
    failure(jobs, original, stage)
    assert jobs.get(original['jobId'])['retryAvailable']
    with ThreadPoolExecutor(6) as pool:
        attempts = list(pool.map(lambda _: ImageJobs(tmp_path).retry(original['jobId'], CONFIG, session='chat'), range(12)))
    assert len({r['jobId'] for r in attempts}) == 1
    retry = attempts[0]
    assert retry['jobId'] != original['jobId'] and retry['phase'] == 'queued'
    assert retry['retryOf'] == original['jobId'] and retry['attempt'] == 2
    for key in ('mode', 'referenceId', 'maskId', 'prompt', 'model', 'size', 'sessionId', 'turnId'):
        assert retry[key] == original[key]
    assert [j['jobId'] for j in jobs.list('chat')] == [retry['jobId']]
    with jobs.db() as db:
        rows = db.execute('SELECT * FROM jobs ORDER BY created').fetchall()
        assert len(rows) == 2
        assert jobs.checkpoint(rows[0]).read()['stage'] == stage
        assert jobs.checkpoint(rows[1]).read() is None
    failure(jobs, retry)
    assert jobs.retry(original['jobId'], CONFIG, session='chat')['jobId'] == retry['jobId']
    next_attempt = jobs.retry(retry['jobId'], CONFIG, session='chat')
    assert next_attempt['attempt'] == 3


@pytest.mark.parametrize('state,stage', [('queued', None), ('running', None), ('unconfirmed', 'accepted'),
    ('done', 'saved'), ('error', 'saved'), ('error', 'responded'), ('error', 'abandoned'), ('error', None)])
def test_pending_unknown_saved_and_abandoned_cannot_generate_again(tmp_path, state, stage):
    jobs = ImageJobs(tmp_path); original = submit(jobs)
    with jobs.db() as db:
        row = db.execute('SELECT * FROM jobs WHERE id=?', (original['jobId'],)).fetchone()
        data = json.loads(row['data']); data['dispatchAt'] = 1
        db.execute('UPDATE jobs SET status=?,data=? WHERE id=?', (state, json.dumps(data), original['jobId']))
        if stage:
            jobs.checkpoint(row).write(stage=stage)
    assert not jobs.get(original['jobId'])['retryAvailable']
    with pytest.raises(ValueError): jobs.retry(original['jobId'], CONFIG, session='chat')
    assert len(jobs.list('chat')) == 1


def test_cancel_changed_channel_and_foreign_session_are_rejected(tmp_path):
    jobs = ImageJobs(tmp_path); original = submit(jobs); failure(jobs, original)
    with pytest.raises(FileNotFoundError): jobs.retry(original['jobId'], CONFIG, session='foreign')
    with pytest.raises(ValueError, match='渠道身份'): jobs.retry(original['jobId'], {**CONFIG, 'IMG_API_KEY': 'changed'}, session='chat')
    jobs.cancel_turn('chat', 'turn')
    with pytest.raises(ValueError, match='已停止'): jobs.retry(original['jobId'], CONFIG, session='chat')
    assert len(jobs.list('chat')) == 1


def test_retry_counts_budget_and_cannot_bypass_paused_goal(tmp_path):
    tasks = TaskStore(tmp_path)
    goal = tasks.create_goal(GoalSpec(objective='测试重试预算', modelRef='fixture/model', criteria=[{'type': 'review', 'label': '测试'}], maxImages=1).model_dump(), session='chat')
    tasks.change_goal(goal['id'], 'start'); _, run = tasks.claim('owner')
    jobs = ImageJobs(tmp_path)
    job = jobs.submit({'prompt': '合成图片'}, CONFIG, session='chat', turn=run['turnId'], request_id='fixed')
    failure(jobs, job)
    with pytest.raises(ValueError, match='数量上限'): jobs.retry(job['jobId'], CONFIG, session='chat')
    assert tasks.get('goals', goal['id'])['imagesUsed'] == 1
    tasks.change_goal(goal['id'], 'pause')
    with pytest.raises(ValueError, match='已停止'): jobs.retry(job['jobId'], CONFIG, session='chat')


def test_api_ownership_conflict_and_local_failure_retry(tmp_path):
    jobs = ImageJobs(tmp_path / 'outputs'); original = submit(jobs)
    (tmp_path / '.env').write_text('\n'.join(f'{k}={v}' for k, v in CONFIG.items()), encoding='utf-8')
    app = FastAPI(); app.include_router(router(lambda: jobs.outputs)); client = TestClient(app)
    url = f"/api/chat/artifacts/chat/jobs/{original['jobId']}/retry"
    assert client.post(url.replace('/chat/', '/foreign/')).status_code == 404
    assert client.post(url).status_code == 409
    # A local pre-dispatch failure can be retried without any remote ambiguity.
    with jobs.db() as db: db.execute("UPDATE jobs SET status='error' WHERE id=?", (original['jobId'],))
    assert jobs.get(original['jobId'])['retryAvailable']
    first = client.post(url); second = client.post(url)
    assert first.status_code == second.status_code == 200
    assert first.json()['jobId'] == second.json()['jobId']


def test_card_retry_keeps_two_successes_and_only_three_current_slots(tmp_path):
    cards = XhsCards(tmp_path)
    result = cards.execute({'action': 'submit', 'requestId': 'cards', 'style': '合成测试', 'prompts': ['封面', '内容', '结尾']}, CONFIG, session='chat', turn='turn')
    jobs = cards.jobs
    calls = []
    def provider(cmd, **_):
        calls.append(cmd)
        Image.new('RGB', (768, 1024), ['red', 'blue', 'green'][len(calls)-1]).save(cmd[cmd.index('--output')+1])
        return SimpleNamespace(returncode=0)
    worker = ImageWorker(Path(__file__).resolve().parents[1], lambda: tmp_path, lambda: CONFIG, lambda: {}, runner=provider)
    for _ in range(3):
        job = jobs.claim(CONFIG, worker.owner)
        if job['cardIndex'] == 2: failure(jobs, job, 'incomplete')
        else: worker.run(jobs, job, CONFIG)
    before = cards.get('chat', 'turn', result['cardSetId'])
    assert before['ready'] == 2
    child = jobs.retry(before['cards'][1]['jobId'], CONFIG, session='chat')
    assert child['cardIndex'] == 2 and child['cardRole'] == 'content'
    during = cards.get('chat', 'turn', result['cardSetId'])
    assert len(during['cards']) == 3 and during['ready'] == 2
    worker.run(jobs, jobs.claim(CONFIG, worker.owner), CONFIG)
    after = cards.get('chat', 'turn', result['cardSetId'])
    assert after['ready'] == 3 and not after['complete'] and len(calls) == 3
    for index in (0, 2): assert after['cards'][index] == before['cards'][index]
    assert len(jobs.list('chat')) == 3
