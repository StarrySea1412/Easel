import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window=new JSDOM('<html><body></body></html>',{url:'https://easel.test/',pretendToBeVisual:true}).window;
globalThis.document=window.document;
globalThis.HTMLElement=window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
Object.defineProperty(globalThis,'navigator',{value:window.navigator,configurable:true});
Object.defineProperty(globalThis,'localStorage',{value:window.localStorage,configurable:true});
const {createRoot}=await import('react-dom/client');
const {default:Workbench}=await loadTsModule('../src/components/ContentAnalysisWorkbench.tsx');
const {default:Page}=await loadTsModule('../src/components/ContentAnalysisPage.tsx');
const {readAccountAnalysis}=await loadTsModule('../src/lib/socialAccountAnalysis.ts');
const a={accountId:'a'.repeat(32),platform:'xiaohongshu',externalAccountId:'a'.repeat(24),label:'品牌甲',name:'甲身份',status:'ready',busy:false};
const b={...a,accountId:'b'.repeat(32),externalAccountId:'b'.repeat(24),label:'品牌乙',name:'乙身份'};
const report=account=>({account:{platform:account.platform,accountId:account.externalAccountId,name:account.label,contentCount:1},
 contents:[{id:'work-'+account.label,title:account.label+'的作品',body:'实际正文',tags:[],format:'图文',metrics:{views:12},period:'unknown',diagnostics:[]}],
 overview:{contentCount:1,metricCoverage:{},totals:{}},themes:[],experiments:[],quality:{identity:'live_verified',warnings:[]}});
const value=account=>({account,sync:{scope:{platform:account.platform,accountId:account.externalAccountId},status:'partial',supported:true,loadedCount:1,totalCount:null,totalKnown:false,complete:false,fetchedAt:'2026-11-12T00:00:00Z',retryable:true,message:'只读第一页',overview:{followers:13,likes:null,posts:1,metrics:[]}},report:report(account)});
const response=data=>({ok:true,json:async()=>structuredClone(data)});
async function fixture(t,component=Workbench,extra={},fetcher){
 localStorage.clear();const requests=[];
 t.mock.method(globalThis,'fetch',async(url,options={})=>{
  requests.push({url:String(url),method:options.method||'GET'});
  if(fetcher){const result=fetcher(String(url),options);if(result)return result;}
  if(String(url).endsWith('/api/social-accounts'))return response([a,b]);
  if(String(url).endsWith('/api/accounts'))return response([]);
  const account=[a,b].find(account=>String(url).includes('/'+account.accountId+'/analysis'));
  if(account)return response(value(account));
  throw new Error('Unexpected endpoint '+url);
 });
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
 const state={platform:a.platform,independentAccountId:a.accountId,liveAccountId:a.externalAccountId,identityScope:'test-'+Math.random(),section:'review',connected:true,sessionReady:true,onSection:()=>{},onNavigateIdeas:()=>{},...extra};
 const render=async(changes={})=>{Object.assign(state,changes);await act(async()=>{root.render(createElement(component,state));});};
 t.after(async()=>{await act(async()=>root.unmount());container.remove();});await render();
 return {container,requests,render,button:name=>[...container.querySelectorAll('button')].find(row=>row.textContent===name)};
}

test('independent workbench reads its explicit account only and synchronizes through the isolated route',async t=>{
 const h=await fixture(t);assert.match(h.container.textContent,/品牌甲/);assert.doesNotMatch(h.container.textContent,/品牌乙/);
 assert.ok(h.container.querySelector('[aria-label="独立账号概览"]'));assert.equal(h.container.querySelector('.ca-account-filter'),null);
 await act(async()=>h.button('重新分析').click());
 assert.ok(h.requests.some(row=>row.method==='POST'&&row.url.endsWith('/'+a.accountId+'/analysis')));
 assert.ok(h.requests.every(row=>row.url.includes('/social-accounts/')));
});

test('late same-platform A response cannot replace newly selected B',async t=>{
 let finish;const delayed=new Promise(resolve=>{finish=()=>resolve(response(value(a)));});
 const h=await fixture(t,Workbench,{},url=>url.includes(a.accountId)?delayed:null);
 await h.render({independentAccountId:b.accountId,liveAccountId:b.externalAccountId,identityScope:'B'});
 assert.match(h.container.textContent,/品牌乙/);
 await act(async()=>finish());assert.match(h.container.textContent,/品牌乙/);assert.doesNotMatch(h.container.textContent,/品牌甲/);
});

test('server returning another account is blocked before report display',async t=>{
 const h=await fixture(t,Workbench,{},()=>response(value(b)));
 assert.match(h.container.textContent,/归属与所选独立账号不一致/);assert.doesNotMatch(h.container.textContent,/品牌乙/);
 await assert.rejects(readAccountAnalysis(a.accountId,a.platform,a.externalAccountId),/归属/);
});

test('independent import cannot change the bound platform identity',async t=>{
 const h=await fixture(t);await act(async()=>h.button('导入作品').click());
 const input=h.container.querySelector('.ca-form-grid input');assert.equal(input.readOnly,true);assert.equal(input.value,a.externalAccountId);
 const textarea=h.container.querySelector('textarea[placeholder^="{"]');
 await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(textarea,JSON.stringify({platform:a.platform,accountId:b.externalAccountId,contents:[{id:'wrong',title:'不能串号'}]}));textarea.dispatchEvent(new window.Event('input',{bubbles:true}));});
 await act(async()=>h.container.querySelector('.ca-entry').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));
 assert.match(h.container.textContent,/文件账号与所填账号 ID 不一致/);assert.ok(h.requests.every(row=>row.method==='GET'));
});

test('page account selector supports keyboard switch and exact management return without default collection',async t=>{
 const managed=[];const h=await fixture(t,Page,{initialPlatform:a.platform,initialAccountId:a.accountId,demoEnabled:false,onNavigateAccounts:id=>managed.push(id)});
 assert.match(h.container.textContent,/品牌甲/);
 const selector=h.container.querySelector('[aria-label="选择分析账号"]');
 await act(async()=>selector.click());
 await act(async()=>selector.dispatchEvent(new window.KeyboardEvent('keydown',{key:'End',bubbles:true})));
 await act(async()=>selector.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})));
 assert.match(h.container.textContent,/品牌乙/);assert.doesNotMatch(h.container.querySelector('.ca-bench').textContent,/品牌甲/);
 await act(async()=>h.button('管理账号').click());assert.deepEqual(managed,[b.accountId]);
 assert.ok(!h.requests.some(row=>row.url.includes('/whoami')||row.url.includes('/api/analytics/')||row.url.includes('/content-analysis/sync')));
});

test('missing initial account is an actionable error and never falls back to default',async t=>{
 const h=await fixture(t,Page,{initialPlatform:a.platform,initialAccountId:'c'.repeat(32),demoEnabled:false,onNavigateAccounts:()=>{}});
 assert.match(h.container.textContent,/所选独立账号不存在或平台不匹配/);assert.equal(h.container.querySelector('.ca-bench'),null);
 assert.ok(!h.requests.some(row=>row.url.includes('/content-analysis/')||row.url.includes('/api/analytics/')));
});
