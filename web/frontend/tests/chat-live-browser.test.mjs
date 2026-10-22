import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {act,createElement} from 'react';
import {loadTsModule} from './load-ts.mjs';

globalThis.window=new Window({url:'https://easel.test/'});
globalThis.document=window.document;
globalThis.localStorage=window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const {default:Panel}=await loadTsModule('../src/components/ChatLiveBrowser.tsx',import.meta.url);
const {getChatDraft,setChatDraftText}=await loadTsModule('../src/lib/chatDrafts.ts',import.meta.url);
const element={ref:'e0',name:'姓名',role:'textbox',tag:'input',disabled:false,sensitive:false,x:10,y:20,width:100,height:30};
function state(sid,stale=false){return {sessionId:sid,workspaceId:'workspace',profile:'isolated',capabilities:[],
  tabs:[{id:'tab1',title:'实际页面',url:'https://example.com/',version:1,closed:false,stale}],
  snapshots:{tab1:{id:'shot1',tabId:'tab1',sessionId:sid,version:1,stale,source:'browser',capturedAt:'2026-10-19T10:00:00Z',
    title:'实际页面',url:'https://example.com/',text:'实际页面正文',selection:'',headings:[],viewport:{width:1280,height:800,scrollX:0,scrollY:0},elements:[element],frames:[],logs:[]}},jobs:[],events:[],controlOrigins:[]};}
const reply=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
async function setup(t,sid,initial=state(sid),active=false){
  const requests=[];
  t.mock.method(globalThis,'fetch',(url,options={})=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject})));
  const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
  await act(async()=>root.render(createElement(Panel,{sessionId:sid,active})));
  const respond=(index,data)=>act(async()=>requests[index].resolve(reply(data)));
  if(initial)await respond(0,initial);
  t.after(async()=>{await act(async()=>root.unmount());container.remove();});
  return {container,root,requests,respond,
    click:text=>act(async()=>[...container.querySelectorAll('button')].find(b=>b.textContent===text||b.getAttribute('aria-label')===text).click())};
}

test('analysis keeps existing drafts and screenshot attaches only to current chat',async t=>{
  const v=await setup(t,'visual-owner');setChatDraftText('visual-owner','已有草稿');setChatDraftText('visual-other','其他草稿');
  await v.click('带截图分析');assert.equal(v.requests.length,2);
  assert.match(v.requests[1].url,/visual-owner\/tabs\/tab1\/snapshots\/shot1\/attachment/);
  await v.respond(1,{file:{id:'file1',name:'实际截图.png',path:'_inbox/owned/batch/image.png'},snapshotId:'shot1'});
  const draft=getChatDraft('visual-owner');
  assert.match(draft.text,/^已有草稿/);assert.match(draft.text,/附带截图/);
  assert.match(draft.quotes[0],/shot1/);assert.match(draft.quotes[0],/实际页面正文/);
  assert.equal(draft.attachments[0].id,'file1');assert.equal(getChatDraft('visual-other').text,'其他草稿');
  assert.equal(v.requests.length,2,'no model request is made by analysis buttons');
});

test('download receipts distinguish pending and failed files, preserve ownership and add saved files to the current draft',async t=>{
  const data=state('download-owner');data.capabilities=['downloads'];
  data.downloads=[{id:'saved-file',tabId:'tab1',name:'报告.pdf',state:'completed',bytes:256,sourceUrl:'https://example.com/',createdAt:'2026-10-22',sha256:'a'.repeat(64),file:{id:'attachment-1',name:'报告.pdf',path:'_inbox/owned/download-guid/报告.pdf'}},
    {id:'pending-file',tabId:'tab1',name:'视频.mp4',state:'receiving',bytes:100,sourceUrl:'https://example.com/',createdAt:'2026-10-22'},
    {id:'failed-file',tabId:'tab1',name:'失效.pdf',state:'failed',bytes:0,error:'下载返回了网页',sourceUrl:'https://example.com/',createdAt:'2026-10-22'}];
  data.snapshots.tab1.downloadCandidates=[{ref:'e0',name:'下载报告',role:'button'}];
  const v=await setup(t,'download-owner',data);setChatDraftText('download-owner','保留草稿');
  await v.click('文件与下载');
  assert.equal(v.container.querySelectorAll('.browser-downloads a').length,1);
  assert.match(v.container.querySelector('.browser-downloads a').href,/download-owner\/downloads\/saved-file\/file$/);
  assert.match(v.container.querySelector('.browser-downloads').textContent,/正在下载/);
  assert.match(v.container.querySelector('.browser-downloads [role=alert]').textContent,/返回了网页/);
  await v.click('加入对话');
  assert.equal(getChatDraft('download-owner').attachments[0].id,'attachment-1');
  assert.equal(getChatDraft('download-owner').text,'保留草稿');
  await act(async()=>v.container.querySelector('.browser-downloads>button').click());
  const body=JSON.parse(v.requests[1].options.body);
  assert.equal(body.action,'download');assert.equal(body.ref,'e0');assert.equal(body.snapshotId,'shot1');
  await v.respond(1,{id:body.requestId,state:'completed',tabId:'tab1'});await v.respond(2,data);
  await act(async()=>v.root.render(createElement(Panel,{sessionId:'download-other',active:false})));
  await v.respond(3,state('download-other'));
  assert.equal(v.container.querySelector('.browser-downloads'),null,'old session file links cannot survive a session switch');
});

test('element actions use current ref and snapshot, failures remain visible after refresh',async t=>{
  const v=await setup(t,'element-owner');await v.click('查看页面元素');
  await act(async()=>v.container.querySelector('.browser-element-list button').click());
  await v.click('点击元素');
  const body=JSON.parse(v.requests[1].options.body);
  assert.equal(body.ref,'e0');assert.equal(body.snapshotId,'shot1');assert.equal(body.tabId,'tab1');
  await v.respond(1,{id:body.requestId,state:'failed',error:'元素已变化',tabId:'tab1'});
  await v.respond(2,state('element-owner',true));
  assert.match(v.container.querySelector('[role=alert]').textContent,/元素已变化/);
  assert.equal([...v.container.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='分析此页').disabled,true);
  await v.click('重新连接');await v.respond(3,state('element-owner',true));
  assert.equal(v.container.querySelector('[role=alert]'),null);
});

test('automatic viewport adaptation preserves actionable address errors',async t=>{
  const previous=globalThis.ResizeObserver;let resized;
  globalThis.ResizeObserver=class{constructor(callback){resized=callback;}observe(){}disconnect(){}};
  t.after(()=>{globalThis.ResizeObserver=previous;});
  const v=await setup(t,'resize-error');
  t.mock.method(v.container.querySelector('.browser-stage'),'getBoundingClientRect',()=>({width:640,height:480}));
  const input=v.container.querySelector('[aria-label="交互网页地址"]');
  await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,'ftp://invalid.example');input.dispatchEvent(new window.Event('input',{bubbles:true}));});
  await act(async()=>input.form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));
  assert.match(v.container.querySelector('[role=alert]').textContent,/HTTP或HTTPS/);
  await act(async()=>{resized();await new Promise(resolve=>setTimeout(resolve,400));});
  await act(async()=>v.root.render(createElement(Panel,{sessionId:'resize-error',active:true})));
  assert.equal(JSON.parse(v.requests[1].options.body).action,'resize');
  assert.match(v.container.querySelector('[role=alert]').textContent,/HTTP或HTTPS/);
  await v.respond(1,{id:'resize',state:'completed',tabId:'tab1'});
  const updated=state('resize-error');updated.snapshots.tab1.viewport={width:640,height:480};await v.respond(2,updated);
  assert.match(v.container.querySelector('[role=alert]').textContent,/HTTP或HTTPS/);
});

test('stop cancels exact operation and exposes stale observation',async t=>{
  const v=await setup(t,'cancel-owner');await v.click('重新观察');
  const id=JSON.parse(v.requests[1].options.body).requestId;
  await v.click('停止操作');assert.match(v.requests[2].url,new RegExp(`${id}/cancel$`));
  await v.respond(2,{id,state:'cancelled',error:'操作已中断'});
  await v.respond(3,state('cancel-owner',true));
  await v.respond(1,{id,state:'cancelled',error:'操作已中断',tabId:'tab1'});
  await v.respond(4,state('cancel-owner',true));
  assert.match(v.container.querySelector('[role=alert]').textContent,/操作已中断/);
});

test('late session response cannot replace current page or permission',async t=>{
  const v=await setup(t,'old-owner',null);
  await act(async()=>v.root.render(createElement(Panel,{sessionId:'new-owner',active:false})));
  await v.respond(1,state('new-owner'));await v.respond(0,state('old-owner'));
  assert.match(v.container.querySelector('img').src,/new-owner/);
  await act(async()=>v.container.querySelector('input[type=checkbox]').click());
  assert.match(v.requests[2].url,/new-owner\/control$/);
  await act(async()=>v.root.render(createElement(Panel,{sessionId:'third-owner',active:false})));
  await v.respond(3,state('third-owner'));
  const old=state('new-owner');old.controlOrigins=['https://example.com'];await v.respond(2,old);
  assert.equal(v.container.querySelector('input[type=checkbox]').checked,false);
  assert.match(v.container.querySelector('img').src,/third-owner/);
});

test('incompatible responses show reconnect and keyboard screenshot activation opens elements',async t=>{
  const v=await setup(t,'format-owner',{});
  assert.match(v.container.querySelector('[role=alert]').textContent,/格式不兼容/);
  await v.click('重新连接');await v.respond(1,state('format-owner'));
  await act(async()=>v.container.querySelector('.browser-screenshot').click());
  assert.ok(v.container.querySelector('.browser-element-list'));
  assert.equal(v.requests.length,2,'keyboard activation must not click coordinates 0,0');
});


test('page icons keep a default until loaded, reject remote URLs and recover from broken images',async t=>{
  // happy-dom loads data URLs synchronously. Hold that event to exercise pending state.
  let pending=true;
  const dispatch=window.HTMLImageElement.prototype.dispatchEvent;
  t.mock.method(window.HTMLImageElement.prototype,'dispatchEvent',function(event){
    if(pending&&event.type==='load')return true;
    return dispatch.call(this,event);
  });
  const data=state('icon-owner');data.tabs.push({...data.tabs[0],id:'tab2',title:'第二页'});
  data.snapshots.tab1.favicon='https://untrusted.test/icon.png';
  data.snapshots.tab2={...data.snapshots.tab1,tabId:'tab2',id:'shot2',favicon:'data:image/png;base64,aGVsbG8='};
  const v=await setup(t,'icon-owner',data);
  const icons=v.container.querySelectorAll('.browser-page-tabs .browser-site-icon');
  assert.ok(icons[0].querySelector('svg'),'external URL must retain the default without making a UI-origin request');
  assert.ok(icons[1].querySelector('img'));
  assert.ok(icons[1].querySelector('svg'),'pending image keeps the default icon visible');
  assert.equal(icons[1].querySelector('img').hidden,true);
  pending=false;
  await act(async()=>icons[1].querySelector('img').dispatchEvent(new window.Event('load')));
  assert.equal(icons[1].querySelector('svg'),null,'loaded site icon replaces the default');
  assert.equal(icons[1].querySelector('img').hidden,false);
  await act(async()=>icons[1].querySelector('img').dispatchEvent(new window.Event('error')));
  assert.ok(icons[1].querySelector('svg'),'broken site icon restores the default at the same size');
  assert.equal(icons[1].querySelector('img'),null);
});

test('live page accepts human input during an agent operation and resumes only after fresh evidence',async t=>{
  const sid='shared-live';const initial=state(sid);
  initial.capabilities=['live-input','user-takeover'];
  initial.jobs=[{id:'agent-busy',tabId:'tab1',state:'running',action:'navigate'}];
  const v=await setup(t,sid,initial,true);
  const surface=v.container.querySelector('.browser-live-surface');
  assert.ok(surface,'real time view is the default for a compatible backend');
  t.mock.method(surface,'getBoundingClientRect',()=>({left:0,top:0,width:1280,height:800}));
  await act(async()=>surface.dispatchEvent(new window.MouseEvent('mousedown',{bubbles:true,cancelable:true,clientX:15,clientY:25,button:0})));
  await act(async()=>new Promise(resolve=>setTimeout(resolve,70)));
  const input=v.requests.find(r=>r.url.endsWith('/input'));
  assert.deepEqual(JSON.parse(input.options.body).events,[{type:'click',x:15,y:25}]);
  await v.click('恢复Agent操作');
  assert.equal(v.requests.some(r=>r.url.endsWith('/takeover')),false,'cannot resume while input is unacknowledged');
  await v.respond(v.requests.indexOf(input),{ok:true,userControl:true});
  await v.click('恢复Agent操作');
  const resume=v.requests.find(r=>r.url.endsWith('/takeover'));
  assert.deepEqual(JSON.parse(resume.options.body),{enabled:false});
  const fresh=state(sid);fresh.capabilities=initial.capabilities;fresh.snapshots.tab1.id='fresh-after-input';
  await v.respond(v.requests.indexOf(resume),fresh);
  assert.equal(v.container.querySelector('[aria-label="恢复Agent操作"]'),null);
});

test('Chinese composition sends only committed text once and does not swallow navigation keys',async t=>{
  const sid='ime-live',initial=state(sid);initial.capabilities=['live-input'];
  const v=await setup(t,sid,initial,true);
  const input=v.container.querySelector('[aria-label="网页键盘输入"]');
  await act(async()=>{
    input.dispatchEvent(new window.CompositionEvent('compositionstart',{bubbles:true}));
    input.value='中文';input.dispatchEvent(new window.Event('input',{bubbles:true}));
    input.dispatchEvent(new window.KeyboardEvent('keydown',{bubbles:true,key:'Enter',isComposing:true}));
  });
  assert.equal(v.requests.filter(r=>r.url.endsWith('/input')).length,0,'intermediate IME text is local only');
  await act(async()=>{
    input.dispatchEvent(new window.CompositionEvent('compositionend',{bubbles:true,data:'中文'}));
    input.dispatchEvent(new window.Event('input',{bubbles:true}));
  });
  await act(async()=>new Promise(resolve=>setTimeout(resolve,70)));
  const sent=v.requests.find(r=>r.url.endsWith('/input'));
  assert.deepEqual(JSON.parse(sent.options.body).events,[{type:'text',text:'中文'}]);
  await v.respond(v.requests.indexOf(sent),{ok:true});
});

test('lost input acknowledgement is not retried and stale queued keys are discarded',async()=>{
  const {createLiveInput}=await loadTsModule('../src/lib/browserLive.ts',import.meta.url);
  const requests=[];const errors=[];
  const channel=createLiveInput('input-owner','tab1',(_url,options)=>new Promise((resolve,reject)=>requests.push({options,resolve,reject})));
  channel.onError(message=>errors.push(message));
  channel.send({type:'text',text:'a'});
  await new Promise(resolve=>setTimeout(resolve,70));
  channel.send({type:'key',key:'Enter'});
  requests[0].reject(new Error('lost ack'));
  await new Promise(resolve=>setTimeout(resolve,70));
  assert.equal(requests.length,1);assert.equal(channel.pending(),false);assert.equal(errors.length,1);
  channel.close();
});

test('late resume response cannot clear takeover or replace evidence on another tab',async t=>{
  const sid='resume-tabs',initial=state(sid);
  initial.capabilities=['live-input'];initial.tabs[0].userControl=true;
  initial.tabs.push({...initial.tabs[0],id:'tab2',title:'第二页'});
  initial.snapshots.tab2={...initial.snapshots.tab1,tabId:'tab2',id:'shot2'};
  const v=await setup(t,sid,initial,true);
  await v.click('实际页面');
  await v.click('恢复Agent操作');
  const resume=v.requests.find(r=>r.url.endsWith('/takeover'));
  assert.match(resume.url,/tab1\/takeover$/);
  await v.click('第二页');
  const old=structuredClone(initial);old.tabs.forEach(tab=>{tab.userControl=false;});
  await v.respond(v.requests.indexOf(resume),old);
  assert.ok(v.container.querySelector('[aria-label="恢复Agent操作"]'),'second tab remains under human control');
  assert.match(v.container.querySelector('.browser-live-stage img').src,/tab2\/cast\?/);
});
