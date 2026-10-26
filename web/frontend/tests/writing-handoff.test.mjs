import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new JSDOM('<!doctype html><html><body></body></html>', {url:'https://easel.test/',pretendToBeVisual:true}).window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis,'navigator',{configurable:true,value:window.navigator});
Object.defineProperty(globalThis,'localStorage',{configurable:true,value:window.localStorage});
const {createRoot} = await import('react-dom/client');
const writing = await loadTsModule('../src/lib/writingHandoff.ts');
const drafts = await loadTsModule('../src/lib/chatDrafts.ts');
const store = await loadTsModule('../src/lib/store.ts');
const {default:Panel} = await loadTsModule('../src/components/ChatAnalysisPanel.tsx');
const binding = {id:'analysis-binding',platform:'zhihu',accountId:'isolated-owner',accountName:'隔离合成账号',sessionId:'analysis-chat',kind:'account-analysis',contentIds:['sample'],sourceHash:'materials',markdown:'合成原始材料',createdAt:'2026-10-26',status:'completed',result:{markdown:'## 合成分析\n仅作流程验证。',turnId:'analysis-turn',at:'2026-10-26',notice:'合成样例'}};
const source = {id:'analysis-chat',title:'合成分析',messages:[],created:1,engine:'codex',persona:'隔离画像',analysisContext:binding};
const context = {id:'handoff',sessionId:'write-sample',sourceSessionId:source.id,bindingId:binding.id,platform:'zhihu',accountId:binding.accountId,sourceTurnId:'analysis-turn',sourceHash:'version',engine:'codex',persona:'隔离画像',createdAt:2};

test('intake carries the original persona and engine without starting generation',async t=>{
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url:String(url),body:JSON.parse(options.body)});return new Response(JSON.stringify(context));});
  assert.deepEqual(await writing.prepareWriting(source),context);
  assert.equal(calls.length,1);
  assert.match(calls[0].url,/conversations\/analysis-binding\/writing$/);
  assert.deepEqual(calls[0].body,{sourceSessionId:source.id,persona:'隔离画像',engine:'codex'});
});

test('writing is a separate persistent session and repeat intake preserves draft text',()=>{
  const target=writing.writingSession(source,context,[]);
  assert.equal(target.analysisContext,undefined);
  assert.equal(target.conversationType,'content-generation');
  assert.deepEqual(source.analysisContext,binding);
  writing.seedWritingDraft(target);
  drafts.setChatDraftText(target.id,'用户已修改的写作要求');
  const same=writing.writingSession(source,context,[target]);
  writing.seedWritingDraft(same);
  assert.equal(same,target);
  assert.equal(drafts.getChatDraft(target.id).text,'用户已修改的写作要求');
  assert.ok(store.saveSessions([source,target]));
  assert.deepEqual(store.loadSessions().find(item=>item.id===target.id).writingContext,context);
});

async function panel(t,{stale=false,onWrite=async()=>{}}={}) {
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({conversations:[{...binding,stale}]})));
  const container=document.createElement('div');document.body.append(container);
  const root=createRoot(container);
  await act(async()=>root.render(createElement(Panel,{session:source,onWriteFromAnalysis:onWrite})));
  t.after(async()=>{await act(async()=>root.unmount());container.remove();});
  return {container,button:[...container.querySelectorAll('button')].find(node=>node.textContent.includes('据此写一篇'))};
}

test('failed intake preserves the report, shows the failure and permits retry',async t=>{
  const view=await panel(t,{onWrite:async()=>{throw new Error('原分析已变化，请重新准备');}});
  await act(async()=>view.button.click());
  assert.match(view.container.querySelector('[role=alert]').textContent,/原分析已变化/);
  assert.match(view.container.querySelector('[aria-label="已回填的分析报告"]').textContent,/合成分析/);
  assert.equal(view.button.disabled,false);
  assert.equal(view.container.querySelector('.analysis-memory-candidate').open,false);
});

test('an active intake is single-click and stale material disables the writing entry',async t=>{
  let finish,calls=0;const pending=new Promise(resolve=>{finish=resolve;});
  const view=await panel(t,{onWrite:()=>{calls++;return pending;}});
  await act(async()=>view.button.click());
  assert.equal(view.button.disabled,true);
  await act(async()=>view.button.click());
  assert.equal(calls,1);
  await act(async()=>finish());
  assert.equal(view.button.disabled,false);
  const stale=await panel(t,{stale:true});
  assert.equal(stale.button.disabled,true);
});
