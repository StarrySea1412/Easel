"""Account-scoped local evidence. No network, credentials, or inferred ownership."""
from __future__ import annotations

import hashlib
import json
import math
import re
import time
import uuid
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

VERSION = 3
RETENTION_DAYS = 365
RETENTION = {"days": RETENTION_DAYS, "snapshotsPerNote": 2}
PLATFORM = "xiaohongshu"
_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
_MISSING = "平台或导出文件未提供，不能按零计算"


def _read(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return fallback


def _write(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


def state(root: Path) -> dict:
    value = _read(root / f"{PLATFORM}-context.json", {})
    return value if isinstance(value, dict) else {}


def invalidate(root: Path) -> str:
    generation = uuid.uuid4().hex
    _write(root / f"{PLATFORM}-context.json", {"generation": generation, "account": None})
    return generation


def generation(root: Path) -> str:
    return str(state(root).get("generation") or "")


def account_key(external_id: str, source: str) -> str:
    if source not in {"live", "import"} or not _ID.fullmatch(external_id):
        raise ValueError("账号 ID 仅支持 1–128 位字母、数字、下划线或短横线")
    return f"{source}:{external_id}"


def account_dir(root: Path, key: str) -> Path:
    source, separator, external_id = key.partition(":")
    if not separator or account_key(external_id, source) != key:
        raise ValueError("无效账号范围")
    directory = root / f"{PLATFORM}-accounts" / hashlib.sha256(key.encode()).hexdigest()
    if not directory.resolve().is_relative_to(root.resolve()):
        raise ValueError("账号数据目录不能指向分析目录之外")
    return directory


def active_account(root: Path) -> dict | None:
    account = state(root).get("account")
    if not isinstance(account, dict):
        return None
    try:
        account_dir(root, account["id"])
    except (KeyError, TypeError, ValueError):
        return None
    return account


def metric_value(value) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value) if 0 <= value <= 10**18 and math.isfinite(value) and value == int(value) else None
    text = str(value).strip().replace(",", "")
    if len(text) > 80:
        return None
    match = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([万亿wWkK千]?)", text)
    if not match:
        return None
    scale = {"": 1, "万": 10000, "亿": 100000000, "w": 10000, "W": 10000,
             "k": 1000, "K": 1000, "千": 1000}[match[2]]
    number = float(match[1]) * scale
    return int(round(number)) if math.isfinite(number) and number <= 10**18 else None


def _timestamp(value) -> int | None:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) \
        and 0 < value <= time.time() + 300 and math.isfinite(value) else None


def normalize(note: dict, key: str, now: int, source: str) -> dict:
    if not isinstance(note, dict):
        raise ValueError("每条笔记必须是 JSON 对象")
    external_id = key.split(":", 1)[1]
    declared = note.get("account_id") or note.get("accountId")
    if declared and declared not in {key, external_id}:
        raise ValueError("笔记账号与导入账号不一致")
    raw_url = str(note.get("url") or "")
    url = ""
    from_url = ""
    try:
        parsed = urlsplit(raw_url)
        match = re.fullmatch(r"/(?:explore|discovery/item)/([A-Za-z0-9_-]+)(?:/)?", parsed.path)
        if parsed.scheme == "https" and parsed.hostname in {"xiaohongshu.com", "www.xiaohongshu.com"} and match:
            from_url = match[1]
            url = f"https://www.xiaohongshu.com/explore/{from_url}"
    except ValueError:
        pass
    nid = str(note.get("note_id") or note.get("noteId") or from_url).strip()
    if not _ID.fullmatch(nid):
        raise ValueError("每条笔记需提供有效 note_id 或小红书原文 URL")
    if from_url and from_url != nid:
        raise ValueError("笔记 note_id 与原文 URL 不一致")
    if not url:
        url = f"https://www.xiaohongshu.com/explore/{nid}"
    raw_metrics = note.get("metrics") if isinstance(note.get("metrics"), dict) else {}
    metrics = {name: metric_value(raw_metrics.get(name)) for name in ("likes", "collects", "comments")}
    original = note.get("metrics_raw") if isinstance(note.get("metrics_raw"), dict) else raw_metrics
    metrics_raw = {name: str(original[name])[:80] if original.get(name) is not None else None for name in metrics}
    tags = note.get("tags") or []
    if not isinstance(tags, list) or any(not isinstance(tag, str) for tag in tags):
        raise ValueError("tags 必须是字符串数组")
    tags = list(dict.fromkeys(tag.strip().lstrip("#")[:80] for tag in tags if tag.strip()))[:30]
    title = str(note.get("title") or "").strip()[:300]
    publish = str(note.get("publish") or note.get("published_at") or note.get("publishedAt") or "")[:80]
    published_at = None
    if re.match(r"^\d{4}-\d{2}-\d{2}(?:$|[T ])", publish):
        try:
            published_at = datetime.fromisoformat(publish.replace("Z", "+00:00")).isoformat()
        except ValueError:
            pass
    fetched_at = now if source == "live" else _timestamp(note.get("fetched_at", note.get("fetchedAt")))
    missing = {f"metrics.{name}": _MISSING for name, value in metrics.items() if value is None}
    if not title:
        missing["title"] = "未提供标题，仅能使用已有标签提取候选词"
    if not tags:
        missing["tags"] = "未提供标签，仅能使用已有标题提取候选词"
    if not published_at:
        missing["publishedAt"] = "未提供可确认的绝对发布时间，原始日期文案另行保留"
    if not fetched_at:
        missing["fetchedAt"] = "未提供有效采集时间；导入时间不等于采集时间"
    if not raw_url:
        missing["originalUrl"] = "原文链接由 note_id 构造，未验证可访问性"
    elif not from_url:
        missing["originalUrl"] = "导入链接不符合小红书原文格式，已按 note_id 构造链接"
    return {"version": VERSION, "platform": PLATFORM, "account_id": key,
            "note_id": nid, "title": title, "tags": tags, "publish": publish,
            "published_at": published_at, "fetched_at": fetched_at,
            "imported_at": now if source == "import" else None, "observed_at": now,
            "metrics": metrics, "metrics_raw": metrics_raw, "url": url,
            "source": "user_export:xiaohongshu" if source == "import" else "account_stats:xiaohongshu",
            "missing_fields": missing}


def _retained(rows: list[dict], now: int) -> list[dict]:
    by_note: dict[str, dict[int, dict]] = {}
    for row in rows:
        observed = row.get("observed_at")
        fetched = row.get("fetched_at")
        stamp = fetched if isinstance(fetched, int) else observed
        if not isinstance(stamp, int) or stamp < now - RETENTION_DAYS * 86400:
            continue
        by_note.setdefault(row["note_id"], {})[stamp] = row
    out = []
    for group in by_note.values():
        out.extend(value for _, value in sorted(group.items())[-2:])
    return sorted(out, key=lambda row: (row.get("observed_at", 0), row["note_id"]))


def load(root: Path, key: str | None = None, now: int | None = None) -> list[dict]:
    key = key or (active_account(root) or {}).get("id")
    if not key:
        return []  # Legacy unowned records are deliberately never auto-assigned.
    path = account_dir(root, key) / "notes.jsonl"
    rows = []
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if isinstance(row, dict) and row.get("version") == VERSION and row.get("account_id") == key \
                    and isinstance(row.get("note_id"), str) and isinstance(row.get("metrics"), dict) \
                    and isinstance(row.get("observed_at"), int) and isinstance(row.get("title"), str) \
                    and isinstance(row.get("tags"), list) and isinstance(row.get("missing_fields"), dict):
                rows.append(row)
    retained = _retained(rows, int(time.time()) if now is None else now)
    if len(retained) < len(rows):
        temporary = path.with_name("notes." + uuid.uuid4().hex + ".tmp")
        temporary.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in retained), encoding="utf-8")
        temporary.replace(path)
    return retained


def ingest(root: Path, notes: list[dict], external_id: str, now: int, *, source="live", name="") -> list[dict]:
    key = account_key(external_id, source)
    rows = []
    omitted = 0
    for note in notes:
        try:
            rows.append(normalize(note, key, now, source))
        except ValueError:
            if source != "live":
                raise
            omitted += 1
    merged = _retained(load(root, key, now) + rows, now)
    directory = account_dir(root, key)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "notes.jsonl"
    temporary = path.with_name("notes." + uuid.uuid4().hex + ".tmp")
    temporary.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in merged), encoding="utf-8")
    temporary.replace(path)
    account = {"id": key, "externalId": external_id, "name": str(name)[:100], "source": source,
               "verified": source == "live"}
    coverage = {"scope": "imported" if source == "import" else "visible_page", "complete": False,
                "omittedNotes": omitted,
                "observedNotes": len({r["note_id"] for r in rows}), "storedNotes": len({r["note_id"] for r in merged}),
                "pagesFetched": None if source == "import" else 1, "pageLimit": None if source == "import" else 20,
                "reason": "仅分析用户提供的文件，账号归属与完整性未经平台验证" if source == "import" else
                          "仅采集笔记管理页当前可见的最多 20 篇，未执行分页，不能代表全部笔记"}
    _write(directory / "meta.json", {"account": account, "coverage": coverage, "updatedAt": now})
    _write(root / f"{PLATFORM}-context.json", {"generation": uuid.uuid4().hex, "account": account})
    return rows


def context(root: Path) -> dict:
    account = active_account(root)
    metadata = _read(account_dir(root, account["id"]) / "meta.json", {}) if account else {}
    records = load(root, account["id"]) if account else []
    coverage = metadata.get("coverage", {}) if isinstance(metadata, dict) else {}
    coverage = {**coverage, "complete": False, "storedNotes": len({r["note_id"] for r in records})}
    fetched = [row["fetched_at"] for row in records if isinstance(row.get("fetched_at"), int)]
    legacy = (root / f"{PLATFORM}-notes.jsonl").is_file()
    return {"account": account, "accountRequired": account is None, "coverage": coverage,
            "retention": RETENTION, "legacyDataExcluded": legacy,
            "stale": bool(fetched and max(fetched) < time.time() - 7 * 86400),
            "firstFetchedAt": min(fetched) if fetched else None, "lastFetchedAt": max(fetched) if fetched else None}


def clear(root: Path, key: str | None = None) -> int:
    paths = []
    if key:
        paths.append(account_dir(root, key))
    else:
        base = root / f"{PLATFORM}-accounts"
        if base.is_dir():
            paths.extend(path for path in base.iterdir() if path.is_dir() and re.fullmatch(r"[0-9a-f]{64}", path.name))
    count = 0
    for directory in paths:
        if not directory.resolve().is_relative_to(root.resolve()):
            raise ValueError("账号数据目录不能指向分析目录之外")
        for filename in ("notes.jsonl", "overview.jsonl", "meta.json", "page.txt", "page.png"):
            path = directory / filename
            if path.is_file():
                path.unlink()
                count += 1
        try:
            directory.rmdir()
        except OSError:
            pass
    if key is None:
        for filename in (f"{PLATFORM}.jsonl", f"{PLATFORM}-notes.jsonl", f"{PLATFORM}-page.txt", f"{PLATFORM}-page.png"):
            path = root / filename
            if path.is_file():
                path.unlink()
                count += 1
    active = active_account(root)
    if key is None or (active and active["id"] == key):
        invalidate(root)
    return count
