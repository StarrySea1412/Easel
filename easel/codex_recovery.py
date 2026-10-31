"""Read persisted native results. Never resume a thread or replay tool effects."""
from __future__ import annotations

from pathlib import Path

from .codex_client import CodexError


def read_turn(client, state, *, allow_active=False):
    thread_id, turn_id = state.get('threadId'), state.get('codexTurnId')
    if not thread_id or not turn_id:
        raise CodexError('原生线程或轮次标识缺失，无法确认结果。')
    # 0.147.0 supports both legacy full history and paginated threads.
    thread = client.rpc('thread/read', {'threadId': thread_id, 'includeTurns': False}, timeout=15).get('thread')
    if not isinstance(thread, dict) or thread.get('id') != thread_id:
        raise CodexError('原生线程身份不匹配，未收取结果。')
    if not state.get('workspace') or Path(thread.get('cwd', '')).resolve() != Path(state['workspace']).resolve():
        raise CodexError('原生线程工作目录不匹配，未收取结果。')
    if thread.get('historyMode', 'legacy') == 'paginated':
        cursor, seen = None, set()
        for _ in range(20):
            batch = client.rpc('thread/turns/list', {'threadId': thread_id, 'limit': 50,
                'sortDirection': 'desc', 'itemsView': 'full', **({'cursor': cursor} if cursor else {})}, timeout=15)
            turns = batch.get('data')
            if not isinstance(turns, list):
                raise CodexError('原生轮次历史不完整。')
            matches = [turn for turn in turns if isinstance(turn, dict) and turn.get('id') == turn_id]
            if len(matches) == 1:
                return validated_turn(matches[0], allow_active=allow_active)
            if matches:
                raise CodexError('原生轮次身份重复，未收取结果。')
            cursor = batch.get('nextCursor')
            if not cursor:
                break
            if not isinstance(cursor, str) or cursor in seen:
                raise CodexError('原生历史分页无效。')
            seen.add(cursor)
    else:
        full = client.rpc('thread/read', {'threadId': thread_id, 'includeTurns': True}, timeout=15).get('thread')
        if not isinstance(full, dict) or full.get('id') != thread_id or full.get('cwd') != thread.get('cwd'):
            raise CodexError('原生历史身份变化，未收取结果。')
        matches = [turn for turn in full.get('turns', []) if isinstance(turn, dict) and turn.get('id') == turn_id]
        if len(matches) == 1:
            return validated_turn(matches[0], allow_active=allow_active)
    raise CodexError('未找到原轮次的完整记录，完成状态仍未确认。')


def validated_turn(turn, *, allow_active=False):
    if turn.get('status') not in (('completed', 'interrupted', 'failed', 'inProgress')
                                  if allow_active else ('completed', 'interrupted', 'failed')):
        raise CodexError('原轮次没有明确终态；尚不能接管活跃运行。')
    items = turn.get('items')
    if turn.get('itemsView', 'full') != 'full' or not isinstance(items, list):
        raise CodexError('原轮次仅返回摘要，未收取不完整结果。')
    ids = [item.get('id') for item in items if isinstance(item, dict)]
    if len(ids) != len(items) or any(not isinstance(i, str) or not i for i in ids) or len(ids) != len(set(ids)):
        raise CodexError('原轮次执行记录不完整。')
    for item in items:
        if not isinstance(item.get('type'), str):
            raise CodexError('原轮次记录类型缺失。')
        if item['type'] == 'agentMessage' and not isinstance(item.get('text'), str):
            raise CodexError('原轮次回复不完整。')
        if item['type'] == 'reasoning' and (not isinstance(item.get('summary'), list)
                or any(not isinstance(text, str) for text in item['summary'])):
            raise CodexError('原轮次摘要不完整。')
    return turn


def project(state, turn, sanitize):
    """Project facts only: no _consume, dynamic calls, presentation or usage deltas."""
    previous = {i['id']: i for i in state.get('items', []) if isinstance(i, dict) and i.get('id')}
    items = []
    for raw in turn['items']:
        item = {**previous.get(raw['id'], {}), **sanitize(raw)}
        if item.get('status') == 'inProgress':
            item['status'] = 'unconfirmed'
        items.append(item)
    state['items'] = items
    state['text'] = '\n\n'.join(i.get('text', '') for i in items
        if i.get('type') == 'agentMessage' and i.get('phase') != 'commentary')
    summaries = [text for i in items if i.get('type') == 'reasoning'
                 for text in i.get('summary', []) if isinstance(text, str)]
    if summaries:
        state['thinking'] = '\n\n'.join(summaries)
    outcome = turn['status']
    state.update(status='done', outcome=outcome, pending=[],
        thinkingStatus=('partial' if outcome != 'completed' else 'available') if state.get('thinking') else 'unavailable')
    state.pop('error', None)
    if outcome == 'failed':
        state['error'] = {'message': sanitize((turn.get('error') or {}).get('message') or 'Codex 上报原轮次失败。')}
    # Native timing, when supplied, replaces measured local timing. Never add downtime.
    duration = turn.get('durationMs')
    if type(duration) is int and duration >= 0:
        state['elapsedMs'] = duration
    state['stopped'] = outcome == 'interrupted'
