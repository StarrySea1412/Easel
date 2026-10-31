"""Authenticated loopback identity and lifetime; never start the real CLI here."""
import json
import os
import queue

import pytest
import websocket

from easel import codex_runtime as module
from easel.codex_client import CodexError


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    info = {'version': '0.147.0', 'command': ['isolated-native-fixture']}
    monkeypatch.setattr(module, 'runtime_info', lambda: info)
    value = module.CodexRuntime(tmp_path / 'runtime')
    record = {'schema': 1, 'root': str(value.root), 'version': info['version'],
        'fingerprint': value._fingerprint(info), 'instance': 'a' * 32,
        'url': 'ws://127.0.0.1:4242', 'pid': os.getpid()}
    value.record_path.write_text(json.dumps(record), encoding='utf-8')
    value.token_path.write_text('isolated-capability-token-' + 'z' * 40, encoding='utf-8')
    return value, record, info


def test_two_observers_connect_to_same_instance_without_restarting_server(runtime, monkeypatch):
    value, record, _ = runtime
    calls = []
    monkeypatch.setattr(module, 'SocketClient', lambda current, token: calls.append(current['instance']) or current)
    monkeypatch.setattr(value, '_start', lambda _: pytest.fail('duplicate native server'))
    assert value.connect()['instance'] == record['instance']
    assert value.connect_original({'nativeRuntime': record['instance']})['instance'] == record['instance']
    assert calls == [record['instance']] * 2


@pytest.mark.parametrize('field,replacement', [
    ('url', 'ws://192.168.0.138:4242'), ('url', 'wss://127.0.0.1:4242'),
    ('url', 'ws://127.0.0.1:4242/other'), ('url', 'ws://user@127.0.0.1:4242'),
    ('url', 'ws://127.0.0.1:4242?token=secret'), ('pid', True),
    ('root', 'other-data'), ('fingerprint', 'foreign-binary'), ('version', '0.148.0')])
def test_foreign_manifest_never_connects_or_starts_replacement(runtime, monkeypatch, field, replacement):
    value, record, _ = runtime
    record[field] = replacement
    value.record_path.write_text(json.dumps(record), encoding='utf-8')
    monkeypatch.setattr(module, 'SocketClient', lambda *args: pytest.fail('foreign endpoint connected'))
    monkeypatch.setattr(value, '_start', lambda _: pytest.fail('foreign record overwritten'))
    with pytest.raises(CodexError): value.connect()


def test_original_instance_never_replaced_even_if_recorded_process_is_dead(runtime, monkeypatch):
    value, record, _ = runtime
    monkeypatch.setattr(module, 'SocketClient', lambda *args: (_ for _ in ()).throw(ConnectionRefusedError()))
    monkeypatch.setattr(value, '_alive', lambda _: False)
    monkeypatch.setattr(value, '_start', lambda _: pytest.fail('original turn moved to a new runtime'))
    with pytest.raises(CodexError): value.connect_original({'nativeRuntime': record['instance']})
    with pytest.raises(CodexError): value.connect_original({'nativeRuntime': 'b' * 32})


def test_connection_timeout_does_not_replace_a_live_process(runtime, monkeypatch):
    value, *_ = runtime
    monkeypatch.setattr(module, 'SocketClient', lambda *args: (_ for _ in ()).throw(websocket.WebSocketTimeoutException()))
    monkeypatch.setattr(value, '_alive', lambda _: True)
    monkeypatch.setattr(value, '_start', lambda _: pytest.fail('slow native process replaced'))
    with pytest.raises(CodexError): value.connect()


def test_only_failed_endpoint_and_absent_process_allow_new_runtime(runtime, monkeypatch):
    value, record, _ = runtime
    monkeypatch.setattr(module, 'SocketClient', lambda *args: (_ for _ in ()).throw(ConnectionRefusedError()))
    monkeypatch.setattr(value, '_alive', lambda _: False)
    monkeypatch.setattr(value, '_start', lambda _: 'newly-started')
    assert value.connect() == 'newly-started'
    assert json.loads((value.root / 'previous-runtime.json').read_text()) == record
    assert not value.token_path.exists()


def test_missing_manifest_with_remaining_secret_does_not_start_duplicate(runtime, monkeypatch):
    value, *_ = runtime
    value.record_path.unlink()
    monkeypatch.setattr(value, '_start', lambda _: pytest.fail('unknown live process duplicated'))
    with pytest.raises(CodexError): value.connect()


def test_socket_close_only_detaches_observer_and_preserves_authentication(runtime, monkeypatch):
    value, record, _ = runtime
    options = []
    class Socket:
        def __init__(self): self.messages = queue.Queue(); self.closed = False
        def settimeout(self, _): pass
        def send(self, raw):
            message = json.loads(raw)
            if message.get('method') == 'initialize':
                self.messages.put(json.dumps({'id': message['id'], 'result': {}}))
        def recv(self):
            try: return self.messages.get(timeout=.1)
            except queue.Empty: raise websocket.WebSocketTimeoutException()
        def close(self, **kwargs): self.closed = True
    sock = Socket()
    monkeypatch.setattr(module.websocket, 'create_connection', lambda *args, **kwargs: options.append(kwargs) or sock)
    client = value.connect()
    assert client.runtime_instance == record['instance'] and client.proc.poll() is None
    assert options[0]['suppress_origin'] is True
    assert options[0]['header'] == ['Authorization: Bearer ' + value.token_path.read_text()]
    client.close()
    assert sock.closed and client.proc.poll() == 1
    assert value.record_path.exists() and value.token_path.exists()


def test_os_process_check_reports_current_and_missing_pid_without_signalling(runtime):
    value, *_ = runtime
    assert value._alive(os.getpid()) is True
    assert value._alive(2147483647) is False
