"""Durable identity and lifecycle ledger for one Easel chat run.

The web supervisor is intentionally process-local, while the provider run may
outlive the browser connection (and sometimes the web process).  This module
keeps the small amount of identity needed to reconcile those two lifetimes in
one atomic JSON file per logical turn.  It never stores prompts, model output,
credentials, or tool arguments.
"""
from __future__ import annotations

import copy
import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Any


SAFE_ID = re.compile(r"[A-Za-z0-9_.-]{1,160}\Z")
TERMINAL_STATUSES = frozenset({"completed", "failed", "stopped", "unknown"})
_UNSET = object()
_LOCK = threading.RLock()


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _path(root: Path, turn_id: str) -> Path:
    if not isinstance(turn_id, str) or not SAFE_ID.fullmatch(turn_id):
        raise ValueError("invalid turn id")
    return root / "runs" / f"{turn_id}.json"


def _read_path(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError, TypeError):
        return None
    return value if isinstance(value, dict) else None


def read(root: Path, turn_id: str) -> dict[str, Any] | None:
    """Read a run snapshot without exposing mutable module state."""
    try:
        with _LOCK:
            value = _read_path(_path(root, turn_id))
            return copy.deepcopy(value) if value is not None else None
    except ValueError:
        return None


def _public_error(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    allowed = {"code", "category", "retryable", "message", "detail"}
    result = {key: value[key] for key in allowed if key in value}
    for key in ("message", "detail"):
        if isinstance(result.get(key), str):
            result[key] = result[key][:1000]
    return result or None


def _atomic_write(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _event(record: dict[str, Any], kind: str, **details: Any) -> None:
    sequence = int(record.get("eventSeq", 0)) + 1
    item: dict[str, Any] = {"seq": sequence, "type": kind, "at": _now()}
    for key, value in details.items():
        if value is not _UNSET and value is not None:
            item[key] = value
    record["eventSeq"] = sequence
    history = record.setdefault("events", [])
    if isinstance(history, list):
        history.append(item)
        del history[:-200]
    record["lastEvent"] = kind
    record["updatedAt"] = item["at"]


def create(
    root: Path,
    turn_id: str,
    *,
    session_id: str,
    session_key: str,
    model_ref: str | None = None,
    engine: str = "openclaw",
    attempt: int = 1,
    recovery_of: str | None = None,
) -> dict[str, Any]:
    """Create the first ledger row, or return the existing row unchanged.

    Reusing a logical turn ID must never silently create a second paid request.
    Callers can create a new turn with ``recovery_of`` when an explicit retry
    has been requested.
    """
    path = _path(root, turn_id)
    with _LOCK:
        existing = _read_path(path)
        if existing is not None:
            return copy.deepcopy(existing)
        now = _now()
        record: dict[str, Any] = {
            "schemaVersion": 1,
            "turnId": turn_id,
            "sessionId": session_id,
            "sessionKey": session_key,
            "engine": engine,
            "modelRef": model_ref,
            "attempt": max(1, int(attempt or 1)),
            "recoveryOf": recovery_of,
            "providerRunId": None,
            "transport": None,
            "status": "accepted",
            "settled": False,
            "resourceSettled": False,
            "eventSeq": 0,
            "events": [],
            "createdAt": now,
            "updatedAt": now,
            "terminalAt": None,
            "stopReason": None,
            "error": None,
        }
        _event(record, "accepted", attempt=record["attempt"], recoveryOf=recovery_of)
        _atomic_write(path, record)
        return copy.deepcopy(record)


def mark(
    root: Path,
    turn_id: str,
    *,
    event: str | None = None,
    status: str | None = None,
    provider_run_id: Any = _UNSET,
    transport: Any = _UNSET,
    last_event_id: Any = _UNSET,
    stop_reason: Any = _UNSET,
    error: Any = _UNSET,
    settled: bool | None = None,
    resource_settled: bool | None = None,
    **details: Any,
) -> dict[str, Any] | None:
    """Apply one lifecycle transition atomically and append a compact event."""
    try:
        path = _path(root, turn_id)
    except ValueError:
        return None
    with _LOCK:
        record = _read_path(path)
        if record is None:
            return None
        if status is not None:
            record["status"] = status
        if provider_run_id is not _UNSET and provider_run_id is not None:
            record["providerRunId"] = provider_run_id
        if transport is not _UNSET:
            record["transport"] = transport
        if last_event_id is not _UNSET:
            record["lastEventId"] = max(0, int(last_event_id or 0))
        if stop_reason is not _UNSET:
            record["stopReason"] = stop_reason
        if error is not _UNSET:
            record["error"] = _public_error(error)
        if settled is not None:
            record["settled"] = bool(settled)
        if resource_settled is not None:
            record["resourceSettled"] = bool(resource_settled)
        if status in TERMINAL_STATUSES:
            record["terminalAt"] = record.get("terminalAt") or _now()
        event_details = {key: value for key, value in details.items() if value is not None}
        if provider_run_id is not _UNSET and provider_run_id is not None:
            event_details.setdefault("providerRunId", provider_run_id)
        if last_event_id is not _UNSET:
            event_details.setdefault("lastEventId", record.get("lastEventId", 0))
        _event(record, event or status or "updated", **event_details)
        _atomic_write(path, record)
        return copy.deepcopy(record)


def is_active(record: dict[str, Any] | None) -> bool:
    return bool(record and record.get("status") not in TERMINAL_STATUSES and not record.get("settled"))
