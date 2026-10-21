"""Capability guidance must name the real blocker, never an unchecked channel."""
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import office_controls as controls


class Gateway:
    server_version = '2026.9.6'
    methods = {'agent'}

    def close(self):
        pass


@pytest.fixture
def web(tmp_path, monkeypatch):
    state = tmp_path / 'state'
    state.mkdir()
    (state / 'openclaw.json').write_text(json.dumps({'models': {'providers': {'relay': {
        'apiKey': 'PRIVATE_KEY', 'baseUrl': 'https://PRIVATE_URL.invalid',
        'models': [{'id': 'model-a'}]}}}}), encoding='utf-8')
    seen = SimpleNamespace(session=None, probes=[])
    monkeypatch.setattr(controls, '_model_probe_client', lambda transport, credentials: Gateway())
    monkeypatch.setattr(controls, '_cli_override_version', lambda app: '2026.9.6')
    monkeypatch.setattr(controls, '_probe_http_override',
                        lambda app, session, credentials, ref: seen.probes.append(session))

    def resolve(session):
        seen.session = session
        return 'http'

    app = SimpleNamespace(openclaw_state_dir=lambda: state, _channel_labels=lambda: {},
                          _resolve_transport=resolve, gateway_credentials=lambda: object(),
                          chat_completions_url=lambda: 'http://127.0.0.1:1/v1',
                          _openclaw_session_id=lambda session: 'sid-' + session)
    return app, seen


def test_office_agent_identity_resolves_to_its_session(web):
    app, seen = web
    result = controls.turn_model_capability(app, 'root:chat-1')
    assert result['available'] and result['scope'] == 'next_turn'
    assert seen.session == 'chat-1' and seen.probes == ['chat-1']
    assert 'PRIVATE_' not in json.dumps(result)


def test_unrelated_colons_are_still_rejected(web):
    app, _ = web
    with pytest.raises(HTTPException) as raised:
        controls.turn_model_capability(app, 'chat:1')
    assert raised.value.status_code == 400


def test_closed_gateway_is_reported_as_gateway_not_channel(web, monkeypatch):
    app, seen = web
    monkeypatch.setattr(app, '_resolve_transport', lambda session: 'cli')
    monkeypatch.setattr(controls, '_model_probe_client',
                        lambda *_: (_ for _ in ()).throw(ConnectionRefusedError(10061, 'refused')))
    result = controls.turn_model_capability(app, 'chat-1')
    assert not result['available'] and result['scope'] == 'unavailable'
    assert '网关' in result['reason'] and '自动恢复' in result['reason']
    assert '未连' in result['reason'] and seen.probes == []


def test_offline_gateway_stops_capability_probe_with_plain_recovery_message(web, monkeypatch):
    app, seen = web
    monkeypatch.setattr(app, 'check_gateway', lambda: False, raising=False)
    result = controls.turn_model_capability(app, 'chat-1')
    assert result['available'] is False
    assert result['reason'] == 'OpenClaw 未连接，正在自动恢复。连接恢复后请重试。'
    assert seen.probes == []
