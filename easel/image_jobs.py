"""One durable image queue for the workbench and both agent runtimes.

Only the host worker can call the dedicated image channel. Reads, refreshes and
tool retries with the same request ID never create another provider request.
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit
import uuid

from .artifacts import ArtifactStore, scope, file_path, inspect_file

SIZES = {'auto', '1024x1024', '768x1024', '1024x768', '864x1536', '1536x864',
         '1024x1280', '1280x1024', '1024x1536', '1536x1024'}
EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp'}
GENERATE_TOOL = {'type': 'function', 'name': 'easel_generate_image',
    'description': 'Submit an explicitly requested image to the configured dedicated image channel. May incur image fees. Same requestId is idempotent; never change it to retry a pending or unknown job. Returns a durable job ID; successful files appear in this chat automatically. No fallback model.',
    'inputSchema': {'type': 'object', 'additionalProperties': False, 'required': ['requestId', 'prompt'],
        'properties': {'requestId': {'type': 'string', 'pattern': '^[A-Za-z0-9_.-]{1,120}$'},
            'prompt': {'type': 'string', 'minLength': 1, 'maxLength': 2000},
            'size': {'type': 'string', 'enum': sorted(SIZES)}}}}


def read_config(data_root):
    """Use the same dedicated .env fields as the web app, without chat aliases."""
    path = Path(data_root) / '.env'
    result = {}
    if path.is_file():
        for line in path.read_text(encoding='utf-8').splitlines():
            if not line.strip().startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                if key.strip().startswith('IMG_'):
                    result[key.strip()] = value.strip()
    return result


def channel(config):
    base, model, key = (str(config.get(k, '')).strip() for k in ('IMG_BASE_URL', 'IMG_MODEL', 'IMG_API_KEY'))
    parsed = urlsplit(base)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or not model or not key:
        raise ValueError('生图专用通道未配置完整，请检查设置中的地址、模型和密钥')
    host = parsed.hostname.lower()
    try:
        limit = max(1, min(4, int(config.get('IMG_MAX_CONCURRENCY', 4 if host == 'image.mlgb7.com' else 1))))
    except (ValueError, TypeError):
        limit = 1
    if host == 'xjbh.lol' or host.endswith('.xjbh.lol'):
        limit = 1
    fingerprint = hashlib.sha256(json.dumps([base, key]).encode()).hexdigest()
    return host, fingerprint, limit


class ImageJobs:
    def __init__(self, outputs):
        self.outputs = Path(outputs).resolve()
        self.path = self.outputs / '_artifacts' / 'image-jobs.sqlite3'

    @contextmanager
    def db(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            db.execute('''CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, scope TEXT, request TEXT,
                fingerprint TEXT, channel TEXT, config TEXT, status TEXT, owner TEXT, lease REAL,
                created REAL, data TEXT, UNIQUE(scope,request))''')
            with db:
                yield db
        finally:
            db.close()

    def submit(self, payload, config, *, session=None, turn=None, request_id=None):
        raw_prompt = payload.get('prompt', '')
        if not isinstance(raw_prompt, str):
            raise ValueError('提示词必须是文字')
        prompt = raw_prompt.strip()
        size = str(payload.get('size', '1024x1024')).strip().lower()
        mode = payload.get('mode', 'text2img')
        count = payload.get('n', 1)
        if not prompt or len(prompt) > 2000 or size not in SIZES or mode not in ('text2img', 'img2img') or type(count) is not int or not 1 <= count <= 4:
            raise ValueError('无效的生图提示词、尺寸、模式或数量')
        if session is not None:
            scope(session); scope(turn)
        request_id = request_id or uuid.uuid4().hex
        if len(scope(request_id)) > 120:
            raise ValueError('请求标识过长')
        owner_scope = f'{session}:{turn}' if session else 'studio'
        normalized = {k: payload.get(k) for k in ('referenceId', 'maskId') if payload.get(k)}
        normalized.update(prompt=prompt, size=size, mode=mode, n=count,
                          model=str(config.get('IMG_MODEL', '')).strip(), sessionId=session, turnId=turn)
        fingerprint = hashlib.sha256(json.dumps(normalized, sort_keys=True).encode()).hexdigest()
        # Lookup precedes channel validation: retrieving a prior receipt must work
        # even after credentials are removed or changed.
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM jobs WHERE scope=? AND request=?', (owner_scope, request_id)).fetchone()
            if row:
                if row['fingerprint'] != fingerprint:
                    raise ValueError('该请求标识已用于不同参数；未重复生成')
                return self.public(row)
            host, config_id, limit = channel(config)
            if session:
                from easel.task_store import TaskStore
                TaskStore(self.outputs).reserve_image(session, turn, request_id, count)
            ident = uuid.uuid4().hex
            data = {**normalized, 'jobId': ident, 'requestId': request_id, 'started': time.time(),
                    'url': None, 'error': None, 'limit': limit}
            db.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                       (ident, owner_scope, request_id, fingerprint, host, config_id, 'queued', None, 0, time.time(), json.dumps(data, ensure_ascii=False)))
        return self.get(ident, session=session)

    @staticmethod
    def public(row):
        data = json.loads(row['data'])
        data.pop('limit', None)
        return {**data, 'phase': row['status'],
                'state': 'running' if row['status'] in ('queued', 'running') else 'done' if row['status'] == 'done' else 'error'}

    def get(self, ident, *, session=None):
        with self.db() as db:
            row = db.execute('SELECT * FROM jobs WHERE id=?', (ident,)).fetchone()
        if row is None or (session is not None and json.loads(row['data']).get('sessionId') != session):
            raise FileNotFoundError('任务不存在')
        return self.public(row)

    def list(self, session):
        scope(session)
        with self.db() as db:
            return [self.public(row) for row in db.execute('SELECT * FROM jobs ORDER BY created DESC LIMIT 1000')
                    if json.loads(row['data']).get('sessionId') == session][:100]

    def claim(self, config, owner, now=None):
        now = time.time() if now is None else now
        try:
            host, config_id, limit = channel(config)
        except ValueError:
            return None
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            for row in db.execute("SELECT * FROM jobs WHERE status='running' AND lease<?", (now,)).fetchall():
                data = json.loads(row['data']); data['error'] = '执行端连接已丢失，供应商状态未确认；未自动重发。请核对渠道任务后解除占位。'
                db.execute("UPDATE jobs SET status='unconfirmed', data=? WHERE id=?", (json.dumps(data, ensure_ascii=False), row['id']))
            # Unknown requests reserve a slot until a human reconciles them.
            active = db.execute("SELECT COUNT(*) FROM jobs WHERE channel=? AND status IN ('running','unconfirmed')", (host,)).fetchone()[0]
            if active >= limit:
                return None
            for row in db.execute("SELECT * FROM jobs WHERE status='queued' ORDER BY created").fetchall():
                data = json.loads(row['data'])
                if data.get('sessionId'):
                    from easel.task_store import TaskStore
                    if not TaskStore(self.outputs).image_allowed(data['sessionId'], data['turnId']):
                        data['error'] = '所属目标已停止或运行未确认；排队图片未提交供应商。'
                        db.execute("UPDATE jobs SET status='error',data=? WHERE id=?", (json.dumps(data, ensure_ascii=False), row['id']))
                        continue
                if row['config'] != config_id:
                    data['error'] = '排队期间生图渠道或模型已变更；未提交到供应商，请确认配置后新建任务。'
                    db.execute("UPDATE jobs SET status='error', data=? WHERE id=?", (json.dumps(data, ensure_ascii=False), row['id']))
                    continue
                if row['channel'] != host:
                    continue
                db.execute("UPDATE jobs SET status='running',owner=?,lease=? WHERE id=?", (owner, now + 45, row['id']))
                return data
        return None

    def deliver(self, job, owner, values):
        if job.get('sessionId'):
            try:
                artifacts = ArtifactStore(self.outputs).present(job['sessionId'], job['turnId'],
                    [{'path': path} for path in values['paths']], source='imagegen', call=job['jobId'])
                values['artifactIds'] = [a['id'] for a in artifacts]
            except (ValueError, OSError, sqlite3.Error):
                values['error'] = '图片已保存，但对话交付未完成；请重新登记已有文件，勿重复生图。'
        self.finish(job['jobId'], owner, 'done', values)

    def recover_receipts(self):
        """Recover local success before leasing new work; no provider call."""
        directory = self.path.parent / 'image-receipts'
        if not directory.is_dir():
            return
        for path in list(directory.glob('*.json'))[:1000]:
            try:
                if path.is_symlink() or path.stat().st_size > 128 * 1024:
                    continue
                receipt = json.loads(path.read_text(encoding='utf-8'))
                job, values, owner = receipt['job'], receipt['values'], receipt['owner']
                current = self.get(job['jobId'])
                if current['phase'] == 'done':
                    path.unlink(); continue
                if current['phase'] not in ('running', 'unconfirmed'):
                    continue
                if any(inspect_file(self.outputs, file_path(self.outputs, p)[1])['status'] != 'ready' for p in values['paths']):
                    continue
                self.deliver(job, owner, values)
                if self.get(job['jobId'])['phase'] == 'done':
                    path.unlink()
            except (OSError, ValueError, KeyError, TypeError, sqlite3.Error):
                continue

    def heartbeat(self, ident, owner):
        with self.db() as db:
            db.execute("UPDATE jobs SET lease=? WHERE id=? AND owner=? AND status='running'", (time.time() + 45, ident, owner))

    def finish(self, ident, owner, status, values):
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM jobs WHERE id=? AND owner=?', (ident, owner)).fetchone()
            if row and row['status'] in ('running', 'unconfirmed'):
                data = {**json.loads(row['data']), **values, 'finished': time.time()}
                db.execute('UPDATE jobs SET status=?,data=? WHERE id=?', (status, json.dumps(data, ensure_ascii=False), ident))

    def acknowledge(self, ident):
        """Explicit reconciliation only, never resubmit the original request."""
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM jobs WHERE id=?', (ident,)).fetchone()
            if row is None:
                raise FileNotFoundError('任务不存在')
            if row['status'] != 'unconfirmed':
                raise ValueError('仅可解除状态未确认任务的占位')
            data = json.loads(row['data']); data['error'] = '已人工核对并解除占位；原任务未重发，实际扣费以供应商为准。'
            db.execute("UPDATE jobs SET status='error',data=? WHERE id=?", (json.dumps(data, ensure_ascii=False), ident))
        return self.get(ident)


class ImageWorker:
    def __init__(self, code, outputs, config, process_env, *, runner=subprocess.run):
        self.code, self.outputs, self.config, self.process_env = Path(code), outputs, config, process_env
        self.runner = runner
        self.owner = uuid.uuid4().hex
        self.stop_event = threading.Event()
        self.thread = None
        self.active = set()
        self.lock = threading.Lock()

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._loop, name='easel-image-queue', daemon=True)
        self.thread.start()

    def stop(self):
        # A remote request cannot be truthfully cancelled by killing a web host.
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=2)

    def _loop(self):
        while not self.stop_event.is_set():
            try:
                self.tick()
            except (OSError, ValueError, sqlite3.Error):
                pass  # Status remains durable; no provider retry on worker errors.
            self.stop_event.wait(1)

    def tick(self):
        config = self.config()
        jobs = ImageJobs(self.outputs())
        jobs.recover_receipts()
        with self.lock:
            for ident in self.active:
                jobs.heartbeat(ident, self.owner)
        job = jobs.claim(config, self.owner)
        if job:
            with self.lock:
                self.active.add(job['jobId'])
            threading.Thread(target=self.run, args=(jobs, job, config), name='easel-image-job', daemon=True).start()
        return job

    def run(self, jobs, job, config):
        ident = job['jobId']
        output = jobs.outputs / 'AI生图' / f'{ident}.png'
        output.parent.mkdir(parents=True, exist_ok=True)
        cmd = [sys.executable, str(self.code / 'skills/shared/scripts/ai_image.py'), job['mode'],
               '--prompt', job['prompt'], '--output', str(output), '--size', job['size'], '--n', str(job['n'])]
        try:
            if job['mode'] == 'img2img':
                # Revalidate references just before invoking the provider.
                from web.image_inputs import reference_path, validate_mask
                reference = reference_path(jobs.outputs / '_image_references', job.get('referenceId'))
                cmd += ['--image', str(reference)]
                if job.get('maskId'):
                    mask = reference_path(jobs.outputs / '_image_references', job['maskId']); validate_mask(reference, mask)
                    cmd += ['--mask', str(mask)]
            env = self.process_env()
            env.update({k: str(config.get(k, '')).strip() for k in ('IMG_BASE_URL', 'IMG_API_KEY', 'IMG_MODEL')})
            env['IMG_MODEL'] = job['model']
            env['EASEL_DATA_DIR'] = str(jobs.outputs.parent)
            result = self.runner(cmd, cwd=str(self.code), env=env, capture_output=True, text=True, timeout=900)
            if result.returncode != 0:
                # A failed local process may already have submitted remotely.
                jobs.finish(ident, self.owner, 'unconfirmed', {'error': '生图执行未正常完成，供应商结果或扣费未确认；未自动重试。请核对渠道任务后解除占位。'})
                return
            files = sorted(p for p in output.parent.glob(output.stem + '*') if p.is_file() and p.suffix.lower() in EXTENSIONS)
            from PIL import Image
            dimensions = {}
            if not files:
                raise ValueError('生成端未返回实际图片')
            for image_path in files:
                with Image.open(image_path) as image:
                    if not dimensions:
                        dimensions = {'width': image.width, 'height': image.height}
                    image.verify()
                metadata = {k: job.get(k) for k in ('prompt','size','model','mode','referenceId','maskId','jobId','started')}
                metadata['created'] = job['started']
                image_path.with_name(f'.{image_path.name}.easel-image.json').write_text(json.dumps(metadata, ensure_ascii=False), encoding='utf-8')
            values = {'url': '/api/media/AI生图/' + files[0].name,
                      'paths': [str(p.relative_to(jobs.outputs).as_posix()) for p in files], **dimensions, 'error': None}
            receipt = jobs.path.parent / 'image-receipts' / f'{ident}.json'
            receipt.parent.mkdir(parents=True, exist_ok=True)
            temporary = receipt.with_suffix('.tmp')
            temporary.write_text(json.dumps({'job': job, 'owner': self.owner, 'values': values}, ensure_ascii=False), encoding='utf-8')
            temporary.replace(receipt)
            jobs.deliver(job, self.owner, values)
            if jobs.get(ident)['phase'] == 'done':
                receipt.unlink(missing_ok=True)
        except (ValueError, FileNotFoundError) as exc:
            jobs.finish(ident, self.owner, 'error', {'error': str(exc)[:200]})
        except Exception:
            jobs.finish(ident, self.owner, 'unconfirmed', {'error': '执行连接中断或超时，供应商状态未确认；未自动重发，请先核对渠道任务。'})
        finally:
            with self.lock:
                self.active.discard(ident)
