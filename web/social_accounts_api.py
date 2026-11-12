"""Explicit local-account routes; no process-wide default profile switching."""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import shutil
import subprocess
import sys
import threading
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from easel.social_accounts import AccountError, SocialStore, PLATFORMS
from easel import publish_receipts


class NewAccount(BaseModel):
    label: str
    platform: str = 'xiaohongshu'


class CancelLogin(BaseModel):
    attemptId: str


class LoginSms(BaseModel):
    attemptId: str
    code: str


class TargetPayload(BaseModel):
    title: str = Field(max_length=300)
    body: str = Field(default='', max_length=20000)
    media: list[str] = Field(default_factory=list, max_length=20)
    tags: str = Field(default='', max_length=600)
    mediaHashes: dict[str, str] = Field(default_factory=dict, max_length=20)


class DistributionTarget(BaseModel):
    accountId: str
    payload: TargetPayload


class DistributionRequest(BaseModel):
    requestKey: str
    confirmed: bool = False
    requests: list[DistributionTarget] = Field(max_length=20)


class SocialAccountService:
    def __init__(self, workspace):
        self.w = workspace
        self.lock = threading.RLock()
        self.processes: dict = {}
        self.stop_event = threading.Event()

    @property
    def store(self):
        return SocialStore(self.w.DATA_DIR / 'social-accounts' / 'registry.sqlite')

    def paths(self, account_id):
        self.store.get(account_id)  # Validate before using any identifier as a path.
        profile = self.w.DATA_DIR / 'social-accounts' / account_id / 'browser-profiles'
        login = self.w.OUTPUTS_DIR / '_login' / 'social-accounts' / account_id
        return profile, login

    def command(self, account_id, operation, *extra):
        profile, _ = self.paths(account_id)
        platform = self.store.get(account_id)['platform']
        script = {'xiaohongshu': 'xhs_publish.py', 'douyin': 'douyin_publish.py',
                  'bilibili': 'bili_login.py', 'wechat-oa': 'weixin_mp_stats.py'}.get(platform, 'web_publisher.py')
        if platform == 'bilibili':
            options = ['--cookie', str(profile.parent / 'cookies.json')]
        else:
            options = ['--profile-base', str(profile), '--no-proxy'] if platform not in {'kuaishou', 'weixin-channels', 'zhihu'} else ['--profile-base', str(profile), '--platform', platform]
        if platform in {'kuaishou', 'weixin-channels', 'zhihu'} and operation == 'login':
            operation = 'login-qr'
        return [sys.executable, '-X', 'utf8', str(self.w.SHARED_SCRIPTS / script), operation, *options, *extra]

    @contextmanager
    def browser_lease(self):
        pool = getattr(self.w.app.state, 'server_pools', {}).get('browser')
        lease = pool.acquire() if pool else None
        try:
            yield
        finally:
            if lease:
                lease.release()

    def execute(self, command, *, receipt_id='', timeout=150, data_root=None):
        env = self.w._publish_env()
        if data_root is not None:
            env['EASEL_DATA_DIR'] = str(data_root)
            env['EASEL_ANALYTICS_MANAGED'] = '1'
        env['EASEL_CALENDAR_AUTORECORD'] = '0'
        if receipt_id:
            env['EASEL_PUBLISH_RECEIPT_ID'] = receipt_id
        return self.w.publish_followup.run_process(command, cwd=self.w.PROJECT_ROOT, env=env,
                                                   stop_event=self.stop_event, timeout=timeout)

    @staticmethod
    def identity(result):
        if result.returncode != 0:
            raise AccountError('在线核验进程失败，原账号记录已保留；请检查浏览器环境。')
        rows = (result.stdout or '').splitlines()
        for line in reversed(rows):
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if isinstance(value, dict) and type(value.get('loggedIn')) is bool:
                if value.get('error'):
                    raise AccountError('在线核验未完成，原身份记录已保留；请检查平台页面或网络后重试。')
                return value
        raise AccountError('未收到可靠的在线账号核验结果。')

    def check(self, account_id):
        with self.browser_lease():
            account = self.store.reserve(account_id, 'check')
            try:
                value = self.identity(self.execute(self.command(account_id, 'whoami')))
            except Exception:
                self.store.finish(account_id, account['generation'], 'check', 'error', '在线核验未完成，未改变已绑定的平台账号。')
                raise AccountError('在线核验未完成，请检查平台页面或网络后重试。') from None
            return self.store.finish(account_id, account['generation'], 'check',
                                     'ready' if value['loggedIn'] else 'login_required',
                                     '在线核验完成。' if value['loggedIn'] else '平台确认该账号未登录。', value)

    def login(self, account_id):
        from easel.runtime_limits import LoginAdmission
        with self.lock:
            existing = self.processes.get(account_id)
            if existing and existing['process'].poll() is None:
                return self.login_status(account_id)
            with LoginAdmission(self.w.app) as admission:
                account = self.store.reserve(account_id, 'login')
                _, directory = self.paths(account_id)
                directory.mkdir(parents=True, exist_ok=True)
                marker = directory / (account['attemptId'] + '.json')
                qr = directory / (account['attemptId'] + '.png')
                cmd = self.command(account_id, 'login', '--qr-out', str(qr), '--status-file', str(marker), '--timeout', '240')
                if account['platform'] == 'douyin':
                    cmd += ['--sms-code-file', str(directory / (account['attemptId'] + '.code'))]
                try:
                    with (directory / (account['attemptId'] + '.log')).open('ab') as output:
                        proc = subprocess.Popen(cmd, cwd=str(self.w.PROJECT_ROOT), env=self.w._proxy_env(),
                            stdout=output, stderr=subprocess.STDOUT, start_new_session=sys.platform != 'win32',
                            creationflags=getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0) | getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                    admission.track(proc)
                    self.processes[account_id] = {'process': proc, 'account': account, 'marker': marker, 'qr': qr}
                    threading.Thread(target=self._watch_login, args=(account_id, proc), daemon=True,
                                     name='easel-account-login').start()
                except Exception:
                    self.store.finish(account_id, account['generation'], 'login', 'error', '登录进程未能启动。')
                    raise AccountError('登录进程未能启动，请检查浏览器环境。', 503) from None
        return self.login_status(account_id)

    def _watch_login(self, account_id, proc):
        try:
            deadline = time.monotonic() + 270
            while not self.stop_event.wait(0.75):
                self.login_status(account_id)
                if proc.poll() is not None:
                    return
                if time.monotonic() >= deadline:
                    self.cancel(account_id, self.store.get(account_id)['attemptId'])
                    return
        except Exception:
            pass  # The next explicit status read can settle the owned attempt.

    def clear_login_code(self, account_id, attempt_id):
        _, directory = self.paths(account_id)
        try:
            (directory / (attempt_id + '.code')).unlink(missing_ok=True)
        except OSError:
            pass

    def login_status(self, account_id):
        with self.lock:
            account = self.store.get(account_id)
            owned = self.processes.get(account_id)
            result = {'accountId': account_id, 'attemptId': account['attemptId'], 'state': account['status'], 'qr': ''}
            if not owned or owned['account']['generation'] != account['generation']:
                return result
            try:
                marker = json.loads(owned['marker'].read_text(encoding='utf-8'))
            except (OSError, ValueError):
                marker = {}
            state = marker.get('state', 'starting') if isinstance(marker, dict) else 'starting'
            proc = owned['process']
            if proc.poll() is not None:
                from easel.runtime_limits import release_login_admission
                release_login_admission(proc)
                status = 'unverified' if proc.returncode == 0 and state == 'success' else 'error'
                message = '登录资料已保存，请点击在线核验确认平台账号。' if status == 'unverified' else '本次登录未完成，请重新连接。'
                account = self.store.finish(account_id, account['generation'], 'login', status, message)
                self.processes.pop(account_id, None)
                self.clear_login_code(account_id, account['attemptId'])
                return {**result, 'state': account['status'], 'message': message}
            allowed = {'starting', 'qr_ready', 'scanned', 'verifying', 'sms_required'}
            result['state'] = state if state in allowed else 'verifying'
            self.store.progress(account_id, account['generation'], result['state'])
            if state in {'qr_ready', 'scanned'} and owned['qr'].is_file():
                result['qr'] = owned['qr'].relative_to(self.w.OUTPUTS_DIR).as_posix()
                if marker.get('qrKind') in {'qr', 'page'}:
                    result['qrKind'] = marker['qrKind']
            return result

    def cancel(self, account_id, attempt_id):
        from easel.install_runner import terminate_phase_tree
        with self.lock:
            account = self.store.get(account_id)
            if account['attemptId'] != attempt_id:
                raise AccountError('登录尝试已变化，未取消其他登录。')
            owned = self.processes.get(account_id)
            if owned:
                proc = owned['process']
                if proc.poll() is None:
                    terminate_phase_tree(proc)
                    proc.wait(timeout=10)
                from easel.runtime_limits import release_login_admission
                release_login_admission(proc)
                self.processes.pop(account_id, None)
            self.clear_login_code(account_id, attempt_id)
            return self.store.cancel(account_id, attempt_id)

    def logout(self, account_id):
        with self.lock:
            account = self.store.reserve(account_id, 'logout')
            profile, _ = self.paths(account_id)
            root = (self.w.DATA_DIR / 'social-accounts' / account_id).resolve()
            if not profile.resolve().is_relative_to(root):
                raise AccountError('登录资料路径异常，退出未执行。')
            try:
                if profile.exists():
                    shutil.rmtree(profile)
                (root / 'cookies.json').unlink(missing_ok=True)
            except OSError:
                self.store.finish(account_id, account['generation'], 'logout', 'error', '登录资料仍被占用，退出未完成。')
                raise AccountError('登录资料仍被占用，退出未完成。') from None
            return self.store.finish(account_id, account['generation'], 'logout', 'logged_out', '该账号已退出，身份及登录历史保留。')

    def sms(self, account_id, attempt_id, code):
        account = self.store.get(account_id)
        login = self.login_status(account_id)
        if account['platform'] != 'douyin' or account['attemptId'] != attempt_id or login['state'] != 'sms_required':
            raise AccountError('对应账号的登录验证任务已变化。')
        if not code.isascii() or not code.isdigit() or not 4 <= len(code) <= 8:
            raise AccountError('验证码需为 4–8 位数字。', 400)
        _, directory = self.paths(account_id)
        (directory / (attempt_id + '.code')).write_text(code, encoding='utf-8')
        return {'ok': True}

    def validate_payload(self, account, payload):
        platform = account['platform']
        media = self.w._check_publish_request(platform, self.w.LOGIN_RUNNERS[platform], payload, account_scoped=True)
        images, videos, _preparation = media
        if len(images) + len(videos) != len(payload.media):
            raise AccountError('素材包含不支持的文件类型，请核对确认稿。', 400)
        limits = {'xiaohongshu': 20, 'douyin': 55, 'kuaishou': 30, 'bilibili': 80, 'wechat-oa': 64}
        if not payload.title.strip() or len(payload.title) > limits.get(platform, 300):
            raise AccountError(f"请核对 {account['label']} 的标题长度。", 400)
        body_limits = {'xiaohongshu': 1000, 'douyin': 55, 'kuaishou': 1000,
                       'weixin-channels': 1000, 'zhihu': 5000, 'bilibili': 2000, 'wechat-oa': 20000}
        if len(payload.body) > body_limits[platform]:
            raise AccountError(f"{account['label']} 的正文最多 {body_limits[platform]} 字，请修改后重新确认。", 400)
        if platform in {'bilibili', 'douyin', 'weixin-channels'} and len(videos) != 1:
            raise AccountError('该平台每次仅接收一个视频。', 400)
        if platform == 'kuaishou' and len(images) + len(videos) != 1:
            raise AccountError('当前快手执行器每次支持一个图片或视频，请勿选择多份素材。', 400)
        if platform == 'zhihu' and payload.media:
            raise AccountError('当前知乎执行器仅支持文字文章，请将所需内容写入正文。', 400)
        return images, videos

    def media_hashes(self, payload):
        hashes = {}
        try:
            for source in payload.media:
                digest = hashlib.sha256()
                with self.w._safe_output_path(source).open('rb') as handle:
                    for block in iter(lambda: handle.read(1024 * 1024), b''):
                        digest.update(block)
                hashes[source] = digest.hexdigest()
        except OSError:
            raise AccountError('确认稿素材无法读取，未交给平台。', 400) from None
        return hashes

    def publish_command(self, job):
        platform, payload = job['platform'], TargetPayload(**job['payload'])
        account = self.store.get(job['accountId'])
        images, videos = self.validate_payload(account, payload)
        if 'mediaHashes' in job and self.media_hashes(payload) != job['mediaHashes']:
            raise AccountError('素材与原确认稿不同，已停止该账号任务，请重新确认内容。', 400)
        self.w.PUBLISH_DIR.mkdir(parents=True, exist_ok=True)
        status = self.w.PUBLISH_DIR / (job['receiptId'] + '.status.json')
        code = self.w.PUBLISH_DIR / (job['receiptId'] + '.code')
        cmd = self.w._build_publish_command(platform, self.w.LOGIN_RUNNERS[platform], payload.title,
            payload.body, payload.tags, images, videos, job['receiptId'], status, code)
        profile, _ = self.paths(job['accountId'])
        if platform == 'bilibili':
            cmd[cmd.index('--cookie') + 1] = str(profile.parent / 'cookies.json')
        else:
            cmd += ['--profile-base', str(profile)]
        return cmd + ['--expected-account-id', job['externalAccountId']]

    def submit(self, req):
        if not req.confirmed:
            raise AccountError('请先确认每个账号的标题、正文和素材。', 400)
        requests = [{'accountId': target.accountId, 'payload': target.payload.model_dump()} for target in req.requests]
        existing = self.store.existing_request(requests, req.requestKey)
        if existing:
            return existing  # A replay must not depend on now-expired login or media.
        media_hashes = {}
        for target in req.requests:
            account = self.store.get(target.accountId)
            self.validate_payload(account, target.payload)
            hashes = self.media_hashes(target.payload)
            if target.payload.mediaHashes and target.payload.mediaHashes != hashes:
                raise AccountError('素材已变化，不能按原确认稿重试；请重新确认内容。', 400)
            media_hashes[target.accountId] = hashes
        batch, created = self.store.admit(requests, req.requestKey, media_hashes)
        if created:
            for job in batch['jobs']:
                try:
                    receipt = self.w._publish_receipt_store().create(job['receiptId'], job['platform'],
                        job['payload']['title'], account_id=job['accountId'])
                    self.w._publish_receipt_store().update(receipt['receiptId'], {
                        'accountLabel': job['accountLabel'], 'externalAccountId': job['externalAccountId'],
                        'batchId': batch['batchId'], 'state': 'starting',
                        'verification': {'state': 'unsupported', 'automatic': False},
                        'message': '目标账号和内容已封存，等待串行执行。'})
                except Exception:
                    self.finish_job(job, 'failed', '回执未能保存，内容未交给平台。')
            try:
                threading.Thread(target=self.run_batch, args=(batch['batchId'],), daemon=True,
                                 name='easel-account-distribution').start()
            except Exception:
                for job in self.store.batch(batch['batchId'])['jobs']:
                    if job['state'] == 'queued':
                        self.finish_job(job, 'failed', '任务未能启动，内容未交给平台。')
                raise AccountError('分发执行器未能启动。', 503) from None
        return self.store.batch(batch['batchId'])

    def publish_sms(self, receipt, code):
        job = self.store.job_for_receipt(receipt['receiptId'])
        if not job or job['state'] != 'running' or receipt['platform'] != 'douyin' or receipt.get('state') != 'sms_required':
            raise AccountError('对应账号的发布验证任务已结束或已变化。')
        if not code.isascii() or not code.isdigit() or not 4 <= len(code) <= 8:
            raise AccountError('验证码需为 4–8 位数字。', 400)
        path = self.w.PUBLISH_DIR / (receipt['receiptId'] + '.code')
        if path.is_symlink():
            raise AccountError('验证资料路径异常。', 503)
        path.write_text(code, encoding='utf-8')
        return {'ok': True, 'receiptId': receipt['receiptId']}

    def finish_job(self, job, outcome, message, result=None):
        result = result or {'state': 'finished', 'outcome': outcome, 'ok': outcome == 'published',
                            'pending': False, 'message': message}
        try:
            self.w._publish_receipt_store().update(job['receiptId'], result)
        except Exception:
            # The SQLite ledger remains the authoritative recovery surface if
            # the shared receipt JSON cannot be saved. Never resend a runner.
            message += ' 发布回执同步失败，请以账号分发批次记录为准。'
        finally:
            self.store.set_job(job['jobId'], 'finished', outcome, message)
            try:
                (self.w.PUBLISH_DIR / (job['receiptId'] + '.code')).unlink(missing_ok=True)
            except OSError:
                pass  # Cleanup failure must not leave a completed job running.

    def run_batch(self, batch_id):
        for job in self.store.batch(batch_id)['jobs']:
            if not self.store.claim_job(job['jobId']):
                continue
            submitted = False
            try:
                with self.w._PUBLISH_WRITER_LOCK, self.browser_lease():
                    account = self.store.get(job['accountId'])
                    if account['generation'] != job['generation'] or account['externalAccountId'] != job['externalAccountId']:
                        raise AccountError('账号身份已变化，本任务未提交。')
                    identity = self.identity(self.execute(self.command(job['accountId'], 'whoami')))
                    if identity.get('loggedIn') is not True or identity.get('externalAccountId') != job['externalAccountId']:
                        self.store.finish(job['accountId'], job['generation'], 'publish_check',
                            'identity_changed' if identity.get('loggedIn') else 'login_required', '分发前身份核验不通过，内容未提交。')
                        raise AccountError('分发前身份核验不通过，内容未提交。')
                    cmd = self.publish_command(job)
                    submitted = True
                    run = self.execute(cmd, receipt_id=job['receiptId'], timeout=900)
                    result = publish_receipts.parse_result(job['platform'], job['receiptId'], run.stdout, run.returncode)
                    if result['outcome'] == 'failed' and not result.get('evidence'):
                        result.update(outcome='unverified', message='执行器未返回可靠回执，请先核对目标账号作品，避免重复发布。')
                    result['submissionFinishedAt'] = publish_receipts._now()
                    result['verification'] = {'state': 'unsupported' if job['platform'] in {'zhihu', 'wechat-oa'} else 'paused', 'automatic': False, 'attempts': 0,
                        'message': '使用本次目标账号手动核实；不会重新上传或发布。'}
                    self.finish_job(job, result['outcome'], result['message'], result)
            except Exception as exc:
                # An exception after starting the runner is not proof that the
                # platform did not accept the note. Never retry it automatically.
                outcome = 'unverified' if submitted else 'failed'
                message = '发布结果未知，请先核对该账号作品，避免重复发布。' if submitted else '提交前检查未通过，内容未交给平台；请核对该账号状态。'
                if not submitted and isinstance(exc, AccountError):
                    message = str(exc)
                try:
                    self.finish_job(job, outcome, message)
                except Exception:
                    self.store.set_job(job['jobId'], 'finished', outcome, message)

    def verify(self, receipt):
        """Read existing works using the receipt's explicit profile and identity."""
        from datetime import datetime
        account_id = receipt['accountId']
        if receipt['platform'] in {'zhihu', 'wechat-oa'}:
            raise AccountError('该平台暂不支持只读结果核实，请在对应账号后台查看作品或草稿。')
        if receipt.get('outcome') not in {'submitted', 'unverified'}:
            raise AccountError('该回执当前无需核实。')
        if not receipt.get('contentId') and not receipt.get('submissionFinishedAt'):
            raise AccountError('缺少可靠提交时间窗，请直接核对该账号作品，避免误关联。')
        with self.w._PUBLISH_WRITER_LOCK, self.browser_lease():
            account = self.store.reserve(account_id, 'check')
            status, identity = 'error', None
            try:
                value = self.identity(self.execute(self.command(account_id, 'whoami')))
                identity = value
                status = 'ready' if value['loggedIn'] else 'login_required'
                if (not value['loggedIn'] or value.get('externalAccountId') != receipt.get('externalAccountId')
                        or account['externalAccountId'] != receipt.get('externalAccountId')):
                    if value['loggedIn']:
                        status = 'identity_changed'
                    raise AccountError('回执所属平台身份尚未通过核验。')
                args = ['--title', receipt['title'], '--since-ms', str(int(datetime.fromisoformat(receipt['createdAt'].replace('Z', '+00:00')).timestamp() * 1000)),
                        '--expected-account-id', receipt['externalAccountId']]
                if receipt.get('contentId'):
                    args += ['--content-id', receipt['contentId']]
                if receipt.get('submissionFinishedAt'):
                    args += ['--until-ms', str(int(datetime.fromisoformat(receipt['submissionFinishedAt'].replace('Z', '+00:00')).timestamp() * 1000))]
                if receipt['platform'] in {'xiaohongshu', 'weixin-channels'}:
                    command = self.command(account_id, 'verify-publish', *args)
                    if receipt['platform'] == 'weixin-channels':
                        command += ['--no-proxy']
                else:
                    profile, _ = self.paths(account_id)
                    command = [sys.executable, str(self.w.SHARED_SCRIPTS / 'verify_publish.py'), '--platform', receipt['platform'],
                        '--profile-base', str(profile), '--cookie', str(profile.parent / 'cookies.json'), '--no-proxy', *args]
                run = self.execute(command, receipt_id=receipt['receiptId'])
                result = publish_receipts.parse_result(receipt['platform'], receipt['receiptId'], run.stdout, run.returncode)
                result['verification'] = {'state': 'paused', 'automatic': False, 'attempts': 1,
                    'lastCheckedAt': publish_receipts._now(), 'message': '本次只读核实完成，可稍后再次手动核实。'}
                return self.w._publish_receipt_store().update(receipt['receiptId'], result)
            except AccountError:
                raise
            except Exception:
                status = 'error'
                raise AccountError('核实未完成，原发布结果保留。') from None
            finally:
                self.store.finish(account_id, account['generation'], 'check', status, '作品只读核实结束，原发布记录保留。', identity)

    def shutdown(self):
        self.stop_event.set()
        for account_id, owned in list(self.processes.items()):
            try:
                self.cancel(account_id, owned['account']['attemptId'])
            except Exception:
                pass

    def startup(self):
        self.stop_event.clear()
        for job in self.store.recover():
            self.finish_job(job, 'unverified', '服务重启，任务未继续提交；请先核对对应账号的作品结果，避免重复发布。')

    def router(self):
        router = APIRouter(prefix='/api/social-accounts')
        from social_account_analysis import AccountAnalysis
        analysis = AccountAnalysis(self)

        def guarded(call, *args):
            try:
                return call(*args)
            except AccountError as exc:
                raise HTTPException(exc.status_code, str(exc)) from None

        @router.get('')
        def accounts():
            return guarded(self.store.list)

        @router.post('')
        def create(req: NewAccount):
            return guarded(self.store.create, req.label, req.platform)

        @router.get('/platforms')
        def platforms():
            return [{'platform': platform, 'name': self.w.LOGIN_RUNNERS[platform]['name'],
                     'publishMode': 'draft' if platform == 'wechat-oa' else 'publish',
                     'readOnlyVerification': platform not in {'zhihu', 'wechat-oa'}} for platform in sorted(PLATFORMS)]

        @router.get('/batches')
        def batches():
            return guarded(self.store.batches)

        @router.get('/default-history')
        def default_history():
            return guarded(self.store.default_history)

        @router.post('/batches')
        def submit(req: DistributionRequest):
            self.w._require_automated_publishing()
            return guarded(self.submit, req)

        @router.get('/batches/{batch_id}')
        def batch(batch_id: str):
            return guarded(self.store.batch, batch_id)

        @router.get('/{account_id}/history')
        def history(account_id: str):
            return guarded(self.store.history, account_id)

        @router.get('/{account_id}/analysis')
        def account_analysis(account_id: str):
            return guarded(analysis.read, account_id)

        @router.post('/{account_id}/analysis')
        def collect_analysis(account_id: str):
            return guarded(analysis.collect, account_id)

        @router.post('/{account_id}/login')
        def login(account_id: str):
            return guarded(self.login, account_id)

        @router.get('/{account_id}/login')
        def login_status(account_id: str):
            return guarded(self.login_status, account_id)

        @router.post('/{account_id}/cancel')
        def cancel(account_id: str, req: CancelLogin):
            return guarded(self.cancel, account_id, req.attemptId)

        @router.post('/{account_id}/sms')
        def sms(account_id: str, req: LoginSms):
            return guarded(self.sms, account_id, req.attemptId, req.code)

        @router.post('/{account_id}/check')
        def check(account_id: str):
            return guarded(self.check, account_id)

        @router.post('/{account_id}/logout')
        def logout(account_id: str):
            return guarded(self.logout, account_id)

        return router
