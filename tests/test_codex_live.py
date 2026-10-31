"""Live native observation, exact controls and tool receipts. No model calls."""
import asyncio
import copy
import json
import queue
import threading
import time
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from easel.codex_client import CodexError
from easel.codex_service import CodexService, Control
from easel.task_store import TaskStore


class Native:
    def __init__(self, workspace):
        self.workspace = str(workspace)
        self.turn = {'id': 'original-turn', 'status': 'inProgress', 'itemsView': 'full',
            'startedAt': int(time.time()) - 3, 'items': [
                {'id': 'cmd', 'type': 'commandExecution', 'status': 'completed',
                 'command': 'inert', 'aggregatedOutput': 'EASEL_PRESENT {"files":[{"path":"old.txt"}]}'},
                {'id': 'answer', 'type': 'agentMessage', 'text': 'original partial'}]}
        self.calls, self.clients, self.replies = [], [], []
        self.loaded = ['original-thread']
        self.resume_thread = 'original-thread'
        self.resume_workspace = self.workspace
        self.replay = []
        self.backgrounds = []

    def client(self, _):
        native = self
        class Client:
            version = '0.147.0'
            runtime_instance = 'a' * 32
            def __init__(self):
                self.events = queue.Queue()
                self._closed = threading.Event()
                self.proc = SimpleNamespace(poll=lambda: 1 if self._closed.is_set() else None)
                native.clients.append(self)
            def rpc(self, method, params, **kwargs):
                native.calls.append((method, copy.deepcopy(params)))
                if method == 'thread/read':
                    return {'thread': {'id': 'original-thread', 'cwd': native.workspace, 'historyMode': 'paginated'}}
                if method == 'thread/turns/list':
                    return {'data': [copy.deepcopy(native.turn)], 'nextCursor': None}
                if method == 'thread/loaded/list':
                    return {'data': native.loaded}
                if method == 'thread/backgroundTerminals/list':
                    return {'data': copy.deepcopy(native.backgrounds)}
                if method == 'thread/backgroundTerminals/terminate':
                    native.backgrounds = [row for row in native.backgrounds if row['processId'] != params['processId']]
                    return {}
                if method == 'thread/resume':
                    for event in native.replay:
                        self.events.put(copy.deepcopy(event))
                    return {'thread': {'id': native.resume_thread, 'cwd': native.resume_workspace}}
                if method == 'turn/interrupt':
                    assert params == {'threadId': 'original-thread', 'turnId': 'original-turn'}
                    native.turn['status'] = 'interrupted'
                    return {}
                if method == 'turn/steer':
                    assert params['threadId'] == 'original-thread' and params['expectedTurnId'] == 'original-turn'
                    return {'turnId': 'original-turn'}
                raise AssertionError('Unexpected native method: ' + method)
            def subscribe(self, thread):
                native.calls.append(('subscribe', {'threadId': thread}))
                return self.events
            def unsubscribe(self, thread):
                pass
            def reply(self, ident, result):
                native.replies.append((ident, copy.deepcopy(result)))
            def close(self):
                self._closed.set()
        return Client()


@pytest.fixture
def live(tmp_path):
    native = Native(tmp_path / 'workspace')
    service = CodexService(tmp_path, native.client)
    service.bind('s', 'codex')
    binding = service.binding('s')
    binding.update(threadId='original-thread', lastTurnId='t')
    service._write(service.folder('s') / 'session.json', binding)
    state = {'sessionId': 's', 'turn_id': 't', 'threadId': 'original-thread', 'codexTurnId': 'original-turn',
        'nativeRuntime': 'a' * 32, 'workspace': native.workspace, 'status': 'done', 'outcome': 'unconfirmed',
        'seq': 0, 'text': 'saved partial', 'thinking': '', 'items': [], 'pending': [],
        'requestedModelRef': 'codex/fixture', 'requestedThinkingLevel': 'low'}
    service._persist(state)
    service._event(state, 'error', {'message': 'old connection closed'})
    yield service, native, state
    native.turn['status'] = 'interrupted'
    for client in native.clients:
        client.close()
    deadline = time.monotonic() + 5
    while service.active and time.monotonic() < deadline:
        time.sleep(.01)
    assert not service.active


def finished(service):
    deadline = time.monotonic() + 5
    while service.active and time.monotonic() < deadline:
        time.sleep(.01)
    assert not service.active
    return service.snapshot('s', 't')


def tool_request():
    return {'id': 0, 'method': 'item/tool/call', 'params': {'threadId': 'original-thread',
        'turnId': 'original-turn', 'callId': 'same-call', 'tool': 'easel_present',
        'arguments': {'files': [{'path': 'result.txt'}]}}}


def test_rejoins_original_live_turn_and_settles_without_replaying_history(live, monkeypatch):
    service, native, _ = live
    monkeypatch.setattr(service, '_present_files', lambda *args: pytest.fail('historical tool replay'))
    prefix = service._event_path('s', 't').read_bytes()
    adopted = service.reconcile('s', 't')
    assert adopted['status'] == 'running' and adopted['text'] == 'original partial'
    assert adopted['recovery']['source'] == 'codex-live-thread'
    methods = [method for method, _ in native.calls]
    assert methods.index('subscribe') < methods.index('thread/resume')
    assert methods.count('thread/resume') == 1 and 'turn/start' not in methods
    assert service.reconcile('s', 't')['status'] == 'running'
    native.turn['items'][-1]['text'] = 'original final'
    native.turn.update(status='completed', durationMs=4123)
    settled = finished(service)
    assert settled['text'] == 'original final' and settled['elapsedMs'] == 4123
    assert settled['outcome'] == 'completed' and service.session_work('s') == []
    assert service._event_path('s', 't').read_bytes().startswith(prefix)
    restored = CodexService(service.outputs, lambda _: pytest.fail('settled result read must be passive'))
    assert restored.reconcile('s', 't') == settled
    async def events():
        response = await service.stream('s', 't')
        return [event async for event in response.body_iterator]
    assert json.loads(asyncio.run(events())[-1]['data'])['sessionKey'] == 'codex:original-thread'


def test_precise_stop_and_steer_on_reattached_original_run(live):
    service, native, _ = live
    service.reconcile('s', 't')
    req = Control(sessionId='s', turnId='t', message='same turn addition', requestId='steer-once',
                  modelRef='codex/fixture', thinkingLevel='low')
    assert service.steer(req)['turnId'] == 'original-turn'
    assert service.steer(req)['ok']
    assert [method for method, _ in native.calls].count('turn/steer') == 1
    assert service.stop('s', 'wrong-turn') == {'stopped': False}
    assert service.stop('s', 't') == {'stopped': True}
    assert service.snapshot('s', 't')['outcome'] == 'interrupted'


@pytest.mark.parametrize('mismatch', ['runtime', 'loaded', 'thread', 'workspace'])
def test_foreign_or_unloaded_run_never_resumes_execution(live, mismatch):
    service, native, state = live
    if mismatch == 'runtime':
        state['nativeRuntime'] = 'b' * 32
        service._persist(state)
    elif mismatch == 'loaded': native.loaded = []
    elif mismatch == 'thread': native.resume_thread = 'foreign-thread'
    elif mismatch == 'workspace': native.resume_workspace += '-foreign'
    saved = service.reconcile('s', 't')
    assert saved['outcome'] == 'unconfirmed' and not service.active
    assert saved['text'] == state['text']
    assert 'turn/start' not in [method for method, _ in native.calls]


def test_deleted_session_cannot_rejoin_or_execute_tools(live):
    service, native, _ = live
    TaskStore(service.outputs).delete_session('s')
    assert service.reconcile('s', 't')['outcome'] == 'unconfirmed'
    assert 'thread/resume' not in [method for method, _ in native.calls]


def test_lost_observer_does_not_claim_native_resources_released(live):
    service, native, state = live
    state['taskGoal'] = {'id': 'fixture'}
    service._persist(state)
    service.reconcile('s', 't')
    native.clients[-1].close()
    saved = finished(service)
    assert saved['outcome'] == 'unconfirmed' and saved.get('resourceSettled') is not True
    assert service.session_work('s') == ['t']


def test_pending_tool_replayed_during_resume_is_handled_once_and_receipt_retained(live, monkeypatch):
    service, native, _ = live
    native.replay = [tool_request(), tool_request()]
    effects = []
    monkeypatch.setattr(service, '_present_files', lambda *args: effects.append(args) or [])
    service.reconcile('s', 't')
    deadline = time.monotonic() + 5
    while len(native.replies) < 2 and time.monotonic() < deadline:
        time.sleep(.01)
    assert len(effects) == 1 and len(native.replies) == 2
    assert native.replies[0] == native.replies[1]
    assert service.snapshot('s', 't')['nativeRequests']['0']['status'] == 'replied'


def test_replied_tool_survives_host_recreation_without_repeating_effect(live, monkeypatch):
    service, native, state = live
    client = native.client(None)
    run = {'state': state, 'client': client, 'requests': {}}
    effects = []
    monkeypatch.setattr(service, '_present_files', lambda *args: effects.append(args) or [])
    service._request(run, tool_request())
    restored = CodexService(service.outputs, native.client)
    monkeypatch.setattr(restored, '_present_files', lambda *args: pytest.fail('committed effect repeated'))
    restored._request({'state': restored.snapshot('s', 't'), 'client': client}, tool_request())
    assert len(effects) == 1 and native.replies[0] == native.replies[1]


def test_ambiguous_started_tool_and_changed_identity_never_execute_again(live, monkeypatch):
    from easel.codex_live import begin_request
    service, native, state = live
    run = {'state': state, 'client': native.client(None), 'requests': {}}
    assert begin_request(service, run, tool_request()) is False
    monkeypatch.setattr(service, '_present_files', lambda *args: pytest.fail('ambiguous effect retried'))
    with pytest.raises(CodexError, match='前次执行'):
        service._request(run, tool_request())
    changed = tool_request(); changed['params']['arguments']['files'][0]['path'] = 'other.txt'
    with pytest.raises(CodexError, match='身份变化'):
        service._request(run, changed)


def test_tool_execution_requires_durable_intent(live, monkeypatch):
    service, native, state = live
    def fail_write(_): raise OSError('isolated disk failure')
    monkeypatch.setattr(service, '_persist', fail_write)
    monkeypatch.setattr(service, '_present_files', lambda *args: pytest.fail('effect before durable intent'))
    with pytest.raises(OSError, match='disk failure'):
        service._request({'state': state, 'client': native.client(None)}, tool_request())


def test_pending_approval_reappears_once_without_automatic_acceptance(live):
    service, native, _ = live
    event = {'id': 9, 'method': 'item/commandExecution/requestApproval', 'params': {
        'threadId': 'original-thread', 'turnId': 'original-turn', 'command': 'inert'}}
    native.replay = [event, event]
    service.reconcile('s', 't')
    deadline = time.monotonic() + 5
    while not service.snapshot('s', 't')['pending'] and time.monotonic() < deadline:
        time.sleep(.01)
    assert len(service.snapshot('s', 't')['pending']) == 1
    assert native.replies == []
    assert service.answer(Control(sessionId='s', turnId='t', requestId='9', decision='decline'))['ok']
    assert native.replies == [(9, {'decision': 'decline'})]


def test_orphan_with_ambiguous_tool_can_still_stop_exact_original_run(live):
    service, native, _ = live
    assert service.stop('s', 't') == {'stopped': True}
    assert service.snapshot('s', 't')['outcome'] == 'interrupted'
    assert [method for method, _ in native.calls].count('turn/interrupt') == 1
    assert 'turn/start' not in [method for method, _ in native.calls]


def test_stop_terminates_only_background_processes_from_original_turn(live):
    service, native, _ = live
    native.backgrounds = [{'itemId': 'cmd', 'processId': 'owned'}, {'itemId': 'other-turn-command', 'processId': 'foreign'}]
    service.reconcile('s', 't')
    assert service.stop('s', 't')['stopped']
    assert native.backgrounds == [{'itemId': 'other-turn-command', 'processId': 'foreign'}]
    assert service.snapshot('s', 't')['nativeBackgroundSettled'] is False
