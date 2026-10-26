import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// Real editor/hook with ordinary synthetic HTTP fixtures; never contacts a platform.
globalThis.window = new JSDOM('<!doctype html><html><body></body></html>', {url:'https://easel.test/',pretendToBeVisual:true}).window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis,'navigator',{configurable:true,value:window.navigator});
Object.defineProperty(globalThis,'localStorage',{configurable:true,value:window.localStorage});
const {createRoot} = await import('react-dom/client');
const {default:PublishPage} = await loadTsModule('../src/components/PublishPage.tsx');
const {usePublishReceipts} = await loadTsModule('../src/hooks/usePublishReceipts.ts');
const workspace = await loadTsModule('../src/lib/creationWorkspace.ts');
const own = workspace.ensureCreation('publish','handoff-chat');
const item = {id:'a'.repeat(32),sessionId:'handoff-chat',turnId:'writing-turn',createdAt:1,state:'prepared',
  draft:{title:'合成助手稿',body:'已核对的合成正文',platforms:['zhihu'],overrides:{},tags:'',media:['cover.png']}};
const initial = {title:'保留的标题',body:'保留的人工草稿',platforms:[],overrides:{},tags:'',media:[]};
const deferred = () => {let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

async function setup(t,{editor=true}={}) {
  localStorage.clear();workspace.saveCreationDraft(own,initial);
  const h={requests:[],checked:null,accept:null,model:null};
  t.mock.method(globalThis,'fetch',async(url,options={})=>{
    const path=String(url),body=options.body?JSON.parse(options.body):null;
    h.requests.push({path,body});let value;
    if(path==='/api/chat/artifacts/handoff-chat') value={sessionId:'handoff-chat',artifacts:[],creationDrafts:[item]};
    else if(path.endsWith('/drafts/'+item.id)) value=h.checked?await h.checked():item;
    else if(path.endsWith('/drafts/'+item.id+'/accept')) value=h.accept?await h.accept(body):{id:'b'.repeat(32),sessionId:'handoff-chat',preparationId:item.id,platform:body.platform};
    else if(path==='/api/publish/receipts') value=[];
    else if(path==='/api/publish/zhihu') value={receiptId:'c'.repeat(32),platform:'zhihu',title:body.title,createdAt:'2026-10-26',updatedAt:'2026-10-26',state:'finished',outcome:'draft',message:'合成平台草稿回执'};
    else if(path==='/api/accounts'||path==='/api/outputs') value=[];
    else if(path==='/api/diagnostics/failures') value={eventId:'f'.repeat(32)};
    else throw new Error('Unexpected fixture route: '+path);
    return value instanceof Response?value:new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
  });
  const container=document.createElement('div');document.body.append(container);
  const root=createRoot(container);
  function Shell({generation}) {
    h.model=usePublishReceipts();
    return editor?createElement(PublishPage,{key:generation,workspaceId:own.id,sourceSessionId:'handoff-chat',persona:'原会话画像',publishReceipts:h.model,getSourceText:()=>'',active:true}):null;
  }
  const render=generation=>act(async()=>root.render(createElement(Shell,{generation})));
  await render(0);
  t.after(async()=>{await act(async()=>root.unmount());container.remove();});
  const button=text=>[...container.querySelectorAll('button')].find(node=>node.textContent.trim()===text);
  const click=async text=>{
    await act(async()=>{assert.ok(button(text));button(text).click();});
    const dialog=document.querySelector('[role=dialog][aria-describedby]');
    if(dialog)await act(async()=>[...dialog.querySelectorAll('button')].find(node=>['保存并载入','确定'].includes(node.textContent.trim())).click());
  };
  return {h,container,render,button,click};
}

test('checked assistant draft keeps its origin and previous editor version across remount',async t=>{
  const view=await setup(t);await view.click('载入编辑');
  assert.equal(workspace.readCreationDraft(own).preparationId,item.id);
  assert.equal(workspace.previousCreationDraft(own).body,initial.body);
  await view.render(1);
  assert.ok(view.button('已载入'));
  assert.equal(workspace.readCreationDraft(own).body,item.draft.body);
  await view.click('恢复上一稿');
  assert.equal(workspace.readCreationDraft(own).body,initial.body);
  assert.equal(workspace.readCreationDraft(own).preparationId,undefined);
});

test('source version conflict leaves existing editor and previous version untouched',async t=>{
  const view=await setup(t);
  view.h.checked=()=>new Response(JSON.stringify({detail:'草稿素材已变化，请重新准备'}),{status:409});
  await view.click('载入编辑');
  assert.equal(workspace.readCreationDraft(own).body,initial.body);
  assert.equal(workspace.readCreationDraft(own).preparationId,undefined);
  assert.equal(view.h.requests.filter(request=>request.path==='/api/publish/zhihu').length,0);
});

test('edits during a draft read are preserved when its response arrives',async t=>{
  const view=await setup(t),gate=deferred();view.h.checked=()=>gate.promise;
  await view.click('载入编辑');
  const area=[...view.container.querySelectorAll('textarea')].find(node=>node.value===initial.body);
  assert.ok(area);
  await act(async()=>{
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(area,'读取期间继续编辑');
    area.dispatchEvent(new window.Event('input',{bubbles:true}));
  });
  await act(async()=>gate.resolve(item));
  assert.equal(workspace.readCreationDraft(own).body,'读取期间继续编辑');
  assert.equal(workspace.readCreationDraft(own).preparationId,undefined);
});

test('confirmed batch seals its immutable edited payload before submission',async t=>{
  const view=await setup(t,{editor:false}),gate=deferred();view.h.accept=body=>{assert.equal(body.accountIdentity,'fixed-account');return gate.promise;};
  const requests=[{platform:'zhihu',sourceSessionId:'handoff-chat',preparationId:item.id,accountIdentity:'fixed-account',payload:{title:'用户确认',body:'编辑后的正文',media:['cover.png'],tags:'',persona:'原会话画像'}}];
  let pending;await act(async()=>{pending=view.h.model.submit(requests);});
  requests[0].payload.body='后来改动';requests[0].payload.media.push('later.png');
  assert.equal(view.h.requests.filter(request=>request.path==='/api/publish/zhihu').length,0);
  await act(async()=>{gate.resolve({id:'b'.repeat(32),sessionId:'handoff-chat',preparationId:item.id,platform:'zhihu'});await pending;});
  const submitted=view.h.requests.find(request=>request.path==='/api/publish/zhihu').body;
  assert.equal(submitted.body,'编辑后的正文');assert.deepEqual(submitted.media,['cover.png']);
  assert.equal(submitted.acceptanceId,'b'.repeat(32));assert.equal(submitted.sourceSessionId,'handoff-chat');
});

test('acceptance conflict never submits the platform payload',async t=>{
  const view=await setup(t,{editor:false});
  view.h.accept=()=>new Response(JSON.stringify({detail:'原分析已变化，请重新准备'}),{status:409});
  await act(async()=>view.h.model.submit([{platform:'zhihu',sourceSessionId:'handoff-chat',preparationId:item.id,payload:{title:'合成稿',body:'合成正文',media:[]}}]));
  assert.equal(view.h.requests.filter(request=>request.path==='/api/publish/zhihu').length,0);
  assert.match(view.h.model.submissionIssues[0].message,/原分析已变化/);
});
