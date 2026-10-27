"""Version-bound semantic proposals; only a separate UI confirmation activates them.

Bindings contain identifiers and hashes, never copies of old memory bodies.
The agent's relation/reason is a hypothesis, not a semantic verifier.
"""
import json

from easel.profile_memory import Conflict, entry_data, text_value


def normalize(store, value):
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {'kind', 'reason', 'entries'}:
        raise ValueError('经验归并提案格式无效')
    kind, references = value['kind'], value['entries']
    if kind not in ('merge', 'conflict') or not isinstance(references, list):
        raise ValueError('请选择合并或冲突修订')
    if not (2 if kind == 'merge' else 1) <= len(references) <= 8:
        raise ValueError('合并须选择2至8条经验，冲突修订须选择1至8条')
    references = [store._replacement_binding(item) for item in references]
    if len({item['id'] for item in references}) != len(references):
        raise ValueError('归并经验不能重复')
    reason = text_value(value['reason'])
    if len(reason) > 1000:
        raise ValueError('归并原因最多1000字')
    return {'kind': kind, 'reason': reason, 'entries': sorted(references, key=lambda item: item['id'])}


def validate(store, db, profile, proposal, selected_scope, selected_conditions):
    rows = [store._replacement(db, profile, item, selected_scope, selected_conditions)
            for item in proposal['entries']]
    if any(store.source_status(row) != 'available' for row in rows):
        raise Conflict('归并来源已改变或不可用，请重新核对')
    return rows


def check_recalled(db, bound, proposal):
    row = db.execute('SELECT data FROM uses WHERE profile_id=? AND session_id=? AND turn_id=?',
                     (bound['profileId'], bound['sessionId'], bound['turnId'])).fetchone()
    recalled = {item['id']: item['revision'] for item in json.loads(row[0])['entries']} if row else {}
    if any(recalled.get(item['id']) != item['revision'] for item in proposal['entries']):
        raise Conflict('只能归并本轮实际读取的经验版本')


def dependency_status(store, entry, seen):
    proposal = entry.get('consolidation')
    if not proposal:
        return 'available'
    if len(seen) > 32:
        return 'unavailable'
    with store.connect() as db:
        for reference in proposal['entries']:
            row = db.execute('SELECT data FROM entries WHERE id=? AND profile_id=?',
                             (reference['id'], entry['profileId'])).fetchone()
            if not row:
                return 'missing'
            old = entry_data(row[0])
            if old['id'] in seen:
                return 'unavailable'
            if any(old[key] != reference[key] for key in ('contentHash', 'scopeHash', 'conditionsHash')):
                return 'changed'
            # Acceptance changes the old status/revision exactly once, preserving
            # the bound body. Later edits/restores cannot silently revalidate it.
            adopted = (old['revision'] == reference['revision'] + 1
                       and old.get('supersededBy', {}).get('id') == entry['id'])
            if old['revision'] != reference['revision'] and not adopted:
                return 'changed'
            status = store.source_status(old, seen)
            if status != 'available':
                return status
    return 'available'


def supersede(store, db, profile, entry):
    from easel.profile_memory import now
    rows = validate(store, db, profile, entry['consolidation'], entry['scope'], entry['conditions'])
    for old in rows:
        db.execute('INSERT INTO consolidation_links VALUES(?,?,?,?,?)',
                   (profile['id'], old['id'], entry['id'], old['revision'], entry['revision'] + 1))
        old.update(status='superseded', supersededBy={'id': entry['id'], 'revision': entry['revision'] + 1},
                   revision=old['revision'] + 1, updatedAt=now())
        store._save(db, old)
