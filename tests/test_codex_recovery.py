"""Isolated protocol/lifecycle facts; no provider or model calls."""
import asyncio
import copy
import json
import multiprocessing
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from easel.codex_client import CodexError
from easel.codex_service import CodexService
from easel.task_store import TaskStore


class Client:
    def __init__(self, state, turn, *, mode='legacy'):
        self.state, self.turn, self.mode = state, turn, mode
        self.calls = []
        self.closed = False
        self.pages = []
        self.failure = None

    def rpc(self, method, params, **kwargs):
        self.calls.append((method, params))
        assert method in ('thread/read', 'thread/turns/list'), 'recovery must be read-only'
        if self.failure:
            raise self.failure
        if method == 'thread/turns/list':
            return self.pages.pop(0)
        return {'thread': {'id': self.state['threadId'], 'cwd': self.state['workspace'],
            'historyMode': self.mode, 'turns': [self.turn] if params.get('includeTurns') else []}}

    def close(self):
        self.closed = True


@pytest.fixture
def case(tmp_path):
    service = CodexService(tmp_path)
    service.bind('s', 'codex')
    binding = service.binding('s')
    binding.update(lastTurnId='t', threadId='native-thread')
    service._write(service.folder('s') / 'session.json', binding)
    state = {'sessionId': 's', 'turn_id': 't', 'threadId': 'native-thread', 'codexTurnId': 'native-turn',
        'workspace': str(tmp_path / 'workspace'), 'status': 'done', 'outcome': 'unconfirmed', 'seq': 0,
        'text': 'partial', 'thinking': '', 'items': [], 'pending': [{'requestId': 'old'}],
        'error': {'message': 'connection lost'}, 'elapsedMs': 123}
    service._persist(state)
    service._event(state, 'error', state['error'])
    turn = {'id': 'native-turn', 'status': 'completed', 'itemsView': 'full', 'durationMs': 1250,
        'items': [{'id': 'comment', 'type': 'agentMessage', 'phase': 'commentary', 'text': 'progress'},
                  {'id': 'reason', 'type': 'reasoning', 'summary': ['retained summary']},
                  {'id': 'reply', 'type': 'agentMessage', 'phase': 'final_answer', 'text': 'original result'},
                  {'id': 'cmd', 'type': 'commandExecution', 'status': 'completed', 'command': 'echo result',
                   'aggregatedOutput': 'EASEL_PRESENT {"files":[{"path":"not-delivered.txt"}]}', 'exitCode': 0}]}
    client = Client(state, turn)
    service.factory = lambda _: client
    return service, state, turn, client


@pytest.mark.parametrize('status', ['completed', 'interrupted', 'failed'])
def test_exact_terminal_result_without_replaying_tools(case, status, monkeypatch):
    service, state, turn, client = case
    turn['status'] = status
    if status == 'failed':
        turn['error'] = {'message': 'original failure'}
    monkeypatch.setattr(service, '_present_files', lambda *_: pytest.fail('delivery effect repeated'))
    saved = service.reconcile('s', 't')
    assert saved['outcome'] == status and saved['status'] == 'done'
    assert saved['text'] == 'original result' and saved['thinking'] == 'retained summary'
    assert saved['pending'] == [] and saved['elapsedMs'] == 1250
    assert saved['stopped'] is (status == 'interrupted')
    assert saved.get('error', {}).get('message') == ('original failure' if status == 'failed' else None)
    assert saved['thinkingStatus'] == ('available' if status == 'completed' else 'partial')
    assert client.closed and service.session_work('s') == []
    assert service.execution('s', 't')['operations'][0]['output'].startswith('EASEL_PRESENT ')
    before = service._event_path('s', 't').read_bytes(), len(client.calls)
    assert service.reconcile('s', 't') == saved
    assert (service._event_path('s', 't').read_bytes(), len(client.calls)) == before
    restored = CodexService(service.outputs, lambda _: pytest.fail('restart reads must stay passive'))
    assert restored.snapshot('s', 't') == saved


def test_paginated_old_turn_does_not_adopt_latest(case):
    service, state, turn, client = case
    client.mode = 'paginated'
    client.pages = [{'data': [{'id': 'newer', 'status': 'completed', 'items': []}], 'nextCursor': 'older'},
                    {'data': [turn], 'nextCursor': None}]
    assert service.reconcile('s', 't')['text'] == 'original result'
    assert client.calls[-1][1]['cursor'] == 'older'
    assert all(params.get('itemsView') == 'full' for method, params in client.calls if method.endswith('/list'))


@pytest.mark.parametrize('change', ['running', 'missing', 'summary', 'bad-items', 'bad-text', 'no-id', 'timeout', 'cwd', 'foreign'])
def test_uncertain_records_preserve_original_and_occupancy(case, change):
    service, state, turn, client = case
    if change == 'running': turn['status'] = 'inProgress'
    if change == 'missing': turn['id'] = 'another-turn'
    if change == 'summary': turn['itemsView'] = 'summary'
    if change == 'bad-items': turn['items'].append({'type': 'agentMessage', 'text': 'missing id'})
    if change == 'bad-text': turn['items'][0]['text'] = 123
    if change == 'no-id':
        del state['codexTurnId']; service._persist(state)
    if change == 'timeout': client.failure = CodexError('read timed out')
    if change in ('cwd', 'foreign'):
        client.state = {**state, 'workspace': str(service.outputs / 'other')} if change == 'cwd' else {**state,'threadId':'foreign'}
    before = copy.deepcopy(service.snapshot('s', 't'))
    saved = service.reconcile('s', 't')
    assert saved['recovery']['status'] == 'unconfirmed'
    assert {k: v for k, v in saved.items() if k != 'recovery'} == before
    assert service.session_work('s') == ['t']
    assert service._event_path('s', 't').read_text().count('\n') == 1
    assert client.closed is (change != 'no-id')


def test_old_unsettled_turn_blocks_new_send_even_when_latest_completed(case, monkeypatch):
    service, state, *_ = case
    binding = service.binding('s'); binding['lastTurnId'] = 'newer'
    service._write(service.folder('s') / 'session.json', binding)
    service._persist({**state, 'turn_id': 'newer', 'status': 'done', 'outcome': 'completed'})
    model = {'id': 'codex/test', 'model': 'test', 'thinkingLevels': ['low'], 'defaultEffort': 'low'}
    monkeypatch.setattr(service, 'runtime', lambda: {'available': True, 'auth': 'local_provider',
        'options': [model], 'defaultModelRef': model['id']})
    req = SimpleNamespace(sessionId='s', turnId='not-sent', selectedSkills=[], skillRequirements={},
                          message='next', attachments=[], modelRef=None, thinkingLevel='low')
    with pytest.raises(HTTPException, match='未确认'):
        service.start(req)
    assert service.start(SimpleNamespace(sessionId='s', turnId='t')) == 't'


@pytest.mark.parametrize('contents', ['not-json', json.dumps({'sessionId': 'foreign', 'turn_id': 't', 'status': 'done'})])
def test_corrupt_or_foreign_history_fails_closed_before_send(case, contents, monkeypatch):
    service, *_ = case
    path = service._state_path('s', 'corrupt')
    path.write_text(contents, encoding='utf-8')
    with pytest.raises(HTTPException, match='历史'):
        service.session_work('s')


def _hold_owner(root, ready, release):
    service = CodexService(Path(root))
    with service._owner('s'):
        ready.set()
        release.wait(60)


def test_other_process_owner_prevents_restart_rewrite_and_reconciliation(case):
    service, state, *_ = case
    context = multiprocessing.get_context('spawn')
    ready, release = context.Event(), context.Event()
    child = context.Process(target=_hold_owner, args=(str(service.outputs), ready, release))
    child.start()
    try:
        assert ready.wait(30), 'spawned owner did not initialize within the cold-start allowance'
        # A still-running owner, not a stale timestamp, establishes ownership.
        state.update(status='running', outcome='running')
        service._persist(state)
        restored = CodexService(service.outputs, lambda _: pytest.fail('native read while owned'))
        assert restored.snapshot('s', 't')['status'] == 'running'
        with pytest.raises(HTTPException) as exc:
            restored.reconcile('s', 't')
        assert exc.value.status_code == 409
        with pytest.raises(HTTPException):
            restored.start(SimpleNamespace(sessionId='s', turnId='new'))
        assert restored.start(SimpleNamespace(sessionId='s', turnId='t')) == 't'
    finally:
        release.set(); child.join(8)
        if child.is_alive(): child.terminate(); child.join()
    assert child.exitcode == 0
    assert CodexService(service.outputs).snapshot('s', 't')['outcome'] == 'unconfirmed'


def test_replay_skips_superseded_error_and_keeps_final_snapshot(case):
    service, *_ = case
    service.reconcile('s', 't')
    async def read():
        response = await service.stream('s', 't')
        return [event async for event in response.body_iterator]
    events = asyncio.run(read())
    assert not any(event['event'] == 'error' for event in events)
    assert json.loads(next(event['data'] for event in events if event['event'] == 'text_snapshot')) == 'original result'
    assert events[-1]['event'] == 'done'


def test_deleted_session_can_settle_history_but_cannot_start(case):
    service, *_ = case
    TaskStore(service.outputs).delete_session('s')
    assert service.reconcile('s', 't')['outcome'] == 'completed'
    with pytest.raises(HTTPException):
        service.start(SimpleNamespace(sessionId='s', turnId='new'))
