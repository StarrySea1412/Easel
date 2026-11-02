"""Native request retries keep the original turn and completed tool receipts."""
import json
import queue
import threading
import time
from types import SimpleNamespace

import pytest

from easel.codex_service import CodexService


@pytest.mark.parametrize('ending', ['completed', 'failed', 'interrupted', 'disconnected'])
def test_request_retry_does_not_resubmit_turn_or_replay_delivery(tmp_path, monkeypatch, ending):
    calls, deliveries, failures = [], [], []

    class Client:
        def __init__(self):
            self._closed = threading.Event()
            self.proc = SimpleNamespace(poll=lambda: None)

        def rpc(self, method, params):
            calls.append(method)
            if method == 'turn/start':
                return {'turn': {'id': 'original-turn'}}
            assert method == 'thread/start'
            return {'thread': {'id': 'original-thread'}}

        def subscribe(self, thread):
            events = queue.Queue()
            def emit(method, **params):
                events.put({'method': method, 'params': {'threadId': thread, 'turnId': 'original-turn', **params}})
            emit('item/completed', item={'id': 'delivered', 'type': 'commandExecution', 'status': 'completed',
                 'aggregatedOutput': 'EASEL_PRESENT {"files":[{"path":"receipt.txt"}]}'})
            # A foreign turn must not poison this turn or show its retry activity.
            emit('error', turnId='other-turn', error={'message': 'foreign failure'}, willRetry=False)
            emit('error', error={'message': 'temporary stream disconnect'}, willRetry=True)
            emit('item/agentMessage/delta', itemId='reply', delta='retained answer')
            if ending == 'disconnected':
                emit('easel/transportClosed')
            else:
                turn = {'id': 'original-turn', 'status': ending}
                if ending == 'failed':
                    turn['error'] = {'message': 'retry budget exhausted'}
                emit('turn/completed', turn=turn)
            return events

        def unsubscribe(self, _):
            pass

        def close(self):
            self._closed.set()

    service = CodexService(tmp_path / 'outputs', client_factory=lambda _: Client())
    service.failure_events = SimpleNamespace(record_chat=lambda **values: failures.append(values))
    monkeypatch.setattr(service, '_present_files', lambda *args: deliveries.append(args) or [])
    model = {'id': 'codex/fixture', 'model': 'fixture', 'thinkingLevels': ['low'], 'defaultEffort': 'low'}
    monkeypatch.setattr(service, 'runtime', lambda: {'available': True, 'auth': 'local_provider',
                        'defaultModelRef': model['id'], 'options': [model]})
    service.bind('s', 'codex')
    request = SimpleNamespace(sessionId='s', turnId='t', selectedSkills=[], skillRequirements={},
                              message='isolated fixture', attachments=[], modelRef=model['id'], thinkingLevel='low')
    service.start(request)
    deadline = time.monotonic() + 5
    while service.active and time.monotonic() < deadline:
        time.sleep(.01)
    assert not service.active
    state = service.snapshot('s', 't')
    events = [json.loads(line) for line in service._event_path('s', 't').read_text(encoding='utf-8').splitlines()]
    assert calls == ['thread/start', 'turn/start'] and len(deliveries) == 1
    assert state['text'] == 'retained answer'
    assert state['items'][0]['id'] == 'delivered' and state['items'][0]['status'] == 'completed'
    assert any('temporary stream disconnect' in str(e) for e in events if e['event'] == 'activity')
    assert 'foreign failure' not in str(state) + str(events)
    if ending in ('completed', 'interrupted'):
        assert state['outcome'] == ending and not state.get('error') and not failures
        assert events[-1]['event'] == 'done'
    else:
        assert state['outcome'] == ('unconfirmed' if ending == 'disconnected' else 'failed')
        assert state['error'] and failures and events[-1]['event'] == 'error'
        if ending == 'failed':
            assert state['error']['message'] == 'retry budget exhausted'


def test_terminal_receipt_supersedes_intermediate_error_but_failed_keeps_detail(tmp_path):
    service = CodexService(tmp_path, client_factory=lambda _: None)
    state = {'threadId': 'thread', 'codexTurnId': 'turn', 'error': {'message': 'earlier notification'}}
    run = {'state': state}
    assert service._consume(run, {'method': 'turn/completed', 'params': {'turn': {'id': 'turn', 'status': 'completed'}}})
    assert not state.get('error')
    state['error'] = {'message': 'specific provider failure'}
    assert service._consume(run, {'method': 'turn/completed', 'params': {'turn': {'id': 'turn', 'status': 'failed'}}})
    assert state['error']['message'] == 'specific provider failure'
