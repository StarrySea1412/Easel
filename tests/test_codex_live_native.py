"""Opt-in audited CLI integration against a local synthetic Responses provider.

No account directory, external model, real platform or existing CLI is used.
Run with EASEL_TEST_NATIVE_CODEX=1; each fixture owns its original child handle.
"""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from easel.codex_client import CodexError
from easel.codex_runtime import CodexRuntime
from easel.codex_service import CodexService, Control, key

pytestmark = pytest.mark.skipif(os.environ.get('EASEL_TEST_NATIVE_CODEX') != '1',
    reason='Opt-in real audited Codex CLI with isolated local synthetic provider')

SID, TID = 'native-isolated', 'original-web-turn'
MODEL = {'id': 'codex/fixture', 'model': 'fixture', 'thinkingLevels': ['low'], 'defaultEffort': 'low'}


def _crash_owner(root, mode):
    root = Path(root)
    service = CodexService(root / 'outputs')
    service.bind(SID, 'codex')
    service.runtime = lambda: {'available': True, 'auth': 'local_provider',
        'options': [MODEL], 'defaultModelRef': MODEL['id']}
    # Keep the real on-request policy: an explicit require_escalated call must
    # produce a user approval. UnlessTrusted rejects that request before an
    # approval exists, so it cannot exercise pending-request recovery.

    def crash(run=None, event=None):
        state = service.snapshot(SID, TID)
        (root / 'owner-ready.json').write_text(json.dumps({'state': state, 'event': event}), encoding='utf-8')
        os._exit(73)

    if mode in ('tool', 'approval'):
        # Die with the real native server request pending, before Easel handles it.
        service._request = crash
    service.start(SimpleNamespace(sessionId=SID, turnId=TID, roleId=None,
        message='Isolated synthetic native test. No external service.', selectedSkills=[],
        skillRequirements={}, attachments=[], modelRef=MODEL['id'], thinkingLevel='low'))
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        state = service.snapshot(SID, TID)
        if mode not in ('tool', 'approval') and state.get('codexTurnId'):
            crash()
        time.sleep(.05)
    raise AssertionError('Original native identity or pending request was not observed')


class NativeHarness:
    def __init__(self, root, mode):
        self.root, self.mode = root, mode
        self.calls, self.services, self.gate = [], [], threading.Event()
        self.home = root / 'home'
        self.home.mkdir()
        harness = self

        class Provider(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                index = len(harness.calls)
                harness.calls.append(body)
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                if harness.mode not in ('tool', 'approval'):
                    harness.gate.wait(60)
                item = {'id': f'message_{index}', 'type': 'message', 'role': 'assistant',
                    'status': 'completed', 'content': [{'type': 'output_text',
                        'text': 'original isolated result', 'annotations': []}]}
                if index == 0 and harness.mode == 'tool':
                    item = {'id': 'function_fixture', 'type': 'function_call', 'call_id': 'call_fixture',
                        'name': 'easel_present', 'arguments': json.dumps({'files': [{'path': 'result.txt'}]})}
                elif index == 0 and harness.mode == 'approval':
                    names = {tool.get('name') for tool in body.get('tools', [])}
                    name = 'exec_command' if 'exec_command' in names else 'shell_command'
                    assert name in names, sorted(str(value) for value in names)
                    command = f'& \'{sys.executable}\' -c "print(\'ISOLATED_APPROVAL\')"'
                    args = {'cmd' if name == 'exec_command' else 'command': command,
                        'sandbox_permissions': 'require_escalated',
                        'justification': 'Isolated approval recovery test; reject this request.'}
                    item = {'id': 'function_approval', 'type': 'function_call', 'call_id': 'call_approval',
                        'name': name, 'arguments': json.dumps(args)}
                response = {'id': f'response_{index}', 'object': 'response', 'status': 'completed',
                    'output': [item], 'usage': {'input_tokens': 10, 'output_tokens': 2, 'total_tokens': 12}}
                events = [('response.created', {'type': 'response.created',
                    'response': {**response, 'status': 'in_progress', 'output': []}}),
                    ('response.output_item.done', {'type': 'response.output_item.done', 'output_index': 0, 'item': item}),
                    ('response.completed', {'type': 'response.completed', 'response': response})]
                try:
                    for name, value in events:
                        self.wfile.write((f'event: {name}\ndata: ' + json.dumps(value) + '\n\n').encode())
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.provider = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
        threading.Thread(target=self.provider.serve_forever, daemon=True).start()
        (self.home / 'config.toml').write_text('model="fixture"\nmodel_provider="fixture"\n'
            '[model_providers.fixture]\nname="fixture"\n'
            f'base_url="http://127.0.0.1:{self.provider.server_port}/v1"\nwire_api="responses"\n'
            'requires_openai_auth=false\n[analytics]\nenabled=false\n', encoding='utf-8')
        self.runtime = CodexRuntime(root / 'outputs/_codex/runtime')
        self.owner, self.log = None, (root / 'owner.log').open('w', encoding='utf-8')

    def crash(self):
        client = self.runtime.connect()
        self.instance, self.version = client.runtime_instance, client.version
        client.close()
        workspace = CodexService(self.root / 'outputs')
        target = workspace.outputs / 'codex' / key(SID)[:24]
        target.mkdir(parents=True, exist_ok=True)
        (target / 'result.txt').write_text('isolated generated artifact', encoding='utf-8')
        code = ('from tests.test_codex_live_native import _crash_owner; import sys; '
                '_crash_owner(sys.argv[1], sys.argv[2])')
        self.owner = subprocess.Popen([sys.executable, '-c', code, str(self.root), self.mode],
            cwd=Path(__file__).resolve().parents[1], env=os.environ.copy(), stdout=self.log, stderr=self.log,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        assert self.owner.wait(50) == 73, (self.root / 'owner.log').read_text(encoding='utf-8', errors='replace')
        self.original = json.loads((self.root / 'owner-ready.json').read_text(encoding='utf-8'))
        assert self.runtime.process.poll() is None
        assert self.original['state']['nativeRuntime'] == self.instance
        return self.original['state']

    def observer(self):
        value = CodexService(self.root / 'outputs')
        self.services.append(value)
        return value

    def finish(self, service, outcome='completed'):
        deadline = time.monotonic() + 30
        while service.active and time.monotonic() < deadline:
            time.sleep(.05)
        assert not service.active
        result = service.snapshot(SID, TID)
        assert result['outcome'] == outcome, result
        assert result['nativeRuntime'] == self.instance
        assert result['threadId'] == self.original['state']['threadId']
        assert result['codexTurnId'] == self.original['state']['codexTurnId']
        return result

    def close(self):
        self.gate.set()
        for service in self.services:
            service.close()
        for service in self.services:
            deadline = time.monotonic() + 5
            while service.active and time.monotonic() < deadline:
                time.sleep(.05)
        for child in (self.owner, self.runtime.process):
            if child and child.poll() is None:
                child.terminate()
                child.wait(10)
        self.log.close()
        self.provider.shutdown()
        self.provider.server_close()


@pytest.fixture
def native(tmp_path, monkeypatch, request):
    mode = getattr(request, 'param', 'text')
    harness = NativeHarness(tmp_path, mode)
    monkeypatch.setenv('EASEL_CODEX_HOME', str(harness.home))
    try:
        yield harness
    finally:
        harness.close()


def test_native_owner_crash_recovers_same_running_turn_without_second_model_request(native):
    original = native.crash()
    service = native.observer()
    prefix = service._event_path(SID, TID).read_bytes()
    state = service.reconcile(SID, TID)
    assert state['status'] == 'running'
    assert state['threadId'] == original['threadId']
    native.gate.set()
    result = native.finish(service)
    assert result['text'] == 'original isolated result'
    assert service._event_path(SID, TID).read_bytes().startswith(prefix)
    assert len(native.calls) == 1


def test_native_reattached_stop_interrupts_only_original_turn(native):
    native.crash()
    service = native.observer()
    service.reconcile(SID, TID)
    assert service.stop(SID, 'foreign-turn') == {'stopped': False}
    assert service.stop(SID, TID) == {'stopped': True}
    result = native.finish(service, 'interrupted')
    assert result['stopped'] is True
    assert len(native.calls) == 1


def test_native_reattached_steer_is_deduplicated_and_stays_on_original_turn(native):
    native.crash()
    service = native.observer()
    service.reconcile(SID, TID)
    req = Control(sessionId=SID, turnId=TID, requestId='native-steer-once',
        modelRef=MODEL['id'], thinkingLevel='low', message='ISOLATED_STEER_ADDITION')
    assert service.steer(req)['turnId'] == native.original['state']['codexTurnId']
    assert service.steer(req)['ok']
    native.gate.set()
    result = native.finish(service)
    assert result['steering'] == {'native-steer-once': 'accepted'}
    assert sum('ISOLATED_STEER_ADDITION' in json.dumps(body.get('input', [])) for body in native.calls) == 1


@pytest.mark.parametrize('native', ['approval'], indirect=True)
def test_native_pending_approval_survives_owner_exit_and_requires_explicit_answer(native):
    native.crash()
    assert native.original['event']['method'] == 'item/commandExecution/requestApproval'
    service = native.observer()
    service.reconcile(SID, TID)
    deadline = time.monotonic() + 15
    while not service.snapshot(SID, TID)['pending'] and time.monotonic() < deadline:
        time.sleep(.05)
    state = service.snapshot(SID, TID)
    assert len(state['pending']) == 1 and len(native.calls) == 1
    request = state['pending'][0]
    assert service.answer(Control(sessionId=SID, turnId=TID, requestId=request['requestId'], decision='decline'))['ok']
    native.finish(service)
    assert len(native.calls) == 2


@pytest.mark.parametrize('native', ['tool'], indirect=True)
def test_native_tool_reply_lost_after_durable_receipt_does_not_repeat_effect(native, monkeypatch):
    native.crash()
    assert native.original['event']['method'] == 'item/tool/call'
    service = native.observer()
    calls = []
    present = service._present_files
    def deliver_once(*args):
        calls.append(copy.deepcopy(args[1]))
        return present(*args)
    monkeypatch.setattr(service, '_present_files', deliver_once)
    from easel.codex_runtime import SocketClient
    original_reply = SocketClient.reply
    def lose_reply(client, ident, result):
        client.close()
        raise CodexError('isolated connection loss after durable tool receipt')
    with monkeypatch.context() as context:
        context.setattr(SocketClient, 'reply', lose_reply)
        service.reconcile(SID, TID)
        original = native.finish(service, 'unconfirmed')
    assert len(calls) == 1 and len(native.calls) == 1
    assert list(original['nativeRequests'].values())[0]['status'] == 'replied'
    restored = native.observer()
    monkeypatch.setattr(restored, '_present_files', lambda *args: pytest.fail('native side effect replayed'))
    restored.reconcile(SID, TID)
    result = native.finish(restored)
    assert len(native.calls) == 2 and result['text'] == 'original isolated result'
    assert SocketClient.reply is original_reply
