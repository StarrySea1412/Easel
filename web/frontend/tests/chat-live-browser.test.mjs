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
async function setup(t,sid,initial=state(sid)){
  const requests=[];
  t.mock.method(globalThis,'fetch',(url,options={})=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject})));
  const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
  await act(async()=>root.render(createElement(Panel,{sessionId:sid,active:false})));
  const respond=(index,data)=>act(async()=>requests[index].resolve(reply(data)));
  if(initial)await respond(0,initial);
  t.after(async()=>{await act(async()=>root.unmount());container.remove();});
  return {container,root,requests,respond,
    click:text=>act(async()=>[...container.querySelectorAll('button')].find(b=>b.textContent===text).click())};
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

test('element actions use current ref and snapshot, failures remain visible after refresh',async t=>{
  const v=await setup(t,'element-owner');await v.click('元素');
  await act(async()=>v.container.querySelector('.browser-element-list button').click());
  await v.click('点击元素');
  const body=JSON.parse(v.requests[1].options.body);
  assert.equal(body.ref,'e0');assert.equal(body.snapshotId,'shot1');assert.equal(body.tabId,'tab1');
  await v.respond(1,{id:body.requestId,state:'failed',error:'元素已变化',tabId:'tab1'});
  await v.respond(2,state('element-owner',true));
  assert.match(v.container.querySelector('[role=alert]').textContent,/元素已变化/);
  assert.equal([...v.container.querySelectorAll('button')].find(b=>b.textContent==='分析此页').disabled,true);
  await v.click('重新连接');await v.respond(3,state('element-owner',true));
  assert.equal(v.container.querySelector('[role=alert]'),null);
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
