"""Compatibility coverage for the current durable trend-source service.

The former tests imported the deleted web.app parser/cache globals. The
implementation now lives in ``web.trend_sources``; detailed source tests stay
in ``tests/test_trend_sources.py``.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "web"))
import trend_sources as trends


@pytest.fixture(autouse=True)
def clean_trend_state():
    trends._CACHE.clear()
    trends._LAST.clear()
    trends._SOURCE_COOLDOWNS.clear()
    yield
    trends._CACHE.clear()
    trends._LAST.clear()
    trends._SOURCE_COOLDOWNS.clear()


def raw(value):
    return json.dumps(value).encode()


def test_parser_normalizes_plain_rows_and_search_links():
    source = trends.SOURCES["bilibili"][0]
    items, updated = trends.parse(source, raw({"code": 200, "data": ["AI 开源", "  ", "新品发布"]}), "bilibili")
    assert [item["title"] for item in items] == ["AI 开源", "新品发布"]
    assert items[0]["url"].startswith("https://search.bilibili.com/all?keyword=")
    assert items[0]["linkKind"] == "search" and updated is None


def test_parser_distinguishes_auth_and_empty_source_errors():
    source = trends.sixty("zhihu")
    with pytest.raises(trends.SourceError) as error:
        trends.parse(source, raw({"code": -8, "msg": "请携带Key", "data": ""}), "zhihu")
    assert error.value.code == "authentication"
    with pytest.raises(trends.SourceError) as empty:
        trends.parse(trends.SOURCES["weibo"][0], raw({"code": 200, "data": []}), "weibo")
    assert empty.value.code == "empty"


def test_parser_rejects_unsafe_zhihu_question_links():
    source = trends._zhihu_sources()[0]
    payload = {"data": [{"type": "hot_list_feed", "target": {
        "type": "question", "title": "公开问题", "url": "https://api.zhihu.com/questions/123?private=1"
    }}]}
    with pytest.raises(trends.SourceError) as error:
        trends.parse(source, raw(payload), "zhihu")
    assert error.value.code == "empty"


def test_fetch_uses_backup_and_preserves_failure_provenance(monkeypatch):
    sources = trends.SOURCES["weibo"]
    calls = []

    def download(url):
        calls.append(url)
        if url == sources[0].url:
            raise trends.SourceError("rate_limited", "HTTP 429", retry_at=2000)
        return raw({"code": 200, "data": [{"title": "备用热点"}]})

    monkeypatch.setattr(trends, "_download", download)
    result = trends._fetch("weibo")
    assert result["status"] == "fresh" and result["items"][0]["title"] == "备用热点"
    assert result["attempts"][0]["code"] == "rate_limited"
    assert calls == [source.url for source in sources]


def test_fetch_keeps_stale_data_after_failed_refresh(monkeypatch):
    clock = [1000]
    monkeypatch.setattr(trends.time, "time", lambda: clock[0])
    monkeypatch.setattr(trends, "_download", lambda url: raw({"code": 200, "data": [{"title": "旧热点"}]}))
    first = trends._fetch("weibo")
    clock[0] += 301

    def fail(url):
        raise trends.SourceError("timeout", "来源响应超时")

    monkeypatch.setattr(trends, "_download", fail)
    stale = trends._fetch("weibo", refresh=True)
    assert stale["status"] == "stale"
    assert stale["items"] == first["items"] and stale["error"]["code"] == "timeout"


def test_fetch_trends_filters_unknown_platforms_and_applies_limit(monkeypatch):
    monkeypatch.setattr(trends, "_fetch", lambda platform, refresh=False: {
        "platform": platform, "items": [{"title": str(i)} for i in range(5)], "fetchedAt": 100,
        "status": "fresh", "label": trends.LABELS[platform]
    })
    result = asyncio.run(trends.fetch_trends("weibo,unknown,weibo,ithome", limit=2))
    assert [group["platform"] for group in result["trends"]] == ["weibo", "ithome"]
    assert all(len(group["items"]) == 2 for group in result["trends"])


def test_app_endpoint_delegates_to_current_service(monkeypatch):
    import app

    async def fake_fetch(platforms, limit, refresh):
        return {"trends": [{"platform": platforms, "items": [], "status": "error"}], "updated": 0}

    monkeypatch.setattr(trends, "fetch_trends", fake_fetch)
    result = asyncio.run(app.api_trends("weibo,unknown", 7, True))
    assert result["trends"][0]["platform"] == "weibo,unknown"
