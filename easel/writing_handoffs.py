"""Durable, versioned analysis-to-writing intake. Never starts a model turn."""
from contextlib import contextmanager
import json
import time
import uuid

from .creation_drafts import digest
from .memory_sources import analysis_source
from .task_store import TaskStore


_UNSET = object()


class WritingHandoffs:
    def __init__(self, outputs, ledger=None):
        self.tasks = TaskStore(outputs)
        self.outputs = self.tasks.outputs
        self.ledger = ledger

    @contextmanager
    def db(self):
        with self.tasks.db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS writing_handoffs '
                       '(id TEXT PRIMARY KEY, session TEXT UNIQUE, fingerprint TEXT, data TEXT)')
            db.execute('CREATE INDEX IF NOT EXISTS writing_source ON writing_handoffs(fingerprint)')
            yield db

    @staticmethod
    def public(item):
        return {key: value for key, value in item.items() if key != 'analysis'}

    def _save(self, db, item, fingerprint):
        db.execute('INSERT INTO writing_handoffs VALUES(?,?,?,?)',
                   (item['id'], item['sessionId'], fingerprint, json.dumps(item, ensure_ascii=False)))
        context = self.public(item)
        db.execute('INSERT INTO sessions VALUES(?,?)', (item['sessionId'], json.dumps({
            'id': item['sessionId'], 'title': '写作 · ' + item['accountId'], 'messages': [],
            'engine': item['engine'], 'persona': item['persona'], 'created': int(item['createdAt'] * 1000),
            'conversationType': 'content-generation', 'writingContext': context}, ensure_ascii=False)))
        self.tasks._event(db, item['sessionId'], 'writing_prepared', context)
        return context

    def prepare(self, binding, source_session, persona='', engine='openclaw'):
        if not isinstance(persona, str) or len(persona) > 120 or engine not in ('openclaw', 'codex'):
            raise ValueError('写作画像或引擎无效')
        with self.db() as db:
            self.tasks._require_session(db, source_session)
            source = analysis_source(self.outputs, binding, self.ledger)
            if source['sessionId'] != source_session:
                raise ValueError('分析来源与原对话不匹配')
            fingerprint = digest([source, persona, engine])
            row = db.execute('SELECT data FROM writing_handoffs WHERE fingerprint=? ORDER BY rowid DESC LIMIT 1',
                             (fingerprint,)).fetchone()
            if row:
                old = json.loads(row[0])
                if not db.execute('SELECT 1 FROM deleted_sessions WHERE id=?', (old['sessionId'],)).fetchone():
                    return self.public(old)
            item = {'id': uuid.uuid4().hex, 'sessionId': 'write-' + uuid.uuid4().hex,
                    'sourceSessionId': source_session, 'bindingId': source['bindingId'],
                    'platform': source['platform'], 'accountId': source['accountId'],
                    'sourceTurnId': source['turnId'], 'sourceHash': source['sourceHash'],
                    'persona': persona, 'engine': engine, 'createdAt': time.time(), 'analysis': source}
            return self._save(db, item, fingerprint)

    def branch(self, source_session, target_session):
        source = self.checked(source_session)
        if not source:
            return None
        with self.db() as db:
            self.tasks._require_session(db, source_session)
            self.tasks._require_session(db, source['sourceSessionId'])
            self.tasks._require_session(db, target_session)
            item = {**source, 'id': uuid.uuid4().hex, 'sessionId': target_session,
                    'createdAt': time.time(), 'derivedFromSessionId': source_session}
            return self._save(db, item, digest(['edit', target_session]))

    def checked(self, session, *, persona=_UNSET, engine=_UNSET):
        if not session or not session.startswith(('write-', 'edit-')) or not self.tasks.path.is_file():
            return None
        with self.db() as db:
            row = db.execute('SELECT data FROM writing_handoffs WHERE session=?', (session,)).fetchone()
            if not row:
                return None
            item = json.loads(row[0])
            self.tasks._require_session(db, session)
            self.tasks._require_session(db, item['sourceSessionId'])
            if persona is not _UNSET and (persona or '') != item['persona']:
                raise ValueError('写作画像与接收时不同，请回原分析重新准备')
            if engine is not _UNSET and engine != item['engine']:
                raise ValueError('写作引擎与接收时不同，请回原分析重新准备')
            current = analysis_source(self.outputs, item['bindingId'], self.ledger)
            if current != item['analysis']:
                raise ValueError('原分析已变化，请回原对话重新准备；当前写作内容保留')
            return item

    def analysis(self, session, binding=''):
        item = self.checked(session)
        if not item:
            return None
        if binding and binding != item['bindingId']:
            raise ValueError('准备稿的分析来源与写作交接不匹配')
        return {**item['analysis'], 'writingHandoffId': item['id']}

    def image_source(self, session):
        """Freeze an existing writing handoff, without copying report text."""
        item = self.checked(session)
        if not item:
            return None
        return {'schemaVersion': 1, **{key: item[key] for key in (
            'sessionId', 'sourceSessionId', 'bindingId', 'sourceTurnId', 'sourceHash',
            'platform', 'accountId', 'persona', 'engine')}, 'writingHandoffId': item['id']}
