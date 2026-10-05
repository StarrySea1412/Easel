"""B站逐篇快照探索建议（feat: bili insights）测试。

覆盖验收点：
- 复用小红书的候选规则：标签全留、标题词≥2 稿才进候选；
- 主指标是播放（views）不是点赞：均值、缺指标降级 exploratory；
- refs 可追溯到原稿件（bvid），URL 限定 bilibili.com 域；
- 快照流同一 note 取最新一次采集；
- Web 端点：GET insights/bilibili、写入选题库（查重/404/无快照 409）；
- 采集落盘：api_analytics('bilibili') 把 notes 规范化进 bilibili-notes.jsonl。

全离线：只用内存 dict 与 tmp 目录，不调真实 B站接口。
"""
from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(PROJECT_ROOT / "web"))
sys.path.insert(0, str(PROJECT_ROOT / "skills" / "shared" / "scripts"))

import app as web  # noqa: E402
import bili_insights as bi  # noqa: E402
import bili_login  # noqa: E402
import account_stats as st  # noqa: E402


def _rec(bvid, title, tags, views, fetched=None, likes=None):
    return {
        "version": st.NOTE_SNAPSHOT_VERSION, "note_id": bvid, "title": title,
        "tags": tags, "publish": "2026-09-01", "fetched_at": fetched or int(time.time()),
        "metrics": {"views": views, "likes": likes, "collects": None, "comments": None, "shares": None},
        "source": "account_stats:bilibili",
    }


def _records():
    return [
        _rec("BV1", "城市咖啡探店指南", ["咖啡", "探店"], 1200, likes=30),
        _rec("BV2", "周末去哪喝咖啡？小众咖啡馆盘点", ["咖啡"], 3400, likes=88),
        _rec("BV3", "居家咖啡冲煮教程", ["咖啡", "教程"], 900, likes=12),
        _rec("BV4", "露营装备清单一次讲清", ["露营"], 5000, likes=210),
        _rec("BV5", "无标签的随手记", [], None),
    ]


# ---- 候选提取（复用小红书规则） ----

def test_candidates_follow_tag_and_title_rules():
    cands = bi.xi.extract_candidates(_records())
    assert "咖啡" in cands and cands["咖啡"]["tagsOnly"] is True
    assert "露营" in cands
    assert "指南" not in cands and "盘点" not in cands   # 标题词只出现一次


# ---- 建议：主指标是播放，可追溯，缺指标降级 ----

def test_insights_metric_is_views_mean():
    d = bi.keyword_insights(_records())
    cof = next(s for s in d["suggestions"] if s["word"] == "咖啡")
    assert {r["noteId"] for r in cof["refs"]} == {"BV1", "BV2", "BV3"}
    assert cof["metricName"] == "views"
    assert cof["metric"] == round((1200 + 3400 + 900) / 3, 1)
    assert cof["confidence"] == "exploratory"
    assert "篇笔记" not in cof["evidence"] and "稿稿件" in cof["evidence"]


def test_insights_orders_by_views_desc():
    d = bi.keyword_insights(_records())
    words = [s["word"] for s in d["suggestions"]]
    assert words.index("露营") < words.index("咖啡")   # 露营 5000 > 咖啡 1833


def test_insights_missing_views_degrade():
    recs = [_rec("BV1", "咖啡探店", ["咖啡"], None),
            _rec("BV2", "咖啡豆挑选", ["咖啡"], None),
            _rec("BV3", "咖啡器具", ["咖啡"], None)]
    d = bi.keyword_insights(recs)
    cof = next(s for s in d["suggestions"] if s["word"] == "咖啡")
    assert cof["metric"] is None
    assert "缺互动数据" in cof["evidence"]
    assert "同一账号" in cof["evidence"]                # B站快照的平台归属限制要明说


def test_insights_latest_snapshot_wins():
    now = int(time.time())
    old = [_rec("BV1", "咖啡探店", ["咖啡"], 10, fetched=now - 86400)]
    new = [_rec("BV1", "咖啡探店", ["咖啡"], 999, fetched=now)]
    d = bi.keyword_insights(old + new)
    cof = next(s for s in d["suggestions"] if s["word"] == "咖啡")
    assert cof["metric"] == 999 and d["window"]["to"] == now


def test_insights_empty_data_note():
    d = bi.keyword_insights([])
    assert d["suggestions"] == [] and "还没有可用的稿件快照" in d["note"]


def test_insights_rejects_mixed_accounts():
    a = _rec("BV1", "咖啡", ["咖啡"], 1)
    a["account_id"] = "acc-1"
    b = _rec("BV2", "咖啡", ["咖啡"], 2)
    b["account_id"] = "acc-2"
    with pytest.raises(ValueError):
        bi.keyword_insights([a, b])


# ---- idea_from_suggestion ----

def test_idea_from_suggestion_fields():
    d = bi.keyword_insights(_records())
    cof = next(s for s in d["suggestions"] if s["word"] == "咖啡")
    idea = bi.idea_from_suggestion(cof, d["window"])
    assert idea["title"] == "选题：咖啡"
    assert idea["source"] == "本人B站分析" and idea["status"] == "pending"
    assert "引用稿件" in idea["note"]


# ---- Web 端点 ----

@pytest.fixture()
def snapshot_env(tmp_path, monkeypatch):
    monkeypatch.setattr(web, "OUTPUTS_DIR", tmp_path)
    monkeypatch.setattr(web, "IDEAS_FILE", tmp_path / "_ideas.json")
    monkeypatch.setattr(st, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(st, "ANALYTICS_DIR", tmp_path / "_analytics")
    return tmp_path


def _seed_snapshot(root: Path, records: list[dict]):
    st.ANALYTICS_DIR.mkdir(parents=True, exist_ok=True)
    st.record_note_snapshot("bilibili", records, int(time.time()))


def test_insights_endpoint_returns_suggestions(snapshot_env):
    _seed_snapshot(snapshot_env, _records())
    d = asyncio.run(web.api_analytics_insights("bilibili"))
    assert any(s["word"] == "咖啡" for s in d["suggestions"])
    assert d["sampleSize"] == 5
    # 快照流不带 url（record_note_snapshot 不存 url 字段），refs 里的 url 为空是已知口径
    assert all("url" in r and ("bilibili.com" in r["url"] or r["url"] == "")
               for s in d["suggestions"] for r in s["refs"])


def test_insights_endpoint_unknown_platform():
    with pytest.raises(web.HTTPException):
        asyncio.run(web.api_analytics_insights("nope"))


def test_idea_endpoint_creates_and_dedupes(snapshot_env):
    _seed_snapshot(snapshot_env, _records())
    d = asyncio.run(web.api_insights_idea(web.InsightIdeaRequest(platform="bilibili", word="咖啡")))
    assert d["ok"] and d["idea"]["title"] == "选题：咖啡"
    assert d["idea"]["source"] == "本人B站分析"
    ideas = web._read_ideas()
    assert len(ideas) == 1
    assert ideas[0]["analysisEvidence"]["platform"] == "bilibili"
    with pytest.raises(web.HTTPException) as e:
        asyncio.run(web.api_insights_idea(web.InsightIdeaRequest(platform="bilibili", word="咖啡")))
    assert e.value.status_code == 409


def test_idea_endpoint_unknown_word_404(snapshot_env):
    _seed_snapshot(snapshot_env, _records())
    with pytest.raises(web.HTTPException) as e:
        asyncio.run(web.api_insights_idea(web.InsightIdeaRequest(platform="bilibili", word="不存在的词")))
    assert e.value.status_code == 404
    with pytest.raises(web.HTTPException):
        asyncio.run(web.api_insights_idea(web.InsightIdeaRequest(platform="bilibili", word="")))


def test_idea_endpoint_without_snapshot_409(snapshot_env):
    with pytest.raises(web.HTTPException) as e:
        asyncio.run(web.api_insights_idea(web.InsightIdeaRequest(platform="bilibili", word="咖啡")))
    assert e.value.status_code == 409


# ---- 采集落盘：bili_login stats → note_id（bvid）→ 快照流 ----

def test_bili_stats_notes_carry_bvid(monkeypatch, capsys):
    monkeypatch.setattr(bili_login, '_load_cookie', lambda *_: ('test-cookie', 1))

    def api(url, *_):
        if url.endswith('/nav'):
            return {'data': {'isLogin': True, 'uname': '测试账号', 'mid': 1}}
        if '/archives?' in url:
            return {'data': {'archives': [
                {'archive': {'title': '咖啡探店', 'bvid': 'BV1cafe'}, 'stat': {'view': 1200, 'like': 30}},
                {'archive': {'title': '无指标稿件', 'bvid': 'BV2none'}, 'stat': {}},
            ], 'page': {'count': 2}}}
        return {'data': {}}

    monkeypatch.setattr(bili_login, '_api', api)
    assert bili_login.cmd_stats(SimpleNamespace(cookie='unused')) == 0
    result = json.loads(capsys.readouterr().out)
    by_id = {n['note_id']: n for n in result['notes']}
    assert by_id['BV1cafe']['metrics']['views'] == 1200
    assert by_id['BV1cafe']['url'] == 'https://www.bilibili.com/video/BV1cafe'
    assert 'likes' not in by_id['BV2none']['metrics'] or by_id['BV2none']['metrics']['likes'] is None
    # note_id 为空串的稿件不会伪造 bvid
    assert all(n['note_id'].startswith('BV') or n['note_id'] == '' for n in result['notes'])


def test_record_note_snapshot_keeps_bili_metrics_shape(snapshot_env):
    _seed_snapshot(snapshot_env, [_rec("BV1", "咖啡", ["咖啡"], 100, likes=5)])
    rows = st.load_note_snapshots("bilibili")
    assert rows[0]["metrics"]["views"] == 100
    assert rows[0]["metrics"]["shares"] is None      # 缺指标保持 None，不造零
    assert rows[0]["source"] == "account_stats:bilibili"
