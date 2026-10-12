"""Public, bounded operation evidence shared by local execution engines."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import math
from pathlib import Path
import re

from .gateway_auth import redact_gateway_text

LIMITS = {'command': 16000, 'path': 2000, 'cwd': 2000, 'output': 64000, 'diff': 64000, 'query': 2000, 'url': 2000}
SENSITIVE = re.compile(r'(?i)(?:^|[/\\])(?:\.env(?:\..*)?|openclaw\.json|auth[^/\\]*|credentials[^/\\]*)$')


def public_text(value, credentials=None, limit=64000):
    if not isinstance(value, str):
        return ''
    value = redact_gateway_text(value, credentials)
    value = re.sub(r'(?i)\bsk-[a-z0-9_-]{8,}', '[已隐藏]', value)
    value = re.sub(r'''(?ix)((?:api[_-]?key|token|password|secret)["']?\s*[=: ]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)''', r'\1[已隐藏]', value)
    return value[:limit]


def stamp(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return value / 1000 if value > 1e11 else value
    if isinstance(value, str):
        try:
            date = datetime.fromisoformat(value.replace('Z', '+00:00'))
            return date.timestamp() if date.tzinfo else None
        except (ValueError, OverflowError):
            pass
    return None


def iso(value):
    try:
        return datetime.fromtimestamp(value, timezone.utc).isoformat()
    except (ValueError, OSError, OverflowError, TypeError):
        return None


def ident(session, turn, call):
    return hashlib.sha256(f'{session}\0{turn}\0{call}'.encode()).hexdigest()[:24]


def kind(name, args):
    if name in ('exec', 'exec_command', 'bash', 'shell', 'process', 'commandExecution'):
        return 'command'
    if name in ('read', 'read_file', 'imageView', 'view_image'):
        return 'read'
    if name in ('write', 'write_file', 'edit', 'apply_patch', 'fileChange'):
        return 'file_change'
    if name in ('browser', 'browser_navigate', 'browser_click', 'browser_snapshot', 'browser_screenshot'):
        return 'browser'
    if name in ('web_search', 'webSearch', 'search', 'grep', 'glob', 'web_fetch'):
        return 'search'
    return 'tool'


def set_text(row, field, value, credentials=None):
    if not isinstance(value, str):
        return
    limit = LIMITS[field]
    text = public_text(value, credentials, limit + 1)
    row[field] = text[:limit]
    row.setdefault('truncated', {})[field] = len(text) > limit


def begin(session, turn, call, name, args, at=None, credentials=None, source='transcript'):
    args = args if isinstance(args, dict) else {}
    name = name.split('.')[-1][:100]
    row = {'id': ident(session, turn, call), 'name': name, 'kind': kind(name, args),
           'status': 'running', 'command': '', 'path': '', 'cwd': '', 'output': '', 'diff': '',
           'truncated': {}, 'source': source}
    for field, value in {
        'command': args.get('command', args.get('cmd', '')),
        'path': args.get('path', args.get('file_path', args.get('file', ''))),
        'cwd': args.get('cwd', args.get('workdir', '')),
        'query': args.get('query', args.get('pattern', '')),
        'url': args.get('url', args.get('targetUrl', '')),
    }.items():
        set_text(row, field, value, credentials)
    if row['kind'] == 'file_change':
        row['changeKind'] = 'write' if name in ('write', 'write_file') else 'modify'
    if row['kind'] == 'browser':
        row['action'] = public_text(args.get('action', name), credentials, 80)
    if iso(at):
        row['startedAt'] = iso(at)
    return row


def returned(row, result, at=None, credentials=None, partial=False):
    if not isinstance(result, dict):
        return row
    details = result.get('details')
    details = details if isinstance(details, dict) else {}
    state = details.get('status')
    if result.get('isError') is True or state in ('failed', 'error'):
        row['status'] = 'failed'
    elif state in ('running', 'inProgress') or partial:
        row['status'] = 'running'
    else:
        row['status'] = 'returned'
    code = details.get('exitCode')
    if isinstance(code, int) and not isinstance(code, bool):
        row['exitCode'] = code
        if state not in ('running', 'inProgress') and not partial:
            row['status'] = 'completed' if code == 0 else 'failed'
    elif state == 'completed' and row['kind'] == 'command' and not partial:
        row['status'] = 'completed'
    signal = details.get('exitSignal')
    if isinstance(signal, (str, int)) and not isinstance(signal, bool):
        row['exitSignal'] = public_text(str(signal), credentials, 80)
    if state in ('aborted', 'cancelled', 'interrupted'):
        row['status'] = 'stopped'
    if state == 'denied':
        row['status'] = 'denied'
    for field in ('cwd',):
        set_text(row, field, details.get(field), credentials)
    if isinstance(details.get('sessionId'), str):
        row['processSessionId'] = public_text(details['sessionId'], credentials, 200)
    duration = details.get('durationMs')
    start = stamp(row.get('startedAt'))
    if isinstance(duration, (int, float)) and not isinstance(duration, bool) and math.isfinite(duration) and duration >= 0:
        row['elapsedSeconds'] = duration / 1000
    elif row['status'] != 'running' and start is not None and at is not None and at >= start:
        row['elapsedSeconds'] = round(at - start, 3)
    if row['status'] != 'running' and iso(at):
        row['finishedAt'] = iso(at)
    if SENSITIVE.search(row.get('path', '')):
        row['output'] = row['diff'] = ''
        row['contentHidden'] = True
        return row
    content = result.get('content')
    text = content if isinstance(content, str) else '\n'.join(b.get('text', '') for b in content
        if isinstance(b, dict) and isinstance(b.get('text'), str)) if isinstance(content, list) else ''
    if isinstance(details.get('aggregated'), str):
        text = details['aggregated']
    elif partial and isinstance(details.get('tail'), str):
        text = details['tail']
    if text or 'content' in result or 'aggregated' in details or 'tail' in details:
        set_text(row, 'output', text, credentials)
    diff = details.get('diff')
    if isinstance(diff, str) and result.get('isError') is False and not partial:
        set_text(row, 'diff', diff, credentials)
        row['added'] = sum(x.startswith('+') and not x.startswith('+++') for x in diff.splitlines())
        row['removed'] = sum(x.startswith('-') and not x.startswith('---') for x in diff.splitlines())
    return row


def page(rows, before=None, limit=40):
    limit = max(1, min(100, limit))
    end = min(len(rows), max(0, before)) if before is not None else len(rows)
    start = max(0, end - limit)
    return {'operations': rows[start:end], 'total': len(rows), 'nextBefore': start if start else None}


def artifact(row, outputs, cwd=None):
    """Offer only a path in the current outputs root; existing endpoint verifies it."""
    if not outputs or row['kind'] != 'file_change' or row['status'] not in ('returned', 'completed'):
        return
    try:
        value = Path(row.get('path', ''))
        if not str(value) or str(value) == '.':
            return
        root = Path(outputs).resolve()
        if value.is_absolute():
            target = value.resolve()
        elif value.parts and value.parts[0] == 'outputs':
            target = (root / Path(*value.parts[1:])).resolve()
        elif cwd:
            target = (Path(cwd) / value).resolve()
        else:
            return
        relative = target.relative_to(root)
        if any(x.startswith('_') or x.startswith('.') for x in relative.parts):
            return
        row['artifactPath'] = relative.as_posix()
    except (ValueError, OSError):
        return


def codex_rows(state):
    rows = []
    for item in state.get('items', []):
        name = item.get('type', '')
        if name in ('userMessage', 'agentMessage', 'reasoning', 'plan'):
            continue
        row = begin(state['sessionId'], state['turn_id'], item['id'], name, item, source='codex')
        row['status'] = {'inProgress': 'running', 'completed': 'completed', 'failed': 'failed',
                         'declined': 'denied', 'interrupted': 'stopped'}.get(item.get('status'), 'unconfirmed')
        if item.get('_startedAt'):
            row['startedAt'] = item['_startedAt']
        if item.get('_finishedAt'):
            row['finishedAt'] = item['_finishedAt']
        duration = item.get('durationMs')
        if isinstance(duration, (int, float)) and not isinstance(duration, bool) and math.isfinite(duration) and duration >= 0:
            row['elapsedSeconds'] = duration / 1000
        elif stamp(row.get('startedAt')) is not None and stamp(row.get('finishedAt')) is not None:
            row['elapsedSeconds'] = max(0, stamp(row['finishedAt']) - stamp(row['startedAt']))
        if isinstance(item.get('exitCode'), int) and not isinstance(item['exitCode'], bool):
            row['exitCode'] = item['exitCode']
            if row['status'] == 'completed' and item['exitCode'] != 0:
                row['status'] = 'failed'
        set_text(row, 'output', item.get('aggregatedOutput', '' if name == 'fileChange' else item.get('result', '')))
        if item.get('_outputTruncated'):
            row['truncated']['output'] = True
        if name == 'webSearch':
            action = item.get('action') or {}
            row['action'] = action.get('type', 'search')
            set_text(row, 'url', action.get('url'))
        if name in ('mcpToolCall', 'dynamicToolCall'):
            row['name'] = public_text(item.get('tool', name), limit=100)
            result = item.get('result')
            if isinstance(result, dict):
                observed = row['status']
                returned(row, {'content': result.get('content'), 'isError': bool(item.get('error'))})
                row['status'] = observed
            if item.get('error'):
                row['status'] = 'failed'
                set_text(row, 'output', str(item['error']))
        if name == 'fileChange':
            for i, change in enumerate(item.get('changes') or []):
                if not isinstance(change, dict):
                    continue
                file_row = {**row, 'truncated': dict(row['truncated']), 'id': row['id'] + '-' + str(i)}
                set_text(file_row, 'path', change.get('path'))
                change_kind = change.get('kind')
                file_row['changeKind'] = change_kind.get('type', 'modify') if isinstance(change_kind, dict) else change_kind or 'modify'
                if SENSITIVE.search(file_row['path']):
                    file_row['contentHidden'] = True
                    file_row['output'] = file_row['diff'] = ''
                else:
                    diff = change.get('diff', '')
                    set_text(file_row, 'diff', diff)
                    if change.get('_diffTruncated'):
                        file_row['truncated']['diff'] = True
                    file_row['added'] = sum(x.startswith('+') and not x.startswith('+++') for x in diff.splitlines())
                    file_row['removed'] = sum(x.startswith('-') and not x.startswith('---') for x in diff.splitlines())
                artifact(file_row, state.get('_outputs'), state.get('workspace'))
                rows.append(file_row)
            if item.get('changes'):
                continue
        rows.append(row)
    return rows
