import json
import sys
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import app as web


def test_agent_runtime_is_closed_when_no_startup_model(tmp_path, monkeypatch):
    state = tmp_path / 'state'
    state.mkdir()
    config = state / 'openclaw.json'
    config.write_text(json.dumps({'agents': {'defaults': {}}, 'tools': {}}), encoding='utf-8')
    monkeypatch.setattr(web, 'openclaw_state_dir', lambda: state)
    monkeypatch.setattr('office_controls.configured_models', lambda path: [
        {'id': 'cheap/fast', 'provider': 'cheap', 'model': 'fast', 'label': 'cheap · fast', 'configured': True},
    ])
    value = web._agent_runtime_config()
    assert value['ready'] is False
    assert value['startupModel'] is None
    assert value['guard'] == 'strict_model_and_spawn_deny'


def test_agent_runtime_save_requires_exact_model_and_denies_spawn_when_disabled(tmp_path, monkeypatch):
    state = tmp_path / 'state'
    state.mkdir()
    config = state / 'openclaw.json'
    config.write_text(json.dumps({'agents': {'defaults': {}}, 'tools': {}}), encoding='utf-8')
    monkeypatch.setattr(web, 'openclaw_state_dir', lambda: state)
    monkeypatch.setattr('office_controls.configured_models', lambda path: [
        {'id': 'cheap/fast', 'provider': 'cheap', 'model': 'fast', 'label': 'cheap · fast', 'configured': True},
    ])
    client = TestClient(web.app, base_url='http://127.0.0.1:7860', client=('127.0.0.1', 51234))
    bad = client.post('/api/settings/agent-runtime', json={'enabled': True, 'startupModel': 'expensive/unknown'})
    assert bad.status_code == 400
    saved = client.post('/api/settings/agent-runtime', json={
        'enabled': False, 'startupModel': None, 'maxConcurrent': 2,
        'maxChildrenPerAgent': 2, 'maxSpawnDepth': 1, 'runTimeoutSeconds': 600,
    })
    assert saved.status_code == 200
    data = json.loads(config.read_text(encoding='utf-8'))
    assert 'model' not in data['agents']['defaults']['subagents']
    assert 'sessions_spawn' in data['tools']['deny']

    enabled = client.post('/api/settings/agent-runtime', json={
        'enabled': True, 'startupModel': 'cheap/fast', 'maxConcurrent': 2,
        'maxChildrenPerAgent': 2, 'maxSpawnDepth': 1, 'runTimeoutSeconds': 600,
    })
    assert enabled.status_code == 200
    data = json.loads(config.read_text(encoding='utf-8'))
    assert data['agents']['defaults']['subagents']['model'] == 'cheap/fast'
    assert 'sessions_spawn' not in data['tools']['deny']
