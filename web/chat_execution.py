"""Bounded execution details from this session and turn's structured transcript."""
import hashlib
from fastapi import HTTPException
import agent_office as office
from easel.execution import begin, returned, stamp, page, artifact, public_text


def _text(value, credentials, limit=4000):
    return public_text(value, credentials, limit)


def snapshot(session, turn, audits, transcripts, *, live=False, credentials=None,
             before=None, limit=40, journal=None, outputs=None):
    if not office.SAFE_ID.fullmatch(session) or not office.SAFE_ID.fullmatch(turn):
        raise HTTPException(400, '无效的会话或轮次标识')
    warnings = set()
    audit = office._audit_record(audits, session, turn, warnings)
    response = {'sessionId': session, 'turnId': turn, 'operations': [], 'warnings': sorted(warnings),
                'source': 'gateway' if journal else 'transcript'}
    journal = [{**row, 'status': 'unconfirmed'} if not live and row.get('status') == 'running'
               else dict(row) for row in (journal or [])]
    if not audit:
        for row in journal:
            artifact(row, outputs, row.get('cwd'))
        response.update(page(journal, before, limit))
        return response
    path = audits / hashlib.sha256(session.encode()).hexdigest()[:24] / f'{turn}.json'
    revision = office._marker_revision(path)
    finished = office._timestamp(audit.get('finished'))
    if not live and audit.get('status') != 'running' and finished is None and revision:
        finished = revision[3] / 1e9
    events = office._events(transcripts, session, audit, live, finished, warnings)
    operations, process_operations = {}, {}
    for event in events:
        message = event.get('message', event)
        if not isinstance(message, dict):
            continue
        at = stamp(event.get('timestamp') or message.get('timestamp'))
        if message.get('role') == 'assistant':
            for call, name, args in office._tool_calls(message):
                if call in operations:
                    continue
                row = begin(session, turn, call, name, args, at, credentials)
                if not live:
                    row['status'] = 'unconfirmed'
                operations[call] = row
                if name == 'process' and isinstance(args.get('sessionId'), str):
                    row['processSessionId'] = args['sessionId']
        elif message.get('role') in ('toolResult', 'tool', 'tool_result'):
            call = message.get('toolCallId') or message.get('tool_call_id') or message.get('tool_use_id')
            row = operations.get(call) if isinstance(call, str) else None
            if row is None:
                continue
            returned(row, message, at, credentials)
            process_id = row.get('processSessionId')
            if process_id and row['name'] != 'process':
                process_operations[process_id] = row
            elif process_id and row['name'] == 'process' and process_id in process_operations:
                returned(process_operations[process_id], message, at, credentials)
    rows = list(operations.values())
    if journal:
        by_id = {row['id']: row for row in rows}
        for row in journal:
            existing = by_id.get(row['id'])
            if existing and existing['status'] not in ('unconfirmed', 'running') and row['status'] in ('running', 'unconfirmed'):
                by_id[row['id']] = {**row, **existing}
            else:
                by_id[row['id']] = {**(existing or {}), **row}
        rows = list(by_id.values())
    for row in rows:
        artifact(row, outputs, row.get('cwd'))
    if office._marker_revision(path) != revision:
        response['warnings'] = ['执行记录正在更新，请稍后查看。']
        return response
    response.update(page(rows, before, limit), warnings=sorted(warnings))
    return response
