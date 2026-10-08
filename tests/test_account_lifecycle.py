"""Exercise real account endpoints against temporary state and mocked browser runners."""
import asyncio
import json
import sys
import time
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "web"), str(ROOT / "skills/shared/scripts")]
import account_evidence as ae
import app as web


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(web, "DATA_DIR", tmp_path)
    monkeypatch.setattr(web, "OUTPUTS_DIR", tmp_path / "outputs")
    monkeypatch.setattr(web, "LOGIN_DIR", tmp_path / "outputs" / "_login")
    monkeypatch.setattr(web, "PUBLISH_DIR", tmp_path / "outputs" / "_publish")
    monkeypatch.setattr(web, "BROWSER_PROFILES", tmp_path / "browser-profiles")
    monkeypatch.setattr(web, "_WHOAMI_CACHE", {})
    monkeypatch.setattr(web, "LOGIN_PROCESSES", {})
    monkeypatch.setattr(web, "_ACCOUNT_GENERATIONS", {})
    monkeypatch.setattr(web, "_ACCOUNT_CLEARING", set())
    monkeypatch.setattr(web, "_WHOAMI_PROCESSES", {})
    monkeypatch.setattr(web, "_PUBLISH_LOCK", threading.RLock())
    monkeypatch.setattr(web, "_PUBLISH_ACTIVE", {})
    monkeypatch.setattr(web, "_PUBLISH_VOLATILE", {})
    monkeypatch.setattr(web, "WECHAT_CONFIG_YAML", tmp_path / 'wechat-publisher.yaml')
    monkeypatch.setattr(web, "WECHAT_SKILL_SCRIPTS", tmp_path / 'wechat-scripts')
    monkeypatch.setattr(web, "_proxy_env", lambda: {})
    web.LOGIN_DIR.mkdir(parents=True)
    web.BROWSER_PROFILES.mkdir()
    marker = web.LOGIN_DIR / "xiaohongshu.json"
    marker.write_text(json.dumps({"state": "success", "message": "Test", "ts": int(time.time())}), encoding="utf-8")
    return tmp_path


def seed(source):
    root = web.OUTPUTS_DIR / "_analytics"
    ae.ingest(root, [{"note_id": "note1", "title": "咖啡", "tags": ["咖啡"], "metrics": {"likes": 1}}],
              "test-account", int(time.time()), source=source)
    return root


@pytest.mark.parametrize("source", ["live", "import"])
def test_whoami_confirmed_logout_only_invalidates_live_identity(isolated, monkeypatch, source):
    root = seed(source)
    monkeypatch.setattr(web, "_run_owned_whoami", lambda *args, **kwargs: SimpleNamespace(
        stdout=json.dumps({"loggedIn": False}), stderr=""))
    result = asyncio.run(web.api_account_whoami("xiaohongshu"))
    assert result["loggedIn"] is False
    assert not (web.LOGIN_DIR / "xiaohongshu.json").exists()
    assert ae.load(root, f"{source}:test-account")  # Retained evidence survives logout.
    data = asyncio.run(web.api_analytics_insights("xiaohongshu"))
    assert data["sampleSize"] == (1 if source == "import" else 0)
    assert bool(data["account"]) is (source == "import")


@pytest.mark.parametrize("old_logged_in", [True, False])
def test_old_whoami_reply_does_not_overwrite_new_context_or_marker(isolated, monkeypatch, old_logged_in):
    root = seed("live")
    marker = web.LOGIN_DIR / "xiaohongshu.json"
    def delayed_reply(*args, **kwargs):
        ae.ingest(root, [{"note_id": "new-note", "title": "新账号", "tags": ["新账号"]}],
                  "new-account", int(time.time()), source="live")
        marker.write_text("new-login-marker", encoding="utf-8")
        return SimpleNamespace(stdout=json.dumps({"loggedIn": old_logged_in, "name": "Old Account"}), stderr="")
    monkeypatch.setattr(web, "_run_owned_whoami", delayed_reply)
    with pytest.raises(web.HTTPException) as failure:
        asyncio.run(web.api_account_whoami("xiaohongshu"))
    assert failure.value.status_code == 409
    assert ae.active_account(root)["id"] == "live:new-account"
    assert marker.read_text(encoding="utf-8") == "new-login-marker"
    assert "xiaohongshu" not in web._WHOAMI_CACHE


def test_whoami_browser_failure_keeps_last_known_identity(isolated, monkeypatch):
    root = seed("live")
    before = ae.generation(root)
    monkeypatch.setattr(web, "_run_owned_whoami", lambda *args, **kwargs: SimpleNamespace(
        stdout=json.dumps({"loggedIn": False, "error": "mock browser unavailable"}), stderr=""))
    result = asyncio.run(web.api_account_whoami("xiaohongshu"))
    assert result["loggedIn"] is True
    assert ae.generation(root) == before and "xiaohongshu" not in web._WHOAMI_CACHE
    assert (web.LOGIN_DIR / "xiaohongshu.json").exists()


@pytest.mark.parametrize("payload,returncode", [({}, 0), ({"loggedIn": "false"}, 0), ({"loggedIn": False}, 1)])
def test_unreliable_whoami_reply_does_not_invalidate_identity(isolated, monkeypatch, payload, returncode):
    root = seed("live")
    before = ae.generation(root)
    monkeypatch.setattr(web, "_run_owned_whoami", lambda *args, **kwargs: SimpleNamespace(
        stdout=json.dumps(payload), stderr="", returncode=returncode))
    result = asyncio.run(web.api_account_whoami("xiaohongshu"))
    assert result["loggedIn"] is True and ae.generation(root) == before
    assert "xiaohongshu" not in web._WHOAMI_CACHE
    assert (web.LOGIN_DIR / "xiaohongshu.json").exists()


def test_whoami_cache_is_scoped_to_account_generation(isolated, monkeypatch):
    root = seed("live")
    calls = []

    def reply(*args, **kwargs):
        calls.append(True)
        return SimpleNamespace(stdout=json.dumps({"loggedIn": True, "name": f"Account {len(calls)}"}),
                               stderr="", returncode=0)

    monkeypatch.setattr(web, "_run_owned_whoami", reply)
    assert asyncio.run(web.api_account_whoami("xiaohongshu"))["name"] == "Account 1"
    assert asyncio.run(web.api_account_whoami("xiaohongshu"))["name"] == "Account 1"
    assert len(calls) == 1
    ae.ingest(root, [{"note_id": "other-note", "title": "另一账号"}],
              "other-account", int(time.time()), source="live")
    assert asyncio.run(web.api_account_whoami("xiaohongshu"))["name"] == "Account 2"
    assert len(calls) == 2


def test_confirmed_logout_cache_uses_invalidated_generation(isolated, monkeypatch):
    seed("live")
    calls = []

    def reply(*args, **kwargs):
        calls.append(True)
        return SimpleNamespace(stdout=json.dumps({"loggedIn": False}), stderr="", returncode=0)

    monkeypatch.setattr(web, "_run_owned_whoami", reply)
    assert asyncio.run(web.api_account_whoami("xiaohongshu"))["loggedIn"] is False
    assert asyncio.run(web.api_account_whoami("xiaohongshu"))["loggedIn"] is False
    assert len(calls) == 1


def test_logout_endpoint_clears_only_temporary_login_and_active_context(isolated):
    root = seed("live")
    profile = web.BROWSER_PROFILES / web.LOGIN_RUNNERS["xiaohongshu"]["profile"]
    profile.mkdir()
    (profile / "test-session.txt").write_text("mock profile", encoding="utf-8")
    assert profile.resolve().is_relative_to(isolated.resolve())
    result = asyncio.run(web.api_logout("xiaohongshu"))
    assert result["ok"] and not profile.exists()
    assert not (web.LOGIN_DIR / "xiaohongshu.json").exists()
    assert ae.active_account(root) is None and ae.load(root, "live:test-account")
    assert asyncio.run(web.api_analytics_insights("xiaohongshu"))["suggestions"] == []


@pytest.mark.parametrize('platform', ['xiaohongshu', 'douyin', 'kuaishou', 'zhihu', 'weixin-channels', 'bilibili'])
def test_all_platforms_reject_delayed_whoami_after_logout(isolated, monkeypatch, platform):
    marker = web.LOGIN_DIR / f'{platform}.json'
    marker.write_text(json.dumps({'state': 'success', 'ts': int(time.time())}))
    if platform == 'bilibili':
        (isolated / 'cookies.json').write_text('synthetic cookie')
    def reply(*args, **kwargs):
        assert asyncio.run(web.api_logout(platform))['ok']
        return SimpleNamespace(stdout=json.dumps({'loggedIn': True, 'name': 'stale identity'}), stderr='', returncode=0)
    monkeypatch.setattr(web, '_run_owned_whoami', reply)
    with pytest.raises(web.HTTPException) as failure:
        asyncio.run(web.api_account_whoami(platform))
    assert failure.value.status_code == 409
    assert platform not in web._WHOAMI_CACHE
    assert not marker.exists()


def test_account_metadata_does_not_disclose_credentials(isolated):
    profile = web.BROWSER_PROFILES / 'DouyinProfile'
    profile.mkdir()
    (profile / 'cookie-secret').write_text('PRIVATE_COOKIE')
    (isolated / 'cookies.json').write_text('PRIVATE_BILI_COOKIE')
    web.WECHAT_CONFIG_YAML.write_text('accounts:\n  web:\n    app_id: PRIVATE_APP_ID\n    app_secret: PRIVATE_APP_SECRET\n', encoding='utf-8')
    stamp = int(time.time()) - 5
    (web.LOGIN_DIR / 'douyin.json').write_text(json.dumps({'state': 'success', 'ts': stamp}))
    result = asyncio.run(web.api_accounts())
    rows = {a['platform']: a for a in result}
    assert rows['douyin']['hasLocalSession'] and rows['douyin']['lastStateAt'] == stamp
    assert rows['douyin']['credentialStorage'] == 'browser_profile'
    assert rows['bilibili']['hasLocalSession'] and rows['bilibili']['credentialStorage'] == 'cookie_file'
    assert rows['wechat-oa']['hasLocalSession'] and rows['wechat-oa']['credentialStorage'] == 'app_credentials'
    assert 'PRIVATE_' not in json.dumps(result)


def test_logout_stops_only_selected_login_tree_before_deleting_profile(isolated, monkeypatch):
    from easel import install_runner
    profile = web.BROWSER_PROFILES / 'DouyinProfile'
    profile.mkdir()
    (profile / 'data').write_text('session')
    events = []
    class Process:
        def poll(self): return None
        def wait(self, timeout):
            events.append('wait')
            assert profile.exists()
    selected, unrelated = Process(), Process()
    web.LOGIN_PROCESSES.update(douyin=selected, kuaishou=unrelated)
    def stop(process):
        assert process is selected and profile.exists()
        events.append('stop')
    monkeypatch.setattr(install_runner, 'terminate_phase_tree', stop)
    assert asyncio.run(web.api_logout('douyin'))['ok']
    assert events == ['stop', 'wait'] and not profile.exists()
    assert web.LOGIN_PROCESSES == {'kuaishou': unrelated}


def test_delete_failure_is_not_reported_success(isolated, monkeypatch):
    profile = web.BROWSER_PROFILES / 'DouyinProfile'
    profile.mkdir()
    monkeypatch.setattr(web.shutil, 'rmtree', lambda *args, **kwargs: (_ for _ in ()).throw(PermissionError('occupied')))
    with pytest.raises(web.HTTPException) as failure:
        asyncio.run(web.api_logout('douyin'))
    assert failure.value.status_code == 500
    assert profile.exists() and 'douyin' not in web._ACCOUNT_CLEARING
    assert 'douyin' not in web._WHOAMI_CACHE


def test_process_stop_failure_keeps_credentials_and_reports_failure(isolated, monkeypatch):
    from easel import install_runner
    profile = web.BROWSER_PROFILES / 'DouyinProfile'
    profile.mkdir()
    process = SimpleNamespace(poll=lambda: None)
    web.LOGIN_PROCESSES['douyin'] = process
    monkeypatch.setattr(install_runner, 'terminate_phase_tree', lambda p: (_ for _ in ()).throw(RuntimeError('cleanup failed')))
    with pytest.raises(web.HTTPException) as failure:
        asyncio.run(web.api_logout('douyin'))
    assert failure.value.status_code == 500 and profile.exists()
    assert web.LOGIN_PROCESSES['douyin'] is process


def test_wechat_logout_preserves_other_account_and_unowned_default_token(isolated):
    import yaml
    web.WECHAT_SKILL_SCRIPTS.mkdir()
    config = {'default': 'other', 'accounts': {'web': {'app_id': 'mock-web', 'app_secret': 'mock-secret'},
                                               'other': {'app_id': 'keep-id', 'app_secret': 'keep-secret'}}}
    web.WECHAT_CONFIG_YAML.write_text(yaml.safe_dump(config))
    (web.WECHAT_SKILL_SCRIPTS / '.token_cache_web.json').write_text('web token')
    global_token = web.WECHAT_SKILL_SCRIPTS / '.token_cache.json'
    global_token.write_text('other default token')
    assert asyncio.run(web.api_logout('wechat-oa'))['ok']
    saved = yaml.safe_load(web.WECHAT_CONFIG_YAML.read_text())
    assert saved['accounts'] == {'other': config['accounts']['other']}
    assert saved['default'] == 'other' and global_token.exists()
    assert not (web.WECHAT_SKILL_SCRIPTS / '.token_cache_web.json').exists()


def test_api_rejects_new_login_while_selected_account_is_clearing(isolated):
    web._ACCOUNT_CLEARING.add('douyin')
    with pytest.raises(web.HTTPException) as failure:
        asyncio.run(web.api_login_start('douyin'))
    assert failure.value.status_code == 409


def test_queued_whoami_cannot_start_after_logout(isolated, monkeypatch):
    generation = web._account_check_generation('douyin')
    assert asyncio.run(web.api_logout('douyin'))['ok']
    monkeypatch.setattr(web.subprocess, 'Popen', lambda *a, **k: pytest.fail('stale worker must not launch browser'))
    with pytest.raises(web.HTTPException) as failure:
        web._run_owned_whoami('douyin', ['fake-command'], generation)
    assert failure.value.status_code == 409


def test_logout_stops_inflight_whoami_before_profile_removal(isolated, monkeypatch):
    from easel import install_runner
    profile = web.BROWSER_PROFILES / 'DouyinProfile'
    profile.mkdir()
    started, stopped = threading.Event(), threading.Event()
    class Process:
        returncode = None
        def __init__(self, *args, **kwargs):
            self.output = kwargs['stdout']
        def poll(self): return self.returncode
        def wait(self, timeout):
            started.set()
            assert stopped.wait(3)
            return self.returncode
    spawned = []
    def spawn(*args, **kwargs):
        child = Process(*args, **kwargs)
        spawned.append(child)
        return child
    def stop(child):
        assert child is spawned[0] and profile.exists()
        child.returncode = -15
        stopped.set()
    monkeypatch.setattr(web.subprocess, 'Popen', spawn)
    monkeypatch.setattr(install_runner, 'terminate_phase_tree', stop)
    async def exercise():
        whoami = asyncio.create_task(web.api_account_whoami('douyin'))
        assert await asyncio.to_thread(started.wait, 3)
        assert (await web.api_logout('douyin'))['ok']
        with pytest.raises(web.HTTPException) as failure:
            await whoami
        assert failure.value.status_code == 409
        assert not profile.exists() and not web._WHOAMI_PROCESSES
        assert 'douyin' not in web._WHOAMI_CACHE
    asyncio.run(exercise())


def test_malformed_wechat_credentials_cannot_report_successful_cleanup(isolated):
    web.WECHAT_CONFIG_YAML.write_text('accounts: [invalid yaml', encoding='utf-8')
    with pytest.raises(web.HTTPException) as failure:
        asyncio.run(web.api_logout('wechat-oa'))
    assert failure.value.status_code == 500 and web.WECHAT_CONFIG_YAML.exists()
