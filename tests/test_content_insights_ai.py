"""Offline fake-provider checks for account insights, provenance and stale writes."""
import asyncio
import copy
import json
import sys
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI, HTTPException
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from content_analysis import Store, markdown
from content_analysis_ai import evidence_for, fact_sheet, insights, validate_findings, validate_insights
from content_analysis_routes import create_router
from image_reverse import Provider

PROVIDER = Provider('test', 'Test', 'fake-model', 'openai', 'https://example.invalid/v1', 'secret-marker')


def data(account='a'):
    return {'platform': 'xiaohongshu', 'accountId': account, 'contents': [
        {'id': 'a', 'title': '咖啡教程', 'body': '先看实际使用场景，再选择合适器具。', 'tags': ['教程'], 'metrics': {'views': 100}, 'period': '7d', 'snapshotAt': '2026-10-08T00:00:00Z'},
        {'id': 'b', 'title': '器具说明', 'body': '器具需要根据实际用途选择。', 'tags': ['教程'], 'metrics': {'views': None}, 'period': 'unknown', 'snapshotAt': '2026-10-08T00:00:00Z'}]}


def valid(facts):
    return {'insights': [{'factIds': [facts[0]['id'], facts[2]['id']], 'observation': '这些材料都提到使用情境，适用边界仍可明确', 'action': '分别补充适用对象，保留原版供人工核对'}]}


@pytest.fixture
def source(tmp_path):
    store = Store(tmp_path)
    return store, store.ingest(data())


def test_fact_sheet_is_stable_bounded_and_preserves_unknowns(source):
    store, report = source
    facts = fact_sheet(report)
    assert facts == fact_sheet(store.report('xiaohongshu', 'a'))
    assert len(facts) <= 40
    assert '缺失' in '\n'.join(f['text'] for f in facts)
    assert 'unknown' in '\n'.join(f['text'] for f in facts)
    assert all(set(f['contentIds']) <= {'a', 'b'} for f in facts)
    assert report['overview']['totals']['views'] == 100


@pytest.mark.parametrize('mutation', [
    {'factIds': ['missing']}, {'factIds': [{}]}, {'factIds': []},
    {'observation': '提高了表现'}, {'action': '带来了关注'}, {'action': '增加百分之三十'},
    {'action': '播放达到100'}, {'observation': '算法更喜欢教程'}, {'action': 'Guaranteed growth percent'},
    {'action': '因为标题更好所以播放更多'}, {'action': ''}, {'action': ['不是字符串']},
])
def test_reject_unsupported_numbers_causality_and_unknown_facts(source, mutation):
    facts = fact_sheet(source[1])
    response = valid(facts)
    response['insights'][0].update(mutation)
    with pytest.raises(ValueError):
        validate_insights(response, facts)


def test_require_cross_work_references_and_limit_results(source):
    facts = fact_sheet(source[1])
    response = valid(facts)
    response['insights'][0]['factIds'] = [facts[0]['id'], facts[1]['id']]
    with pytest.raises(ValueError):
        validate_insights(response, facts)
    response = valid(facts)
    response['insights'] *= 10
    assert len(validate_insights(response, facts)) == 6


def test_missing_material_and_provider_errors(source):
    _, report = source
    with pytest.raises(HTTPException) as exc:
        insights(report, None)
    assert exc.value.status_code == 503
    report['contents'] = report['contents'][:1]
    with pytest.raises(HTTPException) as exc:
        insights(report, None)
    assert exc.value.status_code == 400


def test_model_receives_only_selected_account_facts_and_profile(source, monkeypatch):
    store, report = source
    other = data('other')
    other['contents'][0]['body'] = 'other-account-private-marker'
    store.ingest(other)
    def fake(provider, system, prompt):
        assert 'secret-marker' not in prompt and 'other-account-private-marker' not in prompt
        parsed = json.loads(prompt)
        assert parsed['platformProfile']['platform'] == 'xiaohongshu'
        return valid(parsed['facts'])
    monkeypatch.setattr('content_analysis_ai.request_json', fake)
    result = insights(report, PROVIDER)
    store.save_insights('xiaohongshu', 'a', report['contents'], result)
    assert Store(store.path.parent).report('xiaohongshu', 'a')['accountInsights'] == result
    assert store.report('xiaohongshu', 'other')['accountInsights'] is None
    assert '跨作品 AI 解读' in markdown(store.report('xiaohongshu', 'a'))


@pytest.mark.parametrize('edit', [{'body': '新的实际内容'}, {'tags': ['新标签']}, {'comments': ['请补充说明']}, {'metrics': {'views': 101}, 'snapshotAt': '2026-10-09T00:00:00Z'}])
def test_material_changes_hide_saved_results_and_reject_inflight_writes(source, edit):
    store, report = source
    result = {'facts': fact_sheet(report), 'insights': [], 'model': 'fake', 'at': 'now', 'notice': ''}
    store.save_insights('xiaohongshu', 'a', report['contents'], result)
    store.ingest({'platform': 'xiaohongshu', 'accountId': 'a', 'contents': [dict(id='a', **edit)]})
    assert store.report('xiaohongshu', 'a')['accountInsights'] is None
    with pytest.raises(ValueError):
        store.save_insights('xiaohongshu', 'a', report['contents'], result)


def test_new_content_invalidates_result_and_other_account_does_not(source):
    store, report = source
    result = {'facts': fact_sheet(report), 'insights': []}
    store.save_insights('xiaohongshu', 'a', report['contents'], result)
    store.ingest(data('other'))
    assert store.report('xiaohongshu', 'a')['accountInsights'] == result
    store.ingest({'platform': 'xiaohongshu', 'accountId': 'a', 'contents': [{'id': 'c', 'title': '新增实际作品'}]})
    assert store.report('xiaohongshu', 'a')['accountInsights'] is None


def test_endpoint_success_failure_and_concurrent_material_change(tmp_path, monkeypatch):
    store = Store(tmp_path)
    store.ingest(data())
    app = FastAPI()
    app.include_router(create_router(lambda: tmp_path, None, lambda: [PROVIDER]))
    mode = ['valid']
    def fake(provider, system, prompt):
        facts = json.loads(prompt)['facts']
        if mode[0] == 'bad':
            return {'insights': [{'factIds': [facts[0]['id']], 'observation': '提升50%', 'action': '原因确定'}]}
        if mode[0] == 'edit':
            store.ingest({'platform': 'xiaohongshu', 'accountId': 'a', 'contents': [{'id': 'a', 'body': '请求过程中材料变更'}]})
        return valid(facts)
    monkeypatch.setattr('content_analysis_ai.request_json', fake)
    async def check():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            request = {'platform': 'xiaohongshu', 'accountId': 'a'}
            response = await client.post('/api/content-analysis/insights', json=request)
            assert response.status_code == 200
            assert response.json()['insights']
            mode[0] = 'bad'
            assert (await client.post('/api/content-analysis/insights', json=request)).status_code == 503
            mode[0] = 'edit'
            assert (await client.post('/api/content-analysis/insights', json=request)).status_code == 409
            assert store.report('xiaohongshu', 'a')['accountInsights'] is None
            request['accountId'] = 'missing'
            assert (await client.post('/api/content-analysis/insights', json=request)).status_code == 404
    asyncio.run(check())


@pytest.mark.parametrize('blank', ['', '   ', '\t\n\u3000', '\u200b', '。！？'])
def test_empty_and_legacy_placeholder_comments_return_400_without_model_call(tmp_path, monkeypatch, blank):
    store = Store(tmp_path)
    imported = store.ingest({'platform': 'xiaohongshu', 'accountId': 'empty', 'contents': [
        {'id': 'a', 'comments': [blank]}, {'id': 'b', 'comments': [blank]},
    ]})
    if not blank.strip():
        assert all(content['comments'] == [] for content in imported['contents'])

    # An old database can still contain strings that normalized to an empty
    # comment before this fix. Reading it must not resurrect fake materials.
    with store.connect() as db:
        for content in imported['contents']:
            legacy = {key: value for key, value in content.items() if key not in ('diagnostics', 'draft', 'aiReview', 'snapshots')}
            legacy['comments'] = ['', ' \t ', blank]
            db.execute('UPDATE contents SET data=? WHERE platform=? AND account_id=? AND id=?',
                       (json.dumps(legacy), 'xiaohongshu', 'empty', content['id']))
    report = store.report('xiaohongshu', 'empty')
    assert all(evidence_for(content) == {} for content in report['contents'])
    calls = []
    def forbidden(*args):
        calls.append(args)
        pytest.fail('Empty materials must not reach the model provider')
    monkeypatch.setattr('content_analysis_ai.request_json', forbidden)
    with pytest.raises(HTTPException) as exc:
        insights(report, PROVIDER)
    assert exc.value.status_code == 400
    app = FastAPI()
    app.include_router(create_router(lambda: tmp_path, None, lambda: [PROVIDER]))
    async def check():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            payload = {'platform': 'xiaohongshu', 'accountId': 'empty', 'contentId': 'a'}
            for route in ('insights', 'interpret'):
                response = await client.post('/api/content-analysis/' + route, json=payload)
                assert response.status_code == 400
    asyncio.run(check())
    assert calls == []


def test_normalized_comments_remove_blanks_but_keep_real_text_and_legacy_quote_ids(tmp_path):
    store = Store(tmp_path)
    report = store.ingest({'platform': 'xiaohongshu', 'accountId': 'a', 'contents': [
        {'id': 'a', 'comments': [' ', '\t\n', ' 实际评论材料 ']},
        {'id': 'b', 'comments': ['另一篇实际评论']},
    ]})
    assert report['contents'][0]['comments'] == ['实际评论材料']
    legacy = dict(report['contents'][0], comments=['', ' \n', '？！', ' 实际评论材料 '])
    assert evidence_for(legacy) == {'a:comment:3': ' 实际评论材料 '}
    report['contents'][0] = legacy
    materials = '\n'.join(fact['text'] for fact in fact_sheet(report))
    assert '实际评论材料' in materials and '另一篇实际评论' in materials
    assert '？！' not in materials


@pytest.mark.parametrize('quantity', [
    '有三篇作品表现更好', '受众增加一百人', '收到十个点赞', '出现七条评论',
    '获得五次分享', '表现达到两倍', '收藏占三成', '播放超过三万',
    '增加壹佰名读者', '增长一点五倍', '有三十多位读者', '有三 篇作品',
    '占千分之二', '补充一个问题供人工核对',
])
@pytest.mark.parametrize('field', ['observation', 'action'])
def test_chinese_quantities_are_rejected_in_both_insight_and_single_work_text(source, quantity, field):
    facts = fact_sheet(source[1])
    response = valid(facts)
    response['insights'][0][field] = quantity
    with pytest.raises(ValueError):
        validate_insights(response, facts)
    finding = {'evidenceId': 'a:body', 'quote': '实际原文材料',
               'interpretation': '建议明确对象和使用场景', 'action': '补充可核验的信息来源'}
    finding['interpretation' if field == 'observation' else 'action'] = quantity
    with pytest.raises(ValueError):
        validate_findings({'findings': [finding]}, {'a:body': '实际原文材料'})


def test_unnumbered_action_remains_valid_when_quantity_version_would_be_rejected(source):
    facts = fact_sheet(source[1])
    response = valid(facts)
    response['insights'][0]['action'] = '补充具体问题，分别核对材料来源与适用场景'
    assert validate_insights(response, facts)[0]['action'] == response['insights'][0]['action']


def test_reviews_saved_under_older_validation_rules_are_hidden(source, monkeypatch):
    store, report = source
    with monkeypatch.context() as prior_rules:
        prior_rules.setattr('content_analysis.REVIEW_RULE_VERSION', 1)
        store.save_review('xiaohongshu', 'a', report['contents'][0], {'findings': []})
        store.save_insights('xiaohongshu', 'a', report['contents'], {'facts': [], 'insights': []})
        previous = store.report('xiaohongshu', 'a')
        assert previous['contents'][0]['aiReview'] is not None
        assert previous['accountInsights'] is not None
    current = store.report('xiaohongshu', 'a')
    assert current['contents'][0]['aiReview'] is None
    assert current['accountInsights'] is None


@pytest.mark.parametrize('payload,expected,status', [
 ({'insights': []}, '没有从当前材料中得出', 503),
 ({'findings': []}, '缺少跨作品解读列表', 503),
 ({'insights': [{'factIds': ['unknown'], 'observation': '材料可比较', 'action': '补充使用场景'}]}, '引用未匹配', 503),
])
def test_insight_failure_explains_actual_category_and_keeps_prior_result(source, monkeypatch, payload, expected, status):
 store,report=source
 prior={'facts':fact_sheet(report),'insights':valid(fact_sheet(report))['insights']}
 store.save_insights('xiaohongshu','a',report['contents'],prior)
 monkeypatch.setattr('content_analysis_ai.request_json',lambda *args:payload)
 with pytest.raises(HTTPException) as exc:insights(report,PROVIDER)
 assert exc.value.status_code==status
 assert expected in exc.value.detail
 assert '已有有效结果保留' in exc.value.detail
 assert store.report('xiaohongshu','a')['accountInsights']==prior


def test_insight_parse_failure_does_not_claim_unfounded_observation(source,monkeypatch):
 def bad(*args):raise json.JSONDecodeError('raw-secret-marker','private-marker',0)
 monkeypatch.setattr('content_analysis_ai.request_json',bad)
 with pytest.raises(HTTPException) as exc:insights(source[1],PROVIDER)
 assert exc.value.status_code==502
 assert 'JSON' in exc.value.detail and 'marker' not in exc.value.detail


def test_insight_reject_reasons_are_specific_without_model_text(source,monkeypatch):
 facts=fact_sheet(source[1]);payload=valid(facts)
 payload['insights'][0]['action']='获得100个关注 private-marker'
 payload['insights'].append({'factIds':[facts[0]['id']],'observation':'作品结构需要核对','action':'补充使用情境'})
 monkeypatch.setattr('content_analysis_ai.request_json',lambda *args:payload)
 with pytest.raises(HTTPException) as exc:insights(source[1],PROVIDER)
 assert '数字、效果归因' in exc.value.detail and '单篇作品' in exc.value.detail
 assert 'private-marker' not in exc.value.detail


@pytest.mark.parametrize('protocol,payload,expected', [
 ('openai',{'choices':[{'finish_reason':'length','message':{'content':''}}]},'长度上限'),
 ('anthropic',{'stop_reason':'max_tokens','content':[{'type':'text','text':'partial'}]},'长度上限'),
 ('openai',{'choices':[{'finish_reason':'stop','message':{'content':None,'reasoning_content':'private-marker'}}]},'没有返回解读正文'),
])
def test_response_truncation_and_reasoning_only_are_not_evidence_failures(monkeypatch,protocol,payload,expected):
 import content_analysis_ai as ai
 provider=Provider('test','Test','model',protocol,'https://example.invalid/v1','secret-marker')
 requests=[]
 class Reply:
  def __enter__(self):return self
  def __exit__(self,*args):pass
  def read(self,*args):return json.dumps(payload).encode()
 class Opener:
  def open(self,request,**kwargs):requests.append(json.loads(request.data));return Reply()
 monkeypatch.setattr(ai.urllib.request,'build_opener',lambda *args:Opener())
 with pytest.raises(ai.ModelResponseError) as exc:ai.request_json(provider,'rules','material')
 assert expected in str(exc.value) and 'private-marker' not in str(exc.value)
 assert requests[0]['max_tokens']==8192
