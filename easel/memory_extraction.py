"""Extract attributed source spans, without another model request or activation."""
import json
import re
import unicodedata

METHOD = 'analysis-explicit-section/1'
MAX_ENTRIES = 3
MAX_CHARS = 1000


def normalized(text):
    # Formatting equivalence only: preserve negation, quantities and punctuation.
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', text).casefold()).rstrip('。.')


def spans(markdown, content_ids):
    """Select original bullet spans in an explicit section, retaining offsets."""
    headings = {'经验候选', 'experience candidates'}
    rows, offset, section, fence, current = [], 0, None, None, None

    def finish(end):
        nonlocal current
        if current is not None:
            start = current
            while end > start and markdown[end - 1].isspace():
                end -= 1
            text = markdown[start:end]
            attribution = re.match(r'\[作品ID\s*[:：]\s*([^\]]+)\]', text, re.I)
            ids = [part.strip() for part in re.split(r'[,，、]', attribution[1])] if attribution else []
            if (20 <= len(text) <= MAX_CHARS and ids and set(ids) <= set(content_ids)
                    and not re.search(r'^\s*(?:#{1,6}\s|```|~~~)', text, re.M)):
                rows.append({'text': text, 'start': start, 'end': end, 'contentIds': sorted(set(ids))})
        current = None

    for line in markdown.splitlines(keepends=True):
        marker = re.match(r'^\s*(`{3,}|~{3,})', line)
        if marker:
            finish(offset)
            if fence is None:
                fence = marker[1]
            elif (marker[1][0] == fence[0] and len(marker[1]) >= len(fence)
                  and not line[marker.end():].strip()):
                fence = None
            offset += len(line)
            continue
        if fence is None:
            heading = re.match(r'^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$', line)
            if heading:
                finish(offset)
                level, title = len(heading[1]), heading[2].strip().casefold()
                if section is not None and level <= section:
                    section = None
                if title in headings:
                    section = level
            elif section is not None:
                bullet = re.match(r'^\s{0,3}(?:[-*+]\s+|\d+[.)]\s+)(\S.*)', line)
                if bullet:
                    finish(offset)
                    current = offset + bullet.start(1)
                elif current is not None and line.strip() and not line.startswith((' ', '\t')):
                    finish(offset)
        offset += len(line)
    finish(len(markdown))
    return rows


def extract(store, name, data):
    from easel.profile_memory import Conflict, conditions, digest, now, scope, terms, text_value, entry_data
    binding = data.get('bindingId')
    source = store.resolve_extraction_source(binding)
    markdown = source.pop('markdown')
    if not source.get('profileName') or source['profileName'] != name:
        raise Conflict('提取须使用创建分析时绑定的画像；未绑定的旧分析可手工保存原文候选')
    expected = data.get('sourceHash')
    if expected is not None and expected != source['sourceHash']:
        raise Conflict('分析版本已改变，请刷新报告后重新提取')
    if data.get('turnId') is not None and data['turnId'] != source['turnId']:
        raise Conflict('分析轮次已改变，请刷新报告后重新提取')
    selected_scope = scope({'kind': 'account', 'platform': source['platform'], 'accountId': source['accountId']})
    selected_conditions = conditions(data.get('conditions'))
    candidates = spans(markdown, source['contentIds'])
    with store.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        profile = store._profile(db, name)
        if source.get('profileId') and source['profileId'] != profile['id']:
            raise Conflict('原画像已删除或重建，请重新准备分析')
        if not profile['managed']:
            raise Conflict('请先在经验沉淀中确认托管旧经验，再提取候选')
        if not store._policy(db, profile)['candidatesEnabled']:
            raise Conflict('当前画像已关闭保存候选，未提取')
        fingerprint = digest([binding, source['sourceHash'], source['turnId'], METHOD, selected_conditions])
        previous = db.execute('SELECT data FROM extractions WHERE profile_id=? AND fingerprint=?',
                              (profile['id'], fingerprint)).fetchone()
        if previous:
            return json.loads(previous[0])
        if 'profileRevision' in data and data['profileRevision'] != profile['revision']:
            raise Conflict('画像经验已更新，请刷新后重试提取')
        # Bind to the same current evidence immediately before writing. Changes
        # after this transaction remain visible through normal source_status.
        checked = store.resolve_extraction_source(binding)
        if checked.pop('markdown') != markdown or checked != source:
            raise Conflict('分析来源已变化，本次未写入候选')
        receipt = {'id': digest([profile['id'], fingerprint]), 'method': METHOD, 'status': 'completed',
                   'profileId': profile['id'], 'profileName': name, 'bindingId': binding,
                   'sourceHash': source['sourceHash'], 'turnId': source['turnId'], 'at': now(),
                   'createdCount': 0, 'existingCount': 0, 'duplicateCount': 0,
                   'deletedCount': 0, 'invalidCount': 0, 'overflowCount': 0,
                   'entryIds': [], 'selections': [], 'modelRequests': 0}
        existing = [entry_data(row[0]) for row in db.execute('SELECT data FROM entries WHERE profile_id=?', (profile['id'],))]
        seen = set()
        for item in candidates:
            identity = normalized(item['text'])
            if identity in seen:
                receipt['duplicateCount'] += 1
                continue
            seen.add(identity)
            if len(receipt['entryIds']) >= MAX_ENTRIES:
                receipt['overflowCount'] += 1
                continue
            try:
                text = text_value(item['text'])
            except ValueError:
                receipt['invalidCount'] += 1
                continue
            same = next((entry for entry in existing if entry['scope'] == selected_scope
                         and entry['conditions'] == selected_conditions
                         and entry['source'].get('sourceHash') == source['sourceHash']
                         and normalized(entry['text']) == identity), None)
            if same:
                receipt['entryIds'].append(same['id'])
                receipt['selections'].append({'entryId': same['id'], 'start': item['start'], 'end': item['end'],
                    'textHash': digest(text), 'contentIds': item['contentIds'], 'reused': True})
                receipt['existingCount'] += 1
                continue
            evidence = {**source, 'extraction': {'method': METHOD, 'start': item['start'], 'end': item['end'],
                        'textHash': digest(text), 'contentIds': item['contentIds']}}
            try:
                entry = store._insert(db, profile, text, selected_scope, evidence, selected_conditions=selected_conditions)
            except Conflict:  # A deleted exact candidate is never recreated.
                receipt['deletedCount'] += 1
                continue
            related = []
            words = terms(text)
            for old in existing:
                if old['scope'] != selected_scope or old['conditions'] != selected_conditions or old['status'] not in ('pending', 'active'):
                    continue
                prior = terms(old['text'])
                equivalent = normalized(old['text']) == identity
                if equivalent or (len(words) >= 8 and len(prior) >= 8 and len(words & prior) / len(words | prior) >= .85):
                    related.append({'id': old['id'], 'revision': old['revision'],
                                    'kind': 'normalized-text' if equivalent else 'lexical-overlap'})
            if related:
                entry['relatedCandidates'] = related[:3]
                # Enrich the initial revision, without pretending a user edited it.
                raw = json.dumps(entry, ensure_ascii=False)
                db.execute('UPDATE entries SET data=? WHERE id=?', (raw, entry['id']))
                db.execute('UPDATE revisions SET data=? WHERE entry_id=? AND revision=1', (raw, entry['id']))
            existing.append(entry)
            receipt['entryIds'].append(entry['id'])
            receipt['selections'].append({'entryId': entry['id'], 'start': item['start'], 'end': item['end'],
                'textHash': digest(text), 'contentIds': item['contentIds'], 'reused': False})
            receipt['createdCount'] += 1
        receipt['reason'] = ('selected' if receipt['entryIds'] else
                             'previously-deleted' if receipt['deletedCount'] else 'no-explicit-candidates')
        receipt['profileRevision'] = db.execute('SELECT revision FROM profiles WHERE id=?', (profile['id'],)).fetchone()[0]
        db.execute('INSERT INTO extractions VALUES(?,?,?)', (profile['id'], fingerprint, json.dumps(receipt, ensure_ascii=False)))
        return receipt
