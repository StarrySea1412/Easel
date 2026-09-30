"""Normalize only provider-returned reasoning text; never generate progress prose.

Providers may expose summaries, thinking deltas, or no visible reasoning at all.
Encrypted reasoning/signatures and arbitrary content objects are not display text.
"""
from __future__ import annotations
import threading


def visible_text(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return ''.join(visible_text(part) for part in value)
    if isinstance(value, dict) and value.get('type') in ('text', 'summary_text', 'reasoning_text', 'thinking'):
        return visible_text(value.get('text') or value.get('thinking') or '')
    return ''


def provider_reasoning(payload):
    """Return (text, cumulative, block, event_id) for known public wire fields."""
    if not isinstance(payload, dict):
        return []
    kind = payload.get('type', '')
    if kind in ('response.reasoning_summary_text.delta', 'response.reasoning_text.delta',
                'response.reasoning_summary_text.done', 'response.reasoning_text.done'):
        snapshot = kind.endswith('.done')
        value = payload.get('text') if snapshot else payload.get('delta')
        block = str(payload.get('item_id', '')) + ':' + str(payload.get('summary_index', 0))
        # sequence_number is stable across replay, unlike the shared response id.
        return [(visible_text(value), snapshot, block, payload.get('sequence_number'))]
    if kind == 'content_block_delta' and isinstance(payload.get('delta'), dict):
        delta = payload['delta']
        if delta.get('type') == 'thinking_delta':
            return [(visible_text(delta.get('thinking')), False, str(payload.get('index', 0)), None)]
    choices = payload.get('choices')
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return []
    delta = choices[0].get('delta')
    if not isinstance(delta, dict):
        return []
    for key in ('reasoning_content', 'reasoning', 'reasoning_summary', 'thinking'):
        text = visible_text(delta.get(key))
        if text:
            return [(text, False, 'chat', None)]
    return []


class ReasoningStream:
    """Choose one source per turn and append only unseen snapshot suffixes."""
    def __init__(self):
        self.source = None
        self.blocks = {}
        self.seen = set()
        self.lock = threading.Lock()

    def reset(self, source, block='raw'):
        with self.lock:
            if self.source in (None, source):
                self.blocks[block] = ''

    def push(self, source, text, *, snapshot=False, block='raw', event_id=None):
        with self.lock:
            return self._push(source, text, snapshot=snapshot, block=block, event_id=event_id)

    def _push(self, source, text, *, snapshot=False, block='raw', event_id=None):
        if not isinstance(text, str) or not text:
            return ''
        if self.source is None:
            self.source = source
        if self.source != source:
            return ''
        if event_id is not None:
            key = (source, block, event_id)
            if key in self.seen:
                return ''
            self.seen.add(key)
        previous = self.blocks.get(block, '')
        if snapshot:
            # Final snapshots repeat already streamed text. A revision that does
            # not extend it cannot be represented as an append-only delta.
            delta = text[len(previous):] if text.startswith(previous) else ''
            if not delta:
                return ''
        else:
            delta = text
        self.blocks[block] = previous + delta
        return delta
