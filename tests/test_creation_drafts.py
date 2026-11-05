"""Offline preparation and adapter tests. Never calls a provider or platform."""
import json
from copy import deepcopy
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from easel.artifact_api import router
from easel.creation_drafts import CreationDrafts, PREPARE_TOOL
from easel.codex_service import CodexService
from easel.publish_receipts import ReceiptStore


def test_preparation_is_idempotent_scoped_persistent_and_not_publication(tmp_path):
    store = CreationDrafts(tmp_path)
    payload = {'requestId': 'draft-1', 'title': '标题', 'body': '实际正文', 'platforms': ['zhihu']}
    first = store.prepare('chat-a', 'turn-a', payload)
    assert store.prepare('chat-a', 'turn-b', payload) == first
    assert CreationDrafts(tmp_path).list('chat-a') == [first]
    assert store.list('chat-b') == []
    assert first['state'] == 'prepared' and 'receiptId' not in first
    with pytest.raises(ValueError, match='requestId'):
        store.prepare('chat-a', 'turn-b', {**payload, 'body': '不同正文'})
    assert store.prepare('chat-b', 'turn-a', payload)['id'] != first['id']


@pytest.mark.parametrize('extra', [
    {'body': ''}, {'body': 3}, {'platforms': ['unknown']}, {'media': ['../outside.png']},
    {'media': ['https://example.com/a.png']}, {'media': ['missing.png']},
    {'requestId': '../../unsafe'}, {'publish': True},
])
def test_invalid_preparation_has_no_saved_draft(tmp_path, extra):
    store = CreationDrafts(tmp_path)
    with pytest.raises((ValueError, OSError)):
        store.prepare('chat', 'turn', {'requestId': 'draft', 'body': '文字', **extra})
    assert store.list('chat') == []


def test_media_must_exist_and_cannot_be_private_registry(tmp_path):
    (tmp_path / 'cover.png').write_bytes(b'controlled fixture')
    store = CreationDrafts(tmp_path)
    draft = store.prepare('chat', 'turn', {'requestId': 'image', 'body': '内容', 'media': ['cover.png']})
    assert draft['draft']['media'] == ['cover.png']
    private = tmp_path / '_artifacts' / 'secret.png'
    private.write_bytes(b'private')
    with pytest.raises(ValueError):
        store.prepare('chat', 'turn', {'requestId': 'private', 'body': '内容', 'media': ['_artifacts/secret.png']})


def test_artifact_snapshot_contains_only_current_chat_drafts(tmp_path):
    store = CreationDrafts(tmp_path)
    store.prepare('current', 'turn', {'requestId': 'one', 'body': '当前'})
    store.prepare('other', 'turn', {'requestId': 'two', 'body': '其他'})
    app = FastAPI()
    app.include_router(router(lambda: tmp_path))
    with TestClient(app) as client:
        result = client.get('/api/chat/artifacts/current')
    assert result.status_code == 200
    assert [item['draft']['body'] for item in result.json()['creationDrafts']] == ['当前']


def test_codex_tool_prepares_without_publishing(tmp_path, monkeypatch):
    service = CodexService(tmp_path)
    replies = []
    events = []
    monkeypatch.setattr(service, '_event', lambda *args: events.append(args))
    run = {'client': SimpleNamespace(reply=lambda ident, result: replies.append(result)),
           'state': {'sessionId': 'bound', 'turn_id': 'turn'}}
    service._request(run, {'id': 1, 'method': 'item/tool/call', 'params': {
        'tool': PREPARE_TOOL['name'], 'arguments': {'requestId': 'one', 'body': '待审核'}}})
    assert replies[0]['success']
    result = json.loads(replies[0]['contentItems'][0]['text'])
    assert result['requiresUserConfirmation'] is True
    assert result['draft']['sessionId'] == 'bound'
    assert result['draft']['state'] == 'prepared'
    assert events and not (tmp_path / '_publish').exists()


def test_publish_receipt_keeps_immutable_origin(tmp_path):
    store = ReceiptStore(tmp_path / 'receipts.json')
    first = store.create('a' * 32, 'zhihu', '标题', source_session='chat-a')
    assert first['sourceSessionId'] == 'chat-a'
    result = store.update(first['receiptId'], {'sourceSessionId': 'other', 'outcome': 'draft'})
    assert result['sourceSessionId'] == 'chat-a'
    assert ReceiptStore(tmp_path / 'receipts.json').get(first['receiptId'])['sourceSessionId'] == 'chat-a'


def legacy_text_fixture(store):
    item = store.prepare('chat', 'turn', {'requestId': 'legacy', 'title': '旧文字稿',
                                        'body': '必须保留的原文', 'platforms': ['zhihu']})
    for field in ('schemaVersion', 'mediaVersions', 'analysis'):
        item.pop(field)
    with store.db() as db:
        db.execute('UPDATE drafts SET data=? WHERE id=?', (json.dumps(item), item['id']))
    return item


def test_legacy_text_load_is_scoped_read_only_and_still_requires_sealed_acceptance(tmp_path):
    store = CreationDrafts(tmp_path)
    original = legacy_text_fixture(store)
    checked = store.checked('chat', original['id'])
    assert checked['legacyTextOnly'] is True and checked['schemaVersion'] == 2
    assert checked['id'] == original['id'] and checked['draft'] == original['draft']
    assert store.list('chat') == [original], 'Reading must not rewrite the old record'
    with pytest.raises(LookupError):
        store.checked('other', original['id'])
    payload = {'title': original['draft']['title'], 'body': original['draft']['body'],
               'tags': '', 'media': [], 'persona': ''}
    acceptance = store.accept('chat', original['id'], 'confirm', 'zhihu', payload, 'account-a')
    provenance, sealed = store.verify_acceptance('chat', acceptance['id'], 'zhihu', payload, 'account-a')
    assert sealed == [] and provenance['preparationId'] == original['id']
    with pytest.raises(ValueError, match='账号'):
        store.verify_acceptance('chat', acceptance['id'], 'zhihu', payload, 'account-b')
    assert store.list('chat') == [original]


@pytest.mark.parametrize('changes', [
    {'schemaVersion': 3}, {'schemaVersion': True}, {'sessionId': 'other'}, {'turnId': '../outside'},
    {'analysis': {'bindingId': 'old'}}, {'mediaVersions': [{'sha256': 'unknown'}]},
    {'draft': {'media': ['cover.png']}}, {'draft': {'body': 1}},
    {'draft': {'platforms': ['unknown']}}, {'draft': {'overrides': {'zhihu': 'unversioned'}}},
])
def test_legacy_media_analysis_and_invalid_records_still_refuse_load(tmp_path, changes):
    store = CreationDrafts(tmp_path)
    original = legacy_text_fixture(store)
    value = deepcopy(original)
    for key, change in changes.items():
        if key == 'draft':
            value[key].update(change)
        else:
            value[key] = change
    with store.db() as db:
        db.execute('UPDATE drafts SET data=? WHERE id=?', (json.dumps(value), original['id']))
    with pytest.raises(ValueError, match='旧草稿'):
        store.checked('chat', original['id'])
    assert store.list('chat') == [value]
