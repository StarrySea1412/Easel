"""Deterministic tool-failure repair for one Easel chat turn.

The repair agent is deliberately not an LLM retry loop.  It can repair only
known local-environment failures whose side effect is a bounded file copy.
Provider failures, browser/auth failures and unknown tool states become an
auditable manual handoff for the next user message.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import time
from pathlib import Path
from typing import Any

from easel.execution import public_text


SAFE_ID = re.compile(r"[A-Za-z0-9_.-]{1,160}\Z")
IMAGE_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"})
ALLOWED_DIRECTORY_MARKERS = (
    "local media path is not under an allowed directory",
    "path is not under an allowed directory",
)


def _safe_id(value: str, fallback: str = "unknown") -> str:
    if isinstance(value, str) and SAFE_ID.fullmatch(value):
        return value
    return fallback


def _text(result: dict[str, Any], credentials: Any = None) -> str:
    content = result.get("content")
    if isinstance(content, str):
        return public_text(content, credentials, 4000)
    if isinstance(content, list):
        return public_text("\n".join(
            block.get("text", "") for block in content
            if isinstance(block, dict) and isinstance(block.get("text"), str)
        ), credentials, 4000)
    if isinstance(result.get("output"), str):
        return public_text(result["output"], credentials, 4000)
    details = result.get("details")
    if isinstance(details, dict):
        for key in ("message", "error", "aggregated", "tail"):
            if isinstance(details.get(key), str):
                return public_text(details[key], credentials, 4000)
    return ""


def _source_path(raw: Any, outputs_root: Path) -> tuple[Path | None, str]:
    if not isinstance(raw, str) or not raw.strip():
        return None, "tool failure did not include a source path"
    value = raw.strip()
    # OpenClaw may expose the Linux data mount while tests/source runs use the
    # configured local outputs root.  Only this exact virtual prefix is mapped.
    if value in {"outputs", "outputs/"}:
        value = "."
    elif value.startswith("outputs/"):
        value = value[len("outputs/"):]
    elif value == "/data/outputs":
        value = "."
    elif value.startswith("/data/outputs/"):
        value = value[len("/data/outputs/"):]
    candidate = Path(value).expanduser()
    try:
        root = outputs_root.expanduser().resolve()
        target = (root / candidate if not candidate.is_absolute() else candidate).resolve()
        relative = target.relative_to(root)
    except (OSError, ValueError):
        return None, "source path is outside the configured outputs root"
    if not relative.parts or any(part in {"", ".", ".."} for part in relative.parts):
        return None, "source path is not a concrete outputs file"
    if target.suffix.lower() not in IMAGE_SUFFIXES:
        return None, "source path is not a supported image"
    if not target.is_file():
        return None, "source image does not exist"
    return target, ""


def _path_from_failure(row: dict[str, Any], message: str) -> str:
    value = row.get("path")
    if isinstance(value, str) and value.strip():
        return value
    match = re.search(r"(?:/data/outputs/|[A-Za-z]:[\\/])[^\\\"'<>\\r\\n]+", message)
    return match.group(0).rstrip(".,;)") if match else ""


def _receipt_path(root: Path, session: str, turn: str, call: str) -> Path:
    digest = hashlib.sha256(f"{session}\0{turn}\0{call}".encode()).hexdigest()[:24]
    return root / "_repairs" / _safe_id(session) / _safe_id(turn) / f"{digest}.json"


class RepairAgent:
    """One bounded repair decision per tool call."""

    def __init__(self, outputs_root: Path, session: str, turn: str, credentials: Any = None,
                 workspace: Path | None = None, max_repairs: int = 1,
                 max_session_repairs: int = 3, stop_event: Any = None):
        self.outputs_root = Path(outputs_root).expanduser().resolve()
        self.session = _safe_id(session)
        self.turn = _safe_id(turn)
        self.credentials = credentials
        self.workspace = Path(workspace).expanduser() if workspace else None
        self.max_repairs = max(0, int(max_repairs))
        self.max_session_repairs = max(0, int(max_session_repairs))
        self.stop_event = stop_event
        self._seen: set[str] = set()
        self._repairs = 0
        self._session_repairs = 0
        self._receipt_paths: dict[str, Path] = {}
        self._restore_budget()

    def _restore_budget(self) -> None:
        """Restore idempotency and repair budgets after a supervisor restart."""
        root = self.outputs_root / "_repairs" / self.session
        try:
            paths = list(root.glob("*/*.json"))
        except OSError:
            return
        for path in paths:
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError, TypeError):
                continue
            if not isinstance(value, dict):
                continue
            call = value.get("callId")
            if isinstance(call, str) and value.get("turnId") == self.turn:
                self._seen.add(call)
                self._receipt_paths[call] = path
                if value.get("status") == "repaired":
                    self._repairs += 1
            if value.get("status") == "repaired":
                self._session_repairs += 1

    def _workspace(self) -> Path:
        if self.workspace is not None:
            return self.workspace
        from easel.openclaw_workspace import workspace_dir
        return Path(workspace_dir()).expanduser()

    def _stopped(self) -> bool:
        return bool(self.stop_event is not None and self.stop_event.is_set())

    def _write_receipt(self, call: str, receipt: dict[str, Any]) -> dict[str, Any]:
        path = _receipt_path(self.outputs_root, self.session, self.turn, call)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, path)
        if call:
            self._receipt_paths[call] = path
        public = {key: value for key, value in receipt.items() if key not in {"sourcePath"}}
        public["receiptPath"] = str(path)
        return public

    def on_failure(self, row: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
        call = str(row.get("id") or "")
        if call in self._seen:
            return {"status": "ignored", "reason": "duplicate tool failure", "agent": "repair-agent",
                    "callId": call, "receiptPath": str(self._receipt_paths[call])
                    if call in self._receipt_paths else ""}
        self._seen.add(call)
        name = str(row.get("name") or "").split(".")[-1].lower()
        message = _text(result, self.credentials)
        common = {"agent": "repair-agent", "tool": name, "callId": call,
                  "sessionId": self.session, "turnId": self.turn,
                  "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        if name not in {"view_image", "imageview", "read_image"}:
            reason = "provider or non-deterministic tool failure requires manual continuation"
            if any(token in message.lower() for token in ("provider_timeout", "model_provider_timeout", "timeout")):
                reason = "provider timeout is recorded but never retried by repair-agent"
            return self._write_receipt(call, {**common, "status": "manual", "reason": reason,
                                               "failure": message[:1000]})
        if self._repairs >= self.max_repairs:
            return self._write_receipt(call, {**common, "status": "manual", "reason": "repair limit reached"})
        if self._session_repairs >= self.max_session_repairs:
            return self._write_receipt(call, {**common, "status": "manual",
                                               "reason": "session repair limit reached"})
        if self._stopped():
            return self._write_receipt(call, {**common, "status": "manual",
                                               "reason": "repair stopped by user"})
        if not any(marker in message.lower() for marker in ALLOWED_DIRECTORY_MARKERS):
            return self._write_receipt(call, {**common, "status": "manual",
                                               "reason": "image failure is outside the known allowed-directory repair"})
        source, reason = _source_path(_path_from_failure(row, message), self.outputs_root)
        if source is None:
            return self._write_receipt(call, {**common, "status": "manual", "reason": reason,
                                               "failure": message[:1000]})
        try:
            if self._stopped():
                return self._write_receipt(call, {**common, "status": "manual",
                                                   "reason": "repair stopped by user"})
            target_dir = self._workspace() / "_inspect" / "easel-repair"
            target_dir.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256(f"{self.session}\0{self.turn}\0{call}".encode()).hexdigest()[:24]
            target = (target_dir / f"{digest}{source.suffix.lower()}").resolve()
            target.relative_to(target_dir.resolve())
            shutil.copy2(source, target)
        except (OSError, ValueError) as exc:
            return self._write_receipt(call, {**common, "status": "manual",
                                               "reason": f"repair copy failed: {type(exc).__name__}",
                                               "failure": message[:1000]})
        self._repairs += 1
        self._session_repairs += 1
        return self._write_receipt(call, {**common, "status": "repaired", "action": "copy_image_for_inspection",
                                           "sourcePath": str(source), "targetPath": str(target),
                                           "failure": message[:1000]})


def read_recent_receipts(outputs_root: Path, session: str, limit: int = 4,
                         max_age_seconds: int = 24 * 60 * 60) -> list[dict[str, Any]]:
    root = Path(outputs_root).expanduser().resolve() / "_repairs" / _safe_id(session)
    rows: list[tuple[float, dict[str, Any]]] = []
    try:
        paths = list(root.glob("*/*.json"))
    except OSError:
        return []
    now = time.time()
    for path in paths:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(value, dict):
                if value.get("sessionId") != _safe_id(session):
                    continue
                if value.get("status") not in {"repaired", "manual"}:
                    continue
                if max_age_seconds >= 0 and now - path.stat().st_mtime > max_age_seconds:
                    continue
                rows.append((path.stat().st_mtime, value))
        except (OSError, ValueError, TypeError):
            continue
    rows.sort(key=lambda item: item[0], reverse=True)
    return [value for _, value in rows[:max(0, min(10, int(limit)))]]


def context_for_session(outputs_root: Path, session: str) -> str:
    receipts = read_recent_receipts(outputs_root, session)
    if not receipts:
        return ""
    public = []
    for item in receipts:
        public.append({key: item[key] for key in (
            "status", "tool", "action", "reason", "targetPath", "turnId", "createdAt"
        ) if key in item})
    return (
        "〔修复 Agent 回执 · 仅作为事实〕\n"
        "以下是当前会话最近工具失败的确定性修复记录。不要重放已失败的工具调用；"
        "如果状态为 repaired，可继续使用回执中的 targetPath 进行后续读取；如果状态为 manual，"
        "请先说明需要人工处理的边界，不要自动重试模型、浏览器、认证或发布操作。\n"
        + json.dumps(public, ensure_ascii=False)
    )
