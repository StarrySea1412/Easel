"""Local API contracts; no model or platform traffic is sent."""
import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import app as web
import skill_audit as audit


@pytest.fixture
def record(tmp_path, monkeypatch):
    monkeypatch.setattr(web, 'OUTPUTS_DIR', tmp_path)
    item = {'sessionId': 'chat-a', 'turnId': 'turn-a', 'started': 1,
            'status': 'completed', 'invocation': [], 'quality': {},
            '_request': 'private prompt', '_response': 'private response', '_specs': {}}
    audit.save(tmp_path / '_skill_audits', item)
    return item


def test_list_is_scoped_and_does_not_expose_private_snapshots(record):
    data = asyncio.run(web.api_skill_audits('chat-a'))
    assert len(data['records']) == 1
    assert not any(key.startswith('_') for key in data['records'][0])
    assert asyncio.run(web.api_skill_audits('chat-b')) == {'records': []}
    with pytest.raises(web.HTTPException) as error:
        asyncio.run(web.api_skill_audits('../chat-a'))
    assert error.value.status_code == 400


def test_review_persists_and_preserves_invocation(record, monkeypatch):
    provider = type('Provider', (), {'configured': True})()
    monkeypatch.setattr(web, '_image_reverse_providers', lambda: [provider])
    result = {'text': '具体问题与修改建议', 'model': 'test-model', 'at': 2}
    monkeypatch.setattr(audit, 'critique', lambda item, outputs, selected: result)
    assert asyncio.run(web.api_skill_critique(web.SkillCritiqueRequest(sessionId='chat-a', turnId='turn-a'))) == result
    stored = asyncio.run(web.api_skill_audits('chat-a'))['records'][0]
    assert stored['critique'] == result
    assert stored['invocation'] == record['invocation']


def test_review_missing_running_and_unconfigured(record, monkeypatch):
    monkeypatch.setattr(web, '_image_reverse_providers', lambda: [])
    request = web.SkillCritiqueRequest(sessionId='chat-a', turnId='turn-a')
    with pytest.raises(web.HTTPException) as error:
        asyncio.run(web.api_skill_critique(request))
    assert error.value.status_code == 503
    assert not web._SKILL_REVIEW_BUSY
    with pytest.raises(web.HTTPException) as error:
        asyncio.run(web.api_skill_critique(web.SkillCritiqueRequest(sessionId='chat-b', turnId='turn-a')))
    assert error.value.status_code == 404
    record['status'] = 'running'
    audit.save(web.OUTPUTS_DIR / '_skill_audits', record)
    with pytest.raises(web.HTTPException) as error:
        asyncio.run(web.api_skill_critique(request))
    assert error.value.status_code == 409
    assert not web._SKILL_REVIEW_BUSY


def test_review_failure_clears_busy_and_does_not_store_success(record, monkeypatch):
    monkeypatch.setattr(web, '_image_reverse_providers', lambda: [])
    def fail(*args):
        raise web.HTTPException(502, 'service unavailable')
    monkeypatch.setattr(audit, 'critique', fail)
    with pytest.raises(web.HTTPException):
        asyncio.run(web.api_skill_critique(web.SkillCritiqueRequest(sessionId='chat-a', turnId='turn-a')))
    assert not web._SKILL_REVIEW_BUSY
    assert 'critique' not in asyncio.run(web.api_skill_audits('chat-a'))['records'][0]
