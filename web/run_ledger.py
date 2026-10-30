"""Durable identity and lifecycle ledger for one Easel chat run.

The web supervisor is intentionally process-local, while the provider run may
outlive the browser connection (and sometimes the web process).  This module
keeps identity and lifecycle events in one transactional SQLite ledger. Legacy
JSON files are imported lazily and retained as compatibility projections. It
never stores prompts, model output, credentials, or tool arguments.
"""
from __future__ import annotations

import copy
from contextlib import contextmanager
import hashlib
import json
import logging
import os
import re
import time
import sqlite3
from pathlib import Path
from typing import Any


SAFE_ID = re.compile(r"[A-Za-z0-9_.-]{1,160}\Z")
TERMINAL_STATUSES = frozenset({"completed", "failed", "stopped", "unknown"})
_UNSET = object()
STORAGE_VERSION = 1
log = logging.getLogger(__name__)


class LedgerError(ValueError):
    """Existing facts could not be read; never interpret this as a new turn."""


class RunExists(LedgerError):
    def __init__(self, record):
        super().__init__('Logical turn already accepted')
        self.record = record


def _database(root):
    return Path(root) / 'ledger.sqlite3'


@contextmanager
def _db(root):
    Path(root).mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(_database(root), timeout=15)
    try:
        db.execute('BEGIN IMMEDIATE')
        version = db.execute('PRAGMA user_version').fetchone()[0]
        if version not in (0, STORAGE_VERSION):
            raise LedgerError('Unsupported run ledger storage version')
        db.execute('CREATE TABLE IF NOT EXISTS runs(turn TEXT PRIMARY KEY, data TEXT NOT NULL)')
        db.execute('CREATE TABLE IF NOT EXISTS events(turn TEXT, seq INTEGER, data TEXT NOT NULL, PRIMARY KEY(turn,seq))')
        db.execute('CREATE TABLE IF NOT EXISTS legacy_snapshots(turn TEXT PRIMARY KEY, source BLOB NOT NULL, sha256 TEXT NOT NULL, imported_at TEXT NOT NULL)')
        if not version:
            db.execute(f'PRAGMA user_version={STORAGE_VERSION}')
        yield db
        db.commit()
    except sqlite3.Error as exc:
        db.rollback()
        raise LedgerError('Run ledger storage is unavailable') from exc
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


def _store(db, record):
    db.execute('INSERT INTO runs VALUES(?,?) ON CONFLICT(turn) DO UPDATE SET data=excluded.data',
               (record['turnId'], json.dumps(record, ensure_ascii=False)))
    if record.get('events'):
        event = record['events'][-1]
        db.execute('INSERT OR IGNORE INTO events VALUES(?,?,?)',
                   (record['turnId'], event['seq'], json.dumps(event, ensure_ascii=False)))


def _load(db, path):
    turn = path.stem
    found = db.execute('SELECT data FROM runs WHERE turn=?', (turn,)).fetchone()
    if found:
        try:
            value = json.loads(found[0])
        except (ValueError, TypeError):
            raise LedgerError('Unreadable run ledger snapshot') from None
        if not isinstance(value, dict) or value.get('turnId') != turn:
            raise LedgerError('Mismatched run ledger snapshot')
        return value
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return None
    try:
        value = json.loads(raw)
        if (not isinstance(value, dict) or value.get('schemaVersion') != 1 or value.get('turnId') != turn
                or not isinstance(value.get('sessionId'), str) or not isinstance(value.get('events'), list)
                or type(value.get('eventSeq')) is not int or value['eventSeq'] < 1):
            raise ValueError()
        for event in value['events']:
            if not isinstance(event, dict) or type(event.get('seq')) is not int or not 1 <= event['seq'] <= value['eventSeq']:
                raise ValueError()
    except (ValueError, UnicodeError, TypeError):
        raise LedgerError('Unreadable legacy run ledger; retain it for recovery') from None
    db.execute('INSERT INTO legacy_snapshots VALUES(?,?,?,?)',
               (turn, raw, hashlib.sha256(raw).hexdigest(), _now()))
    _store(db, value)
    db.executemany('INSERT OR IGNORE INTO events VALUES(?,?,?)',
                  [(turn, event['seq'], json.dumps(event, ensure_ascii=False)) for event in value['events']])
    return value


def _project(root, turn):
    # Serialize projections through the same database lock. A delayed writer
    # always exports the newest committed record, never its older local copy.
    try:
        with _db(root) as db:
            path = _path(root, turn)
            record = _load(db, path)
            if record:
                _atomic_write(path, record)
    except OSError:
        log.warning('Run ledger committed; compatibility projection unavailable: %s', turn)


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _path(root: Path, turn_id: str) -> Path:
    if not isinstance(turn_id, str) or not SAFE_ID.fullmatch(turn_id):
        raise ValueError("invalid turn id")
    return root / "runs" / f"{turn_id}.json"


def read(root: Path, turn_id: str) -> dict[str, Any] | None:
    """Read a run snapshot without exposing mutable module state."""
    try:
        path = _path(root, turn_id)
        if not _database(root).exists() and not path.exists():
            return None
        with _db(root) as db:
            value = _load(db, path)
            return copy.deepcopy(value) if value is not None else None
    except ValueError as exc:
        if isinstance(exc, LedgerError):
            raise
        return None


def event_page(root, turn_id, *, after=0, limit=100):
    """Read a consistent event page; imported history may have an explicit gap."""
    if type(after) is not int or after < 0 or type(limit) is not int or not 1 <= limit <= 200:
        raise ValueError('Invalid event cursor or page size')
    try:
        path = _path(root, turn_id)
    except ValueError:
        return None
    if not _database(root).exists() and not path.exists():
        return None
    with _db(root) as db:
        record = _load(db, path)
        if record is None:
            return None
        first = db.execute('SELECT MIN(seq) FROM events WHERE turn=?', (turn_id,)).fetchone()[0]
        rows = db.execute('SELECT data FROM events WHERE turn=? AND seq>? ORDER BY seq LIMIT ?',
                          (turn_id, after, limit+1)).fetchall()
        events = [json.loads(row[0]) for row in rows[:limit]]
        return {'turnId': turn_id, 'events': events, 'after': after,
                'next': events[-1]['seq'] if events else after, 'revision': record['eventSeq'],
                'hasMore': len(rows) > limit, 'firstAvailableSeq': first,
                'historyTruncated': first is not None and after < first-1}


def backup(root, target):
    """SQLite online backup, including a consistent snapshot of all events."""
    target = Path(target)
    if target.exists():
        raise FileExistsError(target)
    if not _database(root).is_file():
        raise FileNotFoundError(_database(root))
    target.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(_database(root), timeout=15) as source:
        if source.execute('PRAGMA user_version').fetchone()[0] != STORAGE_VERSION:
            raise LedgerError('Unsupported run ledger storage version')
        target.open('xb').close()
        with sqlite3.connect(target) as destination:
            source.backup(destination)
            if destination.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise LedgerError('Run ledger backup verification failed')
    return target


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
    role_id: str | None = None,
    engine: str = "openclaw",
    attempt: int = 1,
    recovery_of: str | None = None,
    _new_only: bool = False,
) -> dict[str, Any]:
    """Create the first ledger row, or return the existing row unchanged.

    Reusing a logical turn ID must never silently create a second paid request.
    Callers can create a new turn with ``recovery_of`` when an explicit retry
    has been requested.
    """
    path = _path(root, turn_id)
    with _db(root) as db:
        existing = _load(db, path)
        if existing is not None:
            record = existing
        else:
            now = _now()
            from easel.agent_roles import role_snapshot
            record: dict[str, Any] = {
                "schemaVersion": 1,
                "turnId": turn_id,
                "sessionId": session_id,
                "sessionKey": session_key,
                "engine": engine,
                "modelRef": model_ref,
                "roleId": role_id,
                "role": role_snapshot(role_id),
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
            _store(db, record)
    if existing is not None:
        if _new_only:
            raise RunExists(record)
        return copy.deepcopy(record)
    _project(root, turn_id)
    return copy.deepcopy(record)


def accept(root, turn_id, **kwargs):
    """Only the winner may dispatch; duplicates retain the existing identity."""
    return create(root, turn_id, _new_only=True, **kwargs)


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
    resource_facts: dict[str, bool] | None = None,
    completion_receipt: dict | None = None,
    observation: dict | None = None,
    expected_revision: int | None = None,
    **details: Any,
) -> dict[str, Any] | None:
    """Apply one lifecycle transition atomically and append a compact event."""
    try:
        path = _path(root, turn_id)
    except ValueError:
        return None
    if not _database(root).exists() and not path.exists():
        return None
    with _db(root) as db:
        record = _load(db, path)
        if record is None:
            return None
        if expected_revision is not None and record['eventSeq'] != expected_revision:
            raise LedgerError('Run ledger changed; reread before reconciling')
        if completion_receipt is not None:
            receipt = completion_receipt
            if (not isinstance(receipt, dict) or set(receipt) != {
                    'schemaVersion', 'sessionId', 'turnId', 'runtime', 'eventSeq', 'eventBytes', 'sha256'}
                    or type(receipt.get('schemaVersion')) is not int or receipt['schemaVersion'] != 1
                    or receipt.get('runtime') not in ('api', 'codex', 'opencode', 'acp')
                    or receipt.get('sessionId') != record['sessionId'] or receipt.get('turnId') != turn_id
                    or receipt.get('runtime') != record.get('engine')
                    or record.get('transport') != 'harness_' + str(receipt.get('runtime'))
                    or type(receipt.get('eventSeq')) is not int or receipt['eventSeq'] < 1
                    or type(receipt.get('eventBytes')) is not int or not 0 < receipt['eventBytes'] <= 64 * 1024 * 1024
                    or not isinstance(receipt.get('sha256'), str) or not re.fullmatch('[0-9a-f]{64}', receipt['sha256'])
                    or (record.get('completionReceipt') is not None and record['completionReceipt'] != receipt)):
                raise LedgerError('Completed producer evidence does not match the original run')
            record['completionReceipt'] = copy.deepcopy(receipt)
        final = record.get('settled') and record.get('resourceSettled') and record.get('status') in TERMINAL_STATUSES
        if status is not None and not final:
            record["status"] = status
        if provider_run_id is not _UNSET and provider_run_id is not None:
            record["providerRunId"] = provider_run_id
        if transport is not _UNSET:
            record["transport"] = transport
        if last_event_id is not _UNSET:
            record["lastEventId"] = max(int(record.get('lastEventId') or 0), int(last_event_id or 0), 0)
        if stop_reason is not _UNSET and not final:
            record["stopReason"] = stop_reason
        if error is not _UNSET and not final:
            record["error"] = _public_error(error)
        if settled is not None:
            record["settled"] = bool(record.get('settled') or settled)
        if resource_settled is not None:
            record["resourceSettled"] = bool(record.get('resourceSettled') or resource_settled)
        if resource_facts is not None:
            facts = record.setdefault('resourceFacts', {})
            for key in ('provider', 'browser'):
                if key in resource_facts:
                    facts[key] = facts.get(key) is True or resource_facts[key] is True
        if observation is not None and 'observation' not in record:
            # Only the original dispatch may establish the raw stream boundary;
            # incremental parser/body state lives in the per-turn snapshot.
            record['observation'] = copy.deepcopy(observation)
        if status in TERMINAL_STATUSES:
            record["terminalAt"] = record.get("terminalAt") or _now()
        event_details = {key: value for key, value in details.items() if value is not None}
        if provider_run_id is not _UNSET and provider_run_id is not None:
            event_details.setdefault("providerRunId", provider_run_id)
        if last_event_id is not _UNSET:
            event_details.setdefault("lastEventId", record.get("lastEventId", 0))
        _event(record, event or status or "updated", **event_details)
        _store(db, record)
    _project(root, turn_id)
    return copy.deepcopy(record)


def is_active(record: dict[str, Any] | None) -> bool:
    return bool(record and record.get("status") not in TERMINAL_STATUSES and not record.get("settled"))
