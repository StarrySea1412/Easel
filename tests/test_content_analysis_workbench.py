"""Deterministic local evidence tests; no claims of live platform verification."""
import asyncio
import copy
import sys
import json
from types import SimpleNamespace
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from content_analysis import PLATFORMS, Store, markdown
from content_analysis_routes import create_router
from content_analysis_ai import evidence_for, validate_findings, interpret
from image_reverse import Provider
from fastapi import HTTPException


@pytest.fixture
def store(tmp_path):
    return Store(tmp_path)


def payload(platform='xiaohongshu', account='account-a', value=0, stamp='2026-09-30T01:00:00Z'):
    return {'platform': platform, 'accountId': account, 'name': '测试作者', 'contents': [
        {'id': 'stable-a', 'title': '真实标题', 'body': '真实首段。\n第二段。', 'tags': ['教程'],
         'publishedAt': '2026-09-28T10:00:00+08:00', 'snapshotAt': stamp, 'period': 'lifetime',
         'metrics': {'views': value, 'likes': None, 'comments': 0}}]}


@pytest.mark.parametrize('platform', PLATFORMS)
def test_platform_import_roundtrip_and_isolation(store, platform):
    report = store.ingest(payload(platform))
    store.ingest(payload(platform, 'account-b', 99))
    assert report['contents'][0]['metrics']['views'] == 0
    assert report['contents'][0]['metrics']['likes'] is None
    assert store.report(platform, 'account-a')['overview']['totals']['views'] == 0
    assert store.report(platform, 'account-b')['overview']['totals']['views'] == 99
    assert report['quality']['identity'] == 'user_declared'
    assert report['contents'][0]['publishedAt'] == '2026-09-28T02:00:00+00:00'


@pytest.mark.parametrize('value', ['1万', -1, True, float('nan'), float('inf')])
def test_invalid_metrics_reject_whole_import(store, value):
    data = payload()
    invalid = copy.deepcopy(data['contents'][0])
    invalid['id'] = 'invalid'
    invalid['metrics']['views'] = value
    data['contents'].append(invalid)
    with pytest.raises(ValueError):
        store.ingest(data)
    assert store.accounts() == []


def test_duplicate_import_idempotent_older_snapshots_preserved(store):
    data = payload(value=10)
    store.ingest(data)
    report = store.ingest(data)
    assert len(report['contents'][0]['snapshots']) == 1
    report = store.ingest(payload(value=3, stamp='2026-09-29T01:00:00Z'))
    assert len(report['contents'][0]['snapshots']) == 2
    assert report['contents'][0]['metrics']['views'] == 10


def test_same_title_never_merges_distinct_ids(store):
    data = payload()
    another = copy.deepcopy(data['contents'][0])
    another['id'] = 'stable-b'
    data['contents'].append(another)
    assert store.ingest(data)['overview']['contentCount'] == 2


def test_no_unknown_or_mixed_period_totals(store):
    data = payload(value=5)
    data['contents'][0]['period'] = 'unknown'
    assert store.ingest(data)['overview']['totals']['views'] is None
    data = payload(value=5)
    another = copy.deepcopy(data['contents'][0])
    another.update(id='second', period='7d')
    data['contents'].append(another)
    assert store.ingest(data)['overview']['totals']['views'] is None


def test_metric_refresh_keeps_materials_and_provenance(store):
    store.ingest(payload())
    data = payload(value=8, stamp='2026-10-01T01:00:00Z')
    del data['contents'][0]['body']
    report = store.ingest(data, identity='live_verified')
    assert report['contents'][0]['body'] == '真实首段。\n第二段。'
    assert report['contents'][0]['diagnostics'][1]['evidence'] == '真实首段。'


def test_missing_materials_do_not_fabricate_visual_analysis(store):
    data = payload()
    data['contents'][0]['body'] = ''
    findings = store.ingest(data)['contents'][0]['diagnostics']
    assert any(f['id'].endswith('missing-body') for f in findings)
    assert any('未进行图像识别' in f['observation'] for f in findings)


def test_material_edit_preserves_metric_snapshot(store):
    store.ingest(payload(value=12))
    report = store.ingest({'platform': 'xiaohongshu', 'accountId': 'account-a',
                           'contents': [{'id': 'stable-a', 'body': '修改后的正文'}]})
    content = report['contents'][0]
    assert content['metrics']['views'] == 12
    assert content['snapshotAt'] == '2026-09-30T01:00:00+00:00'
    assert content['period'] == 'lifetime'
    assert len(content['snapshots']) == 1


def test_comments_cover_and_transcript_diagnostics_quote_actual_materials(store):
    data = payload()
    data['contents'][0].update(comments=['如何设置曝光？', '如何设置曝光？', '谢谢'],
                               coverText='手机夜景曝光设置', transcript='夜景怎么拍？\n先稳定手机。\n再控制曝光。')
    content = store.ingest(data)['contents'][0]
    findings = {f['id'].split(':')[-1]: f for f in content['diagnostics']}
    assert '出现 2 次' in findings['question-0']['observation']
    assert findings['question-0']['evidence'] == '如何设置曝光'
    assert findings['cover']['evidence'] == '手机夜景曝光设置'
    assert '语速' in findings['script-opening']['limitation']
    assert content['draft']['audienceQuestion'] == '如何设置曝光？'
    assert content['draft']['evidenceIds'] == ['stable-a']


def test_material_fields_preserved_and_wrong_types_rejected(store):
    data = payload()
    data['contents'][0].update(comments=['如何选择？'], coverText='封面真实文字')
    store.ingest(data)
    report = store.ingest({'platform': 'xiaohongshu', 'accountId': 'account-a', 'contents': [{'id': 'stable-a', 'body': '新正文'}]})
    assert report['contents'][0]['comments'] == ['如何选择？']
    assert report['contents'][0]['coverText'] == '封面真实文字'
    data['contents'][0]['comments'] = 'not array'
    with pytest.raises(ValueError):
        store.ingest(data)


def experiment_payload(account='account-a'):
    return {'platform': 'xiaohongshu', 'accountId': account, 'title': '改写开头', 'hypothesis': '具体问题更明确',
            'action': '首段增加使用情境', 'metric': 'views', 'contentIds': ['stable-a']}


def test_experiment_freezes_baseline_and_records_real_observations(store):
    store.ingest(payload(value=10))
    experiment = store.experiment(experiment_payload())
    store.ingest(payload(value=16, stamp='2026-10-01T01:00:00Z'))
    result = store.experiment({**experiment_payload(), 'status': 'reviewed', 'conclusion': '仍需重复观察'}, experiment['id'])
    assert result['baseline'][0]['value'] == 10
    assert result['reviews'][0]['observations'][0]['delta'] == 6
    assert '因果' in result['reviews'][0]['observations'][0]['note']


def test_experiment_no_new_snapshot_has_no_delta_and_cross_account_forbidden(store):
    store.ingest(payload(value=10))
    experiment = store.experiment(experiment_payload())
    result = store.experiment({**experiment_payload(), 'status': 'reviewed'}, experiment['id'])
    assert result['reviews'][0]['observations'][0]['delta'] is None
    store.ingest(payload(account='account-b'))
    with pytest.raises(LookupError):
        store.experiment(experiment_payload('account-b'), experiment['id'])


def test_export_and_restart_persistence(store):
    report = store.ingest(payload())
    document = markdown(report)
    assert '真实首段' in document and '缺失' in document
    assert Store(store.path.parent).report('xiaohongshu', 'account-a')['contents'][0]['id'] == 'stable-a'


@pytest.mark.parametrize('mutation', [
    {'id': ''}, {'accountId': 'other'}, {'tags': 'wrong'}, {'url': 'javascript:alert(1)'},
    {'publishedAt': '2026-09-30'}, {'paid': 'false'}, {'period': 'one year'}])
def test_invalid_import_fields(store, mutation):
    data = payload()
    data['contents'][0].update(mutation)
    with pytest.raises(ValueError):
        store.ingest(data)


def test_http_contract_import_export_capture_and_validation(tmp_path):
    async def exercise():
        async def capture(platform):
            return {'loggedIn': True, 'accountId': 'account-a', 'notes': [{'noteId': 'real-id', 'title': '采集作品', 'metrics': {'likes': 1}}]}
        app = FastAPI()
        app.include_router(create_router(lambda: tmp_path, capture))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            assert (await client.post('/api/content-analysis/import', json=payload())).status_code == 200
            assert (await client.get('/api/content-analysis/accounts')).json()['accounts'][0]['accountId'] == 'account-a'
            assert (await client.get('/api/content-analysis/report?platform=xiaohongshu&accountId=other')).status_code == 404
            export = await client.get('/api/content-analysis/export?platform=xiaohongshu&accountId=account-a&format=markdown')
            assert export.status_code == 200 and 'attachment' in export.headers['content-disposition']
            captured = await client.post('/api/content-analysis/capture', json={'platform': 'xiaohongshu', 'accountId': 'account-a'})
            assert captured.status_code == 200 and captured.json()['overview']['contentCount'] == 2
            assert captured.json()['quality']['identity'] == 'mixed'
            mismatch = await client.post('/api/content-analysis/capture', json={'platform': 'xiaohongshu', 'accountId': 'other'})
            assert mismatch.status_code == 409
            assert (await client.post('/api/content-analysis/import', content='not json')).status_code == 400
            assert (await client.post('/api/content-analysis/import', json=[])).status_code == 400
            no_model = await client.post('/api/content-analysis/interpret', json={'platform': 'xiaohongshu', 'accountId': 'account-a', 'contentId': 'stable-a'})
            assert no_model.status_code == 503
    asyncio.run(exercise())


def test_ai_evidence_rejects_fabrication_numbers_and_causal_claims():
    evidence = {'c:body': '这里是真实原文材料'}
    valid = {'evidenceId': 'c:body', 'quote': '真实原文材料', 'interpretation': '建议明确对象', 'action': '补充真实场景'}
    assert validate_findings({'findings': [valid]}, evidence) == [valid]
    for mutation in ({'quote': '不存在的引文'}, {'evidenceId': 'other'}, {'interpretation': '提升了效果'}, {'action': '提高20%'}):
        with pytest.raises(ValueError):
            validate_findings({'findings': [{**valid, **mutation}]}, evidence)


@pytest.mark.parametrize('transcript', ['。', '！？!?\n。', ' \n ？！ \n '])
def test_punctuation_only_transcript_remains_readable_after_import(store, transcript):
    data = payload()
    data['contents'][0]['transcript'] = transcript
    imported = store.ingest(data)
    reopened = store.report('xiaohongshu', 'account-a')
    for report in (imported, reopened):
        findings = report['contents'][0]['diagnostics']
        assert any(finding['id'].endswith(':script-empty') for finding in findings)
        assert not any(finding['id'].endswith(':script-opening') for finding in findings)
        assert report['contents'][0]['transcript'] == transcript.strip()
        assert '尚无可分析的语句' in markdown(report)


@pytest.mark.parametrize('protocol', ['openai', 'anthropic'])
def test_ai_provider_protocol_and_persisted_review_invalidation(store, monkeypatch, protocol):
    import content_analysis_ai as ai
    content = store.ingest(payload())['contents'][0]
    finding = {'evidenceId': 'stable-a:body', 'quote': '真实首段', 'interpretation': '开场可以更明确读者', 'action': '补充实际使用场景'}
    serialized = json.dumps({'findings': [finding]}, ensure_ascii=False)
    response = {'content': [{'type': 'text', 'text': serialized}]} if protocol == 'anthropic' else {'choices': [{'message': {'content': serialized}}]}
    requests = []
    class Reply:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read(self, limit): return json.dumps(response).encode()
    def open_request(req, timeout):
        requests.append(req)
        assert timeout == 90
        return Reply()
    monkeypatch.setattr(ai.urllib.request, 'build_opener', lambda *args: SimpleNamespace(open=open_request))
    review = interpret(content, Provider('test', 'Test', 'test-model', protocol, 'https://provider.example/v1', 'test-key'))
    assert review['findings'] == [finding]
    assert requests[0].full_url.endswith('/messages' if protocol == 'anthropic' else '/chat/completions')
    store.save_review('xiaohongshu', 'account-a', content, review)
    assert store.report('xiaohongshu', 'account-a')['contents'][0]['aiReview']['model'] == 'test-model'
    store.ingest({'platform': 'xiaohongshu', 'accountId': 'account-a', 'contents': [{'id': 'stable-a', 'body': '新的原文'}]})
    assert store.report('xiaohongshu', 'account-a')['contents'][0]['aiReview'] is None
    with pytest.raises(ValueError):
        store.save_review('xiaohongshu', 'account-a', content, review)
