"""Ordinary creation lifecycle on labelled local fixtures; no model/platform calls."""
import ast
import asyncio
import hashlib
import json
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import sys

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import BaseModel
import pytest

from easel.artifact_api import router
from easel.creation_drafts import CreationDrafts
from easel.publish_receipts import ReceiptStore
from easel.task_store import TaskStore


def prepared(root, **extra):
    (root / 'cover.png').write_bytes(b'isolated synthetic media version one')
    store = CreationDrafts(root)
    item = store.prepare('chat', 'writing-turn', {'requestId': 'first', 'title': '隔离样例',
        'body': '合成稿件，不代表真实模型结果', 'media': ['cover.png'], **extra})
    payload = {key: item['draft'][key] for key in ('title', 'body', 'tags', 'media')}
    return store, item, {**payload, 'persona': '隔离画像'}


def test_pins_media_and_seals_edited_payload_across_restart(tmp_path):
    store, item, payload = prepared(tmp_path)
    payload['body'] = '人工修改后的合成正文'
    accepted = store.accept('chat', item['id'], 'confirm-one', 'zhihu', payload, 'account-revision')
    restored = CreationDrafts(tmp_path)
    assert restored.accept('chat', item['id'], 'confirm-one', 'zhihu', payload, 'account-revision') == accepted
    metadata, paths = restored.verify_acceptance('chat', accepted['id'], 'zhihu', payload, 'account-revision')
    assert metadata['edited'] and metadata['sourceTurnId'] == 'writing-turn'
    assert metadata['persona'] == '隔离画像' and metadata['analysis'] is None
    assert 'body' not in metadata
    assert paths[0] != tmp_path / 'cover.png'
    assert hashlib.sha256(paths[0].read_bytes()).hexdigest() == metadata['mediaVersions'][0]['sha256']
    assert not (tmp_path / '_publish').exists()


def test_material_change_blocks_loading_and_submission_without_changing_records(tmp_path):
    store, item, payload = prepared(tmp_path)
    accepted = store.accept('chat', item['id'], 'confirm-one', 'zhihu', payload)
    _, copies = store.verify_acceptance('chat', accepted['id'], 'zhihu', payload)
    original = copies[0].read_bytes()
    (tmp_path / 'cover.png').write_bytes(b'new ordinary media version')
    with pytest.raises(ValueError, match='素材已变化'):
        store.checked('chat', item['id'])
    with pytest.raises(ValueError, match='素材已变化'):
        store.verify_acceptance('chat', accepted['id'], 'zhihu', payload)
    assert store.list('chat')[0] == item and copies[0].read_bytes() == original


def test_additional_editor_media_is_sealed_and_checked(tmp_path):
    store, item, payload = prepared(tmp_path)
    (tmp_path / 'extra.png').write_bytes(b'isolated second image')
    payload['media'].append('extra.png')
    accepted = store.accept('chat', item['id'], 'confirm', 'zhihu', payload)
    metadata, paths = store.verify_acceptance('chat', accepted['id'], 'zhihu', payload)
    assert len(paths) == 2 and metadata['edited']
    (tmp_path / 'extra.png').write_bytes(b'changed second image')
    with pytest.raises(ValueError, match='确认稿素材已变化'):
        store.verify_acceptance('chat', accepted['id'], 'zhihu', payload)


@pytest.mark.parametrize('field,value', [('body', '后来编辑'), ('persona', '另一个画像')])
def test_later_editor_changes_require_another_confirmation(tmp_path, field, value):
    store, item, payload = prepared(tmp_path)
    accepted = store.accept('chat', item['id'], 'confirm', 'zhihu', payload, 'account-a')
    changed = {**payload, field: value}
    with pytest.raises(ValueError, match='重新确认'):
        store.verify_acceptance('chat', accepted['id'], 'zhihu', changed, 'account-a')
    with pytest.raises(ValueError, match='其他内容'):
        store.accept('chat', item['id'], 'confirm', 'zhihu', changed, 'account-a')
    with pytest.raises(ValueError, match='账号已变化'):
        store.verify_acceptance('chat', accepted['id'], 'zhihu', payload, 'account-b')


def test_deleted_source_stops_further_handoffs_and_keeps_history(tmp_path):
    store, item, payload = prepared(tmp_path)
    accepted = store.accept('chat', item['id'], 'confirm', 'zhihu', payload)
    TaskStore(tmp_path).delete_session('chat')
    for action in (lambda: store.checked('chat', item['id']),
                   lambda: store.accept('chat', item['id'], 'again', 'zhihu', payload),
                   lambda: store.verify_acceptance('chat', accepted['id'], 'zhihu', payload)):
        with pytest.raises(ValueError, match='删除'):
            action()
    assert store.list('chat')[0] == item and (tmp_path / 'cover.png').is_file()


@pytest.mark.parametrize('change', ['result', 'materials'])
def test_saved_analysis_account_and_result_version_are_bound(tmp_path, change):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
    from content_analysis import Store
    from analysis_conversations import AnalysisConversations
    material = Store(tmp_path / '_analytics/workbench')
    material.ingest({'platform': 'douyin', 'accountId': 'synthetic-account', 'contents': [
        {'id': 'one', 'body': '隔离合成的作品材料'}]})
    service = AnalysisConversations(material)
    binding = service.prepare({'platform': 'douyin', 'accountId': 'synthetic-account', 'sessionId': 'chat'})
    service.save_result(binding['id'], {'sessionId': 'chat', 'turnId': 'analysis-turn', 'markdown': '隔离合成分析结论引用作品one，尚未经过真实业务验证，不能据此判断内容效果。'})
    (tmp_path / '_sessions').mkdir()
    (tmp_path / '_sessions/web_chat.json').write_text('{}')
    store, item, payload = prepared(tmp_path, analysisBindingId=binding['id'])
    assert item['analysis']['accountId'] == 'synthetic-account'
    assert item['analysis']['turnId'] == 'analysis-turn' and 'markdown' not in item['analysis']
    accepted = store.accept('chat', item['id'], 'confirm', 'zhihu', payload)
    if change == 'result':
        service.save_result(binding['id'], {'sessionId': 'chat', 'turnId': 'analysis-turn-two', 'markdown': '重新回填的隔离合成分析，引用作品one，与上一版不同，需重新核对稿件。'})
    else:
        material.ingest({'platform': 'douyin', 'accountId': 'synthetic-account', 'contents': [{'id': 'one', 'body': '更新后的合成作品材料'}]})
    with pytest.raises(ValueError, match='分析.*变化|分析材料已改变'):
        store.verify_acceptance('chat', accepted['id'], 'zhihu', payload)


def test_concurrent_acceptance_keeps_one_durable_confirmation(tmp_path):
    store, item, payload = prepared(tmp_path)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: CreationDrafts(tmp_path).accept('chat', item['id'], 'same-confirmation', 'zhihu', payload), range(4)))
    assert all(value == results[0] for value in results)
    with store.db() as db:
        assert db.execute('SELECT count(*) FROM acceptances').fetchone()[0] == 1


def test_unversioned_assistant_draft_remains_readable_but_needs_preparation(tmp_path):
    store, item, _ = prepared(tmp_path)
    item.pop('schemaVersion')
    with store.db() as db:
        db.execute('UPDATE drafts SET data=? WHERE id=?', (json.dumps(item), item['id']))
    assert store.list('chat')[0]['draft']['body']
    with pytest.raises(ValueError, match='旧草稿'):
        store.checked('chat', item['id'])


def test_http_checks_before_loading_and_acceptance_is_idempotent(tmp_path):
    store, item, payload = prepared(tmp_path)
    app = FastAPI(); app.include_router(router(lambda: tmp_path))
    url = f'/api/chat/artifacts/chat/drafts/{item["id"]}'
    with TestClient(app) as client:
        assert client.get(url).json() == item
        body = {'requestId': 'confirm', 'platform': 'zhihu', 'payload': payload}
        one = client.post(url + '/accept', json=body)
        assert one.status_code == 200
        assert client.post(url + '/accept', json=body).json() == one.json()
        (tmp_path / 'cover.png').write_bytes(b'updated fixture')
        assert client.get(url).status_code == 409
        assert client.post(url + '/accept', json={**body, 'requestId': 'again'}).status_code == 409


def test_receipt_retains_immutable_provenance_and_prevents_duplicate_acceptance(tmp_path):
    store, item, payload = prepared(tmp_path)
    accepted = store.accept('chat', item['id'], 'confirm', 'zhihu', payload)
    provenance, _ = store.verify_acceptance('chat', accepted['id'], 'zhihu', payload)
    receipts = ReceiptStore(tmp_path / 'receipts.json')
    first = receipts.create('a' * 32, 'zhihu', '隔离样例', source_session='chat', preparation=provenance)
    assert receipts.update(first['receiptId'], {'preparation': {}, 'outcome': 'draft'})['preparation'] == provenance
    assert ReceiptStore(receipts.path).get(first['receiptId'])['preparation'] == provenance
    with pytest.raises(ValueError, match='已有回执'):
        receipts.create('b' * 32, 'zhihu', '相同确认稿', source_session='chat', preparation=provenance)


def test_publish_endpoint_uses_confirmed_media_copy_before_receipt_creation(tmp_path):
    # Compile only this ordinary route; a sentinel stops before any platform code.
    source = Path(__file__).resolve().parents[1] / 'web/app.py'
    tree = ast.parse(source.read_text(encoding='utf-8-sig'))
    nodes = [node for node in tree.body if isinstance(node, (ast.ClassDef, ast.AsyncFunctionDef)) and node.name in {'PublishRequest', 'api_publish'}]
    for node in nodes: node.decorator_list = []
    store, item, payload = prepared(tmp_path)
    accepted = store.accept('chat', item['id'], 'confirm', 'zhihu', payload, 'local-account-version')
    class BeforePlatform(Exception): pass
    captured = []
    def begin(*args):
        captured.append(args)
        raise BeforePlatform()
    namespace = {'BaseModel': BaseModel, 'HTTPException': HTTPException,
        're': __import__('re'), 'LOGIN_RUNNERS': {'zhihu': {'backend': 'fixture', 'name': '知乎'}},
        '_require_automated_publishing': lambda: None, 'valid_persona_name': lambda _: True,
        'profile_exists': lambda _: True, 'OUTPUTS_DIR': tmp_path, '_account_identity_key': lambda _: 'local-account-version',
        'VIDEO_EXTS': {'.mp4'}, 'IMAGE_EXTS': {'.png'}, 'MEDIA_REQUIRED': set(), 'VIDEO_ONLY_PUBLISH': set(),
        '_begin_publish': begin, 'sys': sys}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(source), 'exec'), namespace)
    request = namespace['PublishRequest'](**payload, sourceSessionId='chat', acceptanceId=accepted['id'])
    with pytest.raises(BeforePlatform): asyncio.run(namespace['api_publish']('zhihu', request))
    assert captured[0][3]['acceptanceId'] == accepted['id']
    request.body = '后来修改，须重新确认'
    with pytest.raises(HTTPException) as error: asyncio.run(namespace['api_publish']('zhihu', request))
    assert error.value.status_code == 409 and len(captured) == 1
