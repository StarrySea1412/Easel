"""Observe WeChat Channels' own creator list without changing any work.

First-party, anonymous sources inspected on 2026-10-09:
https://res.wx.qq.com/t/wx_fed/finder/helper/content/finder-helper-content/res/static/js/async/97.98a20fe5.js
  postService.list -> /post/post_list; getPostList consumes data.list. Rows use
  objectId, desc.description, createTime, handleStatus, visibleType and flag.
https://res.wx.qq.com/t/wx_fed/finder/helper/content/finder-helper-content/res/static/js/async/537.9bd4b6c6.js
  Module 96513 defines the processing, visibility and membership enums below.
https://res.wx.qq.com/t/wx_fed/finder/helper/content/finder-helper-content/res/static/js/async/755.151a1d93.js
  PostItem checks processing, effectiveTime and visibility separately. Its
  copy-video-ID action copies objectId; isPreview means non-member preview.

These observations are not a stable public API. Capture only the page's list
response; never reconstruct signed requests, upload, edit or click publish.
No authenticated list or anonymous public-work access was tested. In particular,
the site's shortUrl endpoint needs a separate identity-bound URL review: the
creator URL, media URL and mobile JS-API wrapper are not public work URLs here.
"""
from __future__ import annotations

import re
import time
from typing import Any
from urllib.parse import urlsplit

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from platform_readback import LoginRequiredError, ReadbackResult, WorkItem
import publish_receipt

MANAGE_URL = "https://channels.weixin.qq.com/platform/post/list"
LIST_PATH = "/cgi-bin/mmfinderassistant-bin/post/post_list"
# This is the receipt contract's safe opaque-ID subset, not a promise that
# Channels IDs are numeric or that an ID can be interpolated into a public URL.
CONTENT_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
HANDLE_STATUS = {1: "processing", 2: "processed", 3: "failed", 4: "failed", 5: "failed"}
VISIBLE_TYPE = {1: "public", 2: "private", 3: "private"}
MEMBER_FLAGS = 256 | 1024 | 32768
KNOWN_FLAGS = 65535  # First-party ObjectFlag enum through MemberNotVisiable.
TIMESTAMP_TOLERANCE_MS = 1000


def valid_since_ms(value: Any) -> bool:
    return type(value) is int and 1_000_000_000_000 <= value <= 9_999_999_999_999


def normalize_title(value: Any) -> str:
    return " ".join(value.split()) if isinstance(value, str) else ""


def normalize_status(item: dict) -> str:
    """Require positive evidence for processing, timing and public visibility."""
    handle = item.get("handleStatus")
    status = HANDLE_STATUS.get(handle) if type(handle) is int else None
    if status in {"processing", "failed"}:
        return status
    effective = item.get("effectiveTime")
    if type(effective) is int and effective > 0:
        # The official UI still calls this scheduled even when the time has
        # elapsed. A local clock must never promote it to published.
        return "scheduled"
    visible = item.get("visibleType")
    visibility = VISIBLE_TYPE.get(visible) if type(visible) is int else None
    flags = item.get("flag")
    if visibility == "private" or (type(flags) is int and flags >= 0 and flags & MEMBER_FLAGS):
        return "private"
    preview = item.get("isPreview")
    if preview is True or (type(preview) is int and preview == 1):
        return "private"
    if (status != "processed" or visibility != "public"
            or type(effective) is not int or effective != 0
            or type(flags) is not int or flags < 0 or flags & ~KNOWN_FLAGS):
        return "unknown"
    if "isPreview" in item and not (preview is False or (type(preview) is int and preview == 0)):
        return "unknown"
    # The observed client does not establish the meaning of additional content
    # audit/status fields. If one appears, do not treat it as a public success.
    if any(key in item for key in ("status", "auditStatus", "objectStatus")):
        return "unknown"
    # originalInfo.auditOriginalFlag is a copyright claim review, not a content
    # publication review; it cannot establish or negate public visibility.
    return "published"


def map_work(item: Any) -> WorkItem | None:
    if not isinstance(item, dict):
        return None
    content_id = item.get("objectId")
    # Avoid bool/float coercion and precision loss for 64-bit platform IDs.
    if type(content_id) is int and content_id > 0:
        content_id = str(content_id)
    if not isinstance(content_id, str) or not CONTENT_ID.fullmatch(content_id):
        return None
    if content_id.isdecimal() and int(content_id) == 0:
        return None
    desc = item.get("desc")
    if not isinstance(desc, dict) or not isinstance(desc.get("description"), str):
        return None
    # web_publisher writes title, description and tags on separate lines. Use
    # the complete first title line, never a short substring of another work.
    lines = desc["description"].strip().splitlines()
    title = lines[0] if lines else ""
    timestamp = item.get("createTime")
    if type(timestamp) is int and 1_000_000_000 <= timestamp < 10_000_000_000:
        timestamp *= 1000
    timestamp = timestamp if valid_since_ms(timestamp) else None
    return WorkItem(content_id, title, normalize_status(item), timestamp)


def _is_list_response(response) -> bool:
    try:
        url = urlsplit(response.url)
        return (url.scheme == "https" and url.hostname == "channels.weixin.qq.com"
                and url.port is None and url.username is None and url.password is None
                and not url.fragment and url.path == LIST_PATH
                and response.request.method == "POST")
    except (AttributeError, TypeError, ValueError):
        return False


def _assert_manager_location(page) -> None:
    try:
        url = urlsplit(page.url or "")
        same_origin = (url.scheme == "https" and url.hostname == "channels.weixin.qq.com"
                       and url.port is None and url.username is None and url.password is None)
        if same_origin and "login" in url.path.lower():
            raise LoginRequiredError("视频号创作者登录已失效")
        if not same_origin or url.path.rstrip("/") not in {
                "/platform/post/list", "/micro/content/post/list"}:
            raise RuntimeError("视频号作品管理页未就绪或已跳转")
        qr = page.query_selector("iframe[src*='open.weixin.qq.com/connect/qrconnect']")
        if qr is not None and qr.is_visible():
            raise LoginRequiredError("视频号作品管理页要求扫码登录")
    except ValueError as exc:
        raise RuntimeError("视频号作品管理页地址无效") from exc


def parse_list_response(body: Any) -> list[WorkItem]:
    if not isinstance(body, dict):
        raise RuntimeError("视频号作品列表不是有效 JSON 对象")
    code = body.get("errCode")
    if type(code) is int and 300330 <= code < 300350:
        # First-party main-client MinNeedLogin/MaxNeedLogin enum and predicate.
        raise LoginRequiredError("视频号作品列表登录已失效")
    if type(code) is not int or code != 0:
        raise RuntimeError("视频号作品列表缺少成功标记或返回错误")
    data = body.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("list"), list):
        raise RuntimeError("视频号作品列表字段已变化")
    base = data.get("baseResp")
    if base is not None:
        base_code = base.get("errcode") if isinstance(base, dict) else None
        if type(base_code) is int and 300330 <= base_code < 300350:
            raise LoginRequiredError("视频号作品列表登录已失效")
        if (not isinstance(base, dict) or type(base.get("errcode")) is not int
                or base["errcode"] != 0):
            raise RuntimeError("视频号作品列表返回业务错误")
    # Do not trim or silently drop a malformed row: it could be another work
    # with the same title/time, making an otherwise unique match ambiguous.
    if len(data["list"]) > 100:
        raise RuntimeError("视频号作品列表超出单页核实范围")
    works = [map_work(item) for item in data["list"]]
    if any(work is None for work in works):
        raise RuntimeError("视频号作品字段或编号格式暂不支持")
    return works


def read_channels_works(page, *, wait_ms: int = 12_000) -> list[WorkItem]:
    """Navigate to the list and observe its own request, without replaying it."""
    captured: list[list[WorkItem]] = []
    errors: list[Exception] = []

    def on_response(response):
        if not _is_list_response(response):
            return
        try:
            if response.status == 401:
                raise LoginRequiredError("视频号作品列表登录已失效")
            if response.status != 200:
                raise RuntimeError("视频号作品列表 HTTP 请求失败")
            captured.append(parse_list_response(response.json()))
        except LoginRequiredError as exc:
            errors.append(exc)
        except Exception:
            # Transport messages and raw payloads can contain signed URLs,
            # private IDs or login data. Keep them out of result/receipt logs.
            errors.append(RuntimeError("视频号作品列表无法读取或格式已变化"))

    page.on("response", on_response)
    try:
        page.goto(MANAGE_URL, wait_until="domcontentloaded", timeout=25_000)
        for waited in range(0, max(250, min(wait_ms, 30_000)) + 250, 250):
            _assert_manager_location(page)
            expired = next((error for error in errors if isinstance(error, LoginRequiredError)), None)
            if expired:
                raise expired
            if captured:
                return captured[-1]
            if errors:
                raise errors[-1]
            if waited < max(250, min(wait_ms, 30_000)):
                page.wait_for_timeout(250)
        raise RuntimeError("未捕获到视频号本人作品列表，登录或页面可能已变化")
    finally:
        page.remove_listener("response", on_response)


def capture_channels_snapshot(page) -> set[str] | None:
    """None is a failed read; an empty set is an observed empty list."""
    try:
        return {work.platform_content_id for work in read_channels_works(page)}
    except Exception:
        return None


def find_channels_work(works: list[WorkItem], *, title: str, since_ms: int,
                       content_id: str = "", snapshot_ids: set[str] | None = None,
                       until_ms: int | None = None) -> WorkItem | None:
    if (not valid_since_ms(since_ms) or (not content_id and not normalize_title(title))
            or not isinstance(content_id, str) or (content_id and not CONTENT_ID.fullmatch(content_id))
            or (until_ms is not None and (not valid_since_ms(until_ms) or until_ms < since_ms))):
        return None
    now_ms = int(time.time() * 1000)
    if since_ms > now_ms + TIMESTAMP_TOLERANCE_MS:
        return None
    if content_id:
        # Once a receipt identifies a work, later title/date edits must not
        # redirect its recheck to a different work with the original title.
        matches = [work for work in works if work.platform_content_id == content_id
                   and content_id not in (snapshot_ids or set())]
        return matches[0] if len(matches) == 1 else None
    latest_ms = min(now_ms, until_ms) if until_ms is not None else now_ms
    matches = []
    for work in works:
        if not CONTENT_ID.fullmatch(work.platform_content_id):
            continue
        if work.platform_content_id in (snapshot_ids or set()):
            continue
        if normalize_title(work.title) != normalize_title(title):
            continue
        timestamp = work.published_at_ms
        if (not valid_since_ms(timestamp) or timestamp < since_ms - TIMESTAMP_TOLERANCE_MS
                or timestamp > latest_ms + TIMESTAMP_TOLERANCE_MS):
            continue
        matches.append(work)
    return matches[0] if len(matches) == 1 else None


def verify_channels_publish(page, *, title: str, since_ms: int, content_id: str = "",
                            snapshot_ids: set[str] | None = None, limit: int = 20,
                            attempts: int = 3, delay_s: float = 3.0,
                            until_ms: int | None = None) -> ReadbackResult:
    evidence = {"source": "channels_creator_post_list", "snapshotCaptured": snapshot_ids is not None,
                "snapshotCount": len(snapshot_ids or ()), "attempts": 0}
    if (not valid_since_ms(since_ms) or (not content_id and not normalize_title(title))
            or not isinstance(content_id, str) or (content_id and not CONTENT_ID.fullmatch(content_id))
            or (until_ms is not None and (not valid_since_ms(until_ms) or until_ms < since_ms))):
        return ReadbackResult("unverified", evidence=evidence, error="核实参数无效")
    evidence["sinceMs"] = since_ms
    if until_ms is not None:
        evidence["untilMs"] = until_ms
    read_succeeded = False
    rounds = max(1, min(attempts, 4))
    for attempt in range(rounds):
        evidence["attempts"] = attempt + 1
        evidence["checkedAtMs"] = int(time.time() * 1000)
        try:
            works = read_channels_works(page)
            read_succeeded = True
            evidence["count"] = len(works)
            # The observed page controls its page size. Inspect every captured
            # row rather than silently dropping possible duplicate matches.
            work = find_channels_work(works, title=title, since_ms=since_ms,
                                      content_id=content_id, snapshot_ids=snapshot_ids,
                                      until_ms=until_ms)
            if work:
                evidence["matchedBy"] = "content_id" if content_id else "exact_title_time"
                return ReadbackResult("verified", work, evidence=evidence)
        except LoginRequiredError:
            return ReadbackResult("login_required", evidence=evidence, error="视频号登录已失效")
        except Exception:
            pass
        if attempt + 1 < rounds:
            try:
                page.wait_for_timeout(max(0, min(int(delay_s * 1000), 30_000)))
            except Exception:
                return ReadbackResult("readback_error", evidence=evidence)
    return ReadbackResult("unverified" if read_succeeded else "readback_error", evidence=evidence)


def receipt_from_result(result: ReadbackResult, *, read_only: bool = False, signal: str = "") -> dict:
    receipt = publish_receipt.from_readback("weixin-channels", result)
    receipt["evidence"].update(source="channels_creator_post_list", readOnly=read_only,
                               urlSource="unavailable")
    if type(result.evidence.get("snapshotCaptured")) is bool:
        receipt["evidence"]["snapshotCaptured"] = result.evidence["snapshotCaptured"]
    for key in ("snapshotCount", "attempts", "checkedAtMs", "sinceMs", "untilMs", "count"):
        value = result.evidence.get(key)
        if type(value) is int and 0 <= value <= 9_999_999_999_999:
            receipt["evidence"][key] = value
    if result.evidence.get("matchedBy") in {"content_id", "exact_title_time"}:
        receipt["evidence"]["matchedBy"] = result.evidence["matchedBy"]
    if signal in {"success_message", "page_navigation"}:
        receipt["evidence"]["submissionSignal"] = signal
    # There is deliberately no URL fallback to the creator or media page.
    return receipt
