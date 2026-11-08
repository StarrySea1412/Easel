"""Durable multi-platform publish batches.

A batch is created only after the user explicitly confirmed the platforms and
content in the publishing center. The web server owns the batch and runs the
accepted platforms serially, so closing the browser cannot drop platforms that
were already confirmed. Every platform keeps its own receipt; a restart never
resubmits anything — an unfinished batch is only marked interrupted so the
user can verify each platform result first.
"""
from __future__ import annotations

import json
from pathlib import Path
import re
import time

from easel import local_records
from easel.publish_receipts import OUTCOMES, _now, _text

BATCH_ID = re.compile(r'^[0-9a-f]{32}$')
LABEL = '发布批次'
BATCH_RUNNING = 'running'
BATCH_COMPLETED = 'completed'
BATCH_INTERRUPTED = 'interrupted'
BATCH_STATES = frozenset({BATCH_RUNNING, BATCH_COMPLETED, BATCH_INTERRUPTED})
# Terminal per-platform facts come from the receipt outcome itself.
ENTRY_ACCEPTED = 'accepted'
ENTRY_RUNNING = 'running'
ENTRY_FINISHED = 'finished'
ENTRY_REJECTED = 'rejected'
ENTRY_STATES = frozenset({ENTRY_ACCEPTED, ENTRY_RUNNING, ENTRY_FINISHED, ENTRY_REJECTED})
MAX_BATCHES = 50
MAX_BODY = 20000


class BatchStore:
    def __init__(self, path: Path):
        self.path = Path(path)

    def _read(self) -> list[dict]:
        items = local_records.read(self.path, LABEL)
        for item in items:
            if (not isinstance(item.get('batchId'), str)
                    or not BATCH_ID.fullmatch(item['batchId'])
                    or item.get('state') not in BATCH_STATES
                    or not isinstance(item.get('platforms'), list)
                    or not isinstance(item.get('requests'), dict)):
                raise local_records.RecordError('发布批次格式不受支持，原文件已保留；请从备份恢复。')
            for entry in item['platforms']:
                if (not isinstance(entry, dict) or not isinstance(entry.get('platform'), str)
                        or entry.get('state') not in ENTRY_STATES):
                    raise local_records.RecordError('发布批次平台条目格式不受支持，原文件已保留；请从备份恢复。')
        return items

    def _change(self, operation):
        for attempt in range(10):
            items = self._read()
            value = operation(items)
            try:
                local_records.write(self.path, items, LABEL)
                return value
            except local_records.RecordConflict:
                if attempt == 9:
                    raise
                time.sleep(0.01 * (attempt + 1))

    def create(self, batch_id: str, requests: dict[str, dict]) -> dict:
        if not BATCH_ID.fullmatch(batch_id):
            raise ValueError('Invalid batch ID')
        payloads = {}
        for platform, payload in requests.items():
            if not isinstance(platform, str) or not platform or not isinstance(payload, dict):
                raise ValueError('Invalid batch request payload')
            payloads[platform] = {
                'title': _text(payload.get('title'), 300),
                'body': _text(payload.get('body'), MAX_BODY),
                'media': [path for path in payload.get('media', []) if isinstance(path, str)][:20],
                'tags': _text(payload.get('tags'), 600),
            }
        now = _now()

        def operation(items):
            if any(item['batchId'] == batch_id for item in items):
                raise ValueError('Duplicate batch ID')
            items.append({'batchId': batch_id, 'state': BATCH_RUNNING,
                          'createdAt': now, 'updatedAt': now,
                          'platforms': [], 'requests': payloads})
            # Keep the file bounded: only finished history is dropped, and the
            # newest MAX_BATCHES-1 completed batches are retained.
            finished = [item for item in items if item['state'] != BATCH_RUNNING]
            overflow = len(items) - MAX_BATCHES
            if overflow > 0 and finished:
                for stale in sorted(finished, key=lambda item: item['createdAt'])[:overflow]:
                    items.remove(stale)
            return json.loads(json.dumps(items[-1], ensure_ascii=False))
        return self._change(operation)

    def get(self, batch_id: str) -> dict | None:
        if not BATCH_ID.fullmatch(batch_id):
            return None
        return next((dict(item) for item in self._read() if item['batchId'] == batch_id), None)

    def add_platform(self, batch_id: str, platform: str, receipt_id: str,
                     state: str = ENTRY_ACCEPTED, message: str = '') -> dict:
        if state not in ENTRY_STATES:
            raise ValueError('Invalid batch entry state')
        def operation(items):
            for item in items:
                if item['batchId'] == batch_id:
                    if any(entry['platform'] == platform for entry in item['platforms']):
                        raise ValueError('Duplicate batch platform')
                    item['platforms'].append({'platform': platform, 'receiptId': receipt_id,
                                              'state': state, 'outcome': None,
                                              'message': _text(message, 600)})
                    item['updatedAt'] = _now(item.get('updatedAt'))
                    self._settle(item)
                    return dict(item)
            raise KeyError(batch_id)
        return self._change(operation)

    def set_entry(self, batch_id: str, platform: str, **changes) -> None:
        def operation(items):
            for item in items:
                if item['batchId'] != batch_id:
                    continue
                for entry in item['platforms']:
                    if entry['platform'] == platform:
                        if 'state' in changes:
                            if changes['state'] not in ENTRY_STATES:
                                raise ValueError('Invalid batch entry state')
                            entry['state'] = changes['state']
                        if 'outcome' in changes:
                            outcome = changes['outcome']
                            entry['outcome'] = outcome if outcome in OUTCOMES else None
                        if 'message' in changes:
                            entry['message'] = _text(changes['message'], 600)
                        item['updatedAt'] = _now(item.get('updatedAt'))
                        self._settle(item)
                        return
                raise KeyError(platform)
            raise KeyError(batch_id)
        self._change(operation)

    @staticmethod
    def _settle(item: dict) -> None:
        """A batch completes only when every intended platform has a terminal entry."""
        if item['state'] != BATCH_RUNNING:
            return
        intended = set(item.get('requests') or {})
        entries = item['platforms']
        if not intended or not entries:
            return
        if {entry['platform'] for entry in entries} != intended:
            return
        if all(entry['state'] in (ENTRY_FINISHED, ENTRY_REJECTED) for entry in entries):
            item['state'] = BATCH_COMPLETED

    def mark_interrupted(self, batch_id: str, message: str) -> None:
        def operation(items):
            for item in items:
                if item['batchId'] == batch_id and item['state'] == BATCH_RUNNING:
                    item['state'] = BATCH_INTERRUPTED
                    item['message'] = _text(message, 600)
                    item['updatedAt'] = _now(item.get('updatedAt'))
                    return
        self._change(operation)

    def recover_interrupted(self) -> None:
        """Called once at Web startup; never resubmit a platform after a restart."""
        def operation(items):
            changed = False
            for item in items:
                if item['state'] != BATCH_RUNNING:
                    continue
                item['state'] = BATCH_INTERRUPTED
                item['message'] = '服务已重启，批次未继续执行；请先到平台核对结果，避免重复发布。'
                item['updatedAt'] = _now(item.get('updatedAt'))
                changed = True
            return changed
        self._change(operation)
