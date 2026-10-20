import asyncio
import json
import sys
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from content_analysis import Store
from analysis_conversations import AnalysisConversations
from account_analytics_snapshots import AnalyticsSnapshots
from content_analysis_routes import create_router


def seeded(tmp_path):
    store = Store(tmp_path)
    store.ingest({'platform':'douyin', 'accountId':'owner', 'name':'本人', 'contents':[
        {'id':'n1','title':'篮球混剪','transcript':'实际转写材料','metrics':{'views':13}},
        {'id':'n2','title':'另一个真实作品','body':'正文证据','metrics':{'likes':0}}]})
    return store, AnalysisConversations(store)


def test_prepare_real_markdown_scoped_to_account_or_work(tmp_path):
    store, service = seeded(tmp_path)
    context = service.prepare({'platform':'douyin','accountId':'owner','sessionId':'chat-one','contentId':'n1'})
    assert context['kind'] == 'content-analysis' and context['contentIds'] == ['n1']
    assert '实际转写材料' in context['markdown'] and '13' in context['markdown']
    assert '另一个真实作品' not in context['markdown']
    assert context['result'] is None and not service.list('douyin','owner')[0]['stale']
    assert AnalysisConversations(Store(tmp_path)).list('douyin','owner')[0]['id'] == context['id']
    assert service.list('douyin','different') == []


def test_writeback_persists_markdown_source_turn_and_rejects_wrong_chat(tmp_path):
    _, service = seeded(tmp_path)
    context = service.prepare({'platform':'douyin','accountId':'owner','sessionId':'chat-one'})
    data = {'sessionId':'chat-one','turnId':'turn-1','markdown':'## 具体分析\n作品 n1 是篮球混剪，现有文字不足以判断视频开头。'}
    with pytest.raises(ValueError, match='不匹配'):
        service.save_result(context['id'],{**data,'sessionId':'other'})
    result = service.save_result(context['id'],data)
    assert result['result']['turnId'] == 'turn-1' and result['status'] == 'completed'
    assert AnalysisConversations(Store(tmp_path)).list('douyin','owner')[0]['result']['markdown'] == data['markdown']
    with pytest.raises(ValueError):
        service.save_result(context['id'],{**data,'markdown':''})
    assert service.list('douyin','owner')[0]['result'] == result['result']


def test_changed_material_rejects_late_result_and_retains_original_report(tmp_path):
    store, service = seeded(tmp_path)
    context = service.prepare({'platform':'douyin','accountId':'owner','sessionId':'chat-one'})
    old = service.save_result(context['id'],{'sessionId':'chat-one','turnId':'t1','markdown':'原先的分析结果引用作品n1，包含实际材料和局限说明。'})
    store.ingest({'platform':'douyin','accountId':'owner','contents':[{'id':'n1','title':'材料已经改变'}]})
    with pytest.raises(ValueError, match='材料已更新'):
        service.save_result(context['id'],{'sessionId':'chat-one','turnId':'t2','markdown':'这是旧材料迟到的响应，需要阻止覆盖最新作品对应的报告。'})
    current = service.list('douyin','owner')[0]
    assert current['stale'] and current['result'] == old['result']


def test_http_prepare_read_writeback_never_calls_model_or_collector(tmp_path):
    seeded(tmp_path)
    async def prohibited(*args):
        pytest.fail('Analysis preparation must never call the model or platform')
    app = FastAPI()
    app.include_router(create_router(lambda:tmp_path, prohibited, prohibited))
    async def exercise():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://local') as client:
            prepared = await client.post('/api/content-analysis/conversations',json={'platform':'douyin','accountId':'owner','sessionId':'chat-1'})
            assert prepared.status_code == 200
            context = prepared.json()
            response = await client.post('/api/content-analysis/conversations/'+context['id']+'/result',json={'sessionId':'chat-1','turnId':'turn-1','markdown':'## 来自实际对话的分析\n引用作品n1，缺少音视频材料时不能判断节奏。'})
            assert response.status_code == 200
            restored = (await client.get('/api/content-analysis/conversations?platform=douyin&accountId=owner')).json()
            assert restored['conversations'][0]['result']['turnId'] == 'turn-1'
            wrong = await client.post('/api/content-analysis/conversations',json={'platform':'douyin','accountId':'owner','sessionId':'chat-2','contentId':'not-own'})
            assert wrong.status_code == 400
    asyncio.run(exercise())


def test_snapshots_keep_success_and_separate_login_identity(tmp_path):
    store = AnalyticsSnapshots(tmp_path)
    original = {'platform':'douyin','loggedIn':True,'nickname':'本人','followers':17}
    store.save('douyin','identity-a',original)
    store.save('douyin','identity-a',{'loggedIn':False})
    assert AnalyticsSnapshots(tmp_path).get('douyin','identity-a') == original
    assert store.get('douyin','identity-b') is None


def test_account_capture_survives_request_cancellation_and_deduplicates(tmp_path, monkeypatch):
    import app as web
    monkeypatch.setattr(web,'OUTPUTS_DIR',tmp_path)
    monkeypatch.setattr(web,'_account_identity_key',lambda _: 'identity-a')
    monkeypatch.setattr(web,'_content_analysis_session_generation',lambda _: 'generation-a')
    async def exercise():
        started, finish = asyncio.Event(), asyncio.Event()
        calls=[]
        async def capture(platform):
            calls.append(platform); started.set(); await finish.wait()
            return {'platform':platform,'loggedIn':True,'accountId':'owner','nickname':'本人','notes':[{'id':'n1','title':'真实作品','metrics':{'views':3}}]}
        monkeypatch.setattr(web,'_capture_account_analytics',capture)
        first = asyncio.create_task(web.api_analytics('douyin'))
        await started.wait()
        first.cancel()
        with pytest.raises(asyncio.CancelledError): await first
        status = await web.api_analytics_snapshot('douyin')
        assert status['running'] and status['data'] is None
        second = asyncio.create_task(web.api_analytics('douyin'))
        await asyncio.sleep(0)
        finish.set()
        assert (await second)['nickname'] == '本人' and calls == ['douyin']
        snapshot = await web.api_analytics_snapshot('douyin')
        assert snapshot['data']['nickname'] == '本人' and not snapshot['running']
        assert Store(tmp_path/'_analytics'/'workbench').report('douyin','owner')['contents'][0]['id'] == 'n1'
    asyncio.run(exercise())
