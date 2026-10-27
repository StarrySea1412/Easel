"""Focused whoami endpoint coverage using the current owned-process contract."""
import asyncio
import json
import threading
import time
from types import SimpleNamespace

import pytest

import web.app as web


@pytest.fixture
def account_state(tmp_path, monkeypatch):
    outputs = tmp_path / "outputs"
    login_dir = outputs / "_login"
    profiles = tmp_path / "browser-profiles"
    monkeypatch.setattr(web, "DATA_DIR", tmp_path)
    monkeypatch.setattr(web, "OUTPUTS_DIR", outputs)
    monkeypatch.setattr(web, "LOGIN_DIR", login_dir)
    monkeypatch.setattr(web, "PUBLISH_DIR", outputs / "_publish")
    monkeypatch.setattr(web, "BROWSER_PROFILES", profiles)
    monkeypatch.setattr(web, "_WHOAMI_CACHE", {})
    monkeypatch.setattr(web, "_WHOAMI_PROCESSES", {})
    monkeypatch.setattr(web, "_ACCOUNT_GENERATIONS", {})
    monkeypatch.setattr(web, "_ACCOUNT_CLEARING", set())
    monkeypatch.setattr(web, "LOGIN_PROCESSES", {})
    monkeypatch.setattr(web, "_PUBLISH_LOCK", threading.RLock())
    monkeypatch.setattr(web, "_PUBLISH_ACTIVE", {})
    monkeypatch.setattr(web, "_proxy_env", lambda: {})
    login_dir.mkdir(parents=True)
    profiles.mkdir()
    web._write_login_marker("xiaohongshu", "success")
    return tmp_path


def completed(payload, returncode=0):
    return SimpleNamespace(stdout=json.dumps(payload), stderr="", returncode=returncode)


def test_whoami_does_not_start_browser_while_login_owns_profile(account_state, monkeypatch):
    web.LOGIN_PROCESSES["xiaohongshu"] = SimpleNamespace(poll=lambda: None)
    monkeypatch.setattr(web.subprocess, "Popen", lambda *args, **kwargs: pytest.fail("login owns profile"))
    with pytest.raises(web.HTTPException) as error:
        asyncio.run(web.api_account_whoami("xiaohongshu"))
    assert error.value.status_code == 409
    assert not web._WHOAMI_CACHE


@pytest.mark.parametrize(
    ("platform", "script", "argument"),
    [
        ("weixin-channels", "web_publisher.py", "weixin-channels"),
        ("wechat-oa", "weixin_mp_stats.py", "whoami"),
    ],
)
def test_whoami_uses_platform_runner_and_backend_identity(account_state, monkeypatch, platform, script, argument):
    web._write_login_marker(platform, "success")
    commands = []

    def run(_platform, command, _generation):
        commands.append(command)
        return completed({"loggedIn": True, "name": "Backend identity", "avatar": "https://self.test/me.png"})

    monkeypatch.setattr(web, "_run_owned_whoami", run)
    result = asyncio.run(web.api_account_whoami(platform, force=True))
    assert result["name"] == "Backend identity"
    assert result["avatar"] == "https://self.test/me.png"
    assert script in commands[0][1]
    assert argument in commands[0]


def test_expired_wechat_browser_is_not_faked_by_app_credentials(account_state, monkeypatch):
    web._write_login_marker("wechat-oa", "success")
    monkeypatch.setattr(web, "_wechat_has_credentials", lambda: True)
    monkeypatch.setattr(web, "_run_owned_whoami", lambda *args: completed(
        {"loggedIn": False, "reason": "auth_expired"}))
    result = asyncio.run(web.api_account_whoami("wechat-oa", force=True))
    assert result["loggedIn"] is False and result["verified"] is True
    assert not web._account_logged_in("wechat-oa", web.LOGIN_RUNNERS["wechat-oa"])


def test_whoami_timeout_preserves_marker_and_does_not_cache_empty_identity(account_state, monkeypatch):
    monkeypatch.setattr(web, "_run_owned_whoami", lambda *args: (_ for _ in ()).throw(
        web.subprocess.TimeoutExpired("whoami", 150)))
    with pytest.raises(web.HTTPException) as error:
        asyncio.run(web.api_account_whoami("xiaohongshu", force=True))
    assert error.value.status_code == 504
    assert not web._WHOAMI_CACHE
    assert (account_state / "outputs" / "_login" / "xiaohongshu.json").exists()


def test_unknown_reply_preserves_last_verified_identity_without_caching(account_state, monkeypatch):
    marker = account_state / "outputs" / "_login" / "xiaohongshu.json"
    initial = marker.read_bytes()
    monkeypatch.setattr(web, "_run_owned_whoami", lambda *args: completed(
        {"loggedIn": False, "error": "maintenance"}))
    result = asyncio.run(web.api_account_whoami("xiaohongshu", force=True))
    assert result["loggedIn"] is True and result["authState"] == "unknown"
    assert result["verified"] is False
    assert not web._WHOAMI_CACHE and marker.read_bytes() == initial


def test_force_check_bypasses_current_cache_and_refreshes_identity(account_state, monkeypatch):
    platform = "xiaohongshu"
    identity = {"loggedIn": False, "name": "", "avatar": "", "identityKey": web._account_identity_key(platform)}
    generation = web._account_check_generation(platform)
    web._WHOAMI_CACHE[platform] = (time.time(), identity, generation)
    calls = []

    def run(*args):
        calls.append(True)
        return completed({"loggedIn": True, "name": "Current account"})

    monkeypatch.setattr(web, "_run_owned_whoami", run)
    assert asyncio.run(web.api_account_whoami(platform))["loggedIn"] is False
    assert not calls
    assert asyncio.run(web.api_account_whoami(platform, force=True))["name"] == "Current account"
    assert len(calls) == 1


def test_confident_logout_expires_marker_and_caches_verified_result(account_state, monkeypatch):
    monkeypatch.setattr(web, "_run_owned_whoami", lambda *args: completed(
        {"loggedIn": False, "reason": "login_required"}))
    result = asyncio.run(web.api_account_whoami("xiaohongshu", force=True))
    assert result["loggedIn"] is False and result["verified"] is True
    marker = json.loads((account_state / "outputs" / "_login" / "xiaohongshu.json").read_text(encoding="utf-8"))
    assert marker["state"] == "expired"
    assert web._WHOAMI_CACHE["xiaohongshu"][1]["verified"] is True


def test_changed_account_generation_rejects_late_identity(account_state, monkeypatch):
    marker = account_state / "outputs" / "_login" / "xiaohongshu.json"
    initial = marker.read_bytes()

    def late_result(platform, command, generation):
        web._ACCOUNT_GENERATIONS[platform] = "new-login"
        return completed({"loggedIn": True, "name": "Old account"})

    monkeypatch.setattr(web, "_run_owned_whoami", late_result)
    with pytest.raises(web.HTTPException) as error:
        asyncio.run(web.api_account_whoami("xiaohongshu", force=True))
    assert error.value.status_code == 409
    assert marker.read_bytes() == initial and not web._WHOAMI_CACHE


def test_concurrent_checks_never_launch_two_profile_writers(account_state, monkeypatch):
    started, release = threading.Event(), threading.Event()

    class Process:
        returncode = None

        def wait(self, timeout):
            started.set()
            assert release.wait(timeout=3)
            return self.returncode

        def poll(self):
            return self.returncode

    def spawn(command, **options):
        options["stdout"].write(b'{"loggedIn":true,"name":"Me"}')
        options["stdout"].flush()
        return Process()

    monkeypatch.setattr(web.subprocess, "Popen", spawn)

    async def check():
        first = asyncio.create_task(web.api_account_whoami("xiaohongshu", force=True))
        assert await asyncio.to_thread(started.wait, 3)
        with pytest.raises(web.HTTPException) as error:
            await web.api_account_whoami("xiaohongshu", force=True)
        assert error.value.status_code == 409
        release.set()
        result = await first
        return result

    result = asyncio.run(check())
    assert result["name"] == "Me"
    assert not web._WHOAMI_PROCESSES
