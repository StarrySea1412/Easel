"""Server admission limits follow backend completion, not a disconnected browser."""
from __future__ import annotations

import asyncio
import functools
import inspect
import os
import threading
import time
import uuid
from collections import deque

from fastapi import HTTPException


class Pool:
    def __init__(self, name: str, capacity: int):
        self.name, self.capacity, self.active = name, capacity, 0
        self.lock = threading.Lock()
        self.waiters = deque()

    def acquire(self):
        with self.lock:
            if self.active >= self.capacity or self.waiters:
                raise HTTPException(429, {'code': 'server_busy', 'message': '服务器已有任务运行，请稍后重试。', 'resource': self.name}, headers={'Retry-After': '5'})
            self.active += 1
        return Lease(self)

    async def acquire_chat(self, cancelled, on_wait=None, *, timeout=600, max_waiters=16):
        """FIFO waiting only for durable chat supervisors, never for HTTP retries."""
        ticket = object()
        with self.lock:
            if cancelled.is_set():
                return None
            if self.active < self.capacity and not self.waiters:
                self.active += 1
                return Lease(self)
            if len(self.waiters) >= max_waiters:
                raise HTTPException(429, {
                    'code': 'chat_server_queue_full', 'category': 'execution', 'retryable': True,
                    'stage': 'agent_queue', 'resource': self.name,
                    'message': '服务器等待队列已满；本轮未发送到模型，请稍后重试。',
                })
            self.waiters.append(ticket)
        started, previous = time.monotonic(), None
        try:
            while True:
                with self.lock:
                    if cancelled.is_set():
                        return None
                    if self.waiters[0] is ticket and self.active < self.capacity:
                        self.waiters.popleft()
                        self.active += 1
                        return Lease(self)
                    position = self.waiters.index(ticket) + 1
                if time.monotonic() - started >= timeout:
                    raise HTTPException(429, {
                        'code': 'chat_server_queue_timeout', 'category': 'execution', 'retryable': True,
                        'stage': 'agent_queue', 'resource': self.name,
                        'message': '服务器等待超时；本轮未发送到模型，可稍后手动继续。',
                    })
                if position != previous and on_wait is not None:
                    on_wait(position)
                previous = position
                await asyncio.sleep(0.1)
        finally:
            with self.lock:
                if ticket in self.waiters:
                    self.waiters.remove(ticket)


def queued_chat(call):
    """The OpenClaw SSE supervisor owns admission; Codex keeps the old fence."""
    call._easel_queued_chat = True
    return call


class Lease:
    def __init__(self, pool: Pool):
        self.pool, self.released = pool, False

    def release(self, *_):
        with self.pool.lock:
            if not self.released:
                self.pool.active -= 1
                self.released = True

    def watch(self, terminal):
        def monitor():
            while True:
                try:
                    if terminal():
                        self.release()
                        return
                except Exception:
                    # Failure to observe does not prove the job is terminal.
                    pass
                time.sleep(0.25)
        threading.Thread(target=monitor, daemon=True, name='easel-admission-' + self.pool.name).start()


class LoginAdmission:
    """Reserve only a newly started runner; reconnects need no second slot."""

    def __init__(self, app):
        self.pool = getattr(app.state, 'server_pools', {}).get('browser')
        self.lease = None
        self.process = None

    def __enter__(self):
        self.lease = self.pool.acquire() if self.pool else None
        return self

    def track(self, process):
        self.process = process
        process._easel_login_attempt = uuid.uuid4().hex
        if self.lease:
            process._easel_login_lease = self.lease

    def __exit__(self, *_):
        if self.lease:
            if self.process is None:
                self.lease.release()
            else:
                self.lease.watch(lambda: self.process.poll() is not None)


def release_login_admission(process):
    """A confirmed exit can release immediately before an explicit restart."""
    lease = getattr(process, '_easel_login_lease', None)
    if lease is not None and process.poll() is not None:
        lease.release()


def install_limits(workspace):
    pools = {name: Pool(name, max(1, int(os.environ.get('EASEL_' + name.upper() + '_LIMIT', '1'))))
             for name in ('agent', 'browser', 'media')}
    workspace.app.state.server_pools = pools
    running_calls = set()

    def classify(path, methods):
        if path in {'/api/chat/stream', '/api/chat', '/api/skill', '/api/profile/build',
                    '/api/settings/models/selftest', '/api/settings/models/probe',
                    '/api/skill-audits/critique'} and 'POST' in methods:
            return 'agent'
        if path in {'/api/imagegen', '/api/videogen', '/api/image-reverse'} and 'POST' in methods:
            return 'media'
        # Login endpoints acquire inside their account lock, after the reuse
        # and credential-only branches, and retain the slot until child exit.
        if path in {'/api/analytics/{platform}', '/api/accounts/{platform}/whoami'} and 'GET' in methods:
            return 'browser'
        return None

    def wrap(call, group, path):
        def capture():
            return set(workspace._BG_TASKS), dict(workspace.LOGIN_PROCESSES)

        def transfer(lease, response, previous):
            old_tasks, old_logins = previous
            tasks = [task for task in workspace._BG_TASKS if task not in old_tasks] if group == 'agent' else []
            if tasks:
                remaining = set(tasks)
                def ended(task):
                    remaining.discard(task)
                    if not remaining:
                        lease.release()
                for task in tasks:
                    task.add_done_callback(ended)
                return
            processes = [proc for key, proc in workspace.LOGIN_PROCESSES.items() if old_logins.get(key) is not proc] if group == 'browser' else []
            if processes:
                lease.watch(lambda: all(proc.poll() is not None for proc in processes))
                return
            if path == '/api/profile/build' and isinstance(response, dict) and response.get('async'):
                import json
                status_file = workspace.PROFILE_BUILD_DIR / (response['name'] + '.json')
                lease.watch(lambda: json.loads(status_file.read_text())['state'] in {'done', 'failed', 'unconfirmed'})
                return
            if group == 'media' and isinstance(response, dict) and response.get('jobId'):
                jobs = workspace._VIDEO_SERVICE.jobs if 'videogen' in path else workspace._IMAGEGEN_JOBS
                identifier = response['jobId']
                lease.watch(lambda: jobs.get(identifier, {}).get('state') in {'done', 'error', 'cancelled', 'unconfirmed'})
                return
            lease.release()

        if inspect.iscoroutinefunction(call):
            @functools.wraps(call)
            async def asynchronous(*args, **kwargs):
                if getattr(call, '_easel_queued_chat', False):
                    req = kwargs.get('req') if 'req' in kwargs else args[0]
                    if getattr(req, 'engine', 'openclaw') != 'codex':
                        return await call(*args, **kwargs)
                lease, previous = pools[group].acquire(), capture()
                async def complete():
                    try:
                        response = await call(*args, **kwargs)
                    except BaseException:
                        # A login process or SSE supervisor may already have started.
                        transfer(lease, None, previous)
                        raise
                    transfer(lease, response, previous)
                    return response
                task = asyncio.create_task(complete())
                running_calls.add(task)
                def ended(completed):
                    running_calls.discard(completed)
                    if not completed.cancelled():
                        completed.exception()  # Consume exceptions from disconnected clients.
                task.add_done_callback(ended)
                # Executor work cannot be cancelled by cancelling its HTTP waiter.
                return await asyncio.shield(task)
            return asynchronous
        @functools.wraps(call)
        def synchronous(*args, **kwargs):
            lease, previous = pools[group].acquire(), capture()
            try:
                response = call(*args, **kwargs)
            except BaseException:
                lease.release()
                raise
            transfer(lease, response, previous)
            return response
        return synchronous

    for route in workspace.app.routes:
        group = classify(getattr(route, 'path', ''), getattr(route, 'methods', set()))
        if group and hasattr(route, 'dependant'):
            call = wrap(route.dependant.call, group, route.path)
            route.endpoint = route.dependant.call = call

    @workspace.app.get('/api/server/readiness')
    async def readiness():
        status = await asyncio.to_thread(workspace.check_gateway)
        return {'web': True, 'gateway': bool(status), 'modelInference': 'not_probed',
                'deployment': {'mode': 'server', 'readOnlyRoot': True,
                               'environmentInstall': False, 'storageMigration': False},
                'codex': os.environ.get('EASEL_CODEX_ENABLED', '0') == '1',
                'resources': {name: {'capacity': pool.capacity, 'active': pool.active,
                                     'waiting': len(pool.waiters)} for name, pool in pools.items()}}
