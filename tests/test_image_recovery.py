"""Real CLI/process loss against an isolated fake HTTP provider; no paid calls."""
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from types import SimpleNamespace

from PIL import Image
import pytest

from easel.image_jobs import ImageJobs, ImageWorker

ROOT = Path(__file__).resolve().parents[1]


@contextmanager
def provider():
    image = io.BytesIO()
    Image.new('RGB', (24, 32), 'green').save(image, 'PNG')
    calls = []
    behavior = {'failed': False, 'downloadFailures': 0}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, payload, status=200, mime='application/json'):
            body = json.dumps(payload).encode() if mime == 'application/json' else payload
            self.send_response(status)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            calls.append(('POST', self.path))
            self.rfile.read(int(self.headers['Content-Length']))
            self.reply({'data': [{'task_id': 'original-task'}]})

        def do_GET(self):
            calls.append(('GET', self.path))
            if self.path == '/v1/tasks/original-task':
                self.reply({'data': {'status': 'failed' if behavior['failed'] else 'completed',
                    'result': {'images': [{'url': [f'http://127.0.0.1:{self.server.server_port}/image.png']}]}}})
            elif self.path == '/image.png':
                if behavior['downloadFailures']:
                    behavior['downloadFailures'] -= 1
                    self.reply({'error': 'temporary download failure'}, 503)
                else:
                    self.reply(image.getvalue(), mime='image/png')
            else:
                self.reply({'error': 'unexpected endpoint'}, 404)

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield {'IMG_BASE_URL': f'http://127.0.0.1:{server.server_port}/v1',
               'IMG_MODEL': 'fixture-image', 'IMG_API_KEY': 'fixture-secret-not-persisted'}, calls, behavior
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


def submit(root, config, *, count=1):
    jobs = ImageJobs(root)
    job = jobs.submit({'prompt': '运营封面', 'n': count}, config, request_id='fixed-request')
    return jobs, job


@contextmanager
def sync_provider(items=1):
    """OpenAI-compatible sync provider: response URLs, never a task id."""
    image = io.BytesIO()
    Image.new('RGB', (24, 32), 'blue').save(image, 'PNG')
    calls = []
    behavior = {'downloadFailures': 0, 'downloadDelay': 0}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, payload, status=200, mime='application/json'):
            body = json.dumps(payload).encode() if mime == 'application/json' else payload
            self.send_response(status)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            calls.append(('POST', self.path))
            self.rfile.read(int(self.headers['Content-Length']))
            base = f'http://127.0.0.1:{self.server.server_port}'
            self.reply({'data': [{'url': f'{base}/image-{number}.png'} for number in range(items)]})

        def do_GET(self):
            calls.append(('GET', self.path))
            if self.path.startswith('/image-'):
                if behavior['downloadDelay']:
                    time.sleep(behavior['downloadDelay'])
                if behavior['downloadFailures']:
                    behavior['downloadFailures'] -= 1
                    self.reply({'error': 'temporary download failure'}, 503)
                else:
                    self.reply(image.getvalue(), mime='image/png')
            else:
                self.reply({'error': 'unexpected endpoint'}, 404)

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield {'IMG_BASE_URL': f'http://127.0.0.1:{server.server_port}/v1',
               'IMG_MODEL': 'fixture-image', 'IMG_API_KEY': 'fixture-secret-not-persisted'}, calls, behavior
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


def interrupt_after_acceptance(jobs, config, *, on_accepted=None):
    """Kill only the exact child created here after its accepted receipt is on disk."""
    def runner(cmd, **options):
        args = {k: v for k, v in options.items() if k not in ('timeout', 'capture_output')}
        child = subprocess.Popen(cmd + ['--mode', 'async'], **args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        deadline = time.monotonic() + 12
        try:
            while time.monotonic() < deadline:
                receipt = checkpoint.read()
                if receipt and receipt['stage'] == 'accepted':
                    if on_accepted:
                        on_accepted(checkpoint, options)
                    child.terminate()
                    child.communicate(timeout=5)
                    return SimpleNamespace(returncode=child.returncode)
                if child.poll() is not None:
                    out, err = child.communicate()
                    raise AssertionError(f'fixture child exited before acceptance: {out!r} {err!r}')
                time.sleep(.02)
            raise AssertionError('fixture child did not persist acceptance')
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate(timeout=5)

    worker = ImageWorker(ROOT, lambda: jobs.outputs, lambda: config, lambda: dict(os.environ), runner=runner)
    job = jobs.claim(config, worker.owner)
    with jobs.db() as db:
        checkpoint = jobs.checkpoint(db.execute('SELECT * FROM jobs WHERE id=?', (job['jobId'],)).fetchone())
    worker.run(jobs, job, config)
    return checkpoint


def resume(jobs, config):
    worker = ImageWorker(ROOT, lambda: jobs.outputs, lambda: config, lambda: dict(os.environ))
    recovered = jobs.claim(config, worker.owner, now=time.time() + 301)
    assert recovered and recovered['_resume']
    worker.run(jobs, recovered, config)


def test_process_loss_recovers_original_provider_task_without_another_post(tmp_path):
    with provider() as (config, calls, _):
        jobs, job = submit(tmp_path / 'outputs', config)
        checkpoint = interrupt_after_acceptance(jobs, config)
        assert jobs.get(job['jobId'])['phase'] == 'unconfirmed'
        assert jobs.get(job['jobId'])['recoveryAvailable']
        assert config['IMG_API_KEY'] not in checkpoint.path.read_text()
        assert config['IMG_API_KEY'].encode() not in jobs.path.read_bytes()
        resume(ImageJobs(jobs.outputs), config)
        result = jobs.get(job['jobId'])
        assert result['phase'] == 'done' and (result['width'], result['height']) == (24, 32)
        assert calls.count(('POST', '/v1/images/generations')) == 1
        assert calls.count(('GET', '/v1/tasks/original-task')) == 1


def test_live_original_child_is_fenced_before_any_recovery_query(tmp_path):
    with provider() as (config, calls, _):
        jobs, _ = submit(tmp_path / 'outputs', config)
        def while_original_alive(checkpoint, options):
            with jobs.db() as db:
                db.execute("UPDATE jobs SET status='unconfirmed' WHERE id=?", (checkpoint.identity['jobId'],))
            with pytest.raises(ValueError, match='仍在运行'):
                jobs.acknowledge(checkpoint.identity['jobId'])
            result = subprocess.run([os.sys.executable, str(ROOT / 'skills/shared/scripts/ai_image.py'),
                'resume', '--output', str(checkpoint.output)], env=options['env'], cwd=ROOT,
                capture_output=True, text=True, timeout=8)
            assert result.returncode == 75
            assert calls == [('POST', '/v1/images/generations')]
        interrupt_after_acceptance(jobs, config, on_accepted=while_original_alive)


def test_recovery_is_bounded_then_manual_query_can_resume_without_another_post(tmp_path):
    with provider() as (config, calls, _):
        jobs, job = submit(tmp_path / 'outputs', config)
        interrupt_after_acceptance(jobs, config)
        worker = ImageWorker(ROOT, lambda: jobs.outputs, lambda: config, lambda: dict(os.environ),
            runner=lambda *_, **__: SimpleNamespace(returncode=1))
        for _ in range(3):
            claimed = jobs.claim(config, worker.owner, now=time.time() + 301)
            assert claimed and claimed['_resume']
            worker.run(jobs, claimed, config)
        assert jobs.claim(config, worker.owner, now=time.time() + 301) is None
        jobs.reconcile(job['jobId'], config)
        resume(jobs, config)
        assert jobs.get(job['jobId'])['phase'] == 'done'
        assert calls.count(('POST', '/v1/images/generations')) == 1


def test_download_failure_retries_download_and_query_without_regenerating(tmp_path):
    with provider() as (config, calls, behavior):
        jobs, job = submit(tmp_path / 'outputs', config)
        interrupt_after_acceptance(jobs, config)
        behavior['downloadFailures'] = 1
        resume(jobs, config)
        assert jobs.get(job['jobId'])['phase'] == 'unconfirmed'
        resume(jobs, config)
        assert jobs.get(job['jobId'])['phase'] == 'done'
        assert calls.count(('POST', '/v1/images/generations')) == 1
        assert calls.count(('GET', '/image.png')) == 2


def test_original_provider_failure_releases_slot_without_a_creation_retry(tmp_path):
    with provider() as (config, calls, behavior):
        jobs, job = submit(tmp_path / 'outputs', config)
        interrupt_after_acceptance(jobs, config)
        behavior['failed'] = True
        resume(jobs, config)
        assert jobs.get(job['jobId'])['phase'] == 'error'
        assert calls == [('POST', '/v1/images/generations'), ('GET', '/v1/tasks/original-task')]


def test_changed_credentials_and_foreign_receipts_do_not_query_or_resubmit(tmp_path):
    with provider() as (config, calls, _):
        jobs, job = submit(tmp_path / 'outputs', config)
        checkpoint = interrupt_after_acceptance(jobs, config)
        with pytest.raises(ValueError, match='渠道身份'):
            jobs.reconcile(job['jobId'], {**config, 'IMG_API_KEY': 'different-secret'})
        receipt = json.loads(checkpoint.path.read_text())
        receipt['binding'] = '0' * 64
        checkpoint.path.write_text(json.dumps(receipt))
        assert jobs.claim(config, 'foreign-recovery', now=time.time() + 301) is None
        assert calls == [('POST', '/v1/images/generations')]


def test_partial_image_batch_cannot_be_reported_as_completed(tmp_path):
    config = {'IMG_BASE_URL': 'https://fixture.invalid/v1', 'IMG_MODEL': 'fixture', 'IMG_API_KEY': 'fixture'}
    jobs, job = submit(tmp_path / 'outputs', config, count=2)
    def incomplete(cmd, **_):
        Image.new('RGB', (24, 32)).save(cmd[cmd.index('--output') + 1])
        return SimpleNamespace(returncode=0)
    worker = ImageWorker(ROOT, lambda: jobs.outputs, lambda: config, lambda: {}, runner=incomplete)
    worker.run(jobs, jobs.claim(config, worker.owner), config)
    assert jobs.get(job['jobId'])['phase'] == 'error'
    assert not jobs.get(job['jobId'])['url']


def test_saved_checkpoint_recovers_local_delivery_without_provider_requests(tmp_path):
    with provider() as (config, calls, _):
        jobs, job = submit(tmp_path / 'outputs', config)
        jobs.claim(config, 'lost-owner')
        with jobs.db() as db:
            row = db.execute('SELECT * FROM jobs WHERE id=?', (job['jobId'],)).fetchone()
            checkpoint = jobs.checkpoint(row)
        checkpoint.output.parent.mkdir(parents=True, exist_ok=True)
        Image.new('RGB', (24, 32), 'green').save(checkpoint.output)
        checkpoint.saved([checkpoint.output])
        with jobs.db() as db:
            db.execute("UPDATE jobs SET status='unconfirmed' WHERE id=?", (job['jobId'],))
        with pytest.raises(ValueError, match='先接回'):
            jobs.acknowledge(job['jobId'])
        resume(ImageJobs(jobs.outputs), config)
        assert jobs.get(job['jobId'])['phase'] == 'done' and not calls


def test_memory_pressure_keeps_image_queued_with_a_visible_reason(tmp_path, monkeypatch):
    from easel import resource_health
    config = {'IMG_BASE_URL': 'https://fixture.invalid/v1', 'IMG_MODEL': 'fixture', 'IMG_API_KEY': 'fixture'}
    jobs, job = submit(tmp_path / 'outputs', config)
    monkeypatch.setattr(resource_health, 'memory_snapshot', lambda: {'state': 'pressure'})
    assert jobs.claim(config, 'worker') is None
    assert jobs.get(job['jobId'])['phase'] == 'queued'
    assert jobs.get(job['jobId'])['queueReason'] == 'memory_pressure'
    monkeypatch.setattr(resource_health, 'memory_snapshot', lambda: {'state': 'available'})
    assert jobs.claim(config, 'worker')['jobId'] == job['jobId']


def test_acknowledge_fences_a_spawned_child_that_has_not_started_yet(tmp_path):
    with provider() as (config, calls, _):
        jobs, job = submit(tmp_path / 'outputs', config)
        def delayed_child(cmd, **options):
            jobs.finish(job['jobId'], worker.owner, 'unconfirmed', {'error':'执行端失联'})
            jobs.acknowledge(job['jobId'])
            return subprocess.run(cmd + ['--mode', 'async'], **options)
        worker = ImageWorker(ROOT, lambda: jobs.outputs, lambda: config, lambda: dict(os.environ), runner=delayed_child)
        worker.run(jobs, jobs.claim(config, worker.owner), config)
        assert jobs.get(job['jobId'])['phase'] == 'error' and not calls


def test_acknowledged_accepted_task_cannot_be_resumed_by_a_late_child(tmp_path):
    with provider() as (config, calls, _):
        jobs, job = submit(tmp_path / 'outputs', config)
        checkpoint = interrupt_after_acceptance(jobs, config)
        jobs.acknowledge(job['jobId'])
        assert not jobs.get(job['jobId'])['recoveryAvailable']
        env = {**os.environ, **config, 'EASEL_IMAGE_CONTEXT': json.dumps(checkpoint.identity),
               'EASEL_IMAGE_DEDICATED_CHANNEL':'1', 'EASEL_DATA_DIR':str(jobs.outputs.parent)}
        result = subprocess.run([sys.executable, str(ROOT/'skills/shared/scripts/ai_image.py'),
            'resume', '--output', str(checkpoint.output)], env=env, cwd=ROOT,
            capture_output=True, text=True, timeout=8)
        assert result.returncode != 0 and calls == [('POST','/v1/images/generations')]


def test_acceptance_receipt_survives_transient_windows_file_sharing(tmp_path, monkeypatch):
    config = {'IMG_BASE_URL': 'https://fixture.invalid/v1', 'IMG_MODEL': 'fixture', 'IMG_API_KEY': 'fixture'}
    jobs, job = submit(tmp_path / 'outputs', config)
    with jobs.db() as db:
        checkpoint = jobs.checkpoint(db.execute('SELECT * FROM jobs WHERE id=?',(job['jobId'],)).fetchone())
    checkpoint.write(stage='submitting')
    original = os.replace; attempts = []
    def sharing_conflict(source, destination):
        attempts.append(destination)
        if len(attempts) <= 2:
            raise PermissionError('simulated Windows reader sharing conflict')
        return original(source, destination)
    monkeypatch.setattr(os, 'replace', sharing_conflict)
    checkpoint.write(stage='accepted', protocol='apimart-v1', taskId='original-task')
    assert len(attempts) == 3 and checkpoint.read()['taskId'] == 'original-task'


def test_recovery_workers_share_the_original_channel_concurrency_limit(tmp_path):
    config = {'IMG_BASE_URL':'https://fixture.invalid/v1','IMG_MODEL':'fixture','IMG_API_KEY':'fixture'}
    jobs = ImageJobs(tmp_path / 'outputs')
    for number in range(2):
        job = jobs.submit({'prompt':'原图片'},config,request_id=f'original-{number}')
        with jobs.db() as db:
            row = db.execute('SELECT * FROM jobs WHERE id=?',(job['jobId'],)).fetchone()
            jobs.checkpoint(row).write(stage='accepted',protocol='apimart-v1',taskId=f'original-{number}')
            db.execute("UPDATE jobs SET status='unconfirmed' WHERE id=?",(job['jobId'],))
    first = jobs.claim(config,'worker')
    assert first['_resume'] and jobs.claim(config,'other-worker') is None
    jobs.finish(first['jobId'],'worker','error',{'error':'供应商已确认失败'})
    assert jobs.claim(config,'other-worker')['_resume']


def job_checkpoint(jobs, ident):
    with jobs.db() as db:
        row = db.execute('SELECT * FROM jobs WHERE id=?', (ident,)).fetchone()
    return jobs.checkpoint(row)


def test_sync_response_survives_download_failure_and_resumes_without_post(tmp_path):
    with sync_provider() as (config, calls, behavior):
        jobs, job = submit(tmp_path / 'outputs', config)
        behavior['downloadFailures'] = 1
        worker = ImageWorker(ROOT, lambda: jobs.outputs, lambda: config, lambda: dict(os.environ))
        worker.run(jobs, jobs.claim(config, worker.owner), config)
        result = jobs.get(job['jobId'])
        assert result['phase'] == 'unconfirmed' and result['recoveryAvailable']
        checkpoint = job_checkpoint(jobs, job['jobId'])
        receipt = checkpoint.read()
        assert receipt['protocol'] == 'sync-v1' and receipt['response']['count'] == 1
        assert config['IMG_API_KEY'] not in checkpoint.path.read_text()
        assert config['IMG_API_KEY'].encode() not in jobs.path.read_bytes()
        resume(ImageJobs(jobs.outputs), config)
        result = jobs.get(job['jobId'])
        assert result['phase'] == 'done' and (result['width'], result['height']) == (24, 32)
        assert calls.count(('POST', '/v1/images/generations')) == 1
        assert calls.count(('GET', '/image-0.png')) == 2
        assert not checkpoint.response_path.exists()


def test_sync_response_is_persisted_before_download_and_process_loss_recovers(tmp_path):
    with sync_provider() as (config, calls, behavior):
        jobs, job = submit(tmp_path / 'outputs', config)
        behavior['downloadDelay'] = 3
        checkpoint = job_checkpoint(jobs, job['jobId'])

        def runner(cmd, **options):
            args = {k: v for k, v in options.items() if k not in ('timeout', 'capture_output')}
            child = subprocess.Popen(cmd, **args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            deadline = time.monotonic() + 12
            try:
                while time.monotonic() < deadline:
                    receipt = checkpoint.read()
                    if receipt and receipt['stage'] == 'downloading':
                        child.terminate()
                        child.communicate(timeout=5)
                        return SimpleNamespace(returncode=child.returncode)
                    if child.poll() is not None:
                        out, err = child.communicate()
                        raise AssertionError(f'fixture child exited before persisting: {out!r} {err!r}')
                    time.sleep(.02)
                raise AssertionError('fixture child did not persist the sync response')
            finally:
                if child.poll() is None:
                    child.kill()
                    child.communicate(timeout=5)

        worker = ImageWorker(ROOT, lambda: jobs.outputs, lambda: config, lambda: dict(os.environ), runner=runner)
        worker.run(jobs, jobs.claim(config, worker.owner), config)
        assert calls.count(('POST', '/v1/images/generations')) == 1
        assert jobs.get(job['jobId'])['phase'] == 'unconfirmed'
        behavior['downloadDelay'] = 0
        resume(ImageJobs(jobs.outputs), config)
        result = jobs.get(job['jobId'])
        assert result['phase'] == 'done' and (result['width'], result['height']) == (24, 32)
        assert calls.count(('POST', '/v1/images/generations')) == 1


def test_tampered_sync_response_is_refused_without_another_post(tmp_path):
    with sync_provider() as (config, calls, behavior):
        jobs, job = submit(tmp_path / 'outputs', config)
        behavior['downloadFailures'] = 1
        worker = ImageWorker(ROOT, lambda: jobs.outputs, lambda: config, lambda: dict(os.environ))
        worker.run(jobs, jobs.claim(config, worker.owner), config)
        checkpoint = job_checkpoint(jobs, job['jobId'])
        raw = json.loads(checkpoint.response_path.read_text(encoding='utf-8'))
        raw['data'][0]['url'] = raw['data'][0]['url'].replace('image-0', 'image-other')
        checkpoint.response_path.write_text(json.dumps(raw), encoding='utf-8')
        env = {**os.environ, **config, 'EASEL_IMAGE_CONTEXT': json.dumps(checkpoint.identity),
               'EASEL_IMAGE_DEDICATED_CHANNEL': '1', 'EASEL_DATA_DIR': str(jobs.outputs.parent)}
        result = subprocess.run([sys.executable, str(ROOT / 'skills/shared/scripts/ai_image.py'),
            'resume', '--output', str(checkpoint.output)], env=env, cwd=ROOT,
            capture_output=True, text=True, timeout=10)
        assert result.returncode != 0
        assert calls.count(('POST', '/v1/images/generations')) == 1


def test_partial_sync_result_is_terminal_without_automatic_regeneration(tmp_path):
    with sync_provider(items=1) as (config, calls, _):
        jobs, job = submit(tmp_path / 'outputs', config, count=2)
        worker = ImageWorker(ROOT, lambda: jobs.outputs, lambda: config, lambda: dict(os.environ))
        worker.run(jobs, jobs.claim(config, worker.owner), config)
        result = jobs.get(job['jobId'])
        assert result['phase'] == 'error' and '部分' in (result['error'] or '')
        assert not result['recoveryAvailable']
        assert jobs.claim(config, 'later', now=time.time() + 301) is None
        assert calls.count(('POST', '/v1/images/generations')) == 1


def test_sync_wait_budget_applies_to_text_and_image_edits(monkeypatch):
    shared = ROOT / 'skills' / 'shared' / 'scripts'
    monkeypatch.syspath_prepend(str(shared))
    spec = importlib.util.spec_from_file_location('image_budget_helper', shared / 'ai_image.py')
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    monkeypatch.setattr(helper, 'load_and_require', lambda: ('https://images.example.test/v1', 'model', 'key', None))
    monkeypatch.setattr(helper, 'save_sync_data', lambda *args: [])
    seen = []
    monkeypatch.setattr(helper, 'http_post',
                        lambda *args, **kwargs: seen.append(kwargs['timeout']) or {'data': [{'url': 'https://x.test/a.png'}]})
    args = SimpleNamespace(prompt='x', mode=None, size='1024x1024', n=1, request_timeout=42,
                           output='unused.png', format='png', quality=None, poll_interval=5, timeout=60)
    helper.cmd_text2img(args)
    assert seen == [42]
    edits = []
    monkeypatch.setattr(helper, '_post_edits_multipart',
                        lambda *a, **kw: edits.append(kw['timeout']) or {'data': [{'url': 'https://x.test/a.png'}]})
    args.image = 'unused.png'
    helper.cmd_img2img(args)
    assert edits == [42]
    monkeypatch.delenv(helper.ENV_SYNC_TIMEOUT, raising=False)
    monkeypatch.setenv(helper.ENV_SYNC_TIMEOUT, '77')
    args.request_timeout = None
    helper.cmd_text2img(args)
    assert seen == [42, 77]
