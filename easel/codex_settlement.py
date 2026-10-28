"""Local write-ahead commits for recovered Codex facts; never dispatch native work."""
from __future__ import annotations

import copy
import hashlib
import json
import os


MAX_LOG_BYTES = 64 * 1024 * 1024


def path(service, sid, tid):
    return service._state_path(sid, tid).with_suffix('.recovery')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def log_bytes(target):
    if not target.exists():
        return b''
    with target.open('rb') as stream:
        data = stream.read(MAX_LOG_BYTES + 1)
    if len(data) > MAX_LOG_BYTES:
        raise ValueError('原轮次事件超过恢复上限，保留待核。')
    return data


def prefix(data):
    """Preserve complete ordered events, ignoring only an unfinished final write."""
    end = seq = 0
    for line in data.splitlines(keepends=True):
        if not line.endswith(b'\n'):
            break
        row = json.loads(line)
        if (not isinstance(row, dict) or type(row.get('id')) is not int
                or row['id'] <= seq or not isinstance(row.get('event'), str) or 'data' not in row):
            raise ValueError('原轮次事件损坏，未覆盖记录。')
        end += len(line)
        seq = row['id']
    return data[:end], seq


def load(service, sid, tid):
    record = json.loads(path(service, sid, tid).read_text(encoding='utf-8'))
    if not isinstance(record, dict):
        raise ValueError('原轮次恢复日志格式无效。')
    state, events = record.get('state'), record.get('events')
    if (record.get('version') != 1 or record.get('sessionId') != sid or record.get('turnId') != tid
            or not isinstance(state, dict) or state.get('sessionId') != sid or state.get('turn_id') != tid
            or state.get('status') != 'done' or state.get('outcome') not in ('completed', 'failed', 'interrupted')
            or not isinstance(events, list) or len(events) != 3
            or not isinstance(state.get('recovery'), dict)
            or state['recovery'].get('status') != 'adopted'
            or not isinstance(state.get('text'), str) or not isinstance(state.get('threadId'), str)
            or not state['threadId'] or state.get('stopped') is not (state['outcome'] == 'interrupted')):
        raise ValueError('原轮次恢复日志身份或格式无效。')
    for field in ('originalSize', 'prefixSize', 'after'):
        if type(record.get(field)) is not int or record[field] < 0:
            raise ValueError('原轮次恢复日志边界无效。')
    if record['prefixSize'] > record['originalSize'] or record['originalSize'] > MAX_LOG_BYTES:
        raise ValueError('原轮次恢复日志边界无效。')
    for field in ('originalHash', 'prefixHash'):
        value = record.get(field)
        if not isinstance(value, str) or len(value) != 64 or any(c not in '0123456789abcdef' for c in value):
            raise ValueError('原轮次恢复日志校验无效。')
    names = ['text_snapshot', 'execution', 'error' if state.get('error') else 'done']
    if (state.get('seq') != record['after'] + 3 or state.get('recoveryEventAfter') != record['after']
            or any(not isinstance(event, dict) or type(event.get('id')) is not int
                   or event.get('id') != record['after'] + index
                   or event.get('event') != name or 'data' not in event
                   for index, (event, name) in enumerate(zip(events, names), 1))
            or events[0]['data'] != state.get('text')
            or not isinstance(events[1]['data'], dict)
            or events[1]['data'].get('sessionId') != sid or events[1]['data'].get('turnId') != tid
            or events[2]['data'] != (state.get('error') or
                {'sessionKey': 'codex:' + state['threadId'], 'stopped': state['stopped']})):
        raise ValueError('原轮次恢复事件不完整。')
    return record


def prepare(service, original, recovered):
    sid, tid = original['sessionId'], original['turn_id']
    target = path(service, sid, tid)
    if target.exists():
        raise ValueError('原轮次已有待提交的恢复结果。')
    data = log_bytes(service._event_path(sid, tid))
    base, last = prefix(data)
    seq = original.get('seq', 0)
    if type(seq) is not int or seq < 0:
        raise ValueError('原轮次事件序号无效。')
    after = max(seq, last)
    recovered.update(seq=after + 3, recoveryEventAfter=after)
    terminal = ('error', recovered['error']) if recovered.get('error') else (
        'done', {'sessionKey': 'codex:' + recovered['threadId'], 'stopped': recovered['stopped']})
    events = [{'id': after + index, 'event': name, 'data': value} for index, (name, value) in enumerate([
        ('text_snapshot', recovered['text']), ('execution', service._execution_data(recovered)), terminal], 1)]
    if len(base) + sum(len((json.dumps(event, ensure_ascii=False) + '\n').encode('utf-8'))
                       for event in events) > MAX_LOG_BYTES:
        raise ValueError('原轮次恢复事件超过恢复上限，保留待核。')
    service._write(target, {'version': 1, 'sessionId': sid, 'turnId': tid, 'state': recovered,
        'events': events, 'after': after, 'originalSize': len(data), 'originalHash': digest(data),
        'prefixSize': len(base), 'prefixHash': digest(base)})


def replace_events(target, data):
    temporary = target.with_suffix('.recovery.tmp')
    try:
        with temporary.open('wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


def finish(service, sid, tid):
    """Call with the session owner and service lock held. Safe to repeat after death."""
    record = load(service, sid, tid)
    state = record['state']
    target = service._event_path(sid, tid)
    current = log_bytes(target)
    base = current[:record['prefixSize']]
    if len(base) != record['prefixSize'] or digest(base) != record['prefixHash']:
        raise ValueError('原轮次事件前缀变化，未覆盖记录。')
    encoded = b''.join((json.dumps(event, ensure_ascii=False) + '\n').encode('utf-8')
                       for event in record['events'])
    intended = base + encoded
    if current != intended and (len(current) != record['originalSize'] or digest(current) != record['originalHash']):
        raise ValueError('原轮次事件已变化，未覆盖记录。')
    pending = copy.deepcopy(state)
    pending.update(outcome='unconfirmed', seq=record['after'])
    pending['recovery'] = {**pending['recovery'], 'status': 'unconfirmed',
                           'message': '已取得原生结果，本地记录尚待结算。'}
    service._persist(pending)
    if current != intended:
        replace_events(target, intended)
    service._persist(state)
    path(service, sid, tid).unlink()
    return state
