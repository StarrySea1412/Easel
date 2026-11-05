import asyncio
import json
from pathlib import Path

import pytest


def test_role_registry_is_bounded_and_returns_copies():
    from web.agent_roles import ROLE_SCHEMA_VERSION, get_role, list_roles, role_context

    roles = list_roles()
    assert ROLE_SCHEMA_VERSION == 1
    assert {row['id'] for row in roles} >= {'orchestrator', 'researcher', 'builder', 'reviewer'}
    roles[0]['name'] = 'tampered'
    assert get_role(roles[0]['id'])['name'] != 'tampered'
    assert role_context('reviewer').startswith('〔Easel 角色契约')
    assert role_context('missing') == ''


def test_run_ledger_persists_role_snapshot(tmp_path: Path):
    from web import run_ledger

    row = run_ledger.create(tmp_path, 'turn-role', session_id='session', session_key='agent:main:session',
                            model_ref='openai/test', role_id='reviewer')
    assert row['roleId'] == 'reviewer'
    saved = json.loads((tmp_path / 'runs' / 'turn-role.json').read_text(encoding='utf-8'))
    assert saved['roleId'] == 'reviewer'


def test_chat_request_injects_known_role_contract_and_rejects_unknown_role():
    from web import app

    message = app._chat_message(app.ChatRequest(message='核对本轮修复', roleId='reviewer'))
    assert '〔Easel 角色契约 · 本轮请求快照〕' in message
    assert '验收审查员' in message
    with pytest.raises(app.HTTPException) as exc:
        app._chat_message(app.ChatRequest(message='核对本轮修复', roleId='missing'))
    assert exc.value.status_code == 400


def test_agent_roles_endpoint_exposes_versioned_safe_copies():
    from web import app

    payload = asyncio.run(app.api_agent_roles())
    assert payload['schemaVersion'] == 1
    assert any(role['id'] == 'incident-responder' for role in payload['roles'])
