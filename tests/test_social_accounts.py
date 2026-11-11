"""Multi-platform, multi-account contracts with isolated storage and runners.

No real platform network, QR login, upload or SMTP is used by this suite.
"""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('_social_fixture', ROOT / 'tests/test_account_lifecycle.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
isolated, web = fixture.isolated, fixture.web

from easel.social_accounts import AccountError, SocialStore, PLATFORMS
from social_accounts_api import SocialAccountService, DistributionRequest
import publish_account_identity as account_identity
import xhs_publish


def ready(store, label='A', platform='xiaohongshu', external=None):
    row = store.create(label, platform)
    reservation = store.reserve(row['accountId'], 'check')
    return store.finish(row['accountId'], reservation['generation'], 'check', 'ready', '模拟核验',
                        {'externalAccountId': external or ('a' * 24 if platform == 'xiaohongshu' else '12345'), 'name': label})


def target(account, media=None):
    return {'accountId': account['accountId'], 'payload': {'title': '确认稿', 'body': '正文',
            'media': list(media or []), 'tags': ''}}


@pytest.fixture
def service(isolated, monkeypatch):
    service = SocialAccountService(web)
    monkeypatch.setattr(service, 'run_batch', lambda _id: None)
    web.OUTPUTS_DIR.mkdir(exist_ok=True)
    (web.OUTPUTS_DIR / 'cover.png').write_bytes(b'fake image')
    (web.OUTPUTS_DIR / 'video.mp4').write_bytes(b'fake video')
    return service


@pytest.mark.parametrize('platform', sorted(PLATFORMS))
def test_each_platform_supports_two_isolated_accounts_and_persistent_events(tmp_path, platform):
    store = SocialStore(tmp_path / 'accounts.sqlite')
    first = ready(store, 'A', platform)
    second = ready(store, 'B', platform, 'b' * 24 if platform == 'xiaohongshu' else '67890')
    assert first['accountId'] != second['accountId']
    assert {a['status'] for a in store.list()} == {'ready'}
    reloaded = SocialStore(store.path)
    assert len(reloaded.history(first['accountId'])) == 3
    attempt = reloaded.reserve(first['accountId'], 'logout')
    reloaded.finish(first['accountId'], attempt['generation'], 'logout', 'logged_out', '已退出')
    assert reloaded.get(second['accountId'])['status'] == 'ready'
    assert reloaded.history(first['accountId'])[0]['action'] == 'logout'


def test_identity_binding_is_per_platform_and_cannot_be_silently_replaced(tmp_path):
    store = SocialStore(tmp_path / 'accounts.sqlite')
    first = ready(store, 'same', 'douyin', '123')
    assert ready(store, 'same', 'bilibili', '123')['status'] == 'ready'
    duplicate = ready(store, 'duplicate', 'douyin', '123')
    assert duplicate['status'] == 'identity_changed'
    current = store.reserve(first['accountId'], 'check')
    changed = store.finish(first['accountId'], current['generation'], 'check', 'ready', '核验', {'externalAccountId': '999'})
    assert changed['status'] == 'identity_changed' and changed['externalAccountId'] == '123'
    assert store.finish(first['accountId'], current['generation'], 'check', 'ready', '核验', {})['status'] == 'unverified'


def test_cancel_generation_discards_late_reply_and_never_cancels_new_attempt(tmp_path):
    store = SocialStore(tmp_path / 'accounts.sqlite')
    account = store.create('A')
    old = store.reserve(account['accountId'], 'login')
    store.cancel(account['accountId'], old['attemptId'])
    new = store.reserve(account['accountId'], 'login')
    with pytest.raises(AccountError):
        store.finish(account['accountId'], old['generation'], 'login', 'ready', 'late', {'externalAccountId': 'a' * 24})
    with pytest.raises(AccountError):
        store.cancel(account['accountId'], old['attemptId'])
    assert store.get(account['accountId'])['attemptId'] == new['attemptId']


def test_admission_is_atomic_idempotent_and_busy_accounts_are_reserved(tmp_path):
    store = SocialStore(tmp_path / 'accounts.sqlite')
    account = ready(store)
    requests, key = [target(account)], uuid.uuid4().hex
    batch, created = store.admit(requests, key)
    assert created and store.admit(requests, key)[1] is False
    for action in ('login', 'check', 'logout'):
        with pytest.raises(AccountError):
            store.reserve(account['accountId'], action)
    with pytest.raises(AccountError):
        store.admit([target(account), target(account)], uuid.uuid4().hex)
    changed = [target(account)]; changed[0]['payload']['title'] = '另一稿'
    with pytest.raises(AccountError):
        store.admit(changed, key)
    job_id = batch['jobs'][0]['jobId']
    with ThreadPoolExecutor(6) as executor:
        assert list(executor.map(store.claim_job, [job_id] * 6)).count(True) == 1
    store.set_job(job_id, 'finished', 'unverified')
    assert not store.claim_job(job_id)
    store.set_job(job_id, 'running')
    assert store.batch(batch['batchId'])['jobs'][0]['state'] == 'finished'


def test_recovery_retains_audit_and_never_resubmits_unknown_jobs(tmp_path):
    store = SocialStore(tmp_path / 'accounts.sqlite')
    a = ready(store)
    b = store.create('B')
    store.reserve(b['accountId'], 'login')
    batch, _ = store.admit([target(a)], uuid.uuid4().hex)
    store.recover()
    assert store.batch(batch['batchId'])['jobs'][0]['outcome'] == 'unverified'
    assert store.get(b['accountId'])['status'] == 'unverified'
    assert store.history(b['accountId'])[0]['action'] == 'interrupted'


@pytest.mark.parametrize('platform', sorted(PLATFORMS))
def test_commands_cannot_borrow_default_account_paths(service, platform, monkeypatch):
    account = ready(service.store, 'A', platform)
    identifier = account['accountId']
    for action in ('whoami', 'login'):
        command = service.command(identifier, action)
        option = '--cookie' if platform == 'bilibili' else '--profile-base'
        assert identifier in command[command.index(option) + 1]
        assert (platform == 'bilibili') == command[3].endswith('bili_login.py')
    media = [] if platform == 'zhihu' else ['video.mp4'] if platform in {'douyin', 'bilibili', 'weixin-channels'} else ['cover.png']
    job = {'platform': platform, 'accountId': identifier, 'externalAccountId': account['externalAccountId'],
           'payload': target(account, media)['payload'], 'receiptId': uuid.uuid4().hex}
    # The local converter is replaced; no platform interaction is permitted.
    if platform == 'wechat-oa':
        original = web._build_publish_command
        def build(*args):
            return ['python', 'weixin_mp_stats.py', 'publish', '--html', 'isolated.html']
        monkeypatch.setattr(web, '_build_publish_command', build)
    command = service.publish_command(job)
    option = '--cookie' if platform == 'bilibili' else '--profile-base'
    assert identifier in command[command.index(option) + 1]
    assert command[command.index('--expected-account-id') + 1] == account['externalAccountId']
    if platform == 'wechat-oa':
        monkeypatch.setattr(web, '_build_publish_command', original)


@pytest.mark.parametrize('platform,limit', [('xiaohongshu', 1000), ('douyin', 55), ('kuaishou', 1000),
    ('weixin-channels', 1000), ('zhihu', 5000), ('bilibili', 2000), ('wechat-oa', 20000)])
def test_account_body_limit_rejects_before_admission_without_truncating(service, platform, limit):
    account = ready(service.store, '长度检查', platform)
    media = [] if platform == 'zhihu' else ['video.mp4'] if platform in {'douyin', 'bilibili', 'weixin-channels'} else ['cover.png']
    item = target(account, media)
    item['payload']['body'] = '字' * limit
    from social_accounts_api import TargetPayload
    service.validate_payload(account, TargetPayload(**item['payload']))
    item['payload']['body'] += '字'
    if platform == 'wechat-oa':
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            DistributionRequest(requestKey=uuid.uuid4().hex, confirmed=True, requests=[item])
    else:
        with pytest.raises(AccountError, match='正文最多'):
            service.submit(DistributionRequest(requestKey=uuid.uuid4().hex, confirmed=True, requests=[item]))
    assert service.store.batches() == []
    assert not service.store.list()[0]['busy']


def test_http_distribution_runs_seven_platforms_and_two_same_platform_accounts(service, monkeypatch):
    accounts = [ready(service.store, platform, platform) for platform in sorted(PLATFORMS)]
    accounts.append(ready(service.store, '小红书第二号', 'xiaohongshu', 'b' * 24))
    requests = [target(account, [] if account['platform'] == 'zhihu' else ['video.mp4']
        if account['platform'] in {'douyin', 'bilibili', 'weixin-channels'} else ['cover.png']) for account in accounts]
    expected = {account['accountId']: account for account in accounts}
    commands = []
    original_build = web._build_publish_command
    def build(platform, *args):
        if platform == 'wechat-oa':
            return ['python', 'weixin_mp_stats.py', 'publish', '--html', 'isolated.html']
        return original_build(platform, *args)
    monkeypatch.setattr(web, '_build_publish_command', build)
    def execute(command, **kwargs):
        identifier = next(key for key in expected if key in ' '.join(command))
        account = expected[identifier]
        if 'whoami' in command:
            return SimpleNamespace(returncode=0, stdout=json.dumps({'loggedIn': True, 'externalAccountId': account['externalAccountId']}))
        assert command[command.index('--expected-account-id') + 1] == account['externalAccountId']
        commands.append((identifier, command))
        return SimpleNamespace(returncode=0, stdout='EASEL_PUBLISH_RECEIPT=' + json.dumps({
            'schemaVersion': 1, 'receiptId': kwargs['receipt_id'], 'platform': account['platform'],
            'outcome': 'draft' if account['platform'] == 'wechat-oa' else 'submitted', 'message': '隔离执行器回执'}))
    monkeypatch.setattr(service, 'execute', execute)
    app = FastAPI(); app.include_router(service.router()); client = TestClient(app)
    envelope = {'requestKey': uuid.uuid4().hex, 'confirmed': True, 'requests': requests}
    response = client.post('/api/social-accounts/batches', json=envelope)
    assert response.status_code == 200
    batch_id = response.json()['batchId']
    SocialAccountService.run_batch(service, batch_id)
    SocialAccountService.run_batch(service, batch_id)
    current = client.get('/api/social-accounts/batches/' + batch_id).json()
    assert current['state'] == 'finished' and len(current['jobs']) == len(commands) == 8
    assert len({identifier for identifier, _ in commands}) == 8
    for job in current['jobs']:
        assert job['outcome'] == ('draft' if job['platform'] == 'wechat-oa' else 'submitted')
        receipt = web._get_publish_receipt(job['receiptId'])
        assert receipt['accountId'] == job['accountId']
        assert receipt['externalAccountId'] == expected[job['accountId']]['externalAccountId']
    assert client.post('/api/social-accounts/batches', json=envelope).json()['batchId'] == batch_id
    assert len(commands) == 8


def test_batch_failure_does_not_block_other_account_and_worker_replay_does_not_publish_twice(service, monkeypatch):
    a = ready(service.store, 'A')
    b = ready(service.store, 'B', 'bilibili', '67890')
    request = DistributionRequest(requestKey=uuid.uuid4().hex, confirmed=True,
        requests=[target(a, ['cover.png']), target(b, ['video.mp4'])])
    batch = service.submit(request)
    calls = []
    def execute(command, **kwargs):
        if 'whoami' in command:
            owner = a if a['accountId'] in ' '.join(command) else b
            identity = owner['externalAccountId'] if owner is b else 'c' * 24
            return SimpleNamespace(returncode=0, stdout=json.dumps({'loggedIn': True, 'externalAccountId': identity}))
        calls.append(command)
        return SimpleNamespace(returncode=0, stdout='EASEL_PUBLISH_RECEIPT=' + json.dumps({
            'schemaVersion': 1, 'receiptId': kwargs['receipt_id'], 'platform': 'bilibili', 'outcome': 'submitted', 'message': '模拟提交'}))
    monkeypatch.setattr(service, 'execute', execute)
    SocialAccountService.run_batch(service, batch['batchId'])
    SocialAccountService.run_batch(service, batch['batchId'])
    final = service.store.batch(batch['batchId'])
    assert [job['outcome'] for job in final['jobs']] == ['failed', 'submitted']
    assert len(calls) == 1 and b['accountId'] in ' '.join(calls[0])
    assert service.store.get(a['accountId'])['status'] == 'identity_changed'
    # Replaying an already admitted request ignores newly missing media.
    (web.OUTPUTS_DIR / 'cover.png').unlink()
    assert service.submit(request)['batchId'] == batch['batchId']
    assert all(web._get_publish_receipt(j['receiptId'])['accountId'] == j['accountId'] for j in final['jobs'])


def test_process_failure_after_start_is_unknown_not_retryable(service, monkeypatch):
    account = ready(service.store)
    batch = service.submit(DistributionRequest(requestKey=uuid.uuid4().hex, confirmed=True, requests=[target(account, ['cover.png'])]))
    monkeypatch.setattr(service, 'execute', lambda cmd, **kw: SimpleNamespace(returncode=0,
        stdout=json.dumps({'loggedIn': True, 'externalAccountId': account['externalAccountId']}))
        if 'whoami' in cmd else SimpleNamespace(returncode=1, stdout='crash without receipt'))
    SocialAccountService.run_batch(service, batch['batchId'])
    assert service.store.batch(batch['batchId'])['jobs'][0]['outcome'] == 'unverified'


def test_logout_clears_only_owned_profiles_and_cookie_and_retains_history(service):
    a, b = ready(service.store, 'A', 'bilibili', '1'), ready(service.store, 'B', 'bilibili', '2')
    for account in (a, b):
        profile, _ = service.paths(account['accountId'])
        profile.mkdir(parents=True)
        (profile / 'marker').write_text('not a real session')
        (profile.parent / 'cookies.json').write_text('{}')
    service.logout(a['accountId'])
    assert not service.paths(a['accountId'])[0].exists()
    assert service.paths(b['accountId'])[0].exists()
    assert service.store.history(a['accountId'])[0]['state'] == 'logged_out'


def test_default_history_is_controlled_persistent_and_deduplicated(service):
    store = service.store
    store.default_event('douyin', 'a' * 32, 'login', 'qr_ready')
    store.default_event('douyin', 'a' * 32, 'login', 'qr_ready')
    store.default_event('douyin', 'a' * 32, 'login', 'arbitrary secret')
    assert len(SocialStore(store.path).default_history()) == 1
    assert 'secret' not in json.dumps(store.default_history())


def test_legacy_default_verifier_cannot_pick_account_scoped_receipts(service):
    a = ready(service.store)
    batch = service.submit(DistributionRequest(requestKey=uuid.uuid4().hex, confirmed=True, requests=[target(a, ['cover.png'])]))
    identifier = batch['jobs'][0]['receiptId']
    web._publish_receipt_store().update(identifier, {'outcome': 'unverified', 'state': 'finished'})
    assert not web._publish_receipt_store().awaiting_verification()
    assert web._read_publish_status('xiaohongshu')['state'] == 'unknown'
    with pytest.raises(web.HTTPException):
        asyncio.run(web.api_set_publish_verification(identifier, web.PublishVerificationRequest(automatic=True)))


@pytest.mark.parametrize('href,expected', [('/user/profile/' + 'a' * 24, 'a' * 24),
    ('https://evil.test/user/profile/' + 'a' * 24, ''), ('/user/profile/short', ''), ('javascript:alert(1)', '')])
def test_xhs_identity_is_only_own_official_link(href, expected):
    assert xhs_publish.own_account_id(href) == expected


def test_guard_closes_temporary_page_and_blocks_changed_identity(monkeypatch):
    closed = []
    page = SimpleNamespace(close=lambda: closed.append(True))
    context = SimpleNamespace(new_page=lambda: page)
    monkeypatch.setattr(account_identity, 'page_identity', lambda platform, p: {'externalAccountId': 'different'})
    with pytest.raises(RuntimeError):
        account_identity.require_context(context, 'douyin', 'expected')
    assert closed == [True]


def test_real_http_routes_cover_seven_platforms_and_reject_ambiguous_requests(service, monkeypatch):
    app = FastAPI()
    app.include_router(service.router())
    client = TestClient(app)
    accounts = []
    for platform in sorted(PLATFORMS):
        for label in ('A', 'B'):
            response = client.post('/api/social-accounts', json={'platform': platform, 'label': label})
            assert response.status_code == 200
            account = response.json()
            accounts.append(account)
            assert account['status'] == 'logged_out'
            assert client.get(f"/api/social-accounts/{account['accountId']}/history").json()[0]['action'] == 'create'
    assert len(client.get('/api/social-accounts').json()) == 14
    assert len(client.get('/api/social-accounts/platforms').json()) == 7
    assert client.post('/api/social-accounts', json={'platform': 'unknown', 'label': 'X'}).status_code == 400
    assert client.post('/api/social-accounts/batches', json={'requestKey': uuid.uuid4().hex, 'requests': []}).status_code == 400
    assert client.get('/api/social-accounts/not-an-id/history').status_code == 404
    account = accounts[0]
    monkeypatch.setattr(service, 'execute', lambda *_a, **_k: SimpleNamespace(returncode=0,
        stdout=json.dumps({'loggedIn': True, 'externalAccountId': '12345', 'name': '模拟身份'})))
    response = client.post(f"/api/social-accounts/{account['accountId']}/check")
    assert response.status_code == 200 and response.json()['status'] == 'ready'
    assert 'profile' not in json.dumps(client.get('/api/social-accounts').json())


def test_login_attempt_files_qr_cancel_and_sms_never_cross_account_scope(service, monkeypatch):
    import social_accounts_api as api
    import easel.install_runner
    import easel.runtime_limits
    calls = []
    class Process:
        returncode = None
        def poll(self): return self.returncode
        def wait(self, timeout=0): self.returncode = -1; return -1
    def popen(command, **kwargs):
        calls.append(command)
        return Process()
    monkeypatch.setattr(api.subprocess, 'Popen', popen)
    monkeypatch.setattr(api.threading.Thread, 'start', lambda self: None)
    monkeypatch.setattr(easel.install_runner, 'terminate_phase_tree', lambda proc: setattr(proc, 'returncode', -1))
    monkeypatch.setattr(easel.runtime_limits, 'release_login_admission', lambda proc: None)
    a, b = service.store.create('A', 'douyin'), service.store.create('B', 'douyin')
    login_a, login_b = service.login(a['accountId']), service.login(b['accountId'])
    assert login_a['attemptId'] != login_b['attemptId']
    for account, login in ((a, login_a), (b, login_b)):
        owned = service.processes[account['accountId']]
        owned['marker'].write_text(json.dumps({'state': 'qr_ready', 'qrKind': 'page'}))
        owned['qr'].write_bytes(b'synthetic-qr')
        progress = service.login_status(account['accountId'])
        assert account['accountId'] in progress['qr'] and login['attemptId'] in progress['qr']
        assert progress['qrKind'] == 'page'
    with pytest.raises(AccountError):
        service.cancel(a['accountId'], login_b['attemptId'])
    with pytest.raises(AccountError):
        service.sms(a['accountId'], login_b['attemptId'], '123456')
    service.processes[a['accountId']]['marker'].write_text(json.dumps({'state': 'sms_required'}))
    service.sms(a['accountId'], login_a['attemptId'], '123456')
    assert not (service.paths(b['accountId'])[1] / (login_b['attemptId'] + '.code')).exists()
    service.cancel(a['accountId'], login_a['attemptId'])
    assert not (service.paths(a['accountId'])[1] / (login_a['attemptId'] + '.code')).exists()
    assert service.login_status(b['accountId'])['state'] == 'qr_ready'
    assert all(a['accountId'] in arg or b['accountId'] in arg for command in calls for arg in command if arg.endswith(('.json', '.png', '.code')))


def test_receipt_failure_and_locked_code_cleanup_still_settle_durable_job(service, monkeypatch):
    account = ready(service.store)
    batch = service.submit(DistributionRequest(requestKey=uuid.uuid4().hex, confirmed=True, requests=[target(account, ['cover.png'])]))
    job = batch['jobs'][0]
    monkeypatch.setattr(web, '_publish_receipt_store', lambda: SimpleNamespace(update=lambda *_a: (_ for _ in ()).throw(OSError('simulated disk failure'))))
    original = Path.unlink
    def unlink(path, *args, **kwargs):
        if path.suffix == '.code': raise PermissionError('simulated locked code')
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'unlink', unlink)
    service.finish_job(job, 'submitted', '模拟平台已受理')
    current = service.store.batch(batch['batchId'])['jobs'][0]
    assert current['state'] == 'finished' and current['outcome'] == 'submitted'
    assert '回执同步失败' in current['message']
    assert not service.store.list()[0]['busy']


def test_restart_settles_receipt_and_never_resends_queued_job(service, monkeypatch):
    account = ready(service.store)
    batch = service.submit(DistributionRequest(requestKey=uuid.uuid4().hex, confirmed=True, requests=[target(account, ['cover.png'])]))
    job = batch['jobs'][0]
    monkeypatch.setattr(service, 'execute', lambda *_a, **_k: pytest.fail('Recovery must not start a runner'))
    service.startup()
    assert service.store.batch(batch['batchId'])['jobs'][0]['outcome'] == 'unverified'
    assert web._get_publish_receipt(job['receiptId'])['outcome'] == 'unverified'
    SocialAccountService.run_batch(service, batch['batchId'])
    next_batch = service.submit(DistributionRequest(requestKey=uuid.uuid4().hex, confirmed=True, requests=[target(account, ['cover.png'])]))
    assert next_batch['batchId'] != batch['batchId']


def test_changed_media_is_blocked_before_upload_and_cannot_be_retried_as_original(service, monkeypatch):
    account = ready(service.store)
    batch = service.submit(DistributionRequest(requestKey=uuid.uuid4().hex, confirmed=True, requests=[target(account, ['cover.png'])]))
    job = batch['jobs'][0]
    assert len(job['mediaHashes']['cover.png']) == 64
    (web.OUTPUTS_DIR / 'cover.png').write_bytes(b'changed content')
    def execute(command, **kwargs):
        assert 'whoami' in command, 'Changed media must not start an upload'
        return SimpleNamespace(returncode=0, stdout=json.dumps({'loggedIn': True, 'externalAccountId': account['externalAccountId']}))
    monkeypatch.setattr(service, 'execute', execute)
    SocialAccountService.run_batch(service, batch['batchId'])
    final = service.store.batch(batch['batchId'])['jobs'][0]
    assert final['outcome'] == 'failed' and '素材与原确认稿不同' in final['message']
    retry = target(account, ['cover.png'])
    retry['payload']['mediaHashes'] = job['mediaHashes']
    with pytest.raises(AccountError, match='素材已变化'):
        service.submit(DistributionRequest(requestKey=uuid.uuid4().hex, confirmed=True, requests=[retry]))
