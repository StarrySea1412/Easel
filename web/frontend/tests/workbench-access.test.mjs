import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new Window({url:'https://easel.test/'});
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const {createRoot} = await import('react-dom/client');
const {createWorkbenchAccess, workbenchAccess} = await loadTsModule('../src/lib/workbenchAccess.ts');
const {default:Notice} = await loadTsModule('../src/components/WorkbenchLoginNotice.tsx');
const expired = () => new Response('{"code":"workbench_login_required"}',{status:401,headers:{'X-Easel-Auth':'required'}});
const isLogin = e => e.status===401 && e.code==='workbench_login_required';

test('a workbench expiry notifies once, blocks polling and writes, and never replays pending work',async()=>{
 const access=createWorkbenchAccess();let notices=0,calls=0;
 access.subscribe(()=>notices++);
 let late;
 const guarded=access.guard(async input=>{calls++;return String(input).endsWith('/slow')?new Promise(resolve=>{late=resolve;}):expired();},'https://easel.test');
 const pending=guarded('/api/slow');
 await assert.rejects(guarded('/api/accounts'),isLogin);
 for(const path of ['/api/tasks','/api/accounts','/api/chat/stream'])await assert.rejects(guarded(path,{method:'POST'}),isLogin);
 assert.equal(calls,2);assert.equal(notices,1);
 late(new Response('{}'));await pending;
 assert.equal(access.snapshot(),true,'late successful reads cannot clear an expiry');
 assert.equal(notices,1);assert.equal(calls,2);
});

test('platform 401s, origin rejections and external 401s cannot expire the workbench',async()=>{
 const access=createWorkbenchAccess();let result=new Response('{}',{status:401});
 const guarded=access.guard(async()=>result,'https://easel.test');
 assert.equal((await guarded('/api/accounts/zhihu/whoami')).status,401);
 result=new Response('{}',{status:403});assert.equal((await guarded('/api/config')).status,403);
 result=expired();await guarded('https://platform.test/api/accounts');
 assert.equal(access.snapshot(),false);
 await assert.rejects(guarded(new Request('https://easel.test/api/accounts')),isLogin);
 assert.equal(access.snapshot(),true);
});

test('expiry shows one keyboard reachable login entry without replacing mounted work or stored drafts',async t=>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 t.after(async()=>{await act(async()=>root.unmount());host.remove();});
 window.localStorage.setItem('easel:chat-draft:original','saved draft');
 await act(async()=>root.render(createElement('div',null,createElement('textarea',{defaultValue:'unsent text'}),createElement(Notice))));
 const draft=host.querySelector('textarea');assert.equal(host.querySelector('[role=alert]'),null);
 const guarded=workbenchAccess.guard(async()=>expired(),'https://easel.test');
 await act(async()=>{await assert.rejects(guarded('/api/tasks'),isLogin);});
 const link=host.querySelector('[role=alert] a');assert.equal(link.getAttribute('href'),'/login');
 assert.equal(link.textContent,'重新登录工作台');link.focus();assert.equal(document.activeElement,link);
 assert.equal(host.querySelector('textarea'),draft);assert.equal(draft.value,'unsent text');
 assert.equal(window.localStorage.getItem('easel:chat-draft:original'),'saved draft');
});

test.after(()=>window.close());
