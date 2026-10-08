"""Profile ownership between read-only publication checks and account actions.

All state is temporary and child processes are controlled doubles. No browser,
login, social post, or SMTP operation is started by these tests.
"""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
from pathlib import Path
import threading
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location(
    '_publish_account_lifecycle_fixture', ROOT / 'tests/test_account_lifecycle.py')
_fixture = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_fixture)
isolated, web = _fixture.isolated, _fixture.web

RID = 'c' * 32
PLATFORMS = ['xiaohongshu', 'weixin-channels', 'douyin', 'kuaishou', 'bilibili']


def running_process():
    return SimpleNamespace(poll=lambda: None)


@pytest.mark.parametrize('platform', PLATFORMS)
@pytest.mark.parametrize('operation', ['api_login_start', 'api_logout', 'api_account_whoami'])
def test_active_verification_rejects_account_changes_without_touching_state(
        isolated, monkeypatch, platform, operation):
    marker = web.LOGIN_DIR / f'{platform}.json'
    marker.write_text('original account marker', encoding='utf-8')
    generation = web._account_check_generation(platform)
    monkeypatch.setattr(web.subprocess, 'Popen', lambda *a, **k: pytest.fail('must not start browser'))
    monkeypatch.setattr(web, '_clear_account_files', lambda *a: pytest.fail('must not remove credentials'))
    assert web._acquire_publish_verification(platform, RID)

    with pytest.raises(web.HTTPException) as failure:
        asyncio.run(getattr(web, operation)(platform))

    assert failure.value.status_code == 409
    assert '核实作品' in failure.value.detail
    assert marker.read_text(encoding='utf-8') == 'original account marker'
    assert web._account_check_generation(platform) == generation
    assert platform not in web._ACCOUNT_CLEARING
    assert web._PUBLISH_ACTIVE == {platform: RID}


@pytest.mark.parametrize('owner', ['login', 'whoami', 'clearing'])
def test_account_owner_blocks_only_its_platform(isolated, owner):
    if owner == 'login':
        web.LOGIN_PROCESSES['douyin'] = running_process()
    elif owner == 'whoami':
        web._WHOAMI_PROCESSES['douyin'] = [running_process()]
    else:
        web._ACCOUNT_CLEARING.add('douyin')

    assert not web._acquire_publish_verification('douyin', RID)
    assert 'douyin' not in web._PUBLISH_ACTIVE
    assert web._acquire_publish_verification('kuaishou', RID)


def test_completed_children_do_not_block_later_verification(isolated):
    finished = SimpleNamespace(poll=lambda: 0)
    web.LOGIN_PROCESSES['douyin'] = finished
    web._WHOAMI_PROCESSES['douyin'] = [finished]
    assert web._acquire_publish_verification('douyin', RID)


@pytest.mark.parametrize('owner', ['login', 'whoami', 'clearing'])
def test_account_owner_blocks_new_publish_only_on_its_platform(isolated, owner):
    assert web.PUBLISH_DIR.resolve().is_relative_to(isolated.resolve())
    if owner == 'login':
        web.LOGIN_PROCESSES['douyin'] = running_process()
    elif owner == 'whoami':
        web._WHOAMI_PROCESSES['douyin'] = [running_process()]
    else:
        web._ACCOUNT_CLEARING.add('douyin')

    with pytest.raises(web.HTTPException) as failure:
        web._begin_publish('douyin', 'synthetic blocked publication')

    assert failure.value.status_code == 409
    assert ('退出' if owner == 'clearing' else '登录或核验账号') in failure.value.detail
    assert not web.PUBLISH_DIR.exists()
    assert web._PUBLISH_ACTIVE == {} and web._PUBLISH_VOLATILE == {}
    unrelated = web._begin_publish('kuaishou', 'synthetic unrelated publication')
    assert unrelated['platform'] == 'kuaishou'
    assert web._PUBLISH_ACTIVE == {'kuaishou': unrelated['receiptId']}
    assert web._publish_receipt_store().recent() == [unrelated]


def test_wechat_mp_alias_shares_the_account_owner(isolated):
    web.LOGIN_PROCESSES['wechat-oa-mp'] = running_process()
    assert not web._acquire_publish_verification('wechat-oa', RID)
    assert web._acquire_publish_verification('weixin-channels', RID)


def test_queued_whoami_rechecks_publish_ownership_before_spawn(isolated, monkeypatch):
    generation = web._account_check_generation('douyin')
    assert web._acquire_publish_verification('douyin', RID)
    monkeypatch.setattr(web.subprocess, 'Popen', lambda *a, **k: pytest.fail('queued browser must not start'))
    with pytest.raises(web.HTTPException) as failure:
        web._run_owned_whoami('douyin', ['offline-whoami'], generation)
    assert failure.value.status_code == 409
    assert web._WHOAMI_PROCESSES == {}


def test_cleanup_excludes_new_workers_until_files_are_finished(isolated, monkeypatch):
    cleaning, finish = threading.Event(), threading.Event()

    def clear(platform, cfg):
        cleaning.set()
        assert finish.wait(5)
        return {'ok': True, 'scope': platform}

    monkeypatch.setattr(web, '_clear_account_files', clear)
    with ThreadPoolExecutor(max_workers=1) as pool:
        logout = pool.submit(lambda: asyncio.run(web.api_logout('douyin')))
        try:
            assert cleaning.wait(5)
            assert not web._acquire_publish_verification('douyin', RID)
            assert web._acquire_publish_verification('kuaishou', RID)
            for action in (web.api_login_start, web.api_account_whoami):
                with pytest.raises(web.HTTPException) as failure:
                    asyncio.run(action('douyin'))
                assert failure.value.status_code == 409 and '退出' in failure.value.detail
        finally:
            finish.set()
        assert logout.result(timeout=5)['ok']
    assert 'douyin' not in web._ACCOUNT_CLEARING
    assert web._acquire_publish_verification('douyin', RID)


@pytest.mark.parametrize('platform,endpoint,login_key,status_name', [
    ('douyin', 'api_login_start', 'douyin', '_login_status'),
    ('wechat-oa', 'api_mp_login_start', 'wechat-oa-mp', '_mp_login_status'),
])
def test_login_spawn_is_registered_before_verification_can_acquire(
        isolated, monkeypatch, platform, endpoint, login_key, status_name):
    spawning, finish_spawn, verification_started = (threading.Event() for _ in range(3))
    child = running_process()

    def spawn(*args, **kwargs):
        spawning.set()
        assert finish_spawn.wait(5)
        return child

    async def no_delay(_):
        pass

    def verify():
        verification_started.set()
        return web._acquire_publish_verification(platform, RID)

    monkeypatch.setattr(web.subprocess, 'Popen', spawn)
    monkeypatch.setattr(web.asyncio, 'sleep', no_delay)
    monkeypatch.setattr(web, status_name, lambda *a: {'qr': 'synthetic-qr', 'state': 'qr_ready'})
    with ThreadPoolExecutor(max_workers=2) as pool:
        login = pool.submit(lambda: asyncio.run(getattr(web, endpoint)(platform)))
        try:
            assert spawning.wait(5)
            verification = pool.submit(verify)
            assert verification_started.wait(5)
        finally:
            finish_spawn.set()
        assert login.result(timeout=5)['state'] == 'qr_ready'
        assert verification.result(timeout=5) is False
    assert web.LOGIN_PROCESSES[login_key] is child
    assert platform not in web._PUBLISH_ACTIVE


def test_running_whoami_excludes_login_and_verification_but_releases_owner(isolated, monkeypatch):
    checking, finish = threading.Event(), threading.Event()
    spawned = []

    class Process:
        returncode = None

        def __init__(self, *args, **kwargs):
            self.output = kwargs['stdout']
            self.output.write(json.dumps({'loggedIn': True}).encode())

        def poll(self):
            return self.returncode

        def wait(self, timeout):
            checking.set()
            assert finish.wait(5)
            self.returncode = 0
            return 0

    def spawn(*args, **kwargs):
        child = Process(*args, **kwargs)
        spawned.append(child)
        return child

    monkeypatch.setattr(web.subprocess, 'Popen', spawn)
    generation = web._account_check_generation('douyin')
    with ThreadPoolExecutor(max_workers=1) as pool:
        whoami = pool.submit(web._run_owned_whoami, 'douyin', ['offline-whoami'], generation)
        try:
            assert checking.wait(5)
            assert not web._acquire_publish_verification('douyin', RID)
            with pytest.raises(web.HTTPException) as failure:
                asyncio.run(web.api_login_start('douyin'))
            assert failure.value.status_code == 409 and '核验账号' in failure.value.detail
            with pytest.raises(web.HTTPException) as failure:
                web._run_owned_whoami('douyin', ['offline-whoami'], generation)
            assert failure.value.status_code == 409
            assert len(spawned) == 1
            assert web._acquire_publish_verification('kuaishou', RID)
        finally:
            finish.set()
        assert json.loads(whoami.result(timeout=5).stdout)['loggedIn'] is True
    assert web._WHOAMI_PROCESSES == {}
    assert web._acquire_publish_verification('douyin', RID)


@pytest.mark.parametrize('operation', ['login', 'whoami'])
def test_failed_browser_spawn_releases_lock_and_leaves_no_owner(isolated, monkeypatch, operation):
    outputs = []

    def fail_spawn(*args, **kwargs):
        outputs.append(kwargs['stdout'])
        raise OSError('synthetic browser start failure')

    monkeypatch.setattr(web.subprocess, 'Popen', fail_spawn)
    with pytest.raises(OSError, match='synthetic browser'):
        if operation == 'login':
            asyncio.run(web.api_login_start('douyin'))
        else:
            web._run_owned_whoami('douyin', ['offline-whoami'], web._account_check_generation('douyin'))
    assert all(output.closed for output in outputs)
    assert web.LOGIN_PROCESSES == {} and web._WHOAMI_PROCESSES == {}
    with ThreadPoolExecutor(max_workers=1) as pool:
        assert pool.submit(web._acquire_publish_verification, 'douyin', RID).result(timeout=5)
