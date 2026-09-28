"""Offline evidence and account-boundary regression tests; no platform access."""
import asyncio
import json
import sys
import time
from pathlib import Path
from types import SimpleNamespace, ModuleType

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "web"), str(ROOT / "skills/shared/scripts")]
import account_evidence as ae
import account_stats as st
import app as web
import xhs_insights as xi


@pytest.fixture
def local(tmp_path, monkeypatch):
    monkeypatch.setattr(web, "OUTPUTS_DIR", tmp_path)
    monkeypatch.setattr(web, "IDEAS_FILE", tmp_path / "_ideas.json")
    monkeypatch.setattr(st, "ANALYTICS_DIR", tmp_path / "_analytics")
    return tmp_path / "_analytics"


def note(nid="note1", **changes):
    return {"note_id": nid, "title": "咖啡探店指南", "tags": ["咖啡"], "publish": "2026-09-01",
            "url": f"https://www.xiaohongshu.com/explore/{nid}",
            "metrics": {"likes": "1.2万", "collects": None, "comments": 0}, **changes}


def import_notes(account="alice", records=None):
    return asyncio.run(web.api_analytics_import(web.AnalyticsImportRequest(
        accountId=account, records=records or [note()])))


def test_unknown_owner_and_legacy_data_never_assigned(local):
    local.mkdir()
    (local / "xiaohongshu-notes.jsonl").write_text(json.dumps({"version": 2, **note()}), encoding="utf-8")
    assert st.record_note_snapshot("xiaohongshu", [note()], int(time.time())) == []
    data = asyncio.run(web.api_analytics_insights("xiaohongshu"))
    assert data["suggestions"] == [] and data["accountRequired"]
    assert data["legacyDataExcluded"]


def test_imported_identity_is_separate_from_live_and_other_accounts(local):
    now = int(time.time())
    ae.ingest(local, [note("same", metrics={"likes": 1})], "alice", now, source="live")
    imported = import_notes(records=[note("same", metrics={"likes": 999})])
    assert imported["account"] == {"id": "import:alice", "externalId": "alice", "source": "import", "name": "", "verified": False}
    assert ae.load(local, "live:alice")[0]["metrics"]["likes"] == 1
    assert ae.load(local)[0]["metrics"]["likes"] == 999
    import_notes("bob", [note("other")])
    assert {r["note_id"] for r in ae.load(local)} == {"other"}
    assert ae.load(local, "import:alice")[0]["note_id"] == "same"


def test_import_missing_capture_date_is_not_replaced_with_import_time(local):
    result = import_notes()
    row = result["records"][0]
    assert row["fetched_at"] is None and isinstance(row["imported_at"], int)
    assert row["published_at"] == "2026-09-01T00:00:00"
    assert "fetchedAt" in row["missing_fields"]
    assert result["window"] is None and not result["coverage"]["complete"]
    assert result["coverage"]["pagesFetched"] is None
    assert "未经平台验证" in result["coverage"]["reason"]


def test_complete_refs_preserve_all_notes_and_long_ids(local):
    rows = [note("a" * 40 + str(i), fetched_at=int(time.time()), publish="昨天") for i in range(12)]
    import_notes(records=rows)
    insights = asyncio.run(web.api_analytics_insights("xiaohongshu"))
    suggestion = next(s for s in insights["suggestions"] if s["word"] == "咖啡")
    assert suggestion["sampleSize"] == len(suggestion["refs"]) == 12
    assert suggestion["metric"] == 12000 and suggestion["confidence"] == "exploratory"
    ref = suggestion["refs"][0]
    assert len(ref["noteId"]) == 41
    assert ref["metrics"] == {"likes": 12000, "collects": None, "comments": 0}
    assert ref["metricsRaw"]["likes"] == "1.2万"
    assert ref["publish"] == "昨天" and ref["publishedAt"] is None
    assert ref["fetchedAt"] and ref["url"].startswith("https://www.xiaohongshu.com/explore/")
    assert "metrics.collects" in ref["missingFields"] and "publishedAt" in ref["missingFields"]


def test_repeated_title_token_is_not_two_notes(monkeypatch):
    monkeypatch.setattr(xi, "_tokens", lambda _: ["咖啡", "咖啡", "咖啡"])
    assert xi.extract_candidates([note(tags=[])]) == {}
    assert "咖啡" in xi.extract_candidates([note("one", tags=[]), note("two", tags=[])])


def test_idea_saves_evidence_and_deduplicates_within_account(local):
    import_notes()
    request = web.InsightIdeaRequest(accountId="import:alice", word="咖啡")
    result = asyncio.run(web.api_insights_idea(request))
    evidence = result["idea"]["analysisEvidence"]
    assert evidence["account"]["id"] == "import:alice"
    assert evidence["refs"][0]["metrics"]["likes"] == 12000
    with pytest.raises(web.HTTPException) as failure:
        asyncio.run(web.api_insights_idea(request))
    assert failure.value.status_code == 409 and "已在选题库" in failure.value.detail
    import_notes("bob")
    with pytest.raises(web.HTTPException) as failure:
        asyncio.run(web.api_insights_idea(request))
    assert failure.value.status_code == 409 and "账号已切换" in failure.value.detail
    asyncio.run(web.api_insights_idea(web.InsightIdeaRequest(accountId="import:bob", word="咖啡")))
    assert len(web._read_ideas()) == 2


def test_clear_only_active_account_preserves_other_owner_and_login(local):
    import_notes("alice")
    import_notes("bob")
    login = local.parent / "_login" / "xiaohongshu.json"
    login.parent.mkdir()
    login.write_text("test login marker", encoding="utf-8")
    with pytest.raises(web.HTTPException) as failure:
        asyncio.run(web.api_analytics_clear(web.AnalyticsClearRequest(accountId="import:alice")))
    assert failure.value.status_code == 409
    result = asyncio.run(web.api_analytics_clear(web.AnalyticsClearRequest(accountId="import:bob")))
    assert result["deletedCount"] == 2 and result["accountId"] == "import:bob"
    assert ae.load(local, "import:alice") and not ae.load(local, "import:bob")
    assert ae.active_account(local) is None and login.read_text() == "test login marker"


def test_clear_does_not_default_to_all_accounts(local):
    import_notes()
    with pytest.raises(web.HTTPException) as failure:
        asyncio.run(web.api_analytics_clear(web.AnalyticsClearRequest()))
    assert failure.value.status_code == 400 and ae.load(local)
    asyncio.run(web.api_analytics_clear(web.AnalyticsClearRequest(scope="platform")))
    assert ae.load(local, "import:alice") == []


def test_retention_applies_even_before_another_fetch(local):
    now = int(time.time())
    ae.ingest(local, [note()], "alice", now - 400 * 86400)
    assert ae.load(local) == []
    assert (ae.account_dir(local, "live:alice") / "notes.jsonl").read_text(encoding="utf-8") == ""
    assert asyncio.run(web.api_analytics_insights("xiaohongshu"))["sampleSize"] == 0


def test_live_coverage_is_only_visible_page(local):
    ae.ingest(local, [note(str(i)) for i in range(20)], "alice", int(time.time()))
    data = asyncio.run(web.api_analytics_notes("xiaohongshu"))
    assert data["coverage"]["pagesFetched"] == 1 and data["coverage"]["pageLimit"] == 20
    assert not data["coverage"]["complete"] and "未执行分页" in data["coverage"]["reason"]


@pytest.mark.parametrize("value", [True, -1, "3.4万赞", float("inf"), "无", "-", "1.2万/天"])
def test_missing_or_ambiguous_metrics_never_become_zero(value):
    assert ae.metric_value(value) is None


@pytest.mark.parametrize("change", [{"note_id": "../outside"}, {"account_id": "different"},
                                   {"tags": "咖啡"}, {"url": "https://www.xiaohongshu.com/explore/different"}])
def test_invalid_import_is_atomic(local, change):
    import_notes()
    old_generation = ae.generation(local)
    with pytest.raises(web.HTTPException) as failure:
        import_notes("bob", [note("valid"), note(**change)])
    assert failure.value.status_code == 400
    assert ae.generation(local) == old_generation and ae.active_account(local)["id"] == "import:alice"
    assert ae.load(local, "import:bob") == []


def test_private_link_query_is_not_persisted(local):
    data = import_notes(records=[note(url="https://www.xiaohongshu.com/explore/note1?xsec_token=test-secret")])
    assert data["records"][0]["url"] == "https://www.xiaohongshu.com/explore/note1"
    assert "test-secret" not in (ae.account_dir(local, "import:alice") / "notes.jsonl").read_text(encoding="utf-8")


def test_scrape_reply_cannot_restore_context_after_clear(local, monkeypatch):
    import_notes()
    def response(*args, **kwargs):
        assert kwargs["env"]["EASEL_ANALYTICS_MANAGED"] == "1"
        ae.clear(local, "import:alice")
        return SimpleNamespace(stdout=json.dumps({"loggedIn": True, "accountId": "alice", "notes": [note()]}), stderr="")
    monkeypatch.setattr(web.subprocess, "run", response)
    with pytest.raises(web.HTTPException) as failure:
        asyncio.run(web.api_analytics("xiaohongshu"))
    assert failure.value.status_code == 409
    assert ae.active_account(local) is None and ae.load(local, "live:alice") == []


def test_scrape_without_account_id_invalidates_previous_evidence(local, monkeypatch):
    import_notes()
    monkeypatch.setattr(web.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(
        stdout=json.dumps({"loggedIn": True, "notes": [note()]}), stderr=""))
    result = asyncio.run(web.api_analytics("xiaohongshu"))
    assert result["accountRequired"] and not result["account"]
    assert asyncio.run(web.api_analytics_insights("xiaohongshu"))["suggestions"] == []


def test_account_identity_comes_only_from_explicit_creator_label():
    assert st.extract_xhs_account_id(["小红书账号: account123", "昵称"]) == "account123"
    assert st.extract_xhs_account_id(["小红书号", "account123"]) == "account123"
    assert st.extract_xhs_account_id(["相同昵称", "粉丝", "1234"]) == ""
    assert st.extract_xhs_account_id(["小红书号: account123", "小红书号: account456"]) == ""


def test_live_login_expiry_preserves_unverified_import_context(local):
    import_notes()
    before = ae.generation(local)
    web.invalidate_account_context("xiaohongshu", live_only=True)
    assert ae.generation(local) == before
    assert asyncio.run(web.api_analytics_insights("xiaohongshu"))["sampleSize"] == 1
    result = asyncio.run(web.api_insights_idea(web.InsightIdeaRequest(accountId="import:alice", word="咖啡")))
    assert result["idea"]["source"] == "小红书导入数据分析"
    assert "未经平台验证" in result["idea"]["note"]
    ae.ingest(local, [note()], "alice", int(time.time()))
    web.invalidate_account_context("xiaohongshu", live_only=True)
    assert ae.active_account(local) is None


def test_live_unidentified_cards_are_excluded_with_omission_count(local):
    ae.ingest(local, [note(), {"title": "无身份卡片", "metrics": {"likes": 99}}], "alice", int(time.time()))
    data = asyncio.run(web.api_analytics_notes("xiaohongshu"))
    assert data["count"] == 1 and data["coverage"]["omittedNotes"] == 1


def test_managed_scraper_returns_data_without_mutating_account_files(local, monkeypatch, capsys):
    import_notes()
    before = {path: path.read_bytes() for path in local.rglob("*") if path.is_file()}
    monkeypatch.setenv("EASEL_ANALYTICS_MANAGED", "1")
    monkeypatch.setitem(sys.modules, "playwright", ModuleType("playwright"))
    monkeypatch.setitem(sys.modules, "playwright.sync_api", ModuleType("playwright.sync_api"))
    monkeypatch.setattr(st, "_scrape", lambda *args: {"account_id": "bob", "nickname": "Bob",
        "logged_in": True, "followers": 1, "likes": 2, "posts": 3, "following": 4,
        "metrics": [], "notes": [note()]})
    result = st.cmd_fetch(SimpleNamespace(platform="xiaohongshu", no_proxy=True, proxy=None,
                                         headed=False, profile_base=None))
    assert result == 0
    data = json.loads(capsys.readouterr().out)
    assert data["accountId"] == "bob" and data["noteSnapshotCount"] == 0
    assert {path: path.read_bytes() for path in local.rglob("*") if path.is_file()} == before
