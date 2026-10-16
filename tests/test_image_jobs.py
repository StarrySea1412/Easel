"""Persistent queue contracts with fake providers; no network or paid requests."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
from types import SimpleNamespace

from PIL import Image
import pytest

from easel.artifacts import ArtifactStore
from easel.image_jobs import ImageJobs, ImageWorker, channel

CONFIG = {'IMG_BASE_URL': 'https://xjbh.lol/v1', 'IMG_MODEL': 'fixed-image', 'IMG_API_KEY': 'fixture-private-key'}


def submit(jobs, request='one', config=CONFIG):
    return jobs.submit({'prompt': '画一只猫'}, config, session='chat', turn='turn', request_id=request)


def test_parallel_retries_are_idempotent_and_conflicting_arguments_do_not_submit(tmp_path):
    jobs = ImageJobs(tmp_path / 'outputs')
    with ThreadPoolExecutor(max_workers=8) as pool:
        receipts = list(pool.map(lambda _: submit(ImageJobs(jobs.outputs)), range(20)))
    assert len({r['jobId'] for r in receipts}) == 1
    assert ImageJobs(jobs.outputs).get(receipts[0]['jobId'])['phase'] == 'queued'
    with pytest.raises(ValueError, match='不同参数'):
        jobs.submit({'prompt': 'changed'}, CONFIG, session='chat', turn='turn', request_id='one')
    with pytest.raises(FileNotFoundError):
        jobs.get(receipts[0]['jobId'], session='foreign')
    assert CONFIG['IMG_API_KEY'].encode() not in jobs.path.read_bytes()


@pytest.mark.parametrize('base,limit', [('https://xjbh.lol', 1), ('https://image.mlgb7.com/v1', 4), ('https://unknown.example/v1', 1)])
def test_cross_process_channel_limits_hold_and_unknown_requests_are_not_replayed(tmp_path, base, limit):
    config = {**CONFIG, 'IMG_BASE_URL': base}
    jobs = ImageJobs(tmp_path / 'outputs')
    for n in range(6):
        submit(jobs, str(n), config)
    claims = [ImageJobs(jobs.outputs).claim(config, f'worker-{n}', now=100) for n in range(7)]
    assert sum(job is not None for job in claims) == limit
    assert jobs.claim(config, 'restarted', now=200) is None
    assert len([j for j in jobs.list('chat') if j['phase'] == 'unconfirmed']) == limit
    ident = claims[0]['jobId']
    jobs.acknowledge(ident)
    next_job = jobs.claim(config, 'reconciled', now=201)
    assert next_job and next_job['jobId'] != ident
    assert submit(jobs, '0', config)['jobId'] == ident  # even explicit retry keeps old receipt


def test_channel_change_stops_queued_jobs_without_using_a_fallback(tmp_path):
    jobs = ImageJobs(tmp_path / 'outputs'); job = submit(jobs)
    assert jobs.claim({**CONFIG, 'IMG_API_KEY': 'replacement-key'}, 'new-host') is None
    result = jobs.get(job['jobId'])
    assert result['phase'] == 'error' and '未提交' in result['error']
    assert channel({**CONFIG, 'IMG_MAX_CONCURRENCY': '4'})[2] == 1


def test_successful_generation_delivers_files_to_exact_turn_and_preserves_model(tmp_path):
    root = tmp_path / 'outputs'; jobs = ImageJobs(root)
    job = submit(jobs); calls = []
    def provider(cmd, **options):
        calls.append(options)
        Image.new('RGB', (72, 48), 'green').save(cmd[cmd.index('--output') + 1])
        return SimpleNamespace(returncode=0)
    worker = ImageWorker(Path(__file__).resolve().parents[1], lambda: root, lambda: CONFIG, lambda: {}, runner=provider)
    claimed = jobs.claim(CONFIG, worker.owner)
    worker.run(jobs, claimed, {**CONFIG, 'IMG_MODEL': 'other-current-default'})
    receipt = jobs.get(job['jobId'])
    assert receipt['phase'] == 'done' and (receipt['width'], receipt['height']) == (72, 48)
    assert calls[0]['env']['IMG_MODEL'] == 'fixed-image'
    deliveries = ArtifactStore(root).snapshot('chat')['artifacts']
    assert len(deliveries) == 1 and deliveries[0]['turnId'] == 'turn'
    assert submit(ImageJobs(root))['jobId'] == job['jobId'] and len(calls) == 1


def test_success_receipt_recovers_delivery_after_host_failure_without_regenerating(tmp_path, monkeypatch):
    root = tmp_path / 'outputs'; jobs = ImageJobs(root); started = submit(jobs)
    calls = []
    def provider(cmd, **options):
        calls.append(cmd)
        Image.new('RGB', (16, 24)).save(cmd[cmd.index('--output') + 1])
        return SimpleNamespace(returncode=0)
    worker = ImageWorker(Path(__file__).resolve().parents[1], lambda: root, lambda: CONFIG, lambda: {}, runner=provider)
    monkeypatch.setattr(jobs, 'deliver', lambda *_: (_ for _ in ()).throw(sqlite3.OperationalError('simulated host loss')))
    worker.run(jobs, jobs.claim(CONFIG, worker.owner), CONFIG)
    assert jobs.get(started['jobId'])['phase'] == 'unconfirmed'
    restored = ImageJobs(root); restored.recover_receipts()
    assert restored.get(started['jobId'])['phase'] == 'done'
    assert len(ArtifactStore(root).snapshot('chat')['artifacts']) == 1 and len(calls) == 1


def test_timeout_keeps_receipt_and_slot_without_automatic_retry(tmp_path):
    root = tmp_path / 'outputs'; jobs = ImageJobs(root); started = submit(jobs)
    def provider(*args, **kwargs):
        raise subprocess.TimeoutExpired('fake-image-provider', 900)
    worker = ImageWorker(Path(__file__).resolve().parents[1], lambda: root, lambda: CONFIG, lambda: {}, runner=provider)
    worker.run(jobs, jobs.claim(CONFIG, worker.owner), CONFIG)
    assert jobs.get(started['jobId'])['phase'] == 'unconfirmed'
    submit(jobs, 'second')
    assert ImageJobs(root).claim(CONFIG, 'restart') is None
    assert not ArtifactStore(root).snapshot('chat')['artifacts']


def test_real_openclaw_generation_tool_enqueues_with_trusted_session_without_network(tmp_path):
    node = shutil.which('node')
    if not node:
        pytest.skip('Node runtime unavailable')
    (tmp_path / '.env').write_text('\n'.join(f'{k}={v}' for k, v in CONFIG.items()), encoding='utf-8')
    root = tmp_path / 'outputs'; store = ArtifactStore(root); ticket = store.bind('chat', 'turn')
    module = Path(__file__).resolve().parents[1] / 'openclaw/easel-agent-safety/image.mjs'
    program = '''import {registerImage} from MODULE;
let factory;registerImage({registerTool:value=>{factory=value}});
const args={ticket:TICKET,requestId:'fixed-image-one',prompt:'画一只猫'};
const tool=factory({sessionKey:'agent:main:chat'});
const first=await tool.execute('call-one',args),second=await tool.execute('call-two',args);
if(first.details.job.jobId!==second.details.job.jobId)throw new Error('Duplicate generation');
let rejected=false;try{await factory({sessionKey:'agent:main:foreign'}).execute('foreign',args)}catch{rejected=true}
if(!rejected)throw new Error('Wrong session accepted');
console.log(JSON.stringify(first.details));'''.replace('MODULE', json.dumps(module.as_uri())).replace('TICKET', json.dumps(ticket))
    result = subprocess.run([node, '--input-type=module'], input=program, text=True, encoding='utf-8', capture_output=True,
        env={**os.environ, 'EASEL_DATA_DIR': str(tmp_path), 'EASEL_PYTHON': sys.executable}, timeout=35)
    assert result.returncode == 0, result.stderr
    receipt = json.loads(result.stdout)
    assert receipt['job']['phase'] == 'queued'
    assert len(ImageJobs(root).list('chat')) == 1
