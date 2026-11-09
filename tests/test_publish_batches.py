"""Same-account multi-platform publish batches.

Everything runs against temporary state with controlled doubles: no browser,
no platform login, no real submission and no SMTP. A mocked runner finalizes
receipts exactly like a real one, so the batch ledger is exercised end to end.
"""
import asyncio
import importlib.util
import json
from pathlib import Path
import threading
import time

import pytest

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location(
    '_publish_batch_lifecycle_fixture', ROOT / 'tests/test_account_lifecycle.py')
_fixture = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_fixture)
isolated, web = _fixture.isolated, _fixture.web

from easel import publish_batches as pb


def make_store():
    return pb.BatchStore(web.PUBLISH_DIR / 'batches.json')


def fake_runner(outcomes: dict):
    """Finalize receipts like the real worker would, from a versioned marker."""
    def run(platform, cmd, title, body, cfg, status_file, code_file, receipt_id, timeout=600):
        outcome = outcomes.get(platform, 'draft')
        stdout = 'EASEL_PUBLISH_RECEIPT=' + json.dumps({
            'schemaVersion': 1, 'receiptId': receipt_id, 'platform': platform,
            'outcome': outcome, 'message': '模拟回执'})
        receipt = web._finish_publish(platform, receipt_id, title, body, cfg, stdout, 0)
        web._release_publish(platform, receipt_id)  # the real worker releases in finally
        return receipt
    return run


def wait_batch(batch_id: str, timeout: float = 8.0) -> dict:
    store = make_store()
    deadline = time.time() + timeout
    while time.time() < deadline:
        batch = store.get(batch_id)
        if batch and batch['state'] != pb.BATCH_RUNNING:
            return batch
        time.sleep(0.05)
    raise AssertionError('batch did not settle in time')


@pytest.fixture
def batch_env(isolated, monkeypatch):
    """Two logged-in platforms plus one rejected-by-login platform."""
    for platform in ('xiaohongshu', 'zhihu'):
        (web.LOGIN_DIR / f'{platform}.json').write_text(
            json.dumps({'state': 'success', 'ts': int(time.time())}), encoding='utf-8')
    web.OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
    (web.OUTPUTS_DIR / 'batch-cover.png').write_bytes(b'\x89PNG\r\n\x1a\n')
    monkeypatch.setattr(web, '_account_logged_in',
                        lambda platform, cfg: platform in {'xiaohongshu', 'zhihu'})
    outcomes = {'xiaohongshu': 'draft', 'zhihu': 'failed'}
    monkeypatch.setattr(web, '_run_publish_job', fake_runner(outcomes))
    return isolated


def item(platform, title='同一篇内容', body='正文内容', media=None, tags='#测试'):
    return web.PublishBatchItem(platform=platform, title=title, body=body,
                                media=list(media if media is not None else ['batch-cover.png']),
                                tags=tags)


def submit(requests):
    return asyncio.run(web.api_publish_batch(web.PublishBatchRequest(requests=requests)))


def test_batch_keeps_source_and_confirmed_preparation_on_each_receipt(batch_env, monkeypatch):
    preparation = {'acceptanceId': 'f' * 32, 'preparationId': 'e' * 32}
    original = web._check_publish_request

    def checked(platform, cfg, request, **kwargs):
        images, videos, _ = original(platform, cfg, request, **kwargs)
        return images, videos, preparation

    monkeypatch.setattr(web, '_check_publish_request', checked)
    request = item('zhihu')
    request.sourceSessionId = 'confirmed-source'
    result = submit([request])
    receipt = web._get_publish_receipt(result['accepted'][0]['receiptId'])
    assert receipt['sourceSessionId'] == 'confirmed-source'
    assert receipt['preparation'] == preparation
    assert receipt['batchId'] == result['batchId']


def test_batch_respects_manual_publishing_policy_before_creating_jobs(batch_env, monkeypatch):
    def manual_only():
        raise web.HTTPException(403, '当前为人工发布模式')

    monkeypatch.setattr(web, '_require_automated_publishing', manual_only)
    with pytest.raises(web.HTTPException) as caught:
        submit([item('zhihu')])
    assert caught.value.status_code == 403
    assert not web._PUBLISH_ACTIVE


def test_batch_store_create_get_and_payload_caps(tmp_path):
    store = pb.BatchStore(tmp_path / 'batches.json')
    created = store.create('a' * 32, {'zhihu': {'title': 'T' * 400, 'body': 'B' * 30000,
                                                'media': ['m'] * 40, 'tags': 'x' * 900}})
    assert created['batchId'] == 'a' * 32 and created['state'] == pb.BATCH_RUNNING
    loaded = store.get('a' * 32)
    payload = loaded['requests']['zhihu']
    assert len(payload['title']) == 300 and len(payload['body']) == pb.MAX_BODY
    assert len(payload['media']) == 20 and len(payload['tags']) == 600
    with pytest.raises(ValueError):
        store.create('short-id', {})
    with pytest.raises(ValueError):
        store.create('a' * 32, {})  # duplicate batch ID


def test_batch_store_settles_and_recovers(tmp_path):
    store = pb.BatchStore(tmp_path / 'batches.json')
    store.create('c' * 32, {'zhihu': {}})
    store.add_platform('c' * 32, 'zhihu', 'd' * 32)
    store.set_entry('c' * 32, 'zhihu', state=pb.ENTRY_RUNNING)
    assert store.get('c' * 32)['state'] == pb.BATCH_RUNNING
    store.set_entry('c' * 32, 'zhihu', state=pb.ENTRY_FINISHED, outcome='draft', message='ok')
    assert store.get('c' * 32)['state'] == pb.BATCH_COMPLETED
    store.recover_interrupted()
    assert store.get('c' * 32)['state'] == pb.BATCH_COMPLETED


def test_batch_store_rejected_entries_settle_and_recover_marks_running(tmp_path):
    store = pb.BatchStore(tmp_path / 'batches.json')
    store.create('e' * 32, {'zhihu': {}, 'douyin': {}})
    store.add_platform('e' * 32, 'zhihu', '', state=pb.ENTRY_REJECTED, message='未登录')
    assert store.get('e' * 32)['state'] == pb.BATCH_RUNNING
    store.add_platform('e' * 32, 'douyin', 'f' * 32)
    store.set_entry('e' * 32, 'douyin', state=pb.ENTRY_FINISHED, outcome='published')
    assert store.get('e' * 32)['state'] == pb.BATCH_COMPLETED
    store.create('0' * 32, {'zhihu': {}})
    store.add_platform('0' * 32, 'zhihu', '1' * 32)
    store.recover_interrupted()
    assert store.get('0' * 32)['state'] == pb.BATCH_INTERRUPTED
    assert store.get('e' * 32)['state'] == pb.BATCH_COMPLETED


def test_batch_store_keeps_file_bounded_but_never_drops_running(tmp_path):
    store = pb.BatchStore(tmp_path / 'batches.json')
    for index in range(pb.MAX_BATCHES + 3):
        batch_id = f'{index:032x}'
        store.create(batch_id, {'zhihu': {}})
        store.add_platform(batch_id, 'zhihu', '2' * 32)
        store.set_entry(batch_id, 'zhihu', state=pb.ENTRY_FINISHED, outcome='draft')
    survivor = store.create('f' * 32, {'zhihu': {}})
    assert survivor['batchId'] == 'f' * 32
    assert len(store._read()) == pb.MAX_BATCHES


def test_batch_accepts_confirmed_platforms_and_records_batch_id(batch_env):
    result = submit([item('xiaohongshu'), item('zhihu')])
    assert result['batchId'] and not result['rejected']
    assert {row['platform'] for row in result['accepted']} == {'xiaohongshu', 'zhihu'}
    batch = wait_batch(result['batchId'])
    assert batch['state'] == pb.BATCH_COMPLETED
    entries = {entry['platform']: entry for entry in batch['platforms']}
    assert entries['xiaohongshu']['outcome'] == 'draft'
    assert entries['zhihu']['outcome'] == 'failed'
    for row in result['accepted']:
        receipt = web._publish_receipt_store().get(row['receiptId'])
        assert receipt['batchId'] == result['batchId']
        assert receipt['outcome'] == 'draft' if row['platform'] == 'xiaohongshu' else 'failed'


def test_batch_rejections_do_not_block_other_platforms(batch_env):
    web._PUBLISH_ACTIVE['zhihu'] = '9' * 32  # simulated in-flight task on one platform
    result = submit([item('xiaohongshu'), item('zhihu'), item('douyin'),
                     item('not-a-platform'), item('zhihu')])
    reasons = {row['platform']: row['reason'] for row in result['rejected']}
    assert set(reasons) == {'zhihu', 'douyin', 'not-a-platform'}
    zhihu_reasons = [row['reason'] for row in result['rejected'] if row['platform'] == 'zhihu']
    assert any('重复' in reason for reason in zhihu_reasons)  # duplicate listing caught in the dedupe pass
    assert any('已有发布任务' in reason for reason in zhihu_reasons)  # in-flight task caught by the platform lock
    assert '视频' in reasons['douyin']
    assert reasons['not-a-platform'] == '未知平台。'
    batch = wait_batch(result['batchId'])
    entries = {entry['platform']: entry for entry in batch['platforms']}
    assert set(entries) == {'xiaohongshu', 'zhihu'}
    assert entries['zhihu']['state'] == pb.ENTRY_REJECTED
    assert entries['xiaohongshu']['outcome'] == 'draft'
    assert web._PUBLISH_ACTIVE.get('xiaohongshu') is None  # worker released the lock


def test_batch_without_any_accepted_platform_creates_no_record(batch_env, monkeypatch):
    monkeypatch.setattr(web, '_account_logged_in', lambda platform, cfg: False)
    result = submit([item('xiaohongshu')])
    assert result['batchId'] == '' and result['accepted'] == []
    assert '未登录' in result['rejected'][0]['reason']
    assert not (web.PUBLISH_DIR / 'batches.json').exists()


def test_batch_empty_request_is_rejected(batch_env):
    with pytest.raises(web.HTTPException) as failure:
        submit([])
    assert failure.value.status_code == 400


def test_batch_status_merges_live_receipts(batch_env):
    result = submit([item('xiaohongshu')])
    wait_batch(result['batchId'])
    status = asyncio.run(web.api_publish_batch_status(result['batchId']))
    assert status['state'] == pb.BATCH_COMPLETED
    assert status['requests']['xiaohongshu']['title'] == '同一篇内容'
    entry = status['platforms'][0]
    assert entry['state'] == pb.ENTRY_FINISHED and entry['outcome'] == 'draft'
    assert entry['message'] == '模拟回执'
    with pytest.raises(web.HTTPException) as failure:
        asyncio.run(web.api_publish_batch_status('z' * 32))
    assert failure.value.status_code == 404
    with pytest.raises(web.HTTPException) as failure:
        asyncio.run(web.api_publish_batch_status('bad-id'))
    assert failure.value.status_code == 404


def test_batch_restart_marks_running_batch_interrupted_without_resubmit(batch_env):
    result = submit([item('xiaohongshu')])
    store = make_store()
    store.mark_interrupted(result['batchId'], '服务已重启，批次未继续执行；请先到平台核对结果，避免重复发布。')
    status = asyncio.run(web.api_publish_batch_status(result['batchId']))
    assert status['state'] == pb.BATCH_INTERRUPTED
    assert '核对' in status['message']
    calls = []
    original = web._run_publish_job
    def counting(*args, **kwargs):
        calls.append(args[0])
        return original(*args, **kwargs)
    web._run_publish_job = counting
    try:
        asyncio.run(web.api_publish_batch_status(result['batchId']))
    finally:
        web._run_publish_job = original
    assert calls == []  # status reads never resubmit anything
