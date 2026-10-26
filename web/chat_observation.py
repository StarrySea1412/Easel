"""Resume reading an existing gateway raw stream, without dispatching a turn.

The cursor and parser state belong to one logical turn. A byte anchor detects
replacement/truncation even on filesystems which retain an inode on rewrite.
Raw message boundaries are observations, never proof of successful completion.
"""
from __future__ import annotations

import copy
import hashlib
import json

from easel.reasoning_stream import ThinkingTextStream, visible_text

READ_BUDGET = 4 * 1024 * 1024
MAX_LINE = 1024 * 1024


def _source(stat):
    return {'device': stat.st_dev, 'inode': stat.st_ino}


def _anchor(stream, offset):
    start = max(0, offset - 64)
    stream.seek(start)
    return {'offset': start, 'length': offset - start,
            'sha256': hashlib.sha256(stream.read(offset - start)).hexdigest()}


def capture(path):
    """Pin the byte boundary before submitting the original provider request."""
    try:
        with path.open('rb') as stream:
            import os
            stat = os.fstat(stream.fileno())
            return {'version': 1, 'offset': stat.st_size, 'source': _source(stat),
                    'anchor': _anchor(stream, stat.st_size)}
    except FileNotFoundError:
        return {'version': 1, 'offset': 0, 'source': None}
    except OSError:
        return None


def _new_message(state):
    if state.get('ended'):
        state['textPrefix'] += state['text']
        state['thinkingPrefix'] += state['thinking']
        state.update(text='', thinking='', ended=False)


def read(path, checkpoint, run_id, runtime_session_id):
    """Read bounded new complete lines. The caller holds the session OS lock.

    Unread half-lines remain at the cursor for a later pass. Invalid data or a
    source discontinuity keeps the original file and the last visible content.
    """
    point = copy.deepcopy(checkpoint)
    offset = point.get('offset')
    if point.get('version') != 1 or type(offset) is not int or offset < 0:
        return None
    try:
        with path.open('rb') as stream:
            import os
            stat = os.fstat(stream.fileno())
            if stat.st_size < offset or point.get('source') not in (None, _source(stat)):
                return None
            anchor = point.get('anchor')
            if anchor and _anchor(stream, offset) != anchor:
                return None
            point['source'] = _source(stat)
            state = point.setdefault('state', {'textPrefix': '', 'thinkingPrefix': '',
                                               'text': '', 'thinking': '', 'ended': False})
            stream.seek(offset)
            consumed = 0
            partial = False
            while consumed < READ_BUDGET:
                start = stream.tell()
                line = stream.readline(min(MAX_LINE + 1, READ_BUDGET - consumed + 1))
                if not line or not line.endswith(b'\n'):
                    # No complete row can be consumed yet. Oversized rows are a
                    # visible observation gap rather than an unbounded read.
                    if len(line) > MAX_LINE:
                        return None
                    partial = bool(line) and stream.tell() >= stat.st_size
                    stream.seek(start)
                    break
                consumed += len(line)
                try:
                    event = json.loads(line)
                except (ValueError, UnicodeError):
                    return None
                if not isinstance(event, dict):
                    return None
                if (event.get('runId') != run_id
                        or event.get('sessionId') not in (None, runtime_session_id)):
                    continue
                kind, phase = event.get('event'), event.get('evtType')
                if kind == 'assistant_message_end':
                    _new_message(state)
                    if isinstance(event.get('rawText'), str):
                        wrapped, text = ThinkingTextStream().push(event['rawText'], final=True)
                        state['text'] = text
                        if wrapped and not state['thinking']:
                            state['thinking'] = wrapped
                    if isinstance(event.get('rawThinking'), str):
                        state['thinking'] = event['rawThinking'] or state['thinking']
                    state['ended'] = True
                elif kind in ('assistant_text_stream', 'assistant_thinking_stream'):
                    _new_message(state)
                    if kind == 'assistant_text_stream' and phase == 'text_delta':
                        state['text'] += visible_text(event.get('delta'))
                    elif kind == 'assistant_thinking_stream':
                        if phase == 'thinking_delta':
                            state['thinking'] += visible_text(event.get('delta'))
                        elif phase == 'thinking_end':
                            snapshot = visible_text(event.get('content'))
                            if snapshot:
                                state['thinking'] = snapshot
            point['offset'] = stream.tell()
            point['anchor'] = _anchor(stream, point['offset'])
            wrapped, text = ThinkingTextStream().push(state['text'], final=state['ended'])
            return {'checkpoint': point, 'text': state['textPrefix'] + text,
                    'thinking': state['thinkingPrefix'] + (state['thinking'] or wrapped),
                    'hasMore': point['offset'] < stat.st_size and not partial}
    except (OSError, ValueError, KeyError, TypeError):
        return None
