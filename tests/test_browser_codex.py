"""Protocol adapters only: no model call and no Codex process."""
import json
from pathlib import Path
import queue
import threading
import time
from types import SimpleNamespace

from easel.codex_service import CodexService
from easel.browser_runtime import BrowserService
from web.browser_api import save_evidence


def test_new_thread_registers_browser_and_images_resume_uses_cli_fallback(tmp_path, monkeypatch):
    calls=[]
    class Client:
        def rpc(self, method, params):
            calls.append((method,params))
            return {'turn':{'id':'provider-turn'}} if method == 'turn/start' else {'thread':{'id':'provider-thread'}}
        def subscribe(self, thread):
            events=queue.Queue()
            events.put({'method':'turn/completed','params':{'threadId':thread,'turn':{'status':'completed'}}})
            return events
        def unsubscribe(self, thread): pass
        def close(self): pass
    service=CodexService(tmp_path/'outputs',client_factory=lambda workspace:Client())
    browser=BrowserService(service.outputs)
    service.browser_service=browser
    model={'id':'codex/test','model':'test','thinkingLevels':['low'],'defaultEffort':'low'}
    monkeypatch.setattr(service,'runtime',lambda:{'available':True,'auth':'local_provider','defaultModelRef':model['id'],'options':[model]})
    sid='visual-chat'
    service.bind(sid,'codex')
    evidence=save_evidence(service.outputs,sid,b'\x89PNG-test','shot1')
    request=SimpleNamespace(sessionId=sid,turnId='turn1',selectedSkills=[],skillRequirements={},message='分析截图',
                            attachments=[SimpleNamespace(**evidence)],modelRef=model['id'],thinkingLevel='low')
    assert service.start(request) == 'turn1'
    until=time.monotonic()+5
    while sid in service.active and time.monotonic()<until:
        time.sleep(.01)
    assert sid not in service.active
    started=next(params for method,params in calls if method=='thread/start')
    assert any(tool['name']=='easel_browser' for tool in started['dynamicTools'])
    inputs=next(params['input'] for method,params in calls if method=='turn/start')
    image=next(item for item in inputs if item['type']=='localImage')
    assert Path(image['path']).read_bytes()==b'\x89PNG-test'
    request.turnId='turn2'
    service.start(request)
    until=time.monotonic()+5
    while sid in service.active and time.monotonic()<until:
        time.sleep(.01)
    resumed=next(params for method,params in calls if method=='thread/resume')
    assert 'dynamicTools' not in resumed
    assert 'browser_page.py' in resumed['developerInstructions'] and sid in resumed['developerInstructions']
    assert browser.browser is None, 'thread setup must not launch Chromium'
    browser.close()


def test_codex_worker_scopes_tool_and_stop_prevents_late_dispatch(tmp_path):
    class Client:
        def __init__(self):self.replies=[];self.ready=threading.Event()
        def reply(self, ident, result):self.replies.append(result);self.ready.set()
    browser=BrowserService(tmp_path)
    service=CodexService(tmp_path); service.browser_service=browser
    client=Client()
    run={'client':client,'state':{'sessionId':'current'},'browserJobs':set()}
    event={'id':7,'method':'item/tool/call','params':{'tool':'easel_browser','arguments':{'action':'state'}}}
    try:
        service._request(run,event)
        assert client.ready.wait(5)
        result=json.loads(client.replies[0]['contentItems'][0]['text'])
        assert result['sessionId']=='current' and result['tabs']==[]
        service._cancel_browser_jobs(run)
        event['params']['arguments']={'action':'create','requestId':'late'}
        service._request(run,event)
        until=time.monotonic()+3
        while run['browserJobs'] and time.monotonic()<until:time.sleep(.01)
        assert not run['browserJobs']
        assert browser.call('state','current')['tabs']==[]
    finally:
        browser.close()


def test_openclaw_context_contains_owned_image_and_browser_bridge_only_when_available(tmp_path, monkeypatch):
    import sys
    sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'web'))
    import app as web
    browser=BrowserService(tmp_path)
    monkeypatch.setattr(web,'OUTPUTS_DIR',tmp_path)
    monkeypatch.setattr(web,'_browser_service',browser)
    file=save_evidence(tmp_path,'owned',b'\x89PNG-test','shot')
    req=web.ChatRequest(sessionId='owned',message='分析',attachments=[file])
    first=web._chat_message(req)
    assert 'image/read' in first and str(tmp_path/file['path']) in first
    assert 'browser_page.py' not in first
    folder=browser._folder('owned');folder.mkdir(parents=True);(folder/'tabs.json').write_text('{"tabs":[]}')
    assert 'browser_page.py' in web._chat_message(req)
    from fastapi import HTTPException
    import pytest
    with pytest.raises(HTTPException):
        web._attachment_context(web.ChatRequest(sessionId='foreign',message='x',attachments=[file]))
    assert browser.loop is None
