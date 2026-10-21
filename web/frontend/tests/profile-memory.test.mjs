import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadTsModule } from './load-ts.mjs';
globalThis.window=new Window({url:'http://localhost/'});
globalThis.document=window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const lib=await loadTsModule('../src/lib/profileMemory.ts');
const {publishWorkbenchChange}=await loadTsModule('../src/lib/workbenchEvents.ts');
const {default:Manager}=await loadTsModule('../src/components/ProfileMemoryManager.tsx');
const {default:Cache}=await loadTsModule('../src/components/CacheReuseMetric.tsx');
const response=(value,status=200)=>({ok:status===200,status,json:async()=>structuredClone(value)});
const entry=(id='entry')=>({id,profileId:'pid',text:'摄影教程采用分步清单。',status:'pending',revision:1,contentHash:'hash',scopeHash:'scope',scope:{kind:'account',platform:'douyin',accountId:'A'},quality:'hypothesis',source:{type:'manual',sourceHash:'h',capturedAt:null},sourceStatus:'available',createdAt:'2026-10-21',updatedAt:'2026-10-21',confirmedAt:null,reviewAfter:null});
const state=(name,revision=1,rows=[entry()])=>({name,profileId:name,revision,managed:true,entries:rows,legacy:null,projectionReady:true,warning:null});
async function mount(t,name){const container=document.createElement('div');document.body.append(container);const root=createRoot(container);await act(async()=>root.render(createElement(Manager,{name,key:name})));t.after(async()=>{await act(async()=>root.unmount());container.remove();});return {container,root,button:text=>[...container.querySelectorAll('button')].find(b=>b.textContent===text)};}

test('candidate confirmation sends bound hashes and conflicts retain draft until explicit rebase',async t=>{
 let current=state('conflict');const requests=[];
 t.mock.method(globalThis,'fetch',async(url,options={})=>{requests.push({url,options});if(url.endsWith('/edit')){current=state('conflict',2,[{...entry(),revision:2,text:'另一窗口的新结论。'}]);return response({detail:'经验版本已改变；你的草稿保留'},409);}if(url.endsWith('/accept'))return response(state('conflict',2,[{...entry(),status:'active',revision:2}]));return response(current);});
 const v=await mount(t,'conflict');
 await act(async()=>v.button('编辑').click());
 const editor=v.container.querySelector('.memory-editor textarea');
 await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(editor,'我的未保存草稿');editor.dispatchEvent(new window.Event('input',{bubbles:true}));});
 await act(async()=>v.button('保存修订').click());
 assert.equal(v.container.querySelector('.memory-editor textarea').value,'我的未保存草稿');
 assert.match(v.container.textContent,/另一窗口的新结论/);assert.ok(v.button('以当前版本继续修订'));
 await act(async()=>v.button('以当前版本继续修订').click());
 await act(async()=>v.button('取消').click());
 await act(async()=>v.button('确认生效').click());
 const payload=JSON.parse(requests.find(r=>r.url.endsWith('/accept')).options.body);
 assert.equal(payload.revision,2);assert.equal(payload.contentHash,'hash');assert.equal(payload.scopeHash,'scope');assert.equal(payload.profileRevision,2);
});

test('switching profiles rejects late reads and pending candidates stay outside active experience',async t=>{
 let finish; t.mock.method(globalThis,'fetch',async url=>url.includes('/slow/')?new Promise(resolve=>{finish=resolve;}):response(state('fast',3,[{...entry(),text:'另一个画像的候选'}])));
 const v=await mount(t,'slow');
 await act(async()=>v.root.render(createElement(Manager,{name:'fast',key:'fast'})));
 await act(async()=>finish(response(state('slow',1,[{...entry(),text:'迟到的旧画像内容'}]))));
 assert.match(v.container.textContent,/另一个画像的候选/);assert.doesNotMatch(v.container.textContent,/迟到的旧画像内容/);
 assert.match(v.container.textContent,/待确认/);assert.ok(v.button('确认生效'));
});

test('late GET cannot overwrite a newer mutation and domain events or focus recover missed updates',async t=>{
 let finish;let current=state('race',1);let block=true;
 t.mock.method(globalThis,'fetch',async(url,options={})=>{if(options.method==='POST'){current=state('race',2,[{...entry(),status:'invalidated'}]);return response(current);}if(block)return new Promise(resolve=>{finish=resolve;});return response(current);});
 const v=await mount(t,'race');
 await act(async()=>{block=false;await lib.mutateMemory('race','/entries/entry/invalidate',{});finish(response(state('race',1)));});
 assert.match(v.container.textContent,/已失效/);
 current=state('race',3,[]);
 await act(async()=>publishWorkbenchChange({domain:'profile-memory',name:'race',revision:3,reason:'delete'}));
 assert.doesNotMatch(v.container.textContent,/摄影教程采用分步清单/);
 current=state('race',4,[{...entry(),text:'焦点恢复后新候选'}]);
 await act(async()=>window.dispatchEvent(new window.Event('focus')));
 assert.match(v.container.textContent,/焦点恢复后新候选/);
});

test('cache display distinguishes unknown and weighted observed sample coverage',()=>{
 const html=renderToStaticMarkup(createElement(Cache,{value:{ratio:.1,eligibleRecords:2,totalRecords:4,inputTokens:1000,readTokens:100,missingRecords:1,invalidRecords:1,zeroInputRecords:0,unit:'usage_events'}}));
 assert.match(html,/10%/);assert.match(html,/2\/4 条有效用量事件/);assert.match(html,/已上报样本/);assert.match(html,/不是账单节省/);
 assert.match(renderToStaticMarkup(createElement(Cache,{})),/未上报/);
});
test('analysis candidates keep the saved binding and account, without sending a chat or publishing',async t=>{
 const {default:Panel}=await loadTsModule('../src/components/ChatAnalysisPanel.tsx');
 const binding={id:'frozen-binding',kind:'account-analysis',platform:'douyin',accountId:'original-account',accountName:'样例',sessionId:'analysis-session',contentIds:['work'],sourceHash:'server-hash',createdAt:'2026-10-21',markdown:'已保存材料',result:{markdown:'摄影教程先展示成品。单个样本不证明增长。',turnId:'saved-turn',at:'2026-10-21',notice:''}};
 const requests=[];
 t.mock.method(globalThis,'fetch',async(url,options={})=>{requests.push({url,options});if(String(url).includes('/conversations?'))return response({conversations:[binding]});if(String(url).endsWith('/candidates'))return response({entry:entry(),state:state('analysis-profile',2)});throw Error('Unexpected model or publication request: '+url);});
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);t.after(async()=>{await act(async()=>root.unmount());container.remove();});
 await act(async()=>root.render(createElement(Panel,{session:{id:'analysis-session',persona:'analysis-profile',messages:[],analysisContext:binding}})));
 const input=container.querySelector('textarea');
 await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(input,'摄影教程先展示成品。');input.dispatchEvent(new window.Event('input',{bubbles:true}));});
 await act(async()=>[...container.querySelectorAll('button')].find(b=>b.textContent==='保存候选').click());
 const writes=requests.filter(r=>r.options.method==='POST');assert.equal(writes.length,1);
 const body=JSON.parse(writes[0].options.body);assert.deepEqual(body.source,{type:'analysis',bindingId:'frozen-binding'});
 assert.deepEqual(body.scope,{kind:'account',platform:'douyin',accountId:'original-account'});assert.equal(body.text,'摄影教程先展示成品。');
});
test('deleted entries cannot reappear from a delayed historical body read',async t=>{
 const {default:Usage}=await loadTsModule('../src/components/MemoryUsage.tsx');
 let current=state('history-race',1),finish;
 t.mock.method(globalThis,'fetch',async url=>{
  if(String(url).endsWith('/history'))return new Promise(resolve=>{finish=resolve;});
  if(String(url).includes('/usage?'))return response({turns:[{turnId:'t',profileId:'history-race',profileRevision:1,at:'2026-10-21',entries:[{id:'entry',revision:1}]}]});
  return response(current);
 });
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);t.after(async()=>{await act(async()=>root.unmount());container.remove();});
 await act(async()=>root.render(createElement(Usage,{name:'history-race',sessionId:'s'})));
 await act(async()=>container.querySelector('button').click());
 current=state('history-race',2,[]);
 await act(async()=>publishWorkbenchChange({domain:'profile-memory',name:'history-race',revision:2,reason:'delete'}));
 await act(async()=>finish(response({revisions:[{...entry(),text:'已被删除的旧正文'}]})));
 assert.doesNotMatch(container.textContent,/已被删除的旧正文/);
});
test.after(()=>window.happyDOM.abort());
