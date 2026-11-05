"""Question bridge uses the current chat credential without extra device scopes."""
import asyncio
import json
from types import SimpleNamespace

import pytest

import easel.gateway_auth as auth
import easel.gateway_questions as questions
import web.app as web


@pytest.mark.parametrize('mode,token,password,explicit,expected', [
    ('token', 'synthetic-token', '', None, {'token': 'synthetic-token'}),
    ('password', 'stale-token', 'synthetic-password', None, {'password': 'synthetic-password'}),
    ('none', '', '', None, {'token': 'legacy-device-token'}),
    ('token', 'synthetic-token', '', {'token': 'override'}, {'token': 'override'}),
    ('none', '', '', {}, {}),
])
def test_question_connect_authenticates_with_current_credentials(monkeypatch, mode, token, password, explicit, expected):
    sent, signed = [], []
    frames = iter([
        {'event': 'connect.challenge', 'payload': {'nonce': 'nonce', 'ts': 123}},
        {'id': '1', 'ok': True, 'payload': {'auth': {'scopes': ['operator.admin']}}},
    ])
    socket = SimpleNamespace(recv=lambda: json.dumps(next(frames)), send=lambda raw: sent.append(json.loads(raw)), close=lambda: None)
    monkeypatch.setattr(questions, '_load_device', lambda: {'device_id': 'device', 'token': 'legacy-device-token', 'public_key': 'public'})
    monkeypatch.setattr(questions, '_sign', lambda value: signed.append(value) or 'signature')
    monkeypatch.setattr(auth, 'resolve_credentials', lambda: auth.GatewayCredentials(mode, token, password))
    client = questions.GatewayClient(scopes=['operator.admin'], auth=explicit)
    monkeypatch.setattr(client._ws_lib, 'create_connection', lambda *args, **kwargs: socket)
    client.connect()
    payload = sent[0]['params']
    assert payload['auth'] == expected
    assert payload['scopes'] == ['operator.admin']
    assert signed[0].split('|')[7] == expected.get('token', '')
    assert len(sent) == 1  # No pairing, approval or configuration mutation.
    client.close()


def test_question_answer_and_status_forward_to_the_existing_admin_client(monkeypatch):
    calls = []
    class Client:
        def __init__(self, **kwargs): calls.append(('client', kwargs))
        def connect(self): calls.append(('connect',))
        def close(self): calls.append(('close',))
        def resolve(self, ident, answers, who):
            calls.append(('resolve', ident, answers, who)); return {'status': 'answered'}
        def get_question(self, ident): return {'status': 'answered'}
    monkeypatch.setattr(web, 'GatewayClient', Client)
    answer = asyncio.run(web.api_question_answer(web.QuestionAnswerRequest(questionId='test', answers={'style': ['blue']})))
    statuses = asyncio.run(web.api_question_status(web.QuestionStatusRequest(questionIds=['test'])))
    assert answer == {'ok': True, 'result': {'status': 'answered'}}
    assert statuses == {'ok': True, 'questions': {'test': {'status': 'answered'}}}
    assert ('resolve', 'test', {'style': ['blue']}, None) in calls
    assert [v for v in calls if v[0] == 'client'] == [('client', {'scopes': ['operator.admin']})] * 2
    assert calls.count(('close',)) == 2


def test_failed_answer_does_not_echo_gateway_secrets(monkeypatch):
    monkeypatch.setattr(auth, 'resolve_credentials', lambda: auth.GatewayCredentials('token', 'synthetic-private-token'))
    class Client:
        def __init__(self, **kwargs): pass
        def connect(self): raise RuntimeError('unauthorized synthetic-private-token')
        def close(self): pass
    monkeypatch.setattr(web, 'GatewayClient', Client)
    output = asyncio.run(web.api_question_answer(web.QuestionAnswerRequest(questionId='test', answers={})))
    assert output['ok'] is False and 'synthetic-private-token' not in output['error']
