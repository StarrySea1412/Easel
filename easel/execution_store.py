"""Persist normalized tool updates without retaining private tool arguments."""
import hashlib
import json
from pathlib import Path
import threading
import time

from .execution import begin, returned, ident


def location(root, session, turn):
    digest = hashlib.sha256(f'{session}\0{turn}'.encode()).hexdigest()
    return Path(root) / '_execution' / (digest + '.json')


def read(root, session, turn):
    try:
        value = json.loads(location(root, session, turn).read_text(encoding='utf-8'))
        if value.get('sessionId') == session and value.get('turnId') == turn:
            return value.get('operations', [])
    except (OSError, ValueError):
        pass
    return []


class ExecutionStore:
    def __init__(self, root, session, turn, credentials=None):
        self.root, self.session, self.turn, self.credentials = root, session, turn, credentials
        self.rows = {row['id']: row for row in read(root, session, turn)}
        self.seen = set()
        self.lock = threading.Lock()

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
                if seq in self.seen:
                    return None
                self.seen.add(seq)
                if len(self.seen) > 4096:
                    self.seen = set(sorted(self.seen)[-2048:])
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
                process = row.get('processSessionId')
                if process and row['name'] == 'process':
                    for original in self.rows.values():
                        if original['name'] != 'process' and original.get('processSessionId') == process:
                            returned(original, result, time.time(), self.credentials, partial=phase == 'update')
            self.persist()
            return {'sessionId': self.session, 'turnId': self.turn, 'source': 'gateway',
                    'operations': list(self.rows.values())[-100:]}

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
                                  'operations': list(self.rows.values())}, ensure_ascii=False), encoding='utf-8')
        tmp.replace(path)
