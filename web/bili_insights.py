"""B站逐篇快照的探索性选题建议（对齐 xhs_insights 的证据口径）。

与小红书版共用分词与候选规则，差异在数据契约：
- B站快照的 note_id 是视频 bvid，url 是 bilibili.com 域；
- B站逐篇指标是播放/点赞/评论/收藏/分享，主指标用「播放」（views），
  小红书主指标是点赞——两者不可混用，均值只在样本全有指标时计算；
- 快照按平台存（bilibili-notes.jsonl），没有账号目录结构，归属字段
  account_id 缺省为平台维度；不与小红书的账号级结论混写。
所有建议均为 exploratory：只描述已有样本，不声称因果关系或增长承诺。
"""
from __future__ import annotations

import time

import xhs_insights as xi

PLATFORM = "bilibili"
PRIMARY_METRIC = ("views", "播放")
SECONDARY_METRICS = (("likes", "点赞"), ("collects", "收藏"), ("comments", "评论"), ("shares", "分享"))


def _reference(record: dict) -> dict:
    metrics = record.get("metrics") or {}
    missing = dict(record.get("missing_fields") or {})
    for field, _label in (PRIMARY_METRIC, *SECONDARY_METRICS):
        if metrics.get(field) is None:
            missing.setdefault(f"metrics.{field}", "平台或快照未提供，不能按零计算")
    return {"accountId": record.get("account_id"), "noteId": record["note_id"],
            "title": record.get("title") or "", "url": record.get("url") or "",
            "tags": record.get("tags") or [], "publish": record.get("publish") or "",
            "publishedAt": record.get("published_at"), "fetchedAt": record.get("fetched_at"),
            "importedAt": record.get("imported_at"), "metrics": metrics,
            "metricsRaw": record.get("metrics_raw") or {}, "missingFields": missing,
            "source": record.get("source") or ""}


def keyword_insights(records: list[dict], top_k: int = 30) -> dict:
    accounts = {row.get("account_id") for row in records}
    if len(accounts) > 1:
        raise ValueError("不能混合多个账号的分析证据")
    latest: dict[str, dict] = {}
    for record in sorted(records, key=lambda row: (row.get("fetched_at") or row.get("observed_at") or 0)):
        if record.get("note_id"):
            latest[record["note_id"]] = record
    timestamps = [row["fetched_at"] for row in latest.values() if isinstance(row.get("fetched_at"), int)]
    window = {"from": min(timestamps), "to": max(timestamps)} if timestamps else None
    suggestions = []
    for word, candidate in xi.extract_candidates(list(latest.values())).items():
        refs = [_reference(latest[nid]) for nid, _ in candidate["refs"]]
        field, label = PRIMARY_METRIC
        values = [ref["metrics"].get(field) for ref in refs]
        known = [value for value in values if isinstance(value, (int, float)) and not isinstance(value, bool)]
        mean = round(sum(known) / len(known), 1) if len(known) == len(values) else None
        sample = len(refs)
        reasons = ["来自账号历史标题与标签的静态提取，未验证关键词与表现的因果关系",
                   "B站快照按平台保存，历史批次未核验是否同一账号"]
        if sample < 3:
            reasons.append("样本较少")
        if any(ref["missingFields"] for ref in refs):
            reasons.append("证据存在缺失字段")
        if mean is None:
            reasons.append("部分稿件缺互动数据")
        summary = f"出自本地 {sample} 稿稿件；" + (f"这些稿件平均{label} {mean}；" if mean is not None else "")
        suggestions.append({"word": word, "refs": refs, "sampleSize": sample, "metric": mean,
                            "metricName": field, "metricSampleSize": len(known),
                            "confidence": "exploratory", "tagsOnly": candidate["tagsOnly"],
                            "evidence": summary + "；".join(reasons) + "，仅供探索参考", "limitations": reasons})
    suggestions.sort(key=lambda row: (row["metric"] is None, -(row["metric"] or 0), -row["sampleSize"], row["word"]))
    note = "基于本平台稿件标题与标签的探索性建议；样本只覆盖快照里最近一页稿件，不构成增长承诺"
    if not latest:
        note = "还没有可用的稿件快照：连接 B站账号后采集一次，即可得到逐篇建议"
    return {"window": window, "sampleSize": len(latest), "suggestions": suggestions[:max(0, min(top_k, 100))], "note": note}


def idea_from_suggestion(suggestion: dict, window: dict | None) -> dict:
    span = ""
    if window:
        start = time.strftime("%Y-%m-%d", time.localtime(window["from"]))
        end = time.strftime("%Y-%m-%d", time.localtime(window["to"]))
        span = f"，数据窗口 {start}~{end}"
    refs = "\n".join(f"- {ref['title'] or ref['noteId']}：{ref['url']}" for ref in suggestion["refs"])
    return {"title": f"选题：{suggestion['word']}",
            "note": f"{suggestion['evidence']}{span}。\n引用稿件：\n{refs}",
            "source": "本人B站分析", "status": "pending"}
