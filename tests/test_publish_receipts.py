"""Offline publish acceptance: isolated API definitions, no accounts or SMTP.

Runner output, progress files and SMTP completion are controlled fixtures. No
test imports the whole workbench or calls a live platform publishing endpoint.
"""
from __future__ import annotations

import ast
import asyncio
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from types import SimpleNamespace
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import BaseModel
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from easel import local_records, publish_receipts as receipts, publish_followup

RID = 'a' * 32
URL = 'https://zhuanlan.zhihu.com/p/123456'


def emitted(platform='zhihu', receipt_id=RID, outcome='published', **extra):
    value = {'schemaVersion': 1, 'platform': platform, 'receiptId': receipt_id,
             'outcome': outcome, 'contentId': '123456', 'platformStatus': outcome,
             'url': URL if platform == 'zhihu' else 'https://www.douyin.com/video/123456',
             'message': '来自平台的结果', 'evidence': {'source': 'platform-readback'}, **extra}
    return receipts.MARKER + json.dumps(value, ensure_ascii=False)


@pytest.mark.parametrize('outcome', sorted(receipts.OUTCOMES))
def test_exit_zero_never_overrides_platform_outcome(outcome):
    result = receipts.parse_result('zhihu', RID, emitted(outcome=outcome), 0)
    assert result['outcome'] == outcome
    assert result['ok'] is (outcome == 'published')
    if outcome not in {'published', 'submitted'}:
        assert result['url'] == ''


@pytest.mark.parametrize('bad', [
    {'receiptId': 'b' * 32}, {'platform': 'douyin'}, {'schemaVersion': 2},
    {'schemaVersion': True}, {'outcome': 'success'}, {'outcome': ['published']},
])
def test_stale_foreign_or_invalid_receipts_are_not_success(bad):
    data = json.loads(emitted()[len(receipts.MARKER):])
    data.update(bad)
    stdout = receipts.MARKER + json.dumps(data)
    result = receipts.parse_result('zhihu', RID, stdout, 0)
    assert result['outcome'] == 'unverified' and not result['ok'] and not result['url']


def test_plain_success_text_and_embedded_markers_are_not_platform_receipts():
    result = receipts.parse_result('zhihu', RID, '发布成功 ' + URL + '\n用户正文：' + emitted(), 0)
    assert result['outcome'] == 'unverified'
    assert receipts.parse_result('zhihu', RID, emitted(), 1)['outcome'] == 'unverified'
    assert receipts.parse_result('zhihu', RID, emitted() + '\n' + emitted(outcome='failed'), 0)['outcome'] == 'failed'


@pytest.mark.parametrize('url', [
    'javascript:alert(1)', 'http://zhuanlan.zhihu.com/p/123456',
    'https://zhuanlan.zhihu.com.evil.test/p/123456',
    'https://user:password@zhuanlan.zhihu.com/p/123456',
    'https://zhuanlan.zhihu.com:8443/p/123456',
    'https://zhuanlan.zhihu.com/write', URL + '?access_token=private',
    URL + '?token=private', URL + '\nmalicious',
])
def test_unsafe_or_console_urls_never_become_clickable_receipt_links(url):
    result = receipts.parse_result('zhihu', RID, emitted(url=url), 0)
    assert result['outcome'] == 'published' and result['url'] == ''
    assert '未返回可验证' in result['message']


def test_untrusted_raw_evidence_does_not_persist_api_responses_or_credentials():
    result = receipts.parse_result('zhihu', RID, emitted(evidence={
        'source': 'platform-readback', 'access_token': 'PRIVATE',
        'response': {'cookie': 'PRIVATE'}, 'verified': True}), 0)
    assert result['evidence'] == {'source': 'platform-readback', 'verified': True}


@pytest.mark.parametrize('platform,content_id,kind,url', [
    ('douyin', '1234567890123456789', 'imagetext', 'https://www.douyin.com/note/1234567890123456789'),
    ('kuaishou', 'abcd1234efgh5678', 'video', 'https://www.kuaishou.com/short-video/abcd1234efgh5678'),
    ('zhihu', '123456', 'article', URL),
])
def test_real_script_contract_roundtrips_into_backend_receipt(platform, content_id, kind, url, monkeypatch, capsys):
    spec = importlib.util.spec_from_file_location('isolated_script_receipt', ROOT / 'skills/shared/scripts/publish_receipt.py')
    script = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(script)
    monkeypatch.setenv('EASEL_PUBLISH_RECEIPT_ID', RID)
    if platform == 'zhihu':
        receipt = script.from_ui(platform, url=url, signal='page_navigation')
    else:
        readback = SimpleNamespace(outcome='verified', matched=SimpleNamespace(
            platform_content_id=content_id, status='published'))
        receipt = script.from_readback(platform, readback, kind=kind)
    script.emit(receipt)
    result = receipts.parse_result(platform, RID, capsys.readouterr().out, 0)
    assert result['ok'] and result['contentId'] == content_id and result['url'] == url
    assert result['evidence']['publicAccessChecked'] is False


def test_legacy_upload_ids_only_prove_submission_or_draft():
    draft = receipts.parse_result('wechat-oa', RID, '{"success":true,"media_id":"draft123"}', 0)
    assert draft['outcome'] == 'draft' and not draft['ok'] and not draft['url']
    submitted = receipts.parse_result('bilibili', RID, '{"code":0,"data":{"bvid":"BV1xx411c7mD"}}', 0)
    assert submitted['outcome'] == 'submitted' and submitted['contentId'] == 'BV1xx411c7mD'
    ordinary = receipts.parse_result('bilibili', RID, '这是标题 BV1xx411c7mD 发布成功', 0)
    assert ordinary['outcome'] == 'unverified'
    assert receipts.parse_result('bilibili', RID, '{"code":1,"bvid":"BV1xx411c7mD"}', 0)['outcome'] == 'unverified'


def test_restart_retains_results_but_never_resubmits_or_claims_queued_mail_arrived(tmp_path):
    store = receipts.ReceiptStore(tmp_path / 'receipts.json')
    store.create(RID, 'zhihu', 'pending')
    other = 'b' * 32
    store.create(other, 'douyin', 'finished')
    store.update(other, {'outcome': 'published', 'state': 'finished', 'ok': True,
                         'notification': {'state': 'queued', 'message': 'queued'}})
    receipts.ReceiptStore(store.path).recover_interrupted()
    assert store.get(RID)['outcome'] == 'unverified'
    done = store.get(other)
    assert done['outcome'] == 'published' and done['ok'] is True
    assert done['notification']['state'] == 'failed'
    assert '不会自动重发' in done['notification']['message']


def test_simultaneous_starts_on_same_platform_get_only_one_durable_reservation(tmp_path):
    path = tmp_path / 'receipts.json'
    gate = threading.Barrier(2)
    def reserve(letter):
        gate.wait(timeout=5)
        try:
            return receipts.ReceiptStore(path).create(letter * 32, 'douyin', letter)
        except receipts.ActivePublishError:
            return None
    with ThreadPoolExecutor(max_workers=2) as pool:
        values = list(pool.map(reserve, ['a', 'b']))
    assert len([item for item in values if item]) == 1
    assert len(receipts.ReceiptStore(path).recent()) == 1


@pytest.fixture
def api(tmp_path):
    names = {
        'PublishRequest', 'PublishSmsRequest', 'PublishVerificationRequest', '_publish_receipt_store', '_save_publish_receipt',
        '_begin_publish', '_release_publish', '_write_publish_status', '_refresh_publish_receipt',
        '_get_publish_receipt', '_recent_publish_receipts', 'api_publish_receipts', 'api_publish_receipt', '_read_publish_status',
        '_finish_publish', '_run_publish_job', '_run_publish_bg', '_start_async_publish',
        'api_publish_status', 'api_publish_sms', 'api_publish', '_record_published_schedule',
        '_read_schedule', '_write_schedule',
        '_awaiting_publish_verification', '_acquire_publish_verification', '_run_publish_verification', '_account_browser_busy',
        '_publish_verification_service', 'api_verify_publish_receipt', 'api_set_publish_verification',
        '_complete_publish_receipt',
    }
    source = ast.parse((ROOT / 'web/app.py').read_text(encoding='utf-8'))
    nodes = [node for node in source.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
             and node.name in names]
    assert {node.name for node in nodes} == names
    module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0),
                              *nodes], type_ignores=[])
    ast.fix_missing_locations(module)
    app = FastAPI()
    calls, workers = [], []
    def run(*args, **kwargs):
        raise AssertionError('Test must stub publishing explicitly')
    class FakeThread:
        def __init__(self, target, args=(), **kwargs):
            self.target, self.args = target, args
        def start(self):
            workers.append(self)
    namespace = {
        'app': app, 'HTTPException': HTTPException, 'BaseModel': BaseModel,
        'Path': Path, 'json': json, 'os': os, 'sys': sys, 'time': time, 'uuid': uuid,
        'asyncio': asyncio, 'local_records': local_records, 'publish_receipts': receipts,
        'publish_followup': publish_followup, '_PUBLISH_VERIFIER': None, 'LOGIN_PROCESSES': {},
        '_ACCOUNT_CLEARING': set(), '_WHOAMI_LOCK': threading.Lock(), '_WHOAMI_PROCESSES': {},
        'threading': SimpleNamespace(Thread=FakeThread),
        'subprocess': SimpleNamespace(run=run, TimeoutExpired=subprocess.TimeoutExpired),
        'PROJECT_ROOT': tmp_path, 'DATA_DIR': tmp_path, 'OUTPUTS_DIR': tmp_path / 'outputs',
        'PUBLISH_DIR': tmp_path / 'outputs/_publish',
        'SCHEDULE_FILE': tmp_path / 'outputs/_schedule.json',
        'SHARED_SCRIPTS': ROOT / 'skills/shared/scripts',
        'WECHAT_SKILL_SCRIPTS': ROOT / 'skills/openclaw/skill-wechat-publisher/scripts',
        '_PUBLISH_LOCK': threading.RLock(), '_PUBLISH_ACTIVE': {}, '_PUBLISH_VOLATILE': {},
        '_notify_email_completion': lambda **kwargs: {'state': 'unconfigured', 'message': 'not configured'},
        '_publish_env': lambda: {}, '_proxy_env': lambda: {},
        '_safe_output_path': lambda rel: tmp_path / 'outputs' / rel,
        '_mp_login_status': lambda: {'state': 'success'},
        'IMAGE_EXTS': {'.png'}, 'VIDEO_EXTS': {'.mp4'},
        'MEDIA_REQUIRED': {'douyin', 'xiaohongshu', 'bilibili'},
        'VIDEO_ONLY_PUBLISH': {'bilibili'},
        'LOGIN_RUNNERS': {'zhihu': {'name': '知乎', 'backend': 'web', 'wp': 'zhihu'},
                          'douyin': {'name': '抖音', 'backend': 'douyin'},
                          'xiaohongshu': {'name': '小红书', 'backend': 'xhs'},
                          'bilibili': {'name': 'B站', 'backend': 'biliup'},
                          'weixin-channels': {'name': '视频号', 'backend': 'web', 'wp': 'weixin-channels'},
                          'kuaishou': {'name': '快手', 'backend': 'web', 'wp': 'kuaishou'},
                          'wechat-oa': {'name': '微信公众号', 'backend': 'wechat-oa'}},
    }
    exec(compile(module, str(ROOT / 'web/app.py'), 'exec'), namespace)
    with TestClient(app) as client:
        yield client, namespace, calls, workers


def stub_runner(namespace, calls, *, outcome='published', platform='zhihu', returncode=0):
    def run(cmd, **kwargs):
        calls.append((cmd, kwargs))
        rid = kwargs['env']['EASEL_PUBLISH_RECEIPT_ID']
        assert kwargs['env']['EASEL_CALENDAR_AUTORECORD'] == '0'
        return SimpleNamespace(returncode=returncode, stdout=emitted(platform, rid, outcome), stderr='')
    namespace['subprocess'].run = run


def test_sync_api_persists_url_calendar_and_separate_notification_delivery(api):
    client, namespace, calls, _ = api
    stub_runner(namespace, calls)
    mail = []
    def notify(**kwargs):
        mail.append(kwargs)
        kwargs['on_result']({'state': 'queued', 'message': 'queued'})
        return {'state': 'queued', 'message': 'queued'}
    namespace['_notify_email_completion'] = notify
    response = client.post('/api/publish/zhihu', json={'title': '测试文章', 'body': '测试正文'})
    assert response.status_code == 200
    data = response.json()
    assert data['outcome'] == 'published' and data['ok'] and data['url'] == URL
    assert data['notification']['state'] == 'queued'
    rid = data['receiptId']
    assert mail[0]['receipt_id'] == rid and mail[0]['url'] == URL
    schedule = json.loads(namespace['SCHEDULE_FILE'].read_text(encoding='utf-8'))
    assert schedule[0]['url'] == URL and schedule[0]['receiptId'] == rid
    mail[0]['on_result']({'state': 'failed', 'message': 'mail failed'})
    restored = client.get('/api/publish/receipts/' + rid).json()
    assert restored['ok'] and restored['notification']['state'] == 'failed'
    assert client.get('/api/publish/receipts').json()[0] == restored
    assert len(calls) == 1 and namespace['_PUBLISH_ACTIVE'] == {}


def test_bilibili_web_uses_readback_wrapper_and_keeps_verified_bvid_url(api):
    client, namespace, calls, _ = api
    url = 'https://www.bilibili.com/video/BV1xx411c7mD'
    def run(cmd, **kwargs):
        calls.append((cmd, kwargs))
        rid = kwargs['env']['EASEL_PUBLISH_RECEIPT_ID']
        return SimpleNamespace(returncode=0, stderr='', stdout=emitted(
            'bilibili', rid, contentId='BV1xx411c7mD', url=url))
    namespace['subprocess'].run = run
    data = client.post('/api/publish/bilibili', json={
        'title': '视频', 'body': '简介', 'media': ['video.mp4']}).json()
    assert data['outcome'] == 'published' and data['url'] == url
    cmd, kwargs = calls[0]
    assert cmd[:3] == [sys.executable, '-X', 'utf8']
    assert Path(cmd[3]).name == 'bili_upload.py' and cmd[4] == 'upload'
    assert cmd[cmd.index('--cookie') + 1] == str(namespace['DATA_DIR'] / 'cookies.json')
    assert cmd[cmd.index('--tag') + 1] == '日常'
    assert cmd[cmd.index('--desc') + 1] == '简介' and '--exec' in cmd
    assert kwargs['encoding'] == 'utf-8' and kwargs['errors'] == 'replace'


@pytest.mark.parametrize('platform,media', [
    ('zhihu', []), ('douyin', ['video.mp4']), ('xiaohongshu', ['image.png']),
    ('bilibili', ['video.mp4']), ('wechat-oa', ['image.png']),
])
def test_every_python_publish_entry_uses_utf8_mode_including_html_conversion(api, platform, media):
    client, namespace, calls, workers = api
    def run(cmd, **kwargs):
        calls.append((cmd, kwargs))
        assert cmd[:3] == [sys.executable, '-X', 'utf8']
        assert kwargs['encoding'] == 'utf-8' and kwargs['errors'] == 'replace'
        if Path(cmd[3]).name == 'html_converter.py':
            Path(cmd[cmd.index('-o') + 1]).write_text('<p>test</p>', encoding='utf-8')
            return SimpleNamespace(returncode=0, stdout='', stderr='')
        rid = kwargs['env']['EASEL_PUBLISH_RECEIPT_ID']
        return SimpleNamespace(returncode=0, stderr='', stdout=emitted(
            platform, rid, outcome='draft' if platform == 'wechat-oa' else 'submitted'))
    namespace['subprocess'].run = run
    response = client.post('/api/publish/' + platform, json={'title': 'test', 'media': media})
    assert response.status_code == 200
    if platform == 'douyin':
        workers[0].target(*workers[0].args)
    assert len(calls) == (2 if platform == 'wechat-oa' else 1)


@pytest.mark.parametrize('outcome', ['draft', 'submitted', 'unverified', 'failed'])
def test_nonpublic_results_never_save_published_calendar_or_send_success_email(api, outcome):
    client, namespace, calls, _ = api
    stub_runner(namespace, calls, outcome=outcome)
    namespace['_notify_email_completion'] = lambda **kw: pytest.fail('No success email for this outcome')
    data = client.post('/api/publish/zhihu', json={'title': '测试'}).json()
    assert data['outcome'] == outcome and data['ok'] is False
    assert not namespace['SCHEDULE_FILE'].exists()
    assert data['notification']['state'] == 'skipped'


def test_old_notify_hook_without_result_is_not_reported_as_delivered(api):
    client, namespace, calls, _ = api
    stub_runner(namespace, calls)
    namespace['_notify_email_completion'] = lambda **kwargs: None
    data = client.post('/api/publish/zhihu', json={'title': 'test'}).json()
    assert data['notification']['state'] == 'skipped'
    assert '未确认' in data['notification']['message']


def test_async_receipt_restores_sms_state_and_rejects_duplicate_or_stale_code(api):
    client, namespace, calls, workers = api
    stub_runner(namespace, calls, platform='douyin', outcome='submitted')
    accepted = client.post('/api/publish/douyin', json={'title': '视频', 'media': ['video.mp4']}).json()
    rid = accepted['receiptId']
    assert accepted['pending'] is True and accepted['outcome'] is None and not accepted.get('ok')
    assert not calls and len(workers) == 1
    assert client.post('/api/publish/douyin', json={'title': '重复', 'media': ['video.mp4']}).status_code == 409
    status = namespace['PUBLISH_DIR'] / (rid + '.status.json')
    status.write_text(json.dumps({'state': 'sms_required', 'message': '请输入验证码'}), encoding='utf-8')
    restored = client.get('/api/publish/receipts/' + rid).json()
    assert restored['state'] == 'sms_required' and restored['outcome'] is None
    assert client.get('/api/publish/receipts').json()[0]['state'] == 'sms_required'
    assert client.post('/api/publish/douyin/sms', json={'code': '123456', 'receiptId': 'f' * 32}).status_code == 409
    assert client.post('/api/publish/douyin/sms', json={'code': '123456', 'receiptId': rid}).status_code == 200
    code = namespace['PUBLISH_DIR'] / (rid + '.code')
    assert code.read_text() == '123456'
    workers[0].target(*workers[0].args)
    result = client.get('/api/publish/receipts/' + rid).json()
    assert result['outcome'] == 'submitted' and not code.exists()
    assert namespace['_PUBLISH_ACTIVE'] == {} and len(calls) == 1
    assert client.post('/api/publish/douyin/sms', json={'code': '123456', 'receiptId': rid}).status_code == 409


def test_async_status_success_without_matching_receipt_is_still_unverified(api):
    client, namespace, calls, workers = api
    accepted = client.post('/api/publish/douyin', json={'title': '视频', 'media': ['video.mp4']}).json()
    rid = accepted['receiptId']
    (namespace['PUBLISH_DIR'] / (rid + '.status.json')).write_text(
        '{"state":"success","message":"发布成功"}', encoding='utf-8')
    assert client.get('/api/publish/receipts/' + rid).json()['outcome'] is None
    namespace['subprocess'].run = lambda *a, **kw: SimpleNamespace(returncode=0, stdout='发布成功', stderr='')
    workers[0].target(*workers[0].args)
    data = client.get('/api/publish/douyin/status').json()
    assert data['receiptId'] == rid and data['outcome'] == 'unverified' and not data['ok']


def test_timeout_releases_platform_but_keeps_uncertainty_and_never_retries(api):
    client, namespace, calls, _ = api
    def run(*args, **kwargs):
        calls.append(args)
        raise subprocess.TimeoutExpired('synthetic', 1)
    namespace['subprocess'].run = run
    data = client.post('/api/publish/zhihu', json={'title': '测试'}).json()
    assert data['outcome'] == 'unverified' and '避免重复' in data['message']
    assert namespace['_PUBLISH_ACTIVE'] == {} and len(calls) == 1


def test_corrupt_receipts_prevent_start_and_are_preserved(api):
    client, namespace, calls, _ = api
    path = namespace['PUBLISH_DIR'] / 'receipts.json'
    path.parent.mkdir(parents=True)
    path.write_bytes(b'PRIVATE_CORRUPT_RECORDS')
    response = client.post('/api/publish/zhihu', json={'title': 'test'})
    assert response.status_code == 503 and '原文件已保留' in response.text
    assert 'PRIVATE_CORRUPT_RECORDS' not in response.text
    assert path.read_bytes() == b'PRIVATE_CORRUPT_RECORDS' and not calls


def test_calendar_failure_does_not_turn_verified_publication_into_failure(api):
    client, namespace, calls, _ = api
    stub_runner(namespace, calls)
    namespace['OUTPUTS_DIR'].mkdir()
    namespace['SCHEDULE_FILE'].write_bytes(b'PRIVATE_BROKEN_CALENDAR')
    data = client.post('/api/publish/zhihu', json={'title': 'test'}).json()
    assert data['ok'] and '排期记录未保存' in data['message']
    assert 'PRIVATE_BROKEN_CALENDAR' not in data['message']
    assert namespace['SCHEDULE_FILE'].read_bytes() == b'PRIVATE_BROKEN_CALENDAR'


def test_client_leaving_does_not_unlock_an_active_worker_or_lose_its_receipt(api):
    _, namespace, calls, _ = api
    started, proceed = threading.Event(), threading.Event()
    def run(*args, **kwargs):
        calls.append(args)
        started.set()
        assert proceed.wait(timeout=5)
        rid = kwargs['env']['EASEL_PUBLISH_RECEIPT_ID']
        return SimpleNamespace(returncode=0, stdout=emitted(receipt_id=rid), stderr='')
    namespace['subprocess'].run = run
    async def scenario():
        task = asyncio.create_task(namespace['api_publish']('zhihu', namespace['PublishRequest'](title='test')))
        assert await asyncio.to_thread(started.wait, 5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        rid = namespace['_PUBLISH_ACTIVE']['zhihu']
        proceed.set()
        for _ in range(200):
            if not namespace['_PUBLISH_ACTIVE']:
                break
            await asyncio.sleep(0.01)
        assert not namespace['_PUBLISH_ACTIVE']
        assert namespace['_get_publish_receipt'](rid)['outcome'] == 'published'
    try:
        asyncio.run(scenario())
    finally:
        proceed.set()
    assert len(calls) == 1


def test_disk_failure_after_publication_keeps_known_result_and_recovers_on_later_update(api, monkeypatch):
    client, namespace, calls, _ = api
    stub_runner(namespace, calls)
    original = local_records.write
    failures = []
    def fail_first_final_save(path, records, label):
        if label == receipts.LABEL and any(item.get('outcome') == 'published' for item in records) and not failures:
            failures.append(True)
            raise local_records.RecordError('synthetic write failure')
        return original(path, records, label)
    monkeypatch.setattr(local_records, 'write', fail_first_final_save)
    data = client.post('/api/publish/zhihu', json={'title': 'test'}).json()
    # The notification update successfully retries the complete known receipt,
    # not just its notification field over an old "starting" record.
    assert data['outcome'] == 'published' and data['ok'] is True
    saved = client.get('/api/publish/receipts/' + data['receiptId']).json()
    assert saved['outcome'] == 'published' and not saved.get('storageWarning')


@pytest.mark.parametrize('mail_state', ['sent', 'failed'])
def test_list_preserves_latest_notification_and_warning_when_final_mail_save_fails(api, monkeypatch, mail_state):
    client, namespace, calls, _ = api
    stub_runner(namespace, calls)
    callbacks = []
    def notify(**kwargs):
        callbacks.append(kwargs['on_result'])
        kwargs['on_result']({'state': 'queued', 'message': 'queued'})
        return {'state': 'queued', 'message': 'queued'}
    namespace['_notify_email_completion'] = notify
    initial = client.post('/api/publish/zhihu', json={'title': 'test'}).json()
    path = namespace['PUBLISH_DIR'] / 'receipts.json'
    original = path.read_bytes()
    def fail(*args):
        raise local_records.RecordError('PRIVATE_WRITE_FAILURE')
    monkeypatch.setattr(local_records, 'write', fail)
    callbacks[0]({'state': mail_state, 'message': 'SMTP finished'})
    latest = client.get('/api/publish/receipts').json()[0]
    assert latest['notification']['state'] == mail_state and latest['storageWarning']
    assert latest['updatedAt'] > initial['updatedAt']
    assert latest['outcome'] == 'published' and latest['url'] == URL
    assert 'PRIVATE_WRITE_FAILURE' not in json.dumps(latest)
    assert path.read_bytes() == original and len(calls) == 1
    assert client.get('/api/publish/receipts/' + initial['receiptId']).json() == latest
    assert client.get('/api/publish/zhihu/status').json()['notification']['state'] == mail_state


def test_list_keeps_confirmed_publication_when_every_final_receipt_write_fails(api, monkeypatch):
    client, namespace, calls, _ = api
    stub_runner(namespace, calls)
    original = local_records.write
    def fail_final(path, records, label):
        if label == receipts.LABEL and any(item.get('outcome') for item in records):
            raise local_records.RecordError('cannot save result')
        return original(path, records, label)
    monkeypatch.setattr(local_records, 'write', fail_final)
    result = client.post('/api/publish/zhihu', json={'title': 'test'}).json()
    assert result['outcome'] == 'published' and result['storageWarning']
    listed = client.get('/api/publish/receipts').json()
    assert listed[0] == result and len(calls) == 1
    stored = json.loads((namespace['PUBLISH_DIR'] / 'receipts.json').read_text(encoding='utf-8'))
    assert stored[0]['outcome'] is None


def test_read_failure_returns_cached_results_with_partial_history_warning_without_overwriting(api):
    client, namespace, calls, _ = api
    stub_runner(namespace, calls)
    result = client.post('/api/publish/zhihu', json={'title': 'test'}).json()
    path = namespace['PUBLISH_DIR'] / 'receipts.json'
    path.write_bytes(b'PRIVATE_CORRUPT_HISTORY')
    response = client.get('/api/publish/receipts')
    assert response.status_code == 200
    cached = response.json()[0]
    assert cached['receiptId'] == result['receiptId'] and cached['outcome'] == 'published'
    assert '历史可能不完整' in cached['storageWarning']
    detail = client.get('/api/publish/receipts/' + result['receiptId'])
    assert detail.status_code == 200 and detail.json()['storageWarning']
    assert path.read_bytes() == b'PRIVATE_CORRUPT_HISTORY'
    assert 'PRIVATE_CORRUPT_HISTORY' not in response.text
    namespace['_PUBLISH_VOLATILE'].clear()
    assert client.get('/api/publish/receipts').status_code == 503
    assert len(calls) == 1


@pytest.fixture
def notification_module(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / 'mcp/easel-notify'))
    spec = importlib.util.spec_from_file_location('isolated_publish_notification', ROOT / 'mcp/easel-notify/notify_hook.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    cfg = SimpleNamespace(configured=True, on_done=True)
    monkeypatch.setattr(module.mailer, 'load_email_config', lambda: cfg)
    monkeypatch.delenv('EASEL_NOTIFY_OFF', raising=False)
    workers, mails = [], []
    class FakeThread:
        def __init__(self, target, **kwargs):
            self.target = target
        def start(self):
            workers.append(self.target)
    module.threading = SimpleNamespace(Thread=FakeThread)
    def sent(*args):
        mails.append(args)
        return {'ok': True}
    monkeypatch.setattr(module.mailer, 'send_email', sent)
    return module, workers, mails


def test_email_waits_for_smtp_result_and_includes_url_and_receipt(notification_module):
    module, workers, mails = notification_module
    states = []
    queued = module.notify_completion(title='作品', platform='知乎', source='publish',
                                      receipt_id=RID, outcome='published', url=URL,
                                      on_result=states.append)
    assert queued['state'] == 'queued' and not mails
    assert [s['state'] for s in states] == ['queued']
    workers[0]()
    assert states[-1]['state'] == 'sent'
    assert URL in mails[0][2] and RID in mails[0][2]


def test_two_publications_notify_separately_but_same_receipt_does_not_duplicate(notification_module):
    module, workers, _ = notification_module
    for rid in [RID, RID, 'b' * 32]:
        module.notify_completion(source='publish', outcome='published', receipt_id=rid, title='same title')
    assert len(workers) == 2


@pytest.mark.parametrize('outcome', ['', 'draft', 'submitted', 'unverified', 'failed'])
def test_notification_requires_confirmed_public_receipt(notification_module, outcome):
    module, workers, _ = notification_module
    result = module.notify_completion(source='publish', outcome=outcome, receipt_id=RID)
    assert result['state'] == 'skipped' and not workers


def test_smtp_failure_is_observable_without_leaking_server_details(notification_module, monkeypatch):
    module, workers, _ = notification_module
    monkeypatch.setattr(module.mailer, 'send_email', lambda *a: {'ok': False, 'detail': 'PRIVATE_SMTP_DETAIL'})
    states = []
    module.notify_completion(source='publish', outcome='published', receipt_id=RID, on_result=states.append)
    workers[0]()
    assert states[-1]['state'] == 'failed' and 'PRIVATE_SMTP_DETAIL' not in json.dumps(states)


def test_unconfigured_and_disabled_notifications_are_distinct(notification_module, monkeypatch):
    module, workers, _ = notification_module
    monkeypatch.setattr(module.mailer, 'load_email_config', lambda: SimpleNamespace(configured=False))
    result = module.notify_completion(source='publish', outcome='published', receipt_id=RID)
    assert result['state'] == 'unconfigured'
    monkeypatch.setenv('EASEL_NOTIFY_OFF', '1')
    assert module.notify_completion(source='publish', outcome='published', receipt_id=RID)['state'] == 'skipped'
    assert not workers
