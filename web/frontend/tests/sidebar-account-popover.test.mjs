import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';
// Controlled local reads + simulated DOM; browser layout is verified separately.
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: Popover } = await loadTsModule('../src/components/SidebarAccountPopover.tsx', import.meta.url);
const { setWhoamiCache, markWhoamiUnverified } = await loadTsModule('../src/lib/whoami.ts');
const { sidebarAccountInventory } = await loadTsModule('../src/lib/sidebarAccountInventory.ts');
const defaults=()=>[{platform:'zhihu',supported:true,loggedIn:true,hasLocalSession:true,note:'PRIVATE_SESSION'}];
const account=(id,status='ready',patch={})=>({accountId:id,platform:'douyin',label:'品牌 '+id,name:'昵称 '+id,status,busy:false,checkedAt:new Date().toISOString(),...patch});
const response=value=>({ok:true,json:async()=>value});
async function fixture(t){
 localStorage.clear();const requests=[],state={read:async url=>response(url==='/api/accounts'?defaults():[]),visits:[]};
 t.mock.method(globalThis,'fetch',async(url,options)=>{requests.push({url,options});return state.read(url);});
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
 await act(async()=>root.render(createElement(Popover,{active:false,onNavigate:target=>state.visits.push(target)})));
 t.after(async()=>{await act(async()=>root.unmount());container.remove();});const trigger=container.querySelector('button');
 return {state,requests,trigger,panel:()=>document.querySelector('.sidebar-account-popover'),open:async()=>act(async()=>trigger.click()),escape:async()=>act(async()=>document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})))};
}
test('reads both inventories only; unknown remains unknown and raw data never renders',async t=>{
 const v=await fixture(t);assert.deepEqual(v.requests,[]);await v.open();
 assert.deepEqual(v.requests.map(r=>r.url),['/api/accounts','/api/social-accounts']);assert.equal(v.requests[0].options.cache,'no-store');
 assert.match(v.panel().textContent,/1 个平台 · 1 个账号/);assert.match(v.panel().textContent,/待确认/);assert.doesNotMatch(v.panel().textContent,/PRIVATE_SESSION|已退出|均未登录/);
 await act(async()=>v.panel().querySelector('.sidebar-account-open').click());assert.deepEqual(v.state.visits,[undefined]);assert.equal(v.panel(),null);
});
test('mixed same-platform statuses remain independent; abnormal groups are first and expanded',async t=>{
 const v=await fixture(t);await act(async()=>setWhoamiCache('zhihu',{loggedIn:true,verified:true,checkedAt:Date.now(),name:'默认甲',avatar:''}));
 v.state.read=async url=>response(url==='/api/accounts'?defaults():[account('a'),account('b','login_required'),account('c','unverified')]);await v.open();
 assert.match(v.panel().textContent,/2 个平台 · 4 个账号/);assert.match(v.panel().querySelector('.sidebar-account-summary').textContent,/2 在线 · 1 需处理 · 1 待确认/);
 const groups=[...v.panel().querySelectorAll('.sidebar-account-group')];assert.match(groups[0].textContent,/抖音/);assert.equal(groups[0].querySelector('button').getAttribute('aria-expanded'),'true');assert.equal(groups[1].querySelector('button').getAttribute('aria-expanded'),'false');
 for(const state of ['online','attention','unknown'])assert.equal(groups[0].querySelectorAll('.is-'+state).length,1);
 const target=groups[0].querySelector('.is-attention');assert.match(target.title,/上次核验/);await act(async()=>target.click());assert.deepEqual(v.state.visits,['b']);
});
test('default and create actions keep exact targets without mutation requests',async t=>{
 const v=await fixture(t);await v.open();await act(async()=>v.panel().querySelector('.sidebar-account-row').click());await v.open();await act(async()=>v.panel().querySelector('.sidebar-account-add').click());
 assert.deepEqual(v.state.visits,['default:zhihu','create']);assert.ok(v.requests.every(r=>!r.options.method||r.options.method==='GET'));
});
test('duplicate labels use distinct identifiers and busy, stale or future proof never appears online',()=>{
 const now=Date.now(),rows=[account('abcdef1','ready',{label:'同名',name:'同名'}),account('abcdef2','ready',{label:'同名',name:'同名',busy:true}),account('stale','ready',{checkedAt:new Date(now-600001).toISOString()}),account('future','ready',{checkedAt:new Date(now+60000).toISOString()})];
 const [g]=sidebarAccountInventory([],rows,{},new Set(),false,now);assert.equal(g.online,1);assert.equal(g.busy,1);assert.equal(g.unknown,2);assert.notEqual(g.accounts[0].detail,g.accounts[1].detail);assert.equal(g.accounts[1].status,'操作中');
 assert.doesNotMatch(JSON.stringify(sidebarAccountInventory([],rows,{},new Set(),true,now)),/同名|编号/);
});
test('privacy masks visible text, title and accessible labels immediately and after reopening',async t=>{
 const v=await fixture(t);v.state.read=async url=>response(url==='/api/accounts'?[]:[account('a','ready',{label:'私密备注',name:'私密昵称'})]);await v.open();assert.match(v.panel().innerHTML,/私密备注/);
 await act(async()=>{localStorage.setItem('easel_account_privacy','1');window.dispatchEvent(new window.Event('easel:account-privacy'));});assert.doesNotMatch(v.panel().innerHTML,/私密备注|私密昵称/);assert.match(v.panel().textContent,/独立账号 1/);
 await v.escape();await v.open();assert.doesNotMatch(v.panel().innerHTML,/私密备注|私密昵称/);
});
test('reopening removes old success, and a partial failure never reuses green rows',async t=>{
 const v=await fixture(t);v.state.read=async url=>response(url==='/api/accounts'?[]:[account('a')]);await v.open();assert.ok(v.panel().querySelector('.is-online'));await v.escape();assert.equal(document.activeElement,v.trigger);let fail;
 v.state.read=url=>url==='/api/accounts'?Promise.resolve(response([])):new Promise((_,reject)=>{fail=reject;});await v.open();assert.match(v.panel().textContent,/正在读取本次/);assert.equal(v.panel().querySelector('.is-online'),null);
 await act(async()=>fail(Error('PRIVATE_BACKEND')));assert.match(v.panel().textContent,/暂时无法读取/);assert.doesNotMatch(v.panel().textContent,/PRIVATE_BACKEND/);assert.equal(v.panel().querySelector('.sidebar-account-summary'),null);assert.ok(v.requests.slice(-2).every(r=>r.options.signal.aborted));
});
test('closed preview aborts both reads and ignores late old success',async t=>{
 const v=await fixture(t);let finish;v.state.read=url=>url==='/api/accounts'?Promise.resolve(response([])):new Promise(resolve=>{finish=resolve;});await v.open();await v.escape();assert.ok(v.requests.every(r=>r.options.signal.aborted));
 v.state.read=async()=>response([]);await v.open();await act(async()=>finish(response([account('old')])));assert.match(v.panel().textContent,/0 个平台 · 0 个账号/);assert.doesNotMatch(v.panel().textContent,/品牌 old/);
});
test('keyboard focus enters preview, controls expansion and restores focus on dismissal',async t=>{
 const v=await fixture(t);await act(async()=>v.trigger.focus());await act(async()=>v.trigger.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})));assert.equal(document.activeElement,v.panel().querySelector('[aria-label="关闭账号预览"]'));
 const group=v.panel().querySelector('.sidebar-account-group-toggle');for(const [key,value] of [['ArrowLeft','false'],['ArrowRight','true']]){await act(async()=>group.dispatchEvent(new window.KeyboardEvent('keydown',{key,bubbles:true})));assert.equal(group.getAttribute('aria-expanded'),value);}
 await act(async()=>document.body.dispatchEvent(new window.PointerEvent('pointerdown',{bubbles:true})));assert.equal(v.panel(),null);assert.equal(document.activeElement,v.trigger);
});
test('hover makes just two reads and leaving closes preview',async t=>{
 const v=await fixture(t);await act(async()=>v.trigger.dispatchEvent(new window.MouseEvent('mouseover',{bubbles:true})));assert.ok(v.panel());assert.equal(v.requests.length,2);
 await act(async()=>{v.trigger.dispatchEvent(new window.MouseEvent('mouseout',{bubbles:true,relatedTarget:document.body}));await new Promise(resolve=>setTimeout(resolve,220));});assert.equal(v.panel(),null);
});
test('empty inventory provides add without seven placeholder accounts',async t=>{
 const v=await fixture(t);v.state.read=async()=>response([]);await v.open();assert.match(v.panel().textContent,/尚未添加账号/);assert.equal(v.panel().querySelectorAll('li').length,0);assert.ok(v.panel().querySelector('.sidebar-account-add'));
});
test('shared default evidence changes in place without causing HTTP refresh loops',async t=>{
 const v=await fixture(t);await v.open();await act(async()=>setWhoamiCache('zhihu',{loggedIn:true,verified:true,checkedAt:Date.now(),name:'shared',avatar:''}));assert.ok(v.panel().querySelector('.is-online'));assert.equal(v.panel().querySelector('.sidebar-account-name').textContent,'shared');
 await act(async()=>markWhoamiUnverified('zhihu','检查超时'));assert.ok(v.panel().querySelector('.is-unknown'));assert.equal(v.requests.length,2);assert.doesNotMatch(v.panel().textContent,/已退出/);
});
test('health event refreshes independent status; refresh failure clears prior online proof',async t=>{
 const v=await fixture(t);v.state.read=async url=>response(url==='/api/accounts'?[]:[account('a')]);await v.open();v.state.read=async url=>response(url==='/api/accounts'?[]:[account('a','login_required')]);await act(async()=>window.dispatchEvent(new window.Event('easel:account-health')));assert.ok(v.panel().querySelector('.is-attention'));assert.equal(v.requests.length,4);
 v.state.read=async()=>{throw Error('PRIVATE');};await act(async()=>window.dispatchEvent(new window.Event('easel:account-health')));assert.equal(v.panel().querySelectorAll('.sidebar-account-row').length,0);assert.match(v.panel().textContent,/暂时无法读取/);
});
test('another sidebar panel closes preview without refocusing it',async t=>{
 const v=await fixture(t);await v.open();await act(async()=>window.dispatchEvent(new window.CustomEvent('easel:sidebar-panel',{detail:'notification-center'})));assert.equal(v.panel(),null);assert.equal(v.trigger.getAttribute('aria-expanded'),'false');
});
test('workbench expiry offers login without exposing backend details or claiming platform logout',async t=>{
 const v=await fixture(t);v.state.read=async()=>{throw Object.assign(Error('PRIVATE_AUTH'),{status:401,code:'workbench_login_required'});};await v.open();assert.match(v.panel().textContent,/工作台登录已过期/);assert.doesNotMatch(v.panel().textContent,/PRIVATE_AUTH|均未登录/);assert.equal(v.panel().querySelector('a').getAttribute('href'),'/login');
});
test('ordinary business 401 remains retryable read failure',async t=>{
 const v=await fixture(t);v.state.read=async()=>({ok:false,status:401,json:async()=>({detail:'PRIVATE_PLATFORM'})});await v.open();assert.match(v.panel().textContent,/暂时无法读取，请重试/);assert.doesNotMatch(v.panel().textContent,/工作台登录已过期|PRIVATE_PLATFORM/);assert.equal(v.panel().querySelector('a'),null);
});
test('timeout aborts both reads; retry works and discards late success',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const v=await fixture(t);let finish;v.state.read=url=>url==='/api/accounts'?Promise.resolve(response([])):new Promise(resolve=>{finish=resolve;});await v.open();await act(async()=>t.mock.timers.tick(10000));assert.match(v.panel().textContent,/暂时无法读取/);assert.ok(v.requests.every(r=>r.options.signal.aborted));
 v.state.read=async url=>response(url==='/api/accounts'?[]:[account('new')]);await act(async()=>[...v.panel().querySelectorAll('button')].find(b=>b.textContent.includes('重新读取')).click());assert.match(v.panel().textContent,/品牌 new/);await act(async()=>finish(response([account('old')])));assert.doesNotMatch(v.panel().textContent,/品牌 old/);assert.equal(v.requests.length,4);
});
