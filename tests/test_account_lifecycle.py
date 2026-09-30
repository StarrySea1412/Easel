"""Exercise real account endpoints against temporary state and mocked browser runners."""
import asyncio
import json
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "web"), str(ROOT / "skills/shared/scripts")]
import account_evidence as ae
import app as web


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(web, "OUTPUTS_DIR", tmp_path / "outputs")
    monkeypatch.setattr(web, "LOGIN_DIR", tmp_path / "outputs" / "_login")
    monkeypatch.setattr(web, "BROWSER_PROFILES", tmp_path / "browser-profiles")
    monkeypatch.setattr(web, "_WHOAMI_CACHE", {})
    monkeypatch.setattr(web, "LOGIN_PROCESSES", {})
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
    monkeypatch.setattr(web.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(
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
    monkeypatch.setattr(web.subprocess, "run", delayed_reply)
    with pytest.raises(web.HTTPException) as failure:
        asyncio.run(web.api_account_whoami("xiaohongshu"))
    assert failure.value.status_code == 409
    assert ae.active_account(root)["id"] == "live:new-account"
    assert marker.read_text(encoding="utf-8") == "new-login-marker"
    assert "xiaohongshu" not in web._WHOAMI_CACHE


def test_whoami_browser_failure_keeps_last_known_identity(isolated, monkeypatch):
    root = seed("live")
    before = ae.generation(root)
    monkeypatch.setattr(web.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(
        stdout=json.dumps({"loggedIn": False, "error": "mock browser unavailable"}), stderr=""))
    result = asyncio.run(web.api_account_whoami("xiaohongshu"))
    assert result["loggedIn"] is True
    assert ae.generation(root) == before and "xiaohongshu" not in web._WHOAMI_CACHE
    assert (web.LOGIN_DIR / "xiaohongshu.json").exists()


@pytest.mark.parametrize("payload,returncode", [({}, 0), ({"loggedIn": "false"}, 0), ({"loggedIn": False}, 1)])
def test_unreliable_whoami_reply_does_not_invalidate_identity(isolated, monkeypatch, payload, returncode):
    root = seed("live")
    before = ae.generation(root)
    monkeypatch.setattr(web.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(
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

    monkeypatch.setattr(web.subprocess, "run", reply)
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

    monkeypatch.setattr(web.subprocess, "run", reply)
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
