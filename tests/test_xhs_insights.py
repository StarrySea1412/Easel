"""小红书本人账号热词建议（方案功能 A 第二步 / feat/xhs-keyword-insights）测试。

覆盖验收点：
- 候选词提取（标签全留 / 标题词≥2 篇）；
- 每条建议可追溯到原笔记（refs 带 noteId 与标题）；
- 指标均值与排序（有指标在前，缺指标排后）；
- 降级：样本不足或指标缺失 → weak/exploratory，evidence 明说，不声称增长；
- 快照流取最新一条快照算（同一 note 两次采集用新的）；
- 建议写入选题库：格式、查重（同来源同标题 409）、候选词不在列表 404；
- 空数据/坏行输入不炸，给可读提示。

全离线：只用内存 dict 与 tmp 目录，不调真实小红书。
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
import xhs_insights as xi  # noqa: E402
import account_stats as st  # noqa: E402


def _rec(nid, title, tags, likes, fetched=None):
    return {
        "version": st.NOTE_SNAPSHOT_VERSION, "note_id": nid, "title": title,
        "tags": tags, "publish": "2026-09-01", "fetched_at": fetched or int(time.time()),
        "metrics": {"likes": likes, "collects": None, "comments": None},
        "source": "account_stats:xiaohongshu",
    }


def _records():
    return [
        _rec("n1", "城市咖啡探店指南", ["咖啡", "探店"], 120),
        _rec("n2", "周末去哪喝咖啡？小众咖啡馆盘点", ["咖啡"], 340),
        _rec("n3", "居家咖啡冲煮教程", ["咖啡", "教程"], 90),
        _rec("n4", "露营装备清单一次讲清", ["露营"], 500),
        _rec("n5", "无标签的随手记", [], None),           # 缺指标
    ]


# ---- 候选词提取 ----

def test_extract_candidates_keeps_tags_and_requires_title_words_twice():
    cands = xi.extract_candidates(_records())
    assert "咖啡" in cands and cands["咖啡"]["tagsOnly"] is True
    assert "露营" in cands
    # 标题词只出现一次的不进候选（如「指南」只在 n1 出现）
    assert "指南" not in cands
    # 「盘点」出现在 n2 标题……也只出现一次 → 不进
    assert "盘点" not in cands


def test_extract_candidates_empty_and_stopwords():
    assert xi.extract_candidates([]) == {}
    cands = xi.extract_candidates([_rec("n1", "的 分享 推荐", ["分享"], None)])
    assert cands == {}                       # 停用词/功能词全滤掉


# ---- 建议：证据 + 排序 + 降级 ----

def test_insights_refs_traceable_to_notes():
    d = xi.keyword_insights(_records())
    by_word = {s["word"]: s for s in d["suggestions"]}
    cof = by_word["咖啡"]
    assert {r["noteId"] for r in cof["refs"]} == {"n1", "n2", "n3"}   # 可追溯
    assert cof["sampleSize"] == 3
    assert cof["metric"] == round((120 + 340 + 90) / 3, 1)
    assert cof["confidence"] == "strong"
    assert "篇笔记" in cof["evidence"]


def test_insights_orders_metric_words_first():
    d = xi.keyword_insights(_records())
    words = [s["word"] for s in d["suggestions"]]
    assert "咖啡" in words and "露营" in words
    assert words.index("露营") < words.index("咖啡")    # 露营 500 > 咖啡均值 183


def test_insights_missing_metrics_degrade_to_exploratory():
    recs = [_rec("n1", "咖啡探店", ["咖啡"], None),
            _rec("n2", "咖啡豆挑选", ["咖啡"], None),
            _rec("n3", "咖啡器具", ["咖啡"], None)]
    d = xi.keyword_insights(recs)
    cof = next(s for s in d["suggestions"] if s["word"] == "咖啡")
    assert cof["metric"] is None
    assert cof["confidence"] == "exploratory"
    assert "缺互动数据" in cof["evidence"]
    assert "不构成增长承诺" in d["note"]


def test_insights_small_sample_is_weak():
    recs = [_rec("only", "小众冷门体验", ["冷门"], 10)]
    d = xi.keyword_insights(recs)
    s = next(s for s in d["suggestions"] if s["word"] == "冷门")
    assert s["confidence"] == "weak" and "样本较少" in s["evidence"]


def test_insights_uses_latest_snapshot_per_note():
    now = int(time.time())
    old = [_rec("n1", "咖啡探店", ["咖啡"], 10, fetched=now - 86400)]
    new = [_rec("n1", "咖啡探店", ["咖啡"], 999, fetched=now)]
    d = xi.keyword_insights(old + new)
    cof = next(s for s in d["suggestions"] if s["word"] == "咖啡")
    assert cof["metric"] == 999                     # 用最新快照，不吃旧值
    assert d["window"]["to"] == now


def test_insights_empty_data_gives_readable_note():
    d = xi.keyword_insights([])
    assert d["suggestions"] == [] and "先在「账号」页" in d["note"]


def test_insights_window_and_sample_size():
    d = xi.keyword_insights(_records())
    assert d["sampleSize"] == 5 and d["window"]["from"] <= d["window"]["to"]


# ---- idea_from_suggestion 格式 ----

def test_idea_from_suggestion_fields():
    d = xi.keyword_insights(_records())
    cof = next(s for s in d["suggestions"] if s["word"] == "咖啡")
    idea = xi.idea_from_suggestion(cof, d["window"])
    assert idea["title"] == "选题：咖啡"
    assert idea["source"] == "本人小红书分析" and idea["status"] == "pending"
    assert "数据窗口" in idea["note"] and "引用笔记" in idea["note"]


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
    st.record_note_snapshot("xiaohongshu", records, int(time.time()))


def test_insights_endpoint_returns_suggestions(snapshot_env):
    _seed_snapshot(snapshot_env, _records())
    d = asyncio.run(web.api_analytics_insights("xiaohongshu"))
    assert any(s["word"] == "咖啡" for s in d["suggestions"])
    assert d["sampleSize"] == 5


def test_insights_endpoint_unknown_platform():
    with pytest.raises(web.HTTPException):
        asyncio.run(web.api_analytics_insights("nope"))


def test_insights_idea_endpoint_creates_and_dedupes(snapshot_env):
    _seed_snapshot(snapshot_env, _records())
    d = asyncio.run(web.api_insights_idea(web.InsightIdeaRequest(word="咖啡")))
    assert d["ok"] and d["idea"]["title"] == "选题：咖啡"
    assert d["idea"]["source"] == "本人小红书分析"
    ideas = web._read_ideas()
    assert len(ideas) == 1
    # 再写同一条 → 409
    with pytest.raises(web.HTTPException) as e:
        asyncio.run(web.api_insights_idea(web.InsightIdeaRequest(word="咖啡")))
    assert e.value.status_code == 409


def test_insights_idea_endpoint_unknown_word_404(snapshot_env):
    _seed_snapshot(snapshot_env, _records())
    with pytest.raises(web.HTTPException) as e:
        asyncio.run(web.api_insights_idea(web.InsightIdeaRequest(word="不存在的词")))
    assert e.value.status_code == 404
    with pytest.raises(web.HTTPException):
        asyncio.run(web.api_insights_idea(web.InsightIdeaRequest(word="")))


def test_insights_idea_endpoint_survives_bad_jsonl(snapshot_env):
    p = snapshot_env / "_analytics" / "xiaohongshu-notes.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("{broken json\n", encoding="utf-8")
    d = asyncio.run(web.api_analytics_insights("xiaohongshu"))
    assert d["suggestions"] == []          # 坏行被跳过，接口不炸
