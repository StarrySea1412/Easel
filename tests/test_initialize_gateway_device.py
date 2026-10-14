"""Startup connects only its existing local device; it performs no approval RPC."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

import easel.gateway_auth as gateway_auth
import easel.gateway_endpoint as gateway_endpoint
import easel.gateway_questions as gateway_questions


_spec = importlib.util.spec_from_file_location(
    'initialize_gateway_device', Path(__file__).parents[1] / 'scripts/initialize_gateway_device.py')
helper = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(helper)


@pytest.mark.parametrize('host', ['127.0.0.1', 'localhost', '[::1]'])
@pytest.mark.parametrize('mode,expected_auth', [
    ('token', {'token': 'this-copy-token'}),
    ('password', {'password': 'this-copy-password'}),
    ('none', {'token': ''}),
])
def test_connect_uses_local_config_auth_and_no_rpc(monkeypatch, host, mode, expected_auth):
    monkeypatch.setattr(gateway_endpoint, 'gateway_host', lambda: host)
    monkeypatch.setattr(gateway_auth, 'resolve_credentials', lambda: SimpleNamespace(
        mode=mode, token='this-copy-token' if mode == 'token' else '',
        password='this-copy-password' if mode == 'password' else ''))
    events = []
    class Client:
        granted_scopes = ['operator.admin']
        def __init__(self, **kwargs):
            events.append(('init', kwargs))
        def connect(self):
            events.append(('connect',))
        def close(self):
            events.append(('close',))
        def rpc(self, *_args, **_kwargs):
            pytest.fail('startup must not approve devices or expand scopes')
    monkeypatch.setattr(gateway_questions, 'GatewayClient', Client)
    assert helper.initialize_device() is True
    assert events == [('init', {'timeout': 10, 'scopes': ['operator.admin'],
        'client_id': 'cli', 'client_mode': 'cli', 'auth': expected_auth}), ('connect',), ('close',)]


@pytest.mark.parametrize('host', ['remote.example', '192.168.1.138', '127.0.0.2'])
def test_remote_gateway_is_never_contacted(monkeypatch, host):
    monkeypatch.setattr(gateway_endpoint, 'gateway_host', lambda: host)
    monkeypatch.setattr(gateway_auth, 'resolve_credentials', lambda: pytest.fail('must not read remote credentials'))
    monkeypatch.setattr(gateway_questions, 'GatewayClient', lambda **_kw: pytest.fail('must not contact remote Gateway'))
    assert helper.initialize_device() is False


@pytest.mark.parametrize('failure', ['missing_scope', 'connect_error'])
def test_unapproved_or_failed_connect_returns_false_and_closes(monkeypatch, failure):
    monkeypatch.setattr(gateway_endpoint, 'gateway_host', lambda: '127.0.0.1')
    monkeypatch.setattr(gateway_auth, 'resolve_credentials', lambda: SimpleNamespace(mode='none', token='', password=''))
    events = []
    class Client:
        granted_scopes = ['operator.read']
        def __init__(self, **kwargs):
            pass
        def connect(self):
            events.append('connect')
            if failure == 'connect_error':
                raise RuntimeError('not_paired private-detail')
        def close(self):
            events.append('close')
        def rpc(self, *_args, **_kwargs):
            pytest.fail('startup must not approve devices')
    monkeypatch.setattr(gateway_questions, 'GatewayClient', Client)
    assert helper.initialize_device() is False
    assert events == ['connect', 'close']


def test_separate_startup_processes_read_only_their_own_device_state(tmp_path):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    root = Path(__file__).parents[1]
    for label in ('source', 'portable'):
        state = tmp_path / label
        identity = state / 'state/identity/device.json'
        identity.parent.mkdir(parents=True)
        key = Ed25519PrivateKey.generate()
        identity.write_text(json.dumps({
            'version': 1, 'deviceId': label + '-device',
            'privateKeyPem': key.private_bytes(serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode(),
            'publicKeyPem': key.public_key().public_bytes(serialization.Encoding.PEM,
                serialization.PublicFormat.SubjectPublicKeyInfo).decode(),
        }), encoding='utf-8')
        env = dict(os.environ, EASEL_OPENCLAW_STATE_DIR=str(state), OPENCLAW_STATE_DIR=str(state))
        result = subprocess.run([sys.executable, '-B', '-c',
            'import json; from easel import gateway_questions as g; '
            'print(json.dumps({"id":g._load_device()["device_id"],"path":str(g.DEVICE_IDENTITY_FILE)}))'],
            cwd=root, env=env, capture_output=True, text=True, encoding='utf-8', timeout=15)
        assert result.returncode == 0, result.stderr
        assert json.loads(result.stdout) == {'id': label + '-device', 'path': str(identity)}
