"""Small, offline publishing result contract shared by CLI publishers and Web.

A matched creator record proves identity, not public publication. Receipts keep
those states separate and never carry creator-session URLs or raw API responses.
"""
from __future__ import annotations

import json
import os
import re
import uuid
from contextvars import ContextVar
from functools import wraps
from urllib.parse import urlsplit

PREFIX = "EASEL_PUBLISH_RECEIPT="
OUTCOMES = frozenset({"published", "submitted", "draft", "unverified", "failed"})
_RUN: ContextVar[dict | None] = ContextVar("publish_receipt_run", default=None)
_PUBLIC_PATHS = {
    "xiaohongshu": ("www.xiaohongshu.com", r"/explore/([0-9a-fA-F]{24})"),
    "douyin": ("www.douyin.com", r"/(?:video|note)/([1-9][0-9]{5,23})"),
    "kuaishou": ("www.kuaishou.com", r"/short-video/([A-Za-z0-9_-]{8,32})"),
    "zhihu": ("zhuanlan.zhihu.com", r"/p/([1-9][0-9]{0,23})"),
    "bilibili": ("www.bilibili.com", r"/video/(BV[A-Za-z0-9]{10})"),
}
_PUBLISHED = {"published", "public", "已发布", "公开", "公开发布"}
_SUBMITTED = {"reviewing", "pending", "pending_review", "in_review", "in_reviewing",
              "scheduled", "processing", "submitted", "审核中", "待审核", "已提交",
              "转码中", "发布中", "定时发布", "待发布"}
_PRIVATE = {"private", "unlisted", "self_only", "friends_only", "私密", "仅自己可见",
            "好友可见", "粉丝可见"}
_FAILED = {"deleted", "prohibited", "rejected", "failed", "已删除", "审核不通过",
           "审核失败", "已下架", "已屏蔽", "违规"}


def observed_public_work(platform: str, url: str, expected_id: str = "") -> tuple[str, str]:
    """Accept an exact public work page, with no credentials, query, or fragment."""
    if platform not in _PUBLIC_PATHS or not isinstance(url, str):
        return "", ""
    if len(url) > 2048 or re.search(r"[\x00-\x20\\]", url):
        return "", ""
    try:
        parsed = urlsplit(url)
        host, pattern = _PUBLIC_PATHS[platform]
        if (parsed.scheme != "https" or parsed.hostname != host or parsed.port is not None
                or parsed.username is not None or parsed.password is not None
                or parsed.query or parsed.fragment):
            return "", ""
        path = parsed.path[:-1] if parsed.path.endswith("/") else parsed.path
        match = re.fullmatch(pattern, path)
        if not match or (expected_id and match[1] != expected_id):
            return "", ""
        return match[1], f"https://{host}{path}"
    except ValueError:
        return "", ""


def public_work_url(platform: str, content_id: str, *, kind: str = "video") -> str:
    """Construct only documented public routes from a read-back canonical ID."""
    if platform == "xiaohongshu" and re.fullmatch(r"[0-9a-fA-F]{24}", content_id):
        return f"https://www.xiaohongshu.com/explore/{content_id}"
    if platform == "douyin" and re.fullmatch(r"[1-9][0-9]{5,23}", content_id):
        route = "video" if kind == "video" else "note"
        return f"https://www.douyin.com/{route}/{content_id}"
    # Numeric internal photo IDs are not public short-video IDs. Do not guess.
    if (platform == "kuaishou" and re.fullmatch(r"[A-Za-z0-9]{8,32}", content_id)
            and re.search(r"[A-Za-z]", content_id)):
        return f"https://www.kuaishou.com/short-video/{content_id}"
    if platform == "bilibili" and re.fullmatch(r"BV[A-Za-z0-9]{10}", content_id):
        return f"https://www.bilibili.com/video/{content_id}"
    return ""


def make_receipt(platform: str, outcome: str, *, platform_status: str = "",
                 content_id: str = "", url: str = "", message: str = "",
                 evidence: dict | None = None) -> dict:
    if outcome not in OUTCOMES:
        raise ValueError("Unknown publishing outcome")
    scope = _RUN.get()
    receipt_id = (scope["receipt_id"] if scope else
                  os.environ.get("EASEL_PUBLISH_RECEIPT_ID") or uuid.uuid4().hex)
    cid = str(content_id or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", cid):
        cid = ""
    status = str(platform_status or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_ :\-\u3400-\u9fff]{0,80}", status):
        status = "unknown"
    safe_url = observed_public_work(platform, url, cid)[1] if url and cid else ""
    return {
        "schemaVersion": 1, "platform": platform, "receiptId": receipt_id,
        "outcome": outcome, "platformStatus": status, "contentId": cid,
        "url": safe_url if outcome == "published" else "",
        "message": message, "evidence": evidence or {},
    }


def from_readback(platform: str, result, *, kind: str = "video") -> dict:
    readback_outcome = getattr(result, "outcome", "readback_error")
    matched = getattr(result, "matched", None)
    evidence = {"kind": "creator_readback", "readbackOutcome": readback_outcome,
                "matched": bool(matched), "publicAccessChecked": False}
    if readback_outcome != "verified" or matched is None:
        messages = {
            "login_required": "读回时登录已失效，请重新登录后核对作品；当前发布结果未核实。",
            "unverified": "作品列表尚未匹配到本次内容，请先在平台后台核对，避免重复发布。",
        }
        return make_receipt(platform, "unverified", platform_status=readback_outcome,
                            message=messages.get(readback_outcome, "作品读回异常，发布结果未核实，请先到平台后台核对。"),
                            evidence=evidence)
    status = str(getattr(matched, "status", "") or "").strip()
    normalized = status.lower()
    content_id = str(getattr(matched, "platform_content_id", "") or "").strip()
    id_pattern = {"douyin": r"[1-9][0-9]{5,23}", "kuaishou": r"[A-Za-z0-9]{8,32}",
                  "bilibili": r"BV[A-Za-z0-9]{10}", "xiaohongshu": r"[0-9a-fA-F]{24}",
                  # The creator's objectId identifies the work, but is not a
                  # documented public URL component. Never construct a URL.
                  "weixin-channels": r"[A-Za-z0-9_-]{1,128}"}.get(platform)
    valid_id = bool(id_pattern and re.fullmatch(id_pattern, content_id))
    public_status = normalized in _PUBLISHED or (platform == "bilibili" and normalized == "开放浏览")
    url = ""
    if public_status and valid_id:
        outcome, message = "published", "已在平台作品列表核实为公开发布。"
        url = public_work_url(platform, content_id, kind=kind)
        evidence["urlSource"] = "canonical_content_id" if url else "unavailable"
        if not url:
            message += "平台未提供可确认的公开作品链接。"
    elif normalized in _SUBMITTED:
        outcome, message = "submitted", f"平台已接收作品，当前状态：{status}；尚未确认公开发布。"
    elif normalized in _PRIVATE:
        outcome, message = "unverified", "已找到作品，但它为私密或有限可见，未确认公开发布。"
    elif normalized in _FAILED:
        outcome, message = "failed", f"平台作品状态：{status}；本次内容未公开发布。"
    elif public_status:
        outcome, message = "unverified", "作品状态为公开，但尚未取得可核实的规范作品编号，请到平台后台核对。"
    else:
        outcome, message = "unverified", "已找到作品，但平台状态不明确，尚未确认公开发布。"
    return make_receipt(platform, outcome, platform_status=status or "unknown",
                        content_id=content_id, url=url, message=message, evidence=evidence)


def from_ui(platform: str, *, url: str = "", signal: str = "") -> dict:
    evidence = {"kind": "ui_submission", "signal": signal, "publicAccessChecked": False}
    if platform == "zhihu":
        content_id, public_url = observed_public_work(platform, url)
        if public_url:
            evidence.update(kind="public_page_navigation", urlSource="observed_page_url")
            return make_receipt(platform, "published", platform_status="public_page",
                                content_id=content_id, url=public_url,
                                message="发布后已跳转到知乎公开文章页。", evidence=evidence)
    elif signal in {"success_message", "form_reset", "page_navigation"}:
        if platform == "weixin-channels":
            try:
                parsed = urlsplit(url)
                allowed = (parsed.scheme == "https" and parsed.hostname == "channels.weixin.qq.com"
                           and parsed.port is None and parsed.username is None and parsed.password is None
                           and (parsed.path.rstrip("/") == "/platform/post/list"
                                if signal == "page_navigation" else "login" not in parsed.path.lower()))
            except ValueError:
                allowed = False
            if not allowed:
                return make_receipt(platform, "unverified", platform_status="unverified",
                                    message="提交后未能核实平台页面，发布结果仍需到视频号后台核对。",
                                    evidence=evidence)
        # Navigation alone is especially ambiguous on the XHS creator site.
        if platform != "xiaohongshu" or signal != "page_navigation":
            return make_receipt(platform, "submitted", platform_status="ui_submitted",
                                message="页面已完成提交，尚未读回确认公开发布；暂无可核实的作品链接。",
                                evidence=evidence)
    return make_receipt(platform, "unverified", platform_status="unverified",
                        message="页面操作已结束，发布结果和公开作品链接仍需到平台后台核对。",
                        evidence=evidence)


def emit(receipt: dict) -> dict:
    # ASCII framing also works in embedded Windows Python's locale pipes.
    # A subprocess progress line may not end in a newline (notably biliup).
    print("\n" + PREFIX + json.dumps(receipt, ensure_ascii=True, separators=(",", ":")), flush=True)
    scope = _RUN.get()
    if scope is not None:
        scope["emitted"] = True
    return receipt


def mark_submitted() -> None:
    """Mark the point after which an interruption cannot prove a failed publish."""
    scope = _RUN.get()
    if scope is not None:
        scope["submitted"] = True


def publishing_command(platform: str | None = None, *, exec_attribute: str | None = "exec"):
    """Emit one fallback receipt on errors; dry-run and login commands stay inert."""
    def decorate(func):
        @wraps(func)
        def wrapped(args):
            if exec_attribute and not getattr(args, exec_attribute, False):
                return func(args)
            platform_id = platform or args.platform
            scope = {"receipt_id": os.environ.get("EASEL_PUBLISH_RECEIPT_ID") or uuid.uuid4().hex,
                     "emitted": False, "submitted": False}
            token = _RUN.set(scope)

            def fallback(failed: bool) -> None:
                outcome = "failed" if failed and not scope["submitted"] else "unverified"
                emit(make_receipt(platform_id, outcome, platform_status="execution_error" if failed else "unknown",
                                  message=("提交前流程失败，内容未发布。" if outcome == "failed" else
                                           "发布流程未取得可核实的结果，请先到平台后台核对，避免重复发布。"),
                                  evidence={"kind": "execution", "submissionAttempted": scope["submitted"]}))
            try:
                result = func(args)
                if not scope["emitted"]:
                    fallback(result != 0)
                return result
            except (Exception, SystemExit):
                if not scope["emitted"]:
                    fallback(True)
                raise
            finally:
                _RUN.reset(token)
        return wrapped
    return decorate
