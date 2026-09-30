"""Traceable, exploratory topic suggestions from one explicitly scoped account."""
from __future__ import annotations

import re
import time

try:
    import jieba
except ImportError:
    jieba = None

STOP_WORDS = {"的", "了", "在", "是", "我", "有", "和", "就", "不", "都", "一个", "你们",
              "我们", "他们", "这个", "那个", "什么", "怎么", "如何", "可以", "应该", "还是",
              "笔记", "小红书", "视频", "图片", "分享", "推荐", "记录", "日常", "一下", "起来",
              "时候", "地方", "感觉", "真的", "觉得", "以及", "但是", "因为", "所以", "如果",
              "还有", "已经", "通过", "进行", "最后", "第一", "各种"}


def _tokens(text: str) -> list[str]:
    if jieba is not None:
        words = jieba.lcut(text)
    else:
        words = re.findall(r"[A-Za-z][A-Za-z0-9-]{1,17}", text)
        for segment in re.findall(r"[\u4e00-\u9fff]+", text):
            words.extend(segment[i:i + 2] for i in range(len(segment) - 1))
    return [word.strip().lower() for word in words if 2 <= len(word.strip()) <= 12
            and word.strip() not in STOP_WORDS and not re.fullmatch(r"[\d\W]+", word)]


def extract_candidates(records: list[dict]) -> dict[str, dict]:
    candidates = {}
    for record in records:
        nid, title = record.get("note_id"), record.get("title") or ""
        if not nid:
            continue
        tags = {str(tag).strip().lower() for tag in record.get("tags", [])}
        for word in set(_tokens(title)) | tags:
            if not word or word in STOP_WORDS:
                continue
            item = candidates.setdefault(word, {"refs": {}, "tagsOnly": False})
            item["refs"][nid] = title
            item["tagsOnly"] = item["tagsOnly"] or word in tags
    return {word: {**item, "refs": list(item["refs"].items())} for word, item in candidates.items()
            if item["tagsOnly"] or len(item["refs"]) >= 2}


def _reference(record: dict) -> dict:
    metrics = record.get("metrics") or {}
    missing = dict(record.get("missing_fields") or {})
    for field in ("likes", "collects", "comments"):
        if metrics.get(field) is None:
            missing.setdefault(f"metrics.{field}", "平台或导出文件未提供，不能按零计算")
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
    latest = {}
    for record in sorted(records, key=lambda row: (row.get("fetched_at") or row.get("observed_at") or 0)):
        if record.get("note_id"):
            latest[record["note_id"]] = record
    timestamps = [row["fetched_at"] for row in latest.values() if isinstance(row.get("fetched_at"), int)]
    window = {"from": min(timestamps), "to": max(timestamps)} if timestamps else None
    suggestions = []
    for word, candidate in extract_candidates(list(latest.values())).items():
        refs = [_reference(latest[nid]) for nid, _ in candidate["refs"]]
        values = [ref["metrics"].get("likes") for ref in refs]
        known = [value for value in values if isinstance(value, (int, float)) and not isinstance(value, bool)]
        mean = round(sum(known) / len(known), 1) if len(known) == len(values) else None
        sample = len(refs)
        reasons = ["来自账号历史文本的静态提取，未验证关键词与表现的因果关系"]
        if sample < 3:
            reasons.append("样本较少")
        if any(ref["missingFields"] for ref in refs):
            reasons.append("证据存在缺失字段")
        if mean is None:
            reasons.append("部分笔记缺互动数据")
        summary = f"出自本地 {sample} 篇笔记；" + (f"这些笔记平均点赞 {mean}；" if mean is not None else "")
        suggestions.append({"word": word, "refs": refs, "sampleSize": sample, "metric": mean,
                            "metricName": "likes", "metricSampleSize": len(known),
                            "confidence": "exploratory", "tagsOnly": candidate["tagsOnly"],
                            "evidence": summary + "；".join(reasons) + "，仅供探索参考", "limitations": reasons})
    suggestions.sort(key=lambda row: (row["metric"] is None, -(row["metric"] or 0), -row["sampleSize"], row["word"]))
    note = "基于选定账号标题与标签的探索性建议；样本不代表全部笔记，不构成增长承诺"
    if not latest:
        note = "还没有可归属的笔记数据：连接账号后在本页采集一次，或导入本人导出的 JSON 文件"
    return {"window": window, "sampleSize": len(latest), "suggestions": suggestions[:max(0, min(top_k, 100))], "note": note}


def idea_from_suggestion(suggestion: dict, window: dict | None) -> dict:
    span = ""
    if window:
        start = time.strftime("%Y-%m-%d", time.localtime(window["from"]))
        end = time.strftime("%Y-%m-%d", time.localtime(window["to"]))
        span = f"，数据窗口 {start}~{end}"
    refs = "\n".join(f"- {ref['title'] or ref['noteId']}：{ref['url']}" for ref in suggestion["refs"])
    return {"title": f"选题：{suggestion['word']}", "note": f"{suggestion['evidence']}{span}。\n引用笔记：\n{refs}",
            "source": "本人小红书分析", "status": "pending"}
