"""Persist normalized tool updates without retaining private tool arguments."""
import hashlib
import json
from pathlib import Path
import threading
import time

from .execution import begin, returned, ident, public_text


def location(root, session, turn):
    digest = hashlib.sha256(f'{session}\0{turn}'.encode()).hexdigest()
    return Path(root) / '_execution' / (digest + '.json')


def read_snapshot(root, session, turn):
    try:
        value = json.loads(location(root, session, turn).read_text(encoding='utf-8'))
        if isinstance(value, dict) and value.get('sessionId') == session and value.get('turnId') == turn:
            return value
    except (OSError, ValueError):
        pass
    return {}


def read(root, session, turn):
    return read_snapshot(root, session, turn).get('operations', [])


TERMINAL = frozenset({'returned', 'completed', 'failed', 'stopped', 'denied'})


def _adds_detail(value):
    """A later receipt may add detail but must not erase what was already proven."""
    if isinstance(value, bool):
        return value is True
    if value is None:
        return False
    if isinstance(value, (str, list, dict)):
        return bool(value)
    return True


def adopt(existing, incoming):
    """Merge one transcript receipt into a journal row without regressing it."""
    merged = dict(existing)
    for key, value in incoming.items():
        if key in ('id', 'order', 'source', 'status', 'truncated') or not _adds_detail(value):
            continue
        merged[key] = value
    status = incoming.get('status')
    if isinstance(status, str) and status not in ('running', 'unconfirmed'):
        if existing.get('status') not in TERMINAL:
            merged['status'] = status
    truncated = dict(existing['truncated']) if isinstance(existing.get('truncated'), dict) else {}
    if isinstance(incoming.get('truncated'), dict):
        truncated.update(incoming['truncated'])
    if truncated:
        merged['truncated'] = truncated
    return merged


class ExecutionStore:
    def __init__(self, root, session, turn, credentials=None):
        self.root, self.session, self.turn, self.credentials = root, session, turn, credentials
        saved = read_snapshot(root, session, turn)
        self.rows = {row['id']: row for row in saved.get('operations', [])}
        self.timeline = saved.get('timeline', [])
        self.plan = saved.get('plan', [])
        self.runtime = saved.get('runtime', {})
        self.plan_inputs = {}
        self.order = max((entry['order'] for entry in self.timeline), default=0)
        self.seen = set()
        self.lock = threading.RLock()

    def snapshot(self):
        with self.lock:
            return {'sessionId': self.session, 'turnId': self.turn, 'source': 'gateway',
                    'operations': [dict(row) for row in list(self.rows.values())[-100:]],
                    'plan': [dict(step) for step in self.plan], 'runtime': dict(self.runtime),
                    'timeline': [dict(entry) for entry in self.timeline[-500:]]}

    def progress(self, text):
        text = public_text(text, self.credentials, 4000).strip()
        if not text:
            return
        with self.lock:
            if self.timeline and self.timeline[-1].get('text') == text:
                return
            self.order += 1
            self.timeline.append({'id': f'progress-{self.order}', 'type': 'progress',
                                  'order': self.order, 'text': text})
            self.timeline = self.timeline[-500:]
            self.persist()

    def configure_runtime(self, value):
        """Turn-start configuration evidence, not proof of an available gateway tool."""
        with self.lock:
            self.runtime = {'subagentsConfigured': value.get('ready') is True and value.get('maxSpawnDepth', 0) > 0,
                            'subagentReason': public_text(value.get('reason') or ('启动深度设为0，当前不允许委派。' if value.get('maxSpawnDepth') == 0 else ''), self.credentials, 500)}
            self.persist()

    def consume(self, payload):
        data = payload.get('data')
        if payload.get('stream') != 'tool' or not isinstance(data, dict):
            return None
        phase, call = data.get('phase'), data.get('toolCallId')
        if phase not in ('start', 'update', 'end', 'result') or not isinstance(call, str):
            return None
        with self.lock:
            seq = payload.get('seq')
            if isinstance(seq, int):
                identity = (str(payload.get('runId') or ''), seq)
                if identity in self.seen:
                    return None
                self.seen.add(identity)
                if len(self.seen) > 4096:
                    self.seen = set(sorted(self.seen, key=lambda item: item[1])[-2048:])
            row_id = ident(self.session, self.turn, call)
            row = self.rows.get(row_id)
            if phase == 'start':
                if row is not None:
                    return None
                row = begin(self.session, self.turn, call, data.get('name', 'tool'), data.get('args'),
                            time.time(), self.credentials, 'gateway')
                if row['name'] == 'process' and isinstance(data.get('args'), dict):
                    row['processSessionId'] = data['args'].get('sessionId', '')
                self.rows[row_id] = row
                from .plan_progress import NATIVE
                if row['name'].split('.')[-1].lower() in NATIVE:
                    self.plan_inputs[row_id] = data.get('args')
                self.order += 1
                row['order'] = self.order
                self.timeline.append({'id': row_id, 'type': 'operation',
                                      'operationId': row_id, 'order': self.order})
                self.timeline = self.timeline[-500:]
            elif row is None:
                return None  # Unmatched outputs are not public evidence.
            elif row['status'] != 'running':
                return None  # A delayed partial update cannot revive a finished tool.
            else:
                result = data.get('partialResult' if phase == 'update' else 'result')
                if not isinstance(result, dict):
                    result = {'isError': data.get('isError')}
                    if isinstance(data.get('output'), str):
                        result['content'] = data['output']
                result = {**result, **({'isError': data['isError']} if 'isError' in data else {})}
                returned(row, result, time.time(), self.credentials, partial=phase == 'update')
                if phase != 'update':
                    from .plan_progress import receipt_plan
                    plan = receipt_plan(row['name'], self.plan_inputs.pop(row_id, None), result, self.credentials)
                    if plan is not None and row['status'] in {'returned', 'completed'}:
                        self.plan = plan
                process = row.get('processSessionId')
                if process and row['name'] == 'process':
                    for original in self.rows.values():
                        if original['name'] != 'process' and original.get('processSessionId') == process:
                            returned(original, result, time.time(), self.credentials, partial=phase == 'update')
            self.persist()
            return self.snapshot()

    def ingest(self, rows):
        """Adopt transcript receipts this transport cannot stream itself.

        The OpenAI-compatible stream and the plain CLI report no per-tool
        lifecycle, so without this the journal holds progress only. The journal
        is the only place that keeps a whole-turn order, so an adopted call gets
        the same timeline entry a streamed one would have produced.
        Returns True when callers should publish a new snapshot.
        """
        changed = False
        with self.lock:
            for row in rows if isinstance(rows, list) else []:
                row_id = row.get('id') if isinstance(row, dict) else None
                if not isinstance(row_id, str) or not row_id:
                    continue
                existing = self.rows.get(row_id)
                if existing is None:
                    adopted = dict(row)
                    self.order += 1
                    adopted['order'] = self.order
                    self.rows[row_id] = adopted
                    self.timeline.append({'id': row_id, 'type': 'operation',
                                          'operationId': row_id, 'order': self.order})
                    self.timeline = self.timeline[-500:]
                    changed = True
                    continue
                merged = adopt(existing, row)
                if merged != existing:
                    self.rows[row_id] = merged
                    changed = True
            if changed:
                self.persist()
        return changed

    def finish(self):
        with self.lock:
            for row in self.rows.values():
                if row['status'] == 'running':
                    row['status'] = 'unconfirmed'
            self.persist()

    def persist(self):
        path = location(self.root, self.session, self.turn)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix('.tmp')
        tmp.write_text(json.dumps({'sessionId': self.session, 'turnId': self.turn,
                                  'operations': list(self.rows.values()),
                                  'plan': self.plan,
                                  'runtime': self.runtime,
                                  'timeline': self.timeline}, ensure_ascii=False), encoding='utf-8')
        tmp.replace(path)
