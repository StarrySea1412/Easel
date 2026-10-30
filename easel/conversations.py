"""Server copies of visible conversations, independent of execution ownership.

Old browser snapshots may extend a saved prefix, never erase newer messages.
Deletion uses the task store transaction so a delayed sync cannot resurrect it.
"""
import json
import math

from easel.task_store import SAFE_ID, TaskConflict

MAX_BYTES = 4 * 1024 * 1024
FIELDS = {'id', 'title', 'created', 'messages', 'engine', 'persona', 'modelRef', 'roleId',
          'conversationType', 'analysisContext', 'writingContext', 'parentSessionId',
          'sideOrder', 'sideClosed', 'archived', 'pinnedAt', 'sessionKey', 'pendingTurnId', 'editBranch'}


def validate(value):
    if not isinstance(value, dict) or not isinstance(value.get('id'), str) or not SAFE_ID.fullmatch(value['id']):
        raise ValueError('无效对话标识')
    if value.get('importedFromBackup') or value.get('taskWorker'):
        raise ValueError('只读备份及临时任务不能作为原对话同步')
    if not isinstance(value.get('title'), str) or len(value['title']) > 1000:
        raise ValueError('无效对话标题')
    if type(value.get('created')) not in (int, float) or not math.isfinite(value['created']) or value['created'] < 0:
        raise ValueError('无效对话时间')
    messages = value.get('messages')
    if not isinstance(messages, list) or not 1 <= len(messages) <= 10000:
        raise ValueError('对话应包含1至10000条可见消息')
    for message in messages:
        if (not isinstance(message, dict) or message.get('role') not in ('user', 'assistant')
                or not isinstance(message.get('content'), str)):
            raise ValueError('无效对话消息')
        if message.get('turnId') is not None and (not isinstance(message['turnId'], str) or not SAFE_ID.fullmatch(message['turnId'])):
            raise ValueError('无效消息轮次')
    if value.get('engine', 'openclaw') not in ('openclaw', 'codex'):
        raise ValueError('无效对话引擎')
    for key in ('parentSessionId', 'pendingTurnId'):
        if value.get(key) is not None and (not isinstance(value[key], str) or not SAFE_ID.fullmatch(value[key])):
            raise ValueError('无效关联标识')
    result = {key: item for key, item in value.items() if key in FIELDS}
    raw = json.dumps(result, ensure_ascii=False, allow_nan=False)
    if len(raw.encode('utf-8')) > MAX_BYTES:
        raise ValueError('对话超过4MiB同步上限，本地记录仍保留')
    return result


def identity(message):
    return message['role'], message['content'], message.get('turnId')


def save(store, value, base_revision=None):
    value = validate(value)
    if base_revision is not None and (type(base_revision) is not int or base_revision < 1):
        raise ValueError('无效对话版本')
    with store.db() as db:
        store._require_session(db, value['id'])
        row = db.execute('SELECT data,revision FROM conversation_snapshots WHERE id=?', (value['id'],)).fetchone()
        if row:
            old = json.loads(row[0])
            if old.get('engine', 'openclaw') != value.get('engine', 'openclaw'):
                raise TaskConflict('已有对话不能切换引擎')
            if old == value:
                return {'id':value['id'],'saved':True,'revision':row['revision']}
            common = min(len(old['messages']), len(value['messages']))
            same_prefix = all(identity(old['messages'][i]) == identity(value['messages'][i]) for i in range(common))
            if not same_prefix and base_revision != row['revision']:
                raise TaskConflict('对话存在不同版本，已保留两端记录；请从原浏览器核对')
            if len(old['messages']) > len(value['messages']) and base_revision != row['revision']:
                return {'id': value['id'], 'saved': False, 'reason': 'newer_server_copy'}
        revision = row['revision'] + 1 if row else 1
        db.execute('INSERT INTO conversation_snapshots VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,revision=excluded.revision',
                   (value['id'], json.dumps(value, ensure_ascii=False, allow_nan=False), revision))
        return {'id': value['id'], 'saved': True, 'revision': revision}


def read(store, session, *, with_revision=False):
    if not isinstance(session, str) or not SAFE_ID.fullmatch(session):
        raise ValueError('无效对话标识')
    with store.db() as db:
        store._require_session(db, session)
        row = db.execute('SELECT data,revision FROM conversation_snapshots WHERE id=?', (session,)).fetchone()
        if not row:
            return None
        value = json.loads(row[0])
        return {'conversation': value, 'revision': row['revision']} if with_revision else value


def index(store, after='', limit=100):
    if after and (not isinstance(after, str) or not SAFE_ID.fullmatch(after)):
        raise ValueError('无效分页标识')
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError('无效分页长度')
    with store.db() as db:
        rows = [dict(row) for row in db.execute(
            'SELECT c.id,c.revision FROM conversation_snapshots c '
            'LEFT JOIN deleted_sessions d ON c.id=d.id '
            'WHERE c.id>? AND d.id IS NULL ORDER BY c.id LIMIT ?', (after, limit + 1))]
        return {'conversations': rows[:limit], 'next': rows[limit - 1]['id'] if len(rows) > limit else None}
