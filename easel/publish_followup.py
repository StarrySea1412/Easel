"""Bounded, durable read-only checks after a platform accepts a publication.

The worker never uploads content. GET routes only read receipts; explicit user
actions and this lifecycle-owned worker schedule checks. Platform publication,
verification progress and notification delivery remain separate states.
"""
from __future__ import annotations

from datetime import datetime, timezone
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time

PLATFORMS = frozenset({'xiaohongshu', 'weixin-channels', 'bilibili', 'douyin', 'kuaishou'})
AWAITING = frozenset({'submitted', 'unverified'})
MAX_AGE_SECONDS = 24 * 3600
MAX_ATTEMPTS = 12
MANUAL_COOLDOWN_SECONDS = 30


def timestamp(value) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.timestamp() if parsed.tzinfo is not None else None
    except (ValueError, OverflowError, OSError):
        return None


def iso(value: float) -> str:
    return datetime.fromtimestamp(value, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def _attempts(value) -> int:
    return min(max(value, 0), 10000) if type(value) is int else 0


def initial_verification(receipt: dict, *, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    if receipt.get('platform') not in PLATFORMS:
        return {'state': 'unsupported', 'automatic': False, 'attempts': 0,
                'message': '该平台暂不支持自动核实，请在平台查看结果。'}
    if receipt.get('outcome') not in AWAITING:
        return {'state': 'complete', 'automatic': False, 'attempts': 0,
                'message': '本次结果无需继续核实。'}
    if (receipt.get('evidence') or {}).get('readbackOutcome') == 'login_required':
        return {'state': 'login_required', 'automatic': False, 'attempts': 0,
                'message': '登录已失效，请在账号管理重新登录后手动核实。'}
    if receipt.get('platformStatus') in {'private', 'unlisted', 'self_only', 'friends_only'}:
        return {'state': 'paused', 'automatic': False, 'attempts': 0,
                'message': '作品为有限可见，更改可见性后可手动核实。'}
    created = timestamp(receipt.get('createdAt'))
    if created is None or created > now + 60:
        return {'state': 'unsupported', 'automatic': False, 'attempts': 0,
                'message': '回执缺少可靠的提交时间，请在平台核对。'}
    if now - created >= MAX_AGE_SECONDS:
        return {'state': 'exhausted', 'automatic': False, 'attempts': 0,
                'message': '已超过自动核实的 24 小时时限，可手动核实已有作品编号。'}
    finished = timestamp(receipt.get('submissionFinishedAt'))
    if not receipt.get('contentId') and (finished is None or finished < created or finished > now + 60):
        return {'state': 'unsupported', 'automatic': False, 'attempts': 0,
                'message': '历史回执缺少作品编号和完整提交时间窗，请直接在平台核对。'}
    return {'state': 'waiting', 'automatic': True, 'attempts': 0,
            'nextCheckAt': iso(now + 60),
            'message': '将自动核实审核结果；确认公开后更新回执和成功提醒。'}


class VerificationError(Exception):
    def __init__(self, status_code: int, message: str):
        self.status_code = status_code
        super().__init__(message)


class VerificationService:
    """One bounded worker per Web process, sharing publication reservations."""

    def __init__(self, *, list_items, get_item, save_item, acquire, release,
                 run_check, on_confirmed, now=time.time):
        self.list_items, self.get_item, self.save_item = list_items, get_item, save_item
        self.acquire, self.release = acquire, release
        self.run_check, self.on_confirmed, self.now = run_check, on_confirmed, now
        self.stop_event = threading.Event()
        self.wake_event = threading.Event()
        self.lock = threading.RLock()
        self.thread = None

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._loop, daemon=True, name='easel-publish-verification')
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        self.wake_event.set()
        if self.thread:
            self.thread.join(timeout=20)

    def _loop(self):
        while not self.stop_event.is_set():
            self.wake_event.clear()
            try:
                worked = self.tick()
            except Exception:
                # A corrupt history or unavailable disk must not initiate any
                # external work. Existing GET routes surface storage errors.
                worked = False
            if not worked:
                self.wake_event.wait(15)

    def _eligible(self, receipt: dict):
        if receipt.get('platform') not in PLATFORMS or receipt.get('outcome') not in AWAITING:
            raise VerificationError(409, '这条回执当前无需核实，或平台暂不支持只读核实。')
        if receipt.get('storageWarning'):
            raise VerificationError(503, '请先修复回执保存问题，再核实发布结果。')
        created = timestamp(receipt.get('createdAt'))
        if created is None or created > self.now() + 60:
            raise VerificationError(409, '回执缺少可靠的提交时间，请在平台核对。')
        if self.now() - created >= MAX_AGE_SECONDS and not receipt.get('contentId'):
            raise VerificationError(409, '回执已超过 24 小时且没有作品编号，请直接在平台核对。')
        finished = timestamp(receipt.get('submissionFinishedAt'))
        if not receipt.get('contentId') and (finished is None or finished < created or finished > self.now() + 60):
            raise VerificationError(409, '回执没有作品编号或完整提交时间窗，请直接在平台核对。')

    def request(self, receipt_id: str, *, automatic: bool | None = None) -> dict:
        """None = one manual check; bool = change automatic follow-up setting."""
        with self.lock:
            receipt = self.get_item(receipt_id)
            self._eligible(receipt)
            current = dict(receipt.get('verification') or initial_verification(receipt, now=self.now()))
            checking = current.get('state') == 'checking'
            if automatic is False:
                current.update(automatic=False, state='checking' if checking else 'paused',
                               nextCheckAt=None, message=('当前核实完成后停止自动核实。' if checking else
                                                         '已暂停自动核实，可随时手动核实。'))
            else:
                checked = timestamp(current.get('lastCheckedAt'))
                if not checking and checked is not None and self.now() - checked < MANUAL_COOLDOWN_SECONDS:
                    raise VerificationError(429, '刚刚核实过这条回执，请稍后再试。')
                if automatic is True:
                    created = timestamp(receipt.get('createdAt'))
                    if self.now() - created >= MAX_AGE_SECONDS or _attempts(current.get('attempts')) >= MAX_ATTEMPTS:
                        raise VerificationError(409, '已达到自动核实上限，请手动核实。')
                    current['automatic'] = True
                if not checking:
                    current.update(state='waiting', nextCheckAt=iso(self.now()),
                                   manual=automatic is None,
                                   message='已安排核实，只查询结果，不会再次发布内容。')
            saved = self.save_item(receipt_id, {'verification': current})
            if saved.get('storageWarning'):
                raise VerificationError(503, '核实设置未保存，请检查数据目录。')
        self.wake_event.set()
        return saved

    def tick(self) -> bool:
        """Run at most one check; suitable for deterministic offline tests."""
        if self.stop_event.is_set():
            return False
        items = self.list_items()
        candidates = []
        for receipt in items:
            if (receipt.get('outcome') == 'published' and receipt.get('completionPending') is True
                    and not receipt.get('completionHandled') and not receipt.get('storageWarning')):
                with self.lock:
                    if self.acquire(receipt['platform'], receipt['receiptId']):
                        try:
                            self.on_confirmed(self.get_item(receipt['receiptId']))
                        finally:
                            self.release(receipt['platform'], receipt['receiptId'])
                        return True
            if receipt.get('platform') not in PLATFORMS or receipt.get('outcome') not in AWAITING:
                continue
            if receipt.get('storageWarning'):
                continue
            verification = receipt.get('verification')
            if not isinstance(verification, dict):
                verification = initial_verification(receipt, now=self.now())
                receipt = self.save_item(receipt['receiptId'], {'verification': verification})
                if receipt.get('storageWarning'):
                    continue
            next_at = timestamp(verification.get('nextCheckAt'))
            if verification.get('state') == 'waiting' and next_at is not None and next_at <= self.now():
                candidates.append((next_at, receipt['receiptId']))
        for _, receipt_id in sorted(candidates):
            if self._check(receipt_id):
                return True
        return False

    def _check(self, receipt_id: str) -> bool:
        with self.lock:
            receipt = self.get_item(receipt_id)
            try:
                self._eligible(receipt)
            except VerificationError as exc:
                if exc.status_code == 409:
                    terminal = initial_verification(receipt, now=self.now())
                    terminal['attempts'] = _attempts((receipt.get('verification') or {}).get('attempts'))
                    self.save_item(receipt_id, {'verification': terminal})
                return False
            verification = dict(receipt.get('verification') or {})
            next_at = timestamp(verification.get('nextCheckAt'))
            if (verification.get('state') != 'waiting' or next_at is None or next_at > self.now()
                    or self.stop_event.is_set()):
                return False
            created = timestamp(receipt.get('createdAt'))
            if (not verification.get('manual') and
                    (self.now() - created >= MAX_AGE_SECONDS
                     or _attempts(verification.get('attempts')) >= MAX_ATTEMPTS)):
                verification.update(state='exhausted', automatic=False, nextCheckAt=None,
                                    message='已达到自动核实的次数或 24 小时时限，请手动核实或到平台查看。')
                self.save_item(receipt_id, {'verification': verification})
                return False
            platform = receipt['platform']
            if not self.acquire(platform, receipt_id):
                return False
            verification.update(state='checking', nextCheckAt=None, lastCheckedAt=iso(self.now()),
                                manual=False,
                                attempts=_attempts(verification.get('attempts')) + 1,
                                message='正在只读核实平台结果，不会再次发布内容。')
            receipt = self.save_item(receipt_id, {'verification': verification})
            if receipt.get('storageWarning'):
                self.release(platform, receipt_id)
                return False
        try:
            try:
                result = self.run_check(receipt, self.stop_event)
            except Exception:
                result = {'outcome': 'unverified', 'message': '本次核实未完成，已保留上次结果。',
                          'evidence': {'readbackOutcome': 'readback_error'}}
            with self.lock:
                latest = self.get_item(receipt_id)
                if latest.get('outcome') not in AWAITING:
                    return True
                current = dict(latest.get('verification') or verification)
                evidence = result.get('evidence') or {}
                matched = evidence.get('matched') is True and evidence.get('readbackOutcome') == 'verified'
                content_id = result.get('contentId') or ''
                if latest.get('contentId') and content_id != latest['contentId']:
                    matched = False
                matched = matched and bool(content_id)
                changes = {}
                if matched:
                    changes = {key: result[key] for key in (
                        'outcome', 'ok', 'state', 'pending', 'message', 'contentId', 'url',
                        'platformStatus', 'evidence') if key in result}
                outcome = changes.get('outcome', latest['outcome'])
                created = timestamp(latest.get('createdAt'))
                exhausted = self.now() - created >= MAX_AGE_SECONDS or _attempts(current.get('attempts')) >= MAX_ATTEMPTS
                restricted = matched and outcome == 'unverified' and result.get('platformStatus') in {
                    'private', 'unlisted', 'self_only', 'friends_only', 'partially_visible', 'partially_invisible'}
                if outcome not in AWAITING:
                    current.update(state='complete', automatic=False, nextCheckAt=None,
                                   message='已完成平台结果核实。')
                elif evidence.get('readbackOutcome') == 'login_required':
                    current.update(state='login_required', automatic=False, nextCheckAt=None,
                                   message='登录已失效，请在账号管理重新登录后手动核实。')
                elif restricted:
                    current.update(state='paused', automatic=False, nextCheckAt=None,
                                   message='作品为有限可见，已停止自动核实；更改可见性后可手动核实。')
                elif exhausted:
                    current.update(state='exhausted', automatic=False, nextCheckAt=None,
                                   message='已达到自动核实的次数或 24 小时时限，请手动核实或到平台查看。')
                elif not current.get('automatic'):
                    current.update(state='paused', nextCheckAt=None,
                                   message='本次核实已结束；自动核实处于暂停状态。')
                else:
                    delay = min(60 * 2 ** min(_attempts(current.get('attempts')), 7), 7200)
                    current.update(state='waiting', nextCheckAt=iso(self.now() + delay),
                                   message=('审核结果尚未确认，将稍后自动核实。' if matched else
                                            '本次未取得可靠结果，保留上次状态并稍后重查。'))
                changes['verification'] = current
                if matched and outcome == 'published':
                    changes['completionPending'] = True
                updated = self.save_item(receipt_id, changes)
                if matched and outcome == 'published':
                    self.on_confirmed(updated)
            return True
        finally:
            self.release(platform, receipt_id)


def run_process(command: list[str], *, cwd: Path, env: dict, stop_event: threading.Event,
                timeout: float = 100) -> subprocess.CompletedProcess:
    """Bounded child process; stop only the process group created by this check."""
    from easel.install_runner import terminate_phase_tree
    flags = (getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0)
             | getattr(subprocess, 'CREATE_NO_WINDOW', 0)) if os.name == 'nt' else 0
    with tempfile.TemporaryFile() as output:
        process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                   stdout=output, stderr=subprocess.DEVNULL,
                                   creationflags=flags, start_new_session=os.name != 'nt')
        deadline = time.monotonic() + timeout
        try:
            while process.poll() is None:
                if stop_event.wait(0.25) or time.monotonic() >= deadline:
                    raise TimeoutError('Verification stopped or timed out')
            output.seek(0, os.SEEK_END)
            output.seek(max(0, output.tell() - 131072))
            return subprocess.CompletedProcess(command, process.returncode,
                                               output.read().decode('utf-8', errors='replace'), '')
        finally:
            if process.poll() is None:
                terminate_phase_tree(process)
                process.wait(timeout=10)


def verification_command(receipt: dict, *, python: str, root: Path, data_dir: Path) -> list[str]:
    """Select only read-only commands, never a publish/upload fallback."""
    platform = receipt.get('platform')
    created = timestamp(receipt.get('createdAt'))
    if platform not in PLATFORMS or created is None:
        raise ValueError('Unsupported receipt verification')
    scripts = root / 'skills/shared/scripts'
    prefix = [python, '-X', 'utf8']
    if platform == 'xiaohongshu':
        command = prefix + [str(scripts / 'xhs_publish.py'), 'verify-publish', '--no-proxy']
    elif platform == 'weixin-channels':
        command = prefix + [str(scripts / 'web_publisher.py'), 'verify-publish', '--platform', platform]
    else:
        command = prefix + [str(scripts / 'verify_publish.py'), '--platform', platform, '--no-proxy']
        if platform == 'bilibili':
            command += ['--cookie', str(data_dir / 'cookies.json')]
    title = receipt.get('title') or ''
    since_ms = int(created * 1000)
    submitted = (receipt.get('evidence') or {}).get('sinceMs')
    if type(submitted) is int and since_ms <= submitted <= int(time.time() * 1000) + 60000:
        since_ms = submitted
    command += ['--since-ms', str(since_ms), '--title', title[:80] if platform == 'bilibili' else title]
    if receipt.get('contentId'):
        command += ['--content-id', receipt['contentId']]
    else:
        finished = timestamp(receipt.get('submissionFinishedAt'))
        if finished is None or int(finished * 1000) < since_ms:
            raise ValueError('Missing submission identity window')
        command += ['--until-ms', str(int(finished * 1000))]
    return command
