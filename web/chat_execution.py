"""Bounded execution details from this session and turn's structured transcript."""
from datetime import datetime, timezone
import hashlib
import re

from fastapi import HTTPException
import agent_office as office
from easel.gateway_auth import redact_gateway_text


def _text(value, credentials, limit=4000):
    if not isinstance(value, str):
        return ''
    text = redact_gateway_text(value[:limit], credentials)
    text = re.sub(r'(?i)\bsk-[a-z0-9_-]{8,}', '[已隐藏]', text)
    text = re.sub(r'''(?ix)((?:api[_-]?key|token|password|secret)["']?\s*[=: ]\s*)
                      (?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)''', r'\1[已隐藏]', text)
    return text


def snapshot(session, turn, audits, transcripts, *, live=False, credentials=None):
    if not office.SAFE_ID.fullmatch(session) or not office.SAFE_ID.fullmatch(turn):
        raise HTTPException(400, '无效的会话或轮次标识')
    warnings = set()
    audit = office._audit_record(audits, session, turn, warnings)
    response = {'sessionId': session, 'turnId': turn, 'operations': [], 'warnings': sorted(warnings)}
    if not audit:
        return response
    path = audits / hashlib.sha256(session.encode()).hexdigest()[:24] / f'{turn}.json'
    revision = office._marker_revision(path)
    finished = office._timestamp(audit.get('finished'))
    if not live and audit.get('status') != 'running' and finished is None and revision:
        finished = revision[3] / 1e9
    events = office._events(transcripts, session, audit, live, finished, warnings)
    operations = {}
    for event in events:
        message = event.get('message', event)
        if not isinstance(message, dict):
            continue
        stamp = office._timestamp(event.get('timestamp') or message.get('timestamp'))
        if message.get('role') == 'assistant':
            for ident, name, args in office._tool_calls(message):
                if ident in operations:
                    continue
                file_path = args.get('path', args.get('file_path', args.get('file', '')))
                command = args.get('command', args.get('cmd', '')) if name in ('exec', 'exec_command', 'bash', 'shell') else ''
                row = {'id': hashlib.sha256(f'{session}\0{turn}\0{ident}'.encode()).hexdigest()[:24],
                       'name': office._safe_text(name, 100), 'status': 'running' if live else 'unconfirmed',
                       'command': _text(command, credentials, 1200), 'path': _text(file_path, credentials, 500),
                       'output': '', 'diff': '', '_start': stamp}
                if stamp is not None:
                    row['startedAt'] = datetime.fromtimestamp(stamp, timezone.utc).isoformat()
                operations[ident] = row
        elif message.get('role') in ('toolResult', 'tool', 'tool_result'):
            ident = message.get('toolCallId') or message.get('tool_call_id') or message.get('tool_use_id')
            row = operations.get(ident) if isinstance(ident, str) else None
            if row is None:
                continue
            row['status'] = 'failed' if message.get('isError') is True else 'returned'
            if stamp is not None and row['_start'] is not None and stamp >= row['_start']:
                row['elapsedSeconds'] = round(stamp - row['_start'], 3)
            # Never preview credential/configuration file contents. Shell output
            # and edits are bounded and redacted; unmatched results stay private.
            sensitive = re.search(r'(?i)(?:^|[/\\])(?:\.env(?:\..*)?|openclaw\.json|auth[^/\\]*|credentials[^/\\]*)$', row['path'])
            if not sensitive:
                content = message.get('content')
                text = content if isinstance(content, str) else '\n'.join(block.get('text', '') for block in content
                    if isinstance(block, dict) and isinstance(block.get('text'), str)) if isinstance(content, list) else ''
                row['output'] = _text(text, credentials)
                details = message.get('details')
                diff = details.get('diff') if isinstance(details, dict) else None
                if isinstance(diff, str) and message.get('isError') is False:
                    # These are returned diff lines, not guessed from requested
                    # edits or the current file which may have since changed.
                    row['diff'] = _text(diff, credentials, 12000)
                    lines = diff.splitlines()
                    row['added'] = sum(line.startswith('+') and not line.startswith('+++') for line in lines)
                    row['removed'] = sum(line.startswith('-') and not line.startswith('---') for line in lines)
    if office._marker_revision(path) != revision:
        response['warnings'] = ['执行记录正在更新，请稍后查看。']
        return response
    response.update(operations=[{key: value for key, value in row.items() if not key.startswith('_')}
                                for row in list(operations.values())[-40:]], warnings=sorted(warnings))
    return response
