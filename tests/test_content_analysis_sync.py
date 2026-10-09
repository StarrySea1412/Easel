"""Authenticated sync contracts exercised with fake collectors, never real platform requests."""
import asyncio
import sys
import json
import os
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI, HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from content_analysis import Store
from content_analysis_routes import create_router
from content_analysis_sync import SyncService


def evidence(account='a', **extra):
    return {'loggedIn': True, 'accountId': account, 'nickname': '已核验作者',
            'fetched_at': 1791511200, 'notes': [
                {'note_id': 'n1', 'title': '真实作品', 'tags': ['教程'], 'metrics': {'likes': 0}}], **extra}


def report_store(root, platform='xiaohongshu', account='a'):
    return Store(root).ingest({'platform': platform, 'accountId': account, 'contents': [
        {'id': 'manual', 'title': '已有材料', 'body': '人工补充正文', 'metrics': {'views': 8}}]})


def test_http_discovery_cache_refresh_status_and_missing_total(tmp_path):
    async def exercise():
        calls = []
        async def capture(platform):
            calls.append(platform)
            return evidence(posts=99)
        app = FastAPI()
        app.include_router(create_router(lambda: tmp_path, capture, session_getter=lambda _: True))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            idle = (await client.get('/api/content-analysis/sync/status?platform=xiaohongshu')).json()
            assert idle['status'] == 'idle' and calls == []
            live = (await client.post('/api/content-analysis/sync', json={'platform': 'xiaohongshu'})).json()
            assert live['scope'] == {'platform': 'xiaohongshu', 'accountId': 'a'}
            assert live['status'] == 'partial' and live['loadedCount'] == live['receivedCount'] == 1
            assert live['totalCount'] is None and not live['totalKnown'] and not live['complete']
            assert live['pagesFetched'] == 1 and live['pageLimit'] == 20 and not live['cached']
            assert live['report']['quality']['identity'] == 'live_verified'
            assert live['report']['contents'][0]['metrics']['likes'] == 0
            assert live['report']['contents'][0]['metrics']['views'] is None
            cached = (await client.post('/api/content-analysis/sync', json={'platform': 'xiaohongshu', 'accountId': 'a'})).json()
            assert cached['cached'] and calls == ['xiaohongshu']
            assert cached['fetchedAt'] == live['fetchedAt']
            status = (await client.get('/api/content-analysis/sync/status?platform=xiaohongshu&accountId=a')).json()
            assert status['cached'] and status['loadedCount'] == 1 and 'report' not in status
            assert 'cacheExpiresAt' in status and not any(k.startswith('_') for k in status)
            await client.post('/api/content-analysis/sync', json={'platform': 'xiaohongshu', 'force': True})
            assert calls == ['xiaohongshu', 'xiaohongshu']
            for data in ({'platform': 'invalid'}, {'platform': 'xiaohongshu', 'accountId': ''},
                         {'platform': 'xiaohongshu', 'force': 'true'}, {'platform': 'xiaohongshu', 'accountId': 3}):
                assert (await client.post('/api/content-analysis/sync', json=data)).status_code == 400
    asyncio.run(exercise())


@pytest.mark.parametrize('platform', ['douyin', 'kuaishou', 'zhihu', 'weixin-channels', 'wechat-oa'])
def test_unsupported_collectors_never_run(tmp_path, platform):
    async def capture(_):
        pytest.fail('unsupported collector must not run')
    service = SyncService(lambda: tmp_path, capture)
    state = asyncio.run(service.sync(platform))
    assert state['status'] == 'unsupported' and not state['supported'] and state['loadedCount'] == 0
    assert state['totalCount'] is None and not state['complete']
    assert '稳定账号 ID' in state['message']


def test_logged_out_gate_and_collector_expiry_preserve_existing_data(tmp_path):
    report_store(tmp_path)
    async def capture(_):
        return {'loggedIn': False, 'notes': []}
    gated = SyncService(lambda: tmp_path, lambda _: pytest.fail('logged-out gate'), session_getter=lambda _: False)
    assert asyncio.run(gated.sync('xiaohongshu', 'a'))['status'] == 'logged_out'
    service = SyncService(lambda: tmp_path, capture)
    result = asyncio.run(service.sync('xiaohongshu', 'a'))
    assert result['status'] == 'logged_out' and result['loadedCount'] == 1
    assert Store(tmp_path).report('xiaohongshu', 'a')['contents'][0]['id'] == 'manual'


def test_verified_identity_mismatch_and_missing_identity_never_ingest(tmp_path):
    report_store(tmp_path)
    async def mismatch(_):
        return evidence('b')
    service = SyncService(lambda: tmp_path, mismatch)
    result = asyncio.run(service.sync('xiaohongshu', 'a'))
    assert result['status'] == 'account_mismatch' and result['scope']['accountId'] == 'a'
    assert result['connectedAccountId'] == 'b' and result['loadedCount'] == 1
    assert len(Store(tmp_path).accounts()) == 1
    async def missing(_):
        return evidence('')
    result = asyncio.run(SyncService(lambda: tmp_path, missing).sync('xiaohongshu'))
    assert result['status'] == 'identity_unverified' and len(Store(tmp_path).accounts()) == 1


def test_user_declared_evidence_context_is_not_live_account_identity(tmp_path):
    async def capture(_):
        return {'loggedIn': True, 'account': {'id': 'import:a', 'externalId': 'a', 'source': 'import'},
                'notes': [{'note_id': 'n1'}]}
    result = asyncio.run(SyncService(lambda: tmp_path, capture).sync('xiaohongshu'))
    assert result['status'] == 'identity_unverified' and Store(tmp_path).accounts() == []


def test_same_id_and_platform_are_required_for_each_record(tmp_path):
    async def capture(_):
        return evidence(notes=[{'note_id': 'n1', 'accountId': 'foreign'}, {'note_id': 'n2'}])
    result = asyncio.run(SyncService(lambda: tmp_path, capture).sync('xiaohongshu', 'a'))
    assert result['status'] == 'error' and Store(tmp_path).accounts() == []


def test_successful_sync_isolated_by_account_and_platform_and_keeps_materials(tmp_path):
    report_store(tmp_path)
    async def capture(platform):
        return evidence('a' if platform == 'xiaohongshu' else 'b', notes=[
            {'note_id': 'manual', 'title': '更新标题', 'metrics': {'likes': 2}},
            {'title': '没有稳定ID'}, {'note_id': 'manual', 'title': '重复'}], posts=120)
    service = SyncService(lambda: tmp_path, capture)
    xhs = asyncio.run(service.sync('xiaohongshu', 'a'))
    bili = asyncio.run(service.sync('bilibili'))
    assert xhs['skippedCount'] == 2 and xhs['receivedCount'] == 1
    assert xhs['report']['contents'][0]['body'] == '人工补充正文'
    assert bili['totalCount'] == 120 and bili['totalKnown'] and not bili['complete']
    assert bili['report']['account']['accountId'] == 'b' and bili['report']['account']['platform'] == 'bilibili'
    assert len(Store(tmp_path).accounts()) == 2
    assert service.status('xiaohongshu', 'b')['status'] == 'idle'


def test_empty_and_invalid_metrics_are_not_account_history_or_zero(tmp_path):
    async def empty(_):
        return evidence(notes=[], posts=0)
    result = asyncio.run(SyncService(lambda: tmp_path, empty).sync('bilibili'))
    assert result['status'] == 'empty' and result['totalCount'] == 0 and result['loadedCount'] == 0
    assert not result['complete'] and '不能据此判断' in result['message']
    async def invalid(_):
        return evidence(notes=[{'note_id': 'valid'}, {'note_id': 'bad', 'metrics': {'likes': '100'}}])
    result = asyncio.run(SyncService(lambda: tmp_path, invalid).sync('xiaohongshu'))
    assert result['status'] == 'error' and Store(tmp_path).accounts() == []


def test_failures_are_retryable_redacted_and_preserve_old_scope(tmp_path):
    report_store(tmp_path)
    async def capture(_):
        raise HTTPException(502, 'private-cookie-and-secret')
    result = asyncio.run(SyncService(lambda: tmp_path, capture).sync('xiaohongshu', 'a'))
    assert result['status'] == 'error' and result['retryable'] and result['loadedCount'] == 1
    assert 'private' not in result['message'] and result['finishedAt'] and result['fetchedAt'] is None


def test_concurrent_sync_deduplicates_and_status_is_read_only(tmp_path):
    async def exercise():
        entered, release = asyncio.Event(), asyncio.Event()
        calls = []
        async def capture(platform):
            calls.append(platform)
            entered.set()
            await release.wait()
            return evidence()
        service = SyncService(lambda: tmp_path, capture)
        first = asyncio.create_task(service.sync('xiaohongshu', 'a'))
        await entered.wait()
        assert service.status('xiaohongshu', 'a')['status'] == 'syncing'
        second = asyncio.create_task(service.sync('xiaohongshu', 'a'))
        busy = await service.sync('xiaohongshu', 'b')
        assert busy['status'] == 'syncing' and busy['scope']['accountId'] == 'b'
        release.set()
        results = await asyncio.gather(first, second)
        assert calls == ['xiaohongshu'] and results[0]['scope'] == results[1]['scope']
        assert results[0]['loadedCount'] == 1 and not service.tasks
    asyncio.run(exercise())


def test_cache_persistence_expiry_and_login_generation_change(tmp_path, monkeypatch):
    import content_analysis_sync as module
    calls, generation = [], ['session-a']
    async def capture(platform):
        calls.append(platform)
        return evidence()
    service = SyncService(lambda: tmp_path, capture, generation_getter=lambda _: generation[0])
    asyncio.run(service.sync('xiaohongshu'))
    restarted = SyncService(lambda: tmp_path, capture, generation_getter=lambda _: generation[0])
    assert asyncio.run(restarted.sync('xiaohongshu'))['cached'] and len(calls) == 1
    generation[0] = 'session-b'
    assert restarted.status('xiaohongshu')['status'] == 'idle'
    assert not asyncio.run(restarted.sync('xiaohongshu'))['cached'] and len(calls) == 2
    saved = Store(tmp_path).sync_state('xiaohongshu')
    monkeypatch.setattr(module.time, 'time', lambda: saved['_savedAt'] + module.CACHE_SECONDS + 1)
    assert not asyncio.run(restarted.sync('xiaohongshu'))['cached'] and len(calls) == 3


@pytest.mark.parametrize('change', ['session', 'directory'])
def test_late_response_cannot_write_after_session_or_data_directory_switch(tmp_path, change):
    async def exercise():
        entered, release = asyncio.Event(), asyncio.Event()
        root, generation = [tmp_path / 'first'], ['session-a']
        async def capture(_):
            entered.set()
            await release.wait()
            return evidence()
        service = SyncService(lambda: root[0], capture, generation_getter=lambda _: generation[0])
        task = asyncio.create_task(service.sync('xiaohongshu'))
        await entered.wait()
        if change == 'session':
            generation[0] = 'session-b'
        else:
            root[0] = tmp_path / 'second'
        release.set()
        result = await task
        assert result['status'] == 'error' and Store(root[0]).accounts() == []
        assert Store(tmp_path / 'first').accounts() == []
        assert service.status('xiaohongshu')['status'] == 'idle'
    asyncio.run(exercise())


@pytest.mark.parametrize('platform', ['xiaohongshu', 'bilibili'])
def test_application_sync_reuses_existing_collector_and_validates_local_session(tmp_path, monkeypatch, platform):
    import app as web
    import account_stats as stats
    outputs, login, data = tmp_path / 'outputs', tmp_path / 'login', tmp_path / 'data'
    login.mkdir()
    data.mkdir()
    marker = data / 'cookies.json' if platform == 'bilibili' else login / 'xiaohongshu.json'
    marker.write_text(json.dumps({'state': 'success'}), encoding='utf-8')
    monkeypatch.setattr(web, 'OUTPUTS_DIR', outputs)
    monkeypatch.setattr(web, 'LOGIN_DIR', login)
    monkeypatch.setattr(web, 'DATA_DIR', data)
    monkeypatch.setattr(web, '_proxy_env', lambda: {})
    monkeypatch.setattr(stats, 'ANALYTICS_DIR', outputs / '_analytics')
    calls = []
    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        if platform == 'xiaohongshu':
            # The real whoami does exactly this while a separate collector may be running.
            web._write_login_marker(platform, 'success', '同账号正常核验刷新')
        return SimpleNamespace(stdout=json.dumps(evidence()), stderr='', returncode=0)
    monkeypatch.setattr(web.subprocess, 'run', fake_run)
    async def exercise():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=web.app), base_url='http://127.0.0.1') as client:
            result = (await client.post('/api/content-analysis/sync', json={'platform': platform})).json()
            assert result['status'] == 'partial' and result['loadedCount'] == 1
            cached = (await client.post('/api/content-analysis/sync', json={'platform': platform})).json()
            assert cached['cached'] and cached['report']['account']['accountId'] == 'a'
            assert len(calls) == 1
            assert ('bili_login.py' in calls[0][1] if platform == 'bilibili' else 'account_stats.py' in calls[0][1])
            marker.unlink()
            stopped = (await client.post('/api/content-analysis/sync', json={'platform': platform})).json()
            assert stopped['status'] == 'logged_out' and len(calls) == 1
    asyncio.run(exercise())


def test_same_login_marker_refresh_and_browser_reads_keep_stable_generation(tmp_path, monkeypatch):
    import app as web
    monkeypatch.setattr(web, '_ACCOUNT_GENERATIONS', {})
    monkeypatch.setattr(web, '_WHOAMI_CACHE', {})
    login, profiles = tmp_path / 'login', tmp_path / 'profiles'
    profile = profiles / 'XiaohongshuProfile'
    profile.mkdir(parents=True)
    monkeypatch.setattr(web, 'LOGIN_DIR', login)
    monkeypatch.setattr(web, 'BROWSER_PROFILES', profiles)
    web._write_login_marker('xiaohongshu', 'success', '正常登录')
    marker = login / 'xiaohongshu.json'
    os.utime(marker, (1, 1))
    original = web._content_analysis_session_generation('xiaohongshu')
    web._write_login_marker('xiaohongshu', 'success', '更新昵称和核验时间，但仍是同一会话')
    (profile / 'Preferences').write_text('updated while reading', encoding='utf-8')
    assert marker.stat().st_mtime > 1
    assert web._content_analysis_session_generation('xiaohongshu') == original
    web._invalidate_account_check('xiaohongshu')
    assert web._content_analysis_session_generation('xiaohongshu') != original


@pytest.mark.parametrize('change', ['marker_account', 'session_id', 'marker_missing', 'marker_state', 'profile_replaced'])
def test_actual_login_identity_or_session_replacement_changes_generation(tmp_path, monkeypatch, change):
    import app as web
    login, profiles = tmp_path / 'login', tmp_path / 'profiles'
    login.mkdir()
    profile = profiles / 'XiaohongshuProfile'
    profile.mkdir(parents=True)
    monkeypatch.setattr(web, 'LOGIN_DIR', login)
    monkeypatch.setattr(web, 'BROWSER_PROFILES', profiles)
    marker = login / 'xiaohongshu.json'
    value = {'state': 'success', 'accountId': 'account-a', 'sessionId': 'session-a'}
    marker.write_text(json.dumps(value), encoding='utf-8')
    original = web._content_analysis_session_generation('xiaohongshu')
    if change == 'profile_replaced':
        profile.rename(tmp_path / 'old-profile')
        profile.mkdir()
    elif change == 'marker_missing':
        marker.unlink()
    else:
        value[{'marker_account': 'accountId', 'session_id': 'sessionId', 'marker_state': 'state'}[change]] = 'different'
        marker.write_text(json.dumps(value), encoding='utf-8')
    assert web._content_analysis_session_generation('xiaohongshu') != original


def test_bilibili_cookie_replacement_invalidates_same_size_and_timestamp_cache(tmp_path, monkeypatch):
    import app as web
    monkeypatch.setattr(web, 'DATA_DIR', tmp_path)
    marker = tmp_path / 'cookies.json'
    marker.write_text('first', encoding='utf-8')
    previous = marker.stat()
    original = web._content_analysis_session_generation('bilibili')
    replacement = tmp_path / 'replacement.json'
    replacement.write_text('other', encoding='utf-8')
    os.utime(replacement, ns=(previous.st_atime_ns, previous.st_mtime_ns))
    os.replace(replacement, marker)
    assert marker.stat().st_size == previous.st_size
    assert web._content_analysis_session_generation('bilibili') != original


def test_confirmed_login_expiry_during_collection_reports_logged_out_not_scope_switch(tmp_path):
    async def exercise():
        active, generation = [True], ['current']
        async def capture(_):
            active[0] = False
            generation[0] = 'expired'
            return {'loggedIn': False, 'notes': []}
        service = SyncService(lambda: tmp_path, capture, session_getter=lambda _: active[0], generation_getter=lambda _: generation[0])
        result = await service.sync('xiaohongshu')
        assert result['status'] == 'logged_out' and '登录已失效' in result['message']
        assert Store(tmp_path).accounts() == []
        assert service.status('xiaohongshu')['status'] == 'logged_out'
    asyncio.run(exercise())


def test_old_logged_out_response_does_not_describe_a_newly_connected_session(tmp_path):
    async def exercise():
        generation = ['old']
        async def capture(_):
            generation[0] = 'new'
            return {'loggedIn': False, 'notes': []}
        service = SyncService(lambda: tmp_path, capture, session_getter=lambda _: True, generation_getter=lambda _: generation[0])
        result = await service.sync('xiaohongshu')
        assert result['status'] == 'error' and '账号状态已变化' in result['message']
        assert service.status('xiaohongshu')['status'] == 'idle'
    asyncio.run(exercise())
