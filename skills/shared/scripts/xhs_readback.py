"""Read Xiaohongshu's own creator list without publishing or changing notes.

The signed request is made by the note-manager page, not reconstructed here.
Only the current account's exact list endpoint is accepted. Unknown or missing
states never imply public visibility; query tokens and raw responses are never
included in receipts.

First-party sources inspected without logging in on 2026-10-09:
https://fe-static.xhscdn.com/formula-static/ugc/public/resource/js/index.7cd017a9.js
  USER_POSTED_NOTES -> /api/galaxy/v2/creator/note/user/posted.
https://fe-static.xhscdn.com/formula-static/ugc/public/resource/js/async/2298.6056bbb1.js
  Module 56462 uses GET with {tab, page} and returns notes.
https://fe-static.xhscdn.com/formula-static/ugc/public/resource/js/async/4108.3845b8c8.js
  Module 23522 defines the tab_status and permission_code enums below.
https://fe-static.xhscdn.com/formula-static/ugc/public/resource/js/async/98.18cd1a69.js
  Module 78064 also checks schedule_post_time and high_self before opening an
  /explore/<id> page. Its time formatter passes numeric time to Date as ms.

These are observations of the first-party client, not a stable public API
promise. No authenticated list or anonymous public-note access was tested.
"""
from __future__ import annotations

import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import parse_qs, urlsplit

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from platform_readback import LoginRequiredError, ReadbackResult, WorkItem
import publish_receipt

MANAGE_URL = "https://creator.xiaohongshu.com/new/note-manager"
LIST_PATH = "/api/galaxy/v2/creator/note/user/posted"
NOTE_ID = re.compile(r"[0-9a-f]{24}")
TAB_STATUS = {1: "published", 2: "reviewing", 3: "rejected", 4: "scheduled"}
PERMISSIONS = {0: "public", 1: "private", 2: "restricted", 3: "restricted", 4: "friends_only"}
TIMESTAMP_TOLERANCE_MS = 1000


def valid_since_ms(value: Any) -> bool:
    """Require a millisecond integer, not seconds, booleans, NaN or floats."""
    return type(value) is int and 1_000_000_000_000 <= value <= 9_999_999_999_999


def normalize_title(value: Any) -> str:
    return " ".join(value.split()) if isinstance(value, str) else ""


def normalize_status(note: dict) -> str:
    """Use only the documented first-party fields; do not coerce unknown codes."""
    raw_status = note.get("tab_status")
    status = TAB_STATUS.get(raw_status) if type(raw_status) is int else None
    if status in {"rejected", "reviewing", "scheduled"}:
        return status
    if status != "published":
        return "unknown"
    schedule = note.get("schedule_post_time")
    if type(schedule) is int and schedule > 0:
        return "scheduled"
    if note.get("post_timing") is True:
        return "scheduled"
    permission = note.get("permission_code")
    if type(permission) is not int or permission not in PERMISSIONS:
        return "unknown"
    if permission != 0:
        return "private"
    high_self = note.get("high_self")
    if high_self is True or (type(high_self) is int and high_self == 1):
        return "private"
    # Presence matters: a default false/zero would turn an incomplete response
    # into an unsupported public-success claim.
    if (type(schedule) is not int or schedule != 0
            or ("high_self" in note and not (high_self is False or (type(high_self) is int and high_self == 0)))):
        return "unknown"
    if "post_timing" in note and note["post_timing"] is not False:
        return "unknown"
    if note.get("permission_msg") not in (None, "", "公开", "公开可见"):
        return "unknown"
    return "published"


def map_note(note: Any) -> WorkItem | None:
    if not isinstance(note, dict):
        return None
    note_id = note.get("id")
    title = note.get("display_title")
    if not isinstance(note_id, str) or not NOTE_ID.fullmatch(note_id):
        return None
    if not isinstance(title, str):
        return None
    timestamp = note.get("time")
    # The first-party formatter establishes milliseconds for numeric values.
    # Date-only/minute strings cannot prove a new submission within one second.
    timestamp = timestamp if valid_since_ms(timestamp) else None
    stats = {}
    visible = note.get("visible_time")
    # The current creator list formats creation time to a local minute and
    # supplies visibility time separately in seconds. Do not turn either into
    # an exact creation timestamp. The runner pins its display timezone.
    if (isinstance(note.get("time"), str)
            and re.fullmatch(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}", note["time"])
            and type(visible) is int and 1_000_000_000 <= visible <= 9_999_999_999):
        try:
            minute = datetime.strptime(note["time"], "%Y-%m-%d %H:%M").replace(tzinfo=timezone(timedelta(hours=8)))
            stats = {"createdMinuteMs": int(minute.timestamp() * 1000), "visibleAtMs": visible * 1000}
        except ValueError:
            pass
    return WorkItem(note_id, title, normalize_status(note), timestamp, stats)


def _minute_candidate(work: WorkItem, *, title: str, since_ms: int, until_ms: int | None = None) -> bool:
    start = work.stats.get("createdMinuteMs")
    visible = work.stats.get("visibleAtMs")
    now = int(time.time() * 1000)
    end = min(now, until_ms) if until_ms is not None else now
    return (normalize_title(work.title) == normalize_title(title) and valid_since_ms(start)
            and valid_since_ms(visible) and start <= end + TIMESTAMP_TOLERANCE_MS
            and start + 59_999 >= since_ms - TIMESTAMP_TOLERANCE_MS
            and since_ms - TIMESTAMP_TOLERANCE_MS <= visible <= now + TIMESTAMP_TOLERANCE_MS)


def _assert_manager_location(page) -> None:
    try:
        url = urlsplit(page.url or "")
        safe_origin = (url.scheme == "https" and url.hostname == "creator.xiaohongshu.com"
                       and url.port is None and url.username is None and url.password is None)
        if safe_origin and re.search(r"(?:^|/)login(?:/|$)", url.path, re.I):
            raise LoginRequiredError("小红书创作者登录已失效")
        if not safe_origin or url.path.rstrip("/") != "/new/note-manager":
            raise RuntimeError("小红书作品管理页未就绪或已跳转")
    except ValueError as exc:
        raise RuntimeError("小红书作品管理页地址无效") from exc


def _is_list_response(response) -> bool:
    try:
        url = urlsplit(response.url)
        query = parse_qs(url.query, keep_blank_values=True)
        # tab=0 is the all-notes list. Other lists may omit pending/private work.
        return (url.scheme == "https" and url.hostname == "creator.xiaohongshu.com"
                and url.port is None and url.username is None and url.password is None
                and not url.fragment and url.path == LIST_PATH
                and query.get("tab") == ["0"] and query.get("page") == ["0"]
                and response.request.method == "GET")
    except (AttributeError, TypeError, ValueError):
        return False


def parse_list_response(body: Any) -> list[WorkItem]:
    """Parse only the known notes envelope, not arbitrary nested id objects."""
    if not isinstance(body, dict):
        raise RuntimeError("小红书作品列表不是有效 JSON 对象")
    message = str(body.get("message") or body.get("msg") or "").lower()
    if any(token in message for token in ("未登录", "登录失效", "登录已失效", "请先登录", "请登录",
                                          "登录过期", "login required", "unauthorized")):
        raise LoginRequiredError("小红书作品列表要求重新登录")
    if ("success" in body and body["success"] is not True) or (
            "code" in body and (type(body["code"]) is not int or body["code"] != 0)):
        raise RuntimeError("小红书作品列表返回错误，未采用其中的作品")
    if body.get("success") is not True and not (type(body.get("code")) is int and body["code"] == 0):
        raise RuntimeError("小红书作品列表缺少成功响应标记")
    data = body.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("notes"), list):
        raise RuntimeError("小红书作品列表字段已变化")
    # Keep conflicting duplicate IDs separate. The matcher rejects ambiguity.
    works: list[WorkItem] = []
    for note in data["notes"][:100]:
        mapped = map_note(note)
        if mapped is not None:
            works.append(mapped)
    if data["notes"] and not works:
        raise RuntimeError("小红书作品列表缺少可识别的作品字段")
    return works


def read_xhs_works(page, *, wait_ms: int = 12_000) -> list[WorkItem]:
    """Navigate and observe the page's GET response; never click or submit."""
    captured: list[list[WorkItem]] = []
    errors: list[Exception] = []

    def on_response(response):
        if not _is_list_response(response):
            return
        try:
            if response.status == 401:
                raise LoginRequiredError("小红书作品列表登录已失效")
            if response.status != 200:
                raise RuntimeError("小红书作品列表 HTTP 请求失败")
            captured.append(parse_list_response(response.json()))
        except LoginRequiredError as exc:
            errors.append(exc)
        except Exception:
            # Do not retain transport exceptions or raw payloads: they can
            # contain signed URLs, cookies, or other users' note data.
            errors.append(RuntimeError("小红书作品列表无法读取"))

    page.on("response", on_response)
    try:
        page.goto(MANAGE_URL, wait_until="domcontentloaded", timeout=25_000)
        for waited in range(0, max(250, wait_ms) + 250, 250):
            _assert_manager_location(page)
            if captured:
                return captured[-1]
            if errors:
                raise errors[-1]
            if waited < max(250, wait_ms):
                page.wait_for_timeout(250)
        raise RuntimeError("未捕获到小红书本人作品列表，登录或页面可能已变化")
    finally:
        page.remove_listener("response", on_response)


def capture_xhs_snapshot(page) -> set[str] | None:
    """None means the pre-submit snapshot failed; an empty set is observed empty."""
    try:
        return {work.platform_content_id for work in read_xhs_works(page)}
    except Exception:
        return None


def find_xhs_work(works: list[WorkItem], *, title: str, since_ms: int,
                  content_id: str = "", snapshot_ids: set[str] | None = None,
                  until_ms: int | None = None) -> WorkItem | None:
    if not valid_since_ms(since_ms) or (not content_id and not normalize_title(title)):
        return None
    if until_ms is not None and (not valid_since_ms(until_ms) or until_ms < since_ms):
        return None
    if content_id and not NOTE_ID.fullmatch(content_id):
        return None
    now_ms = int(time.time() * 1000)
    if since_ms > now_ms + TIMESTAMP_TOLERANCE_MS:
        return None
    if content_id:
        # A receipt can identify a note before moderation completes. Its title
        # or displayed date may change during review/editing, but that must not
        # turn a recheck into a search for a different note.
        matches = [work for work in works if work.platform_content_id == content_id
                   and content_id not in (snapshot_ids or set())]
        return matches[0] if len(matches) == 1 else None
    latest_ms = min(now_ms, until_ms) if until_ms is not None else now_ms
    candidates = []
    for work in works:
        if not NOTE_ID.fullmatch(work.platform_content_id):
            continue
        if work.platform_content_id in (snapshot_ids or set()):
            continue
        if normalize_title(work.title) != normalize_title(title):
            continue
        timestamp = work.published_at_ms
        # Minute precision is sufficient only with an observed pre-submit
        # baseline proving this ID did not exist before our submission.
        if timestamp is None and snapshot_ids is not None and _minute_candidate(work, title=title, since_ms=since_ms, until_ms=until_ms):
            candidates.append(work)
            continue
        if (not valid_since_ms(timestamp) or timestamp < since_ms - TIMESTAMP_TOLERANCE_MS
                or timestamp > latest_ms + TIMESTAMP_TOLERANCE_MS):
            continue
        candidates.append(work)
    return candidates[0] if len(candidates) == 1 else None


def verify_xhs_publish(page, *, title: str, since_ms: int, content_id: str = "",
                       snapshot_ids: set[str] | None = None, attempts: int = 3,
                       delay_s: float = 3.0, until_ms: int | None = None) -> ReadbackResult:
    """Read-only, bounded verification; matching identity does not mean public."""
    evidence = {"source": "xhs_creator_notes", "snapshotCaptured": snapshot_ids is not None,
                "snapshotCount": len(snapshot_ids or ()), "attempts": 0}
    if (not valid_since_ms(since_ms) or (not content_id and not normalize_title(title))
            or (content_id and not NOTE_ID.fullmatch(content_id))
            or (until_ms is not None and (not valid_since_ms(until_ms) or until_ms < since_ms))):
        return ReadbackResult("unverified", evidence=evidence, error="核实参数无效")
    evidence["sinceMs"] = since_ms
    if until_ms is not None:
        evidence["untilMs"] = until_ms
    latest: list[WorkItem] = []
    read_succeeded = False
    for attempt in range(max(1, min(attempts, 4))):
        evidence["attempts"] = attempt + 1
        evidence["checkedAtMs"] = int(time.time() * 1000)
        try:
            latest = read_xhs_works(page)
            read_succeeded = True
            work = find_xhs_work(latest, title=title, since_ms=since_ms,
                                 content_id=content_id, snapshot_ids=snapshot_ids, until_ms=until_ms)
            if work:
                evidence["matchedBy"] = "content_id" if content_id else "exact_title_time"
                return ReadbackResult("verified", work, evidence=evidence)
            # A follow-up without the original snapshot can offer a preview,
            # but must not adopt its candidate as the submitted work identity.
            previews = [item for item in latest if _minute_candidate(item, title=title, since_ms=since_ms, until_ms=until_ms)]
            if len(previews) == 1:
                evidence["previewContentId"] = previews[0].platform_content_id
        except LoginRequiredError:
            return ReadbackResult("login_required", evidence=evidence, error="小红书登录已失效")
        except Exception:
            pass
        if attempt + 1 < max(1, min(attempts, 4)):
            page.wait_for_timeout(max(0, int(delay_s * 1000)))
    return ReadbackResult("unverified" if read_succeeded else "readback_error", evidence=evidence)


def receipt_from_result(result: ReadbackResult, *, signal: str = "", read_only: bool = False) -> dict:
    receipt = publish_receipt.from_readback("xiaohongshu", result)
    preview_id = result.evidence.get("previewContentId")
    if isinstance(preview_id, str) and NOTE_ID.fullmatch(preview_id):
        receipt["evidence"]["previewContentId"] = preview_id
    receipt["evidence"].update(source="xhs_creator_notes", readOnly=read_only)
    # Copy only our small, non-sensitive provenance fields. Never pass candidates,
    # raw errors, tokens, or account information through to notifications.
    if type(result.evidence.get("snapshotCaptured")) is bool:
        receipt["evidence"]["snapshotCaptured"] = result.evidence["snapshotCaptured"]
    for key in ("snapshotCount", "attempts", "checkedAtMs", "sinceMs", "untilMs"):
        value = result.evidence.get(key)
        if type(value) is int and 0 <= value <= 9_999_999_999_999:
            receipt["evidence"][key] = value
    if result.evidence.get("matchedBy") in {"content_id", "exact_title_time"}:
        receipt["evidence"]["matchedBy"] = result.evidence["matchedBy"]
    if signal in {"success_message", "form_reset", "page_navigation"}:
        receipt["evidence"]["submissionSignal"] = signal
    if (not read_only and result.matched is None and signal in {"success_message", "form_reset"}
            and receipt["outcome"] == "unverified"):
        receipt["outcome"] = "submitted"
        receipt["platformStatus"] = "ui_submitted"
        receipt["message"] = "页面已完成提交，作品列表尚未核实本次笔记；请稍后重新核实，避免重复发布。"
    return receipt
