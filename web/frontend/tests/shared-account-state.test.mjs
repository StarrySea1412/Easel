import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new Window({url:'https://easel.test/'});
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const {createRoot} = await import('react-dom/client');
const {useAccountIdentities, accountConnection, setWhoamiCache, markWhoamiUnverified} = await loadTsModule('../src/lib/whoami.ts');
const {useSyncExternalStore} = await import('react');
const {loadComposerModel, saveComposerModel, subscribeComposerModel} = await loadTsModule('../src/lib/composerModel.ts');

test('mounted account consumers share login, uncertainty, cross-tab changes and explicit logout', async t => {
  const node=document.createElement('div'); document.body.append(node); const root=createRoot(node);
  function Consumer() { const identities=useAccountIdentities(); return createElement('span',null,accountConnection({loggedIn:true},identities.zhihu)); }
  t.after(async()=>{await act(async()=>root.unmount());node.remove();localStorage.clear();});
  await act(async()=>root.render(createElement('div',null,createElement(Consumer),createElement(Consumer))));
  const expect=state=>assert.deepEqual([...node.querySelectorAll('span')].map(item=>item.textContent),[state,state]);
  expect('unknown');
  await act(async()=>setWhoamiCache('zhihu',{loggedIn:true,verified:true,checkedAt:Date.now(),name:'shared',avatar:''})); expect('online');
  await act(async()=>markWhoamiUnverified('zhihu','timeout')); expect('unknown');
  await act(async()=>{localStorage.setItem('easel_whoami',JSON.stringify({zhihu:{loggedIn:false,authState:'login_required',verified:true,checkedAt:Date.now()}}));window.dispatchEvent(new window.StorageEvent('storage',{key:'easel_whoami'}));}); expect('login_required');
  await act(async()=>setWhoamiCache('zhihu',{loggedIn:false,authState:'not_connected',verified:true,checkedAt:Date.now(),name:'',avatar:''})); expect('not_connected');
});

test('model selection is shared by mounted composers and cross-tab changes', async t => {
  const node=document.createElement('div'); document.body.append(node); const root=createRoot(node);
  function Consumer(){ const value=useSyncExternalStore(subscribeComposerModel,loadComposerModel);return createElement('span',null,value); }
  t.after(async()=>{await act(async()=>root.unmount());node.remove();localStorage.clear();});
  await act(async()=>root.render(createElement('div',null,createElement(Consumer),createElement(Consumer))));
  await act(async()=>saveComposerModel('channel/model'));
  assert.deepEqual([...node.querySelectorAll('span')].map(item=>item.textContent),['channel/model','channel/model']);
  await act(async()=>{localStorage.setItem('easel_chat_model_ref','channel/other');window.dispatchEvent(new window.StorageEvent('storage',{key:'easel_chat_model_ref'}));});
  assert.deepEqual([...node.querySelectorAll('span')].map(item=>item.textContent),['channel/other','channel/other']);
});
test.after(()=>window.close());
