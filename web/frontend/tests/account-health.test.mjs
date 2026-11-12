import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new Window({url:'https://easel.test/'});
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
globalThis.HTMLElement = window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const health = await loadTsModule('../src/lib/accountHealth.ts');
const whoami = await loadTsModule('../src/lib/whoami.ts');
const { socialAccountStatus, socialAccountReady, socialAccounts } = await loadTsModule('../src/lib/socialAccounts.ts');
const { default: Notice } = await loadTsModule('../src/components/AccountHealthNotice.tsx');
const { defaultAccountInventory } = await loadTsModule('../src/lib/accountInventory.ts');
const response = data => ({ok:true,json:async()=>structuredClone(data)});
function snapshot(state='online') {
  const now=Date.now();
  return {accounts:[{key:'default:zhihu',platform:'zhihu',source:'default',label:'默认账号',state,checkedAt:now,checking:false,busy:false}],
    defaultAccounts:[{platform:'zhihu',supported:true,loggedIn:state==='online',hasLocalSession:true,identityKey:'saved'}],
    running:true,scanFailed:false,serverTime:now,intervalSeconds:300,freshForSeconds:600};
}

test('background expiry overrides cached green state across pages without starting a browser',async t=>{
  localStorage.clear();
  whoami.setWhoamiCache('zhihu',{loggedIn:true,name:'保存身份',avatar:'',identityKey:'saved',verified:true,checkedAt:Date.now()-1000});
  const requests=[];
  t.mock.method(globalThis,'fetch',async url=>{requests.push(String(url));return response(snapshot('login_required'));});
  await health.refreshAccountHealth();
  assert.equal(whoami.accountConnection(undefined,whoami.getWhoamiCache().zhihu),'login_required');
  assert.equal(requests.length,1);assert.ok(requests[0].endsWith('/api/account-health'));
});

test('unknown check retains the saved identity and stops claiming online',async t=>{
  localStorage.clear();
  whoami.setWhoamiCache('zhihu',{loggedIn:true,name:'保留昵称',avatar:'',identityKey:'saved',verified:true,checkedAt:Date.now()-1000});
  t.mock.method(globalThis,'fetch',async()=>response(snapshot('unknown')));
  await health.refreshAccountHealth();
  assert.equal(whoami.getWhoamiCache().zhihu.name,'保留昵称');
  assert.equal(whoami.accountConnection(undefined,whoami.getWhoamiCache().zhihu),'unknown');
});

test('confirmed expiry remains manageable even after the platform clears its old nickname',()=>{
  const account={platform:'zhihu',supported:true,loggedIn:false,hasLocalSession:true,identityKey:'expired'};
  const identity={loggedIn:false,name:'',avatar:'',identityKey:'expired',verified:true,authState:'login_required',checkedAt:Date.now()};
  const rows=defaultAccountInventory([account],{zhihu:identity});
  assert.equal(rows.length,1);assert.equal(rows[0].connection,'login_required');
});

test('a late health snapshot cannot overwrite newer explicit login evidence',async t=>{
  localStorage.clear();
  const result=snapshot('login_required');result.accounts[0].checkedAt-=1000;
  whoami.setWhoamiCache('zhihu',{loggedIn:true,name:'新身份',avatar:'',identityKey:'saved',verified:true,checkedAt:Date.now()});
  t.mock.method(globalThis,'fetch',async()=>response(result));
  await health.refreshAccountHealth();
  assert.equal(whoami.accountConnection(undefined,whoami.getWhoamiCache().zhihu),'online');
});

test('stale and future independent checks are never ready or selectable',async t=>{
  const row={status:'ready',busy:false,checkedAt:new Date().toISOString()};
  assert.equal(socialAccountReady(row),true);
  for(const checkedAt of [undefined,'invalid',new Date(Date.now()-600001).toISOString(),new Date(Date.now()+60000).toISOString()]){
    assert.equal(socialAccountStatus({...row,checkedAt}),'unverified');
    assert.equal(socialAccountReady({...row,checkedAt}),false);
  }
  t.mock.method(globalThis,'fetch',async()=>response([{...row,checkedAt:'2020-01-01T00:00:00Z'}]));
  assert.equal((await socialAccounts.list())[0].status,'unverified');
});

test('an in-flight snapshot cannot clear a newly switched account identity',async t=>{
  localStorage.clear();
  whoami.setWhoamiCache('zhihu',{loggedIn:true,name:'A',avatar:'',identityKey:'saved',verified:true,checkedAt:Date.now()-2000});
  const old=snapshot('login_required');
  let resolve;
  t.mock.method(globalThis,'fetch',()=>new Promise(done=>{resolve=()=>done(response(old));}));
  const pending=health.refreshAccountHealth();
  whoami.setWhoamiCache('zhihu',{loggedIn:true,name:'B',avatar:'',identityKey:'switched',verified:true,checkedAt:Date.now()});
  resolve();await pending;
  assert.equal(whoami.getWhoamiCache().zhihu.name,'B');
  assert.equal(whoami.accountConnection(undefined,whoami.getWhoamiCache().zhihu),'online');
  assert.equal(health.readAccountHealth().snapshot.accounts.length,0);
});

test('an older request cannot overwrite a newer health response',async t=>{
  localStorage.clear();
  let resolve;let calls=0;
  const old=snapshot('login_required');
  t.mock.method(globalThis,'fetch',()=>++calls===1?new Promise(done=>{resolve=()=>done(response(old));}):Promise.resolve(response(snapshot('online'))));
  const pending=health.refreshAccountHealth();
  await health.refreshAccountHealth();resolve();await pending;
  assert.equal(health.readAccountHealth().snapshot.accounts[0].state,'online');
});

test('global notice polls read-only status, distinguishes expiry from failure, and opens the exact account',async t=>{
  const timers=new Map();let n=0;
  t.mock.method(window,'setInterval',(call,delay)=>{assert.equal(delay,15000);timers.set(++n,call);return n;});
  t.mock.method(window,'clearInterval',id=>timers.delete(id));
  let data=snapshot('login_required');data.accounts[0]={...data.accounts[0],source:'independent',accountId:'a'.repeat(32)};
  let offline=false;
  t.mock.method(globalThis,'fetch',async()=>{if(offline)throw Error('network');return response(data);});
  const container=document.createElement('div');document.body.append(container);
  const root=createRoot(container);const opened=[];
  await act(async()=>{root.render(createElement(Notice,{onOpen:(...args)=>opened.push(args)}));});
  assert.match(container.textContent,/需重新连接/);
  await act(async()=>container.querySelector('button').click());
  assert.deepEqual(opened,[['a'.repeat(32),'zhihu']]);
  data=snapshot('unknown');
  await act(async()=>health.refreshAccountHealth());
  assert.match(container.textContent,/状态待确认/);assert.doesNotMatch(container.textContent,/需重新连接/);
  offline=true;
  await act(async()=>health.refreshAccountHealth());
  assert.match(container.textContent,/巡检暂不可用/);
  await act(async()=>root.unmount());container.remove();
  assert.equal(timers.size,0);
});
