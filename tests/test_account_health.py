"""Login-health scheduling with isolated data and controlled runners, no platform IO."""
import asyncio
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('_health_fixture', ROOT / 'tests/test_account_lifecycle.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
isolated, web = fixture.isolated, fixture.web

from account_health import AccountHealthService, HealthStore
from social_accounts_api import SocialAccountService
from easel.notifications import NotificationStore, notice
from easel.social_accounts import SocialStore, account_view, fresh_account
from easel.runtime_limits import Pool


def complete(value):
    return SimpleNamespace(returncode=0, stdout=json.dumps(value))


@pytest.fixture
def health(isolated, monkeypatch):
    service = SocialAccountService(web)
    monkeypatch.setattr(web, '_social_accounts', service)
    monkeypatch.setattr(web.app.state, 'server_pools', {}, raising=False)
    clock = [datetime.now(timezone.utc).timestamp()]
    monitor = AccountHealthService(web, clock=lambda: clock[0])
    monitor.test_clock = clock
    return monitor


def target(label='A'):
    return dict(key='social:' + 'a' * 32, platform='zhihu', label=label,
                source='independent', accountId='a' * 32, binding='123')


def test_default_expiry_found_without_any_browser_page_and_deduplicated_after_restart(health, monkeypatch):
    monkeypatch.setattr(web, '_run_owned_whoami', lambda *a: complete({'loggedIn': False, 'reason': 'login_required'}))
    asyncio.run(health.tick())
    result = asyncio.run(health.snapshot())
    assert result['accounts'][0]['state'] == 'login_required'
    assert (web.LOGIN_DIR / 'xiaohongshu.json').exists()
    notices = NotificationStore(web.OUTPUTS_DIR).list()['notices']
    assert len(notices) == 1 and notices[0]['target'] == {'page': 'accounts', 'platform': 'xiaohongshu'}
    restarted = AccountHealthService(web, clock=health.clock)
    asyncio.run(restarted.tick())
    assert len(NotificationStore(web.OUTPUTS_DIR).list()['notices']) == 1


def test_unknown_never_becomes_logout_and_backoff_event_is_persisted_once(health, monkeypatch):
    monkeypatch.setattr(web, '_run_owned_whoami', lambda *a: complete({'loggedIn': False, 'error': 'synthetic network'}))
    asyncio.run(health.tick())
    record = health.store.rows()['default:xiaohongshu']
    assert record['state'] == 'unknown' and record['failures'] == 1
    assert record['nextCheckAt'] == int(health.clock() * 1000) + 60_000
    assert not NotificationStore(web.OUTPUTS_DIR).list()['notices']
    health.test_clock[0] += 61
    asyncio.run(health.tick())
    assert len(NotificationStore(web.OUTPUTS_DIR).list()['notices']) == 1
    assert json.loads((web.LOGIN_DIR / 'xiaohongshu.json').read_text(encoding='utf-8'))['state'] == 'success'
    health.test_clock[0] += 121
    asyncio.run(health.tick())
    assert len(NotificationStore(web.OUTPUTS_DIR).list()['notices']) == 1


def test_recovery_closes_one_incident_and_later_logout_gets_new_notice(health):
    t = target()
    for state in ['login_required', 'login_required', 'online', 'online', 'login_required']:
        health.test_clock[0] += 1
        health.observe(t, state)
        health.flush_notices()
    notices = NotificationStore(web.OUTPUTS_DIR).list()['notices']
    assert len(notices) == 3
    assert sum(row['tone'] == 'success' for row in notices) == 1
    assert len({row['id'] for row in notices}) == 3


def test_notification_storage_failure_retries_same_id_without_losing_incident(health, monkeypatch):
    health.observe(target(), 'login_required')
    original = NotificationStore.add
    monkeypatch.setattr(NotificationStore, 'add', lambda *args: (_ for _ in ()).throw(OSError('synthetic disk error')))
    with pytest.raises(OSError):
        health.flush_notices()
    assert len(next(iter(health.store.rows().values()))['outbox']) == 1
    monkeypatch.setattr(NotificationStore, 'add', original)
    health.flush_notices()
    health.flush_notices()
    assert len(NotificationStore(web.OUTPUTS_DIR).list()['notices']) == 1


def test_network_flapping_does_not_repeat_an_open_expiry_incident(health):
    for state in ['unknown', 'unknown', 'login_required', 'unknown', 'unknown', 'login_required'] * 3:
        health.test_clock[0] += 1
        health.observe(target(), state)
        health.flush_notices()
    notices = NotificationStore(web.OUTPUTS_DIR).list()['notices']
    assert len(notices) == 2, 'one unconfirmed incident and one confirmed escalation'


def test_busy_browser_defers_check_and_does_not_emit_false_logout(health, monkeypatch):
    pool = Pool('browser', 1)
    lease = pool.acquire()
    monkeypatch.setattr(web.app.state, 'server_pools', {'browser': pool})
    monkeypatch.setattr(web, '_run_owned_whoami', lambda *a: pytest.fail('browser is busy'))
    asyncio.run(health.tick())
    assert health.store.rows() == {}
    assert pool.active == 1
    lease.release()


def test_check_serializes_and_releases_browser_admission(health, monkeypatch):
    pool = Pool('browser', 1)
    monkeypatch.setattr(web.app.state, 'server_pools', {'browser': pool})
    seen = []
    def run(platform, *_):
        seen.append((platform, pool.active))
        return complete({'loggedIn': True, 'name': 'Synthetic'})
    monkeypatch.setattr(web, '_run_owned_whoami', run)
    asyncio.run(health.tick())
    assert seen == [('xiaohongshu', 1)] and pool.active == 0


def test_late_default_result_after_generation_change_is_discarded(health, monkeypatch):
    async def check(platform, force=False):
        web._ACCOUNT_GENERATIONS[platform] = 'new-generation'
        return {'loggedIn': False, 'verified': True}
    monkeypatch.setattr(web, 'api_account_whoami', check)
    asyncio.run(health.tick())
    assert not health.store.rows()
    assert not NotificationStore(web.OUTPUTS_DIR).list()['notices']


def test_stale_success_is_unknown_without_rewriting_historical_proof(health, monkeypatch):
    monkeypatch.setattr(web, '_run_owned_whoami', lambda *a: complete({'loggedIn': True, 'name': 'Saved'}))
    asyncio.run(health.tick())
    health.test_clock[0] += 601
    snapshot = asyncio.run(health.snapshot())
    assert snapshot['accounts'][0]['state'] == 'unknown'
    assert health.store.rows()['default:xiaohongshu']['state'] == 'online'


def add_account(service):
    row = service.store.create('A', 'douyin')
    reservation = service.store.reserve(row['accountId'], 'check')
    return service.store.finish(row['accountId'], reservation['generation'], 'check', 'ready', 'synthetic',
                                {'externalAccountId': '123', 'name': 'A'})


@pytest.mark.parametrize('payload,expected', [
    ({'loggedIn': False, 'reason': 'login_required'}, 'login_required'),
    ({'loggedIn': True, 'externalAccountId': '456', 'name': 'B'}, 'identity_changed'),
    ({'loggedIn': False, 'error': 'synthetic network'}, 'unknown'),
    ({'loggedIn': False}, 'unknown'),
    ({'loggedIn': False, 'verified': False, 'reason': 'login_required'}, 'unknown'),
])
def test_independent_account_background_check_keeps_scope_and_propagates_failure(health, monkeypatch, payload, expected):
    row = add_account(web._social_accounts)
    with web._social_accounts.store.db() as con:
        con.execute('UPDATE accounts SET checkedAt=? WHERE accountId=?', ('2020-01-01T00:00:00+00:00', row['accountId']))
    monkeypatch.setattr(web, '_run_owned_whoami', lambda *a: complete({'loggedIn': True}))
    commands = []
    def execute(cmd):
        commands.append(cmd)
        return complete(payload)
    monkeypatch.setattr(web._social_accounts, 'execute', execute)
    asyncio.run(health.tick())
    assert row['accountId'] in ' '.join(commands[0])
    result = next(a for a in asyncio.run(health.snapshot())['accounts'] if a['source'] == 'independent')
    assert result['state'] == expected
    assert web._social_accounts.store.get(row['accountId'])['externalAccountId'] == '123'


def test_outdated_proof_is_not_ready_and_cannot_admit_publish(tmp_path):
    store = SocialStore(tmp_path / 'registry.sqlite')
    row = store.create('A', 'douyin')
    reservation = store.reserve(row['accountId'], 'check')
    row = store.finish(row['accountId'], reservation['generation'], 'check', 'ready', '', {'externalAccountId': '123'})
    assert fresh_account(row)
    with store.db() as con:
        con.execute('UPDATE accounts SET checkedAt=?', ('2020-01-01T00:00:00+00:00',))
    stale = store.get(row['accountId'])
    assert account_view(stale)['status'] == 'unverified'
    assert store.get(row['accountId'])['status'] == 'ready', 'display expiry does not rewrite historical evidence'
    from easel.social_accounts import AccountError
    with pytest.raises(AccountError):
        store.admit([{'accountId': row['accountId'], 'payload': {}}], 'f' * 32)


def test_future_proof_cannot_delay_background_check(health, monkeypatch):
    row = add_account(web._social_accounts)
    with web._social_accounts.store.db() as con:
        con.execute('UPDATE accounts SET checkedAt=? WHERE accountId=?', ('2099-01-01T00:00:00+00:00', row['accountId']))
    calls = []
    def execute(cmd):
        calls.append(cmd)
        return complete({'loggedIn': True, 'externalAccountId': '123'})
    monkeypatch.setattr(web._social_accounts, 'execute', execute)
    monkeypatch.setattr(web, '_run_owned_whoami', lambda *a: complete({'loggedIn': True}))
    asyncio.run(health.tick())
    assert len(calls) == 1
    assert health.store.rows()['social:' + row['accountId']]['state'] == 'online'


def test_user_logout_removes_monitor_target_without_a_false_expiry_notice(health, monkeypatch):
    row = add_account(web._social_accounts)
    monkeypatch.setattr(web, '_run_owned_whoami', lambda *a: complete({'loggedIn': True}))
    asyncio.run(health.tick())
    assert health.store.rows()
    asyncio.run(web.api_logout('xiaohongshu'))
    reservation = web._social_accounts.store.reserve(row['accountId'], 'logout')
    web._social_accounts.store.finish(row['accountId'], reservation['generation'], 'logout', 'logged_out', 'User logout')
    asyncio.run(health.tick())
    assert not asyncio.run(health.snapshot())['accounts']
    assert not health.store.rows()
    assert not NotificationStore(web.OUTPUTS_DIR).list()['notices']


def test_notification_account_target_is_validated_without_external_urls():
    result = notice(dict(id='health:test', at=1, tone='error', message='Expired',
                         target=dict(page='accounts', accountId='../bad', platform='https://bad.test')))
    assert result['target'] == {'page': 'accounts'}


def test_background_task_lifecycle_has_one_owner_and_stops_cleanly(health, monkeypatch):
    async def tick():
        health.last_scan = 1
    monkeypatch.setattr(health, 'tick', tick)
    async def run():
        health.start()
        owned = health.task
        health.start()
        assert health.task is owned
        await asyncio.sleep(0)
        await health.stop()
        assert owned.done() and health.last_scan == 1
    asyncio.run(run())
