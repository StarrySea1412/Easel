"""小红书本人账号热词建议（方案功能 A 第二步 / feat/xhs-keyword-insights）。

从「本人账号逐篇笔记快照」里提取候选词并给出带证据的建议。方法复用
skill-xhs-analyzer 的关键词矩阵思路（jieba 分词 + 停用词），全部计算在
本人真实数据上完成：

- 只基于「标题 + 标签」文本提取候选词；
- 逐篇指标（likes/collects/comments）作为表现证据：某词出现在哪些笔记、
  各笔记的指标与采集时间、样本量；
- 样本不足（<3 篇）或缺指标时建议降级为「探索性」，明确标注，不声称能
  带来增长；公域趋势词不属于本模块（无可靠来源，不做合成热度分）；
- 建议可一键写入现有 /api/ideas（由 Web 端调用）。

纯函数模块：不联网、不落盘，输入输出都是普通 dict，方便测试。
"""
from __future__ import annotations

import re
from collections import defaultdict

try:
    import jieba
except ImportError:              # pragma: no cover - 运行依赖已在 pyproject 里
    jieba = None

# 停用词：虚词/平台功能词/数字单位（这类词对「选题建议」没有信息量）
STOP_WORDS = {
    "的", "了", "在", "是", "我", "有", "和", "就", "不", "都", "一个", "你们",
    "我们", "他们", "这个", "那个", "什么", "怎么", "如何", "可以", "应该", "还是",
    "笔记", "小红书", "小红书的", "视频", "图片", "分享", "推荐", "记录", "日常",
    "一下", "起来", "时候", "地方", "感觉", "真的", "觉得", "以及", "但是", "因为",
    "所以", "如果", "还有", "已经", "通过", "进行", "时候", "最后", "第一", "各种",
}

_EN_WORD = re.compile(r"[A-Za-z][A-Za-z0-9\-]{1,17}")
_MAX_WORD = 12
_TOP_K = 30


def _tokens(text: str) -> list[str]:
    """中文 jieba 分词 + 英文/数字词。jieba 不可用时退化为 2-gram（功能可用，精度降）。"""
    text = (text or "").strip()
    if not text:
        return []
    out: list[str] = []
    if jieba is not None:
        for w in jieba.lcut(text):
            w = w.strip()
            if len(w) >= 2 and w not in STOP_WORDS and not re.fullmatch(r"[\d\W]+", w):
                out.append(w.lower()[:_MAX_WORD])
    else:
        clean = re.sub(r"[^\w\u4e00-\u9fff]+", " ", text)
        for seg in clean.split():
            for i in range(len(seg) - 1):
                out.append(seg[i:i + 2].lower())
    out.extend(w.lower() for w in _EN_WORD.findall(text))
    return out


def extract_candidates(records: list[dict]) -> dict[str, dict]:
    """从快照记录提取候选词 → {词: {refs: [(note_id, title)], tagsOnly: bool}}。
    标签词全量保留（用户自己打的标签权重最高）；标题词按分词聚合。"""
    cands: dict[str, dict] = {}
    for r in records or []:
        nid = (r.get("note_id") or r.get("title") or "")[:24]
        title = r.get("title") or ""
        for tag in r.get("tags") or []:
            tag = str(tag).strip().lower()
            if not tag or tag in STOP_WORDS:
                continue
            c = cands.setdefault(tag, {"refs": [], "tagsOnly": True})
            c["refs"].append((nid, title))
        for w in _tokens(title):
            c = cands.setdefault(w, {"refs": [], "tagsOnly": False})
            c["refs"].append((nid, title))
    # 标题词在两篇以上出现才算候选（单篇标题词噪声太大）；标签词不限
    return {k: v for k, v in cands.items() if v["tagsOnly"] or len(v["refs"]) >= 2}


def _metric_avg(refs: list[tuple[str, str]], by_note: dict[str, dict]) -> float | None:
    """候选词所有笔记的 likes 均值；任一篇缺 likes → None（缺指标不造零）。"""
    vals = []
    for nid, _t in refs:
        m = by_note.get(nid, {}).get("metrics") or {}
        v = m.get("likes")
        if v is None:
            return None
        vals.append(v)
    return sum(vals) / len(vals) if vals else None


def keyword_insights(records: list[dict], top_k: int = _TOP_K) -> dict:
    """候选词 → 带证据的建议列表。排序：有指标的样本均值降序；无指标的排后（探索性）。
    返回 {window, sampleSize, suggestions: [{word, refs, sampleSize, metric,
    evidence, confidence}]}——refs 保证每条建议可追溯到原笔记。"""
    # 每 note_id 取最新一条快照（同 note 保留最近两次，用最新的算）
    by_note: dict[str, dict] = {}
    for r in sorted(records or [], key=lambda x: x.get("fetched_at", 0)):
        nid = (r.get("note_id") or r.get("title") or "")
        if nid:
            by_note[nid] = r
    latest = list(by_note.values())
    if not latest:
        return {"window": None, "sampleSize": 0, "suggestions": [],
                "note": "还没有本人笔记数据：先在「账号」页连接小红书并抓取一次"}

    ts = [r.get("fetched_at") for r in latest if isinstance(r.get("fetched_at"), int)]
    window = {"from": min(ts), "to": max(ts)} if ts else None
    cands = extract_candidates(latest)

    rows = []
    for word, c in cands.items():
        refs = list(dict.fromkeys(c["refs"]))          # 去重 (nid, title)
        avg = _metric_avg(refs, by_note)
        sample = len(refs)
        # 可信度分级：样本>=3 且指标齐全 → strong；样本>=3 缺指标 → exploratory；
        # 样本<3 → weak（只作提示，不排前面）。缺指标永远是探索性，不声称增长。
        if avg is None:
            confidence, metric = ("exploratory" if sample >= 3 else "weak"), None
        else:
            confidence = "strong" if sample >= 3 else "weak"
            metric = round(avg, 1)
        rows.append({
            "word": word, "refs": [{"noteId": nid, "title": t} for nid, t in refs][:8],
            "sampleSize": sample, "metric": metric, "confidence": confidence,
            "tagsOnly": c["tagsOnly"],
        })
    rows.sort(key=lambda r: (r["metric"] is None, -(r["metric"] or 0),
                             -r["sampleSize"], r["word"]))
    # 同一建议的证据说明固定文案，前端直接展示
    for r in rows:
        r["evidence"] = (
            f"出自你最近的 {r['sampleSize']} 篇笔记（采集于数据窗口内）；"
            + (f"平均点赞 {r['metric']}" if r["metric"] is not None else "部分笔记缺互动数据")
            + ("；样本较少，仅供探索参考" if r["confidence"] == "weak" else "")
        )
    return {"window": window, "sampleSize": len(latest),
            "suggestions": rows[:top_k],
            "note": "基于本人账号标题与标签的静态提取；缺指标或样本不足时为探索性建议，不构成增长承诺"}


def idea_from_suggestion(s: dict, window: dict | None) -> dict:
    """把一条建议转成 /api/ideas 的创建参数（调现有 createIdea 流程）。
    标题=候选词；说明=建议理由+数据窗口；来源标明本人小红书分析；状态待做。"""
    span = ""
    if window:
        import time as _t
        f = _t.strftime("%Y-%m-%d", _t.localtime(window["from"])) if window.get("from") else "?"
        t = _t.strftime("%Y-%m-%d", _t.localtime(window["to"])) if window.get("to") else "?"
        span = f"，数据窗口 {f}~{t}"
    return {
        "title": f"选题：{s['word']}",
        "note": f"{s['evidence']}{span}。引用笔记：" +
                "、".join(r["title"][:20] for r in s["refs"][:3]),
        "source": "本人小红书分析",
        "status": "pending",
    }
