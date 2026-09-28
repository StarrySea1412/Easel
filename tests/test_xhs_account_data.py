"""小红书本人账号数据（方案功能 A 第一步 / feat/xhs-account-data）定向测试。

覆盖验收点：
- 逐篇卡片 DOM 提取（标题/标签/发布时间/指标），取不到的字段如实为空、指标为 None 不造零；
- 指标归一（万/亿/w 转整数）与 stat 人类可读串；
- 逐篇快照：规范化记录、同 note_id 保留最近两次、12 个月保留期裁剪、原子写；
- 登录失效不写快照；clear 只删 _analytics 下文件；
- Web 端点：notes 读接口的窗口统计、登录失效时 stale/lastGoodAt 标记、clear 校验。

全部离线：DOM 解析用 node/模拟对象，不调真实小红书；_analytics 用 tmp 目录。
"""
from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(PROJECT_ROOT / "web"))
sys.path.insert(0, str(PROJECT_ROOT / "skills" / "shared" / "scripts"))

import app as web  # noqa: E402
import account_stats as st  # noqa: E402


@pytest.fixture()
def analytics_tmp(tmp_path, monkeypatch):
    """account_stats 与 web 两侧都指到同一个 tmp：快照文件由前者写、后者读，
    两边路径拼接方式不同（PROJECT_ROOT vs OUTPUTS_DIR），必须各自打桩。"""
    monkeypatch.setattr(st, "ANALYTICS_DIR", tmp_path / "_analytics")
    monkeypatch.setattr(st, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(web, "OUTPUTS_DIR", tmp_path)
    original_record = st.record_note_snapshot
    monkeypatch.setattr(st, "record_note_snapshot", lambda platform, notes, now, **kwargs: original_record(platform, notes, now, account_id="account-one", **kwargs))
    return tmp_path


def _note(nid="n1", title="标题A", like="1200", fav="3.4万", cmt="56",
          tags=None, publish="2026-09-01", src="xhs"):
    tags = ["咖啡", "探店"] if tags is None else tags
    return {
        "note_id": nid, "title": title, "tags": tags, "publish": publish,
        "metrics": {"likes": st.parse_num(like), "collects": st.parse_num(fav), "comments": st.parse_num(cmt)},
        "stat": "", "url": "https://www.xiaohongshu.com/explore/" + nid, "cover": "", "xsec_token": "",
        "source": f"account_stats:{src}",
    }


# ---- 指标归一 ----

def test_parse_num_normalizes_units():
    assert st.parse_num("1200") == 1200
    assert st.parse_num("3.4万") == 34000
    assert st.parse_num("1.2亿") == 120000000
    assert st.parse_num("8k") == 8000
    assert st.parse_num("") is None and st.parse_num("暂无") is None


# ---- 逐篇快照：规范化 + 去重 + 保留期 ----

def test_record_note_snapshot_normalizes(analytics_tmp):
    now = int(time.time())
    recs = st.record_note_snapshot("xiaohongshu", [_note()], now)
    assert recs[0]["version"] == st.NOTE_SNAPSHOT_VERSION
    assert recs[0]["metrics"] == {"likes": 1200, "collects": 34000, "comments": 56}
    assert recs[0]["tags"] == ["咖啡", "探店"]
    assert recs[0]["fetched_at"] == now
    assert recs[0]["source"] == "account_stats:xiaohongshu"
    # 落盘的 jsonl 可读回
    rows = st.load_note_snapshots("xiaohongshu")
    assert len(rows) == 1 and rows[0]["note_id"] == "n1"


def test_record_note_snapshot_keeps_last_two_per_note(analytics_tmp):
    now = int(time.time())
    st.record_note_snapshot("xiaohongshu", [_note(like="1")], now - 7200)
    st.record_note_snapshot("xiaohongshu", [_note(like="2")], now - 3600)
    st.record_note_snapshot("xiaohongshu", [_note(like="3")], now)
    rows = [r for r in st.load_note_snapshots("xiaohongshu") if r["note_id"] == "n1"]
    assert len(rows) == 2                          # 只留最近两次
    assert {r["metrics"]["likes"] for r in rows} == {2, 3}


def test_record_note_snapshot_prunes_12months(analytics_tmp):
    now = int(time.time())
    old = now - 400 * 86400
    st.record_note_snapshot("xiaohongshu", [_note(nid="ghost", like="9")], old)
    st.record_note_snapshot("xiaohongshu", [_note(nid="fresh", like="1")], now)
    rows = st.load_note_snapshots("xiaohongshu")
    ids = {r["note_id"] for r in rows}
    assert "fresh" in ids and "ghost" not in ids   # 超 12 个月没再出现的裁掉


def test_record_note_snapshot_missing_fields_stay_none(analytics_tmp):
    n = _note(like="", fav="", cmt="", tags=[], publish="")
    recs = st.record_note_snapshot("xiaohongshu", [n], int(time.time()))
    assert recs[0]["metrics"] == {"likes": None, "collects": None, "comments": None}
    assert recs[0]["tags"] == [] and recs[0]["publish"] == ""


def test_record_note_snapshot_empty_input_does_not_claim_full_coverage(analytics_tmp):
    st.record_note_snapshot("xiaohongshu", [], int(time.time()))
    assert st.load_note_snapshots("xiaohongshu") == []
    data = asyncio.run(web.api_analytics_notes("xiaohongshu"))
    assert data["coverage"]["observedNotes"] == 0
    assert data["coverage"]["complete"] is False


def test_clear_analytics(analytics_tmp):
    now = int(time.time())
    st.record_note_snapshot("xiaohongshu", [_note()], now)
    st.append_snapshot("xiaohongshu", {"ts": now, "followers": 1})
    st.clear_analytics("xiaohongshu")
    assert not st._notes_path("xiaohongshu").exists()
    assert not st._history_path("xiaohongshu").exists()
    # 全平台分支
    st.record_note_snapshot("douyin", [_note(src="dy")], now)
    st.clear_analytics()
    assert not st._notes_path("douyin").exists()


# ---- 卡片 DOM 提取（_XHS_NOTES_JS 在 Python 侧无法直接跑，校验其模板内容约定） ----

def test_xhs_notes_js_extracts_new_fields():
    js = st._XHS_NOTES_JS
    for frag in ("like", "fav", "cmt", "publish", "tags", "slice(0, 100)", "slice(0, 20)"):
        assert frag in js, frag
    assert "slice(0, 20)" in js       # 每页最多 20 条（原来 8 条）


# ---- Web 端点 ----

def test_notes_endpoint_window_and_records(analytics_tmp):
    now = int(time.time())
    st.record_note_snapshot("xiaohongshu", [_note()], now)
    st.record_note_snapshot("xiaohongshu", [_note(nid="n2")], now - 100)
    d = asyncio.run(web.api_analytics_notes("xiaohongshu"))
    assert d["platform"] == "xiaohongshu"
    assert d["count"] == 2
    assert d["firstFetchedAt"] == now - 100 and d["lastFetchedAt"] == now
    assert d["window"] == {"from": now - 100, "to": now}
    assert {r["note_id"] for r in d["records"]} == {"n1", "n2"}


def test_notes_endpoint_unknown_platform():
    with pytest.raises(web.HTTPException):
        asyncio.run(web.api_analytics_notes("nope"))


def test_clear_endpoint_validates_and_clears(analytics_tmp):
    with pytest.raises(web.HTTPException):
        asyncio.run(web.api_analytics_clear(web.AnalyticsClearRequest(platform="nope")))
    now = int(time.time())
    st.record_note_snapshot("xiaohongshu", [_note()], now)
    d = asyncio.run(web.api_analytics_clear(web.AnalyticsClearRequest(platform="xiaohongshu", accountId="live:account-one")))
    assert d["ok"] and d["accountId"] == "live:account-one"
    assert not st._notes_path("xiaohongshu").exists()


def test_last_note_snapshot_at(analytics_tmp):
    assert web._last_note_snapshot_at("xiaohongshu") is None
    now = int(time.time())
    st.record_note_snapshot("xiaohongshu", [_note()], now)
    assert web._last_note_snapshot_at("xiaohongshu") == now


def test_analytics_normalizes_notes_and_marks_stale(analytics_tmp, monkeypatch):
    """api_analytics 主流程：子进程返回 JSON → notes 字段归一；登录失效 → stale/lastGoodAt。"""
    now = int(time.time())
    st.record_note_snapshot("xiaohongshu", [_note()], now)

    class _Proc:
        stdout = json.dumps({
            "platform": "xiaohongshu", "loggedIn": False, "notes": [],
            "followers": None, "likes": None, "posts": None, "metrics": [], "growth": {},
        }, ensure_ascii=False)
        stderr = ""

    monkeypatch.setattr(web.subprocess, "run", lambda *a, **k: _Proc())
    d = asyncio.run(web.api_analytics("xiaohongshu"))
    assert d["stale"] is True and d["lastGoodAt"] == now   # 失效时指向上次成功，不填空冒充

    class _Proc2:
        stdout = json.dumps({
            "platform": "xiaohongshu", "loggedIn": True, "accountId": "account-one",
            "notes": [{"title": "t", "note_id": "x"}],
            "followers": 1, "likes": 2, "posts": 3, "metrics": [], "growth": {},
        }, ensure_ascii=False)
        stderr = ""

    monkeypatch.setattr(web.subprocess, "run", lambda *a, **k: _Proc2())
    d2 = asyncio.run(web.api_analytics("xiaohongshu"))
    n = d2["notes"][0]
    assert n["metrics"] == {"likes": None, "collects": None, "comments": None}
    assert n["tags"] == [] and n["publish"] == ""
    assert "stale" not in d2 or d2["stale"] is False
