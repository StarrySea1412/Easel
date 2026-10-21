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


def test_goal_turn_keeps_its_delegation_guard_and_uses_goal_progress(tmp_path, monkeypatch):
    from easel.task_store import TaskStore
    monkeypatch.setattr(web, 'OUTPUTS_DIR', tmp_path)
    monkeypatch.setattr(web, '_agent_runtime_config', lambda: {'ready':True,'maxSpawnDepth':1})
    store = TaskStore(tmp_path)
    goal = store.create_goal({'objective':'核验进度策略','criteria':[{'type':'review','label':'核验','value':''}],
        'modelRef':'fixture/model','maxIterations':2,'maxSeconds':120,'maxTools':5,'maxImages':0},session='policy-session')
    store.change_goal(goal['id'], 'start')
    _, run = store.claim('worker')
    request = web.ChatRequest(message='不需要调用模型', sessionId='policy-session', turnId=run['turnId'])
    runtime = web._chat_agent_runtime(request)
    assert runtime['ready'] is False and runtime['goalManaged'] is True
    assert 'easel_goal_update' in runtime['reason']
    assert 'goalManaged' not in web._chat_agent_runtime(request.model_copy(update={'turnId':'another'}))
    assert 'goalManaged' not in web._chat_agent_runtime(request.model_copy(update={'sessionId':'foreign'}))


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


def test_multiagent_defaults_on_with_the_main_model(tmp_path, monkeypatch):
    state = tmp_path / 'state'
    state.mkdir()
    config = state / 'openclaw.json'
    config.write_text(json.dumps({'agents': {'defaults': {'model': {'primary': 'cheap/fast'}}}, 'tools': {}}), encoding='utf-8')
    monkeypatch.setattr(web, 'openclaw_state_dir', lambda: state)
    monkeypatch.setattr('office_controls.configured_models', lambda path: [
        {'id': 'cheap/fast', 'provider': 'cheap', 'model': 'fast', 'label': 'cheap · fast', 'configured': True},
    ])
    # Before the guard runs, the card already preselects the main model.
    value = web._agent_runtime_config()
    assert value['defaulted'] is True
    assert value['suggestedModel'] == 'cheap/fast'
    assert value['startupModel'] == 'cheap/fast'
    assert value['enabled'] is False and value['guard'] == 'strict_model_and_spawn_deny'
    assert '主模型' in (value['reason'] or '')
    web._sync_agent_safety_guard()
    data = json.loads(config.read_text(encoding='utf-8'))
    assert data['agents']['defaults']['subagents']['model'] == 'cheap/fast'
    assert 'sessions_spawn' not in data.get('tools', {}).get('deny', [])
    value = web._agent_runtime_config()
    assert value['enabled'] is True and value['ready'] is True and value['defaulted'] is False


def test_explicit_subagent_choice_is_never_overridden_by_the_default(tmp_path, monkeypatch):
    state = tmp_path / 'state'
    state.mkdir()
    config = state / 'openclaw.json'
    config.write_text(json.dumps({'agents': {'defaults': {'model': {'primary': 'cheap/fast'},
        'subagents': {'maxConcurrent': 2}}}, 'tools': {'deny': ['sessions_spawn']}}), encoding='utf-8')
    monkeypatch.setattr(web, 'openclaw_state_dir', lambda: state)
    monkeypatch.setattr('office_controls.configured_models', lambda path: [
        {'id': 'cheap/fast', 'provider': 'cheap', 'model': 'fast', 'label': 'cheap · fast', 'configured': True},
    ])
    web._sync_agent_safety_guard()
    data = json.loads(config.read_text(encoding='utf-8'))
    assert 'model' not in data['agents']['defaults']['subagents'], 'an explicit disable keeps spawn blocked'
    assert 'sessions_spawn' in data['tools']['deny']
    value = web._agent_runtime_config()
    assert value['defaulted'] is False and value['enabled'] is False and value['suggestedModel'] is None
