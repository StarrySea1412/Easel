import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadTsModule } from './load-ts.mjs';
globalThis.window=new Window({url:'http://localhost/'});
globalThis.document=window.document;
globalThis.HTMLElement=window.HTMLElement;
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
test('independent profile controls retain a candidate draft and persist only the changed setting',async t=>{
 let current={...state('policy'),policy:{readEnabled:true,candidatesEnabled:true}};const writes=[];
 t.mock.method(globalThis,'fetch',async(url,options={})=>{
  if(options.method==='POST') {const body=JSON.parse(options.body);writes.push({url,body});current={...current,revision:current.revision+1,policy:{...current.policy,...Object.fromEntries(Object.entries(body).filter(([key])=>key!=='profileRevision'))}};}
  return response(current);
 });
 const v=await mount(t,'policy');
 const textarea=v.container.querySelector('.memory-new textarea');
 await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(textarea,'未保存的经验草稿');textarea.dispatchEvent(new window.Event('input',{bubbles:true}));});
 const switches=()=>[...v.container.querySelectorAll('[role="switch"]')];
 await act(async()=>switches()[0].click());
 assert.equal(switches()[0].getAttribute('aria-checked'),'false');assert.equal(switches()[1].getAttribute('aria-checked'),'true');
 assert.equal(textarea.disabled,false);
 assert.deepEqual(writes[0].body,{profileRevision:1,readEnabled:false});assert.ok(writes[0].url.endsWith('/policy'));
 await act(async()=>switches()[1].click());
 assert.equal(textarea.disabled,true);assert.equal(textarea.value,'未保存的经验草稿');
 assert.equal(v.button('保存为待确认候选').disabled,true);
 await act(async()=>switches()[1].click());
 assert.equal(textarea.disabled,false);assert.equal(textarea.value,'未保存的经验草稿');
 assert.equal(v.button('保存为待确认候选').disabled,false);
});
test('recall preview explains disabled reading inside the existing disclosure',async t=>{
 t.mock.method(globalThis,'fetch',async url=>String(url).includes('/context?')?response({entries:[],recall:{reason:'read-disabled',selectedCount:0,budgetChars:5000,usedChars:0}}):response({...state('preview',1,[]),policy:{readEnabled:false,candidatesEnabled:true}}));
 const v=await mount(t,'preview');
 await act(async()=>v.button('查看可用经验').click());
 assert.match(v.container.querySelector('[role="status"]').textContent,/已关闭读取经验/);
 assert.equal(lib.memoryRecallSummary({reason:'selected',selectedCount:2,usedChars:42,budgetChars:5000}),'2条 · 42/5000字');
});
async function fill(field,value){await act(async()=>{const proto=field.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(field,value);field.dispatchEvent(new window.Event('input',{bubbles:true}));});}
async function choose(container,label,text){await act(async()=>container.querySelector(`[aria-label="${label}"]`).click());await act(async()=>[...document.querySelectorAll('[role="option"]')].find(option=>option.textContent.includes(text)).click());}

test('conditional replacement proposal retains its bound old version and draft after a conflict',async t=>{
 const old={...entry('old'),scope:{kind:'profile'},status:'active',revision:2,conditions:{version:1,taskTypes:['writing'],allKeywords:['摄影'],excludeKeywords:[]},conditionsHash:'conditions'};
 let current=state('conditional-proposal',3,[old]);const writes=[];
 t.mock.method(globalThis,'fetch',async(url,options={})=>{if(options.method==='POST'){writes.push(JSON.parse(options.body));current=state('conditional-proposal',4,[{...old,revision:3}]);return response({detail:'要替代的经验已有更新'},409);}return response(current);});
 const v=await mount(t,'conditional-proposal');
 assert.equal(v.container.querySelector('.memory-conditions').open,false);
 await fill(v.container.querySelector('.memory-new textarea'),'摄影新版草稿');
 await choose(v.container,'添加适用任务类型','写作');
 await fill(v.container.querySelector('.memory-condition-fields input'),'摄影');
 await choose(v.container,'替代旧经验','v2');
 await act(async()=>v.button('保存为待确认候选').click());
 assert.equal(v.container.querySelector('.memory-new textarea').value,'摄影新版草稿');
 assert.ok(v.container.querySelector('[aria-label="移除写作"]'));
 assert.deepEqual(writes[0].conditions,old.conditions);assert.equal(writes[0].replaces.revision,2);assert.equal(writes[0].profileRevision,3);
 await act(async()=>v.button('保存为待确认候选').click());
 assert.equal(writes[1].replaces.revision,2,'refresh must not silently rebind a selected version');
 assert.match(v.container.querySelector('[role="alert"]').textContent,/已有更新/);
});

test('replacement confirmation shows old and new text and submits the bound condition identity',async t=>{
 const old={...entry('before'),scope:{kind:'profile'},status:'active',revision:2,conditions:lib.emptyConditions(),conditionsHash:'unrestricted'};
 const candidate={...entry('after'),scope:{kind:'profile'},text:'摄影新版',conditions:lib.emptyConditions(),conditionsHash:'unrestricted',replaces:{id:'before',revision:2,contentHash:'hash',scopeHash:'scope',conditionsHash:'unrestricted'},replacementHash:'replacement'};
 let current=state('replacement-confirm',4,[candidate,old]);const writes=[];
 t.mock.method(globalThis,'fetch',async(url,options={})=>{if(options.method==='POST'){writes.push(JSON.parse(options.body));current=state('replacement-confirm',6,[{...candidate,status:'active',revision:2},{...old,status:'superseded',revision:3,supersededBy:{id:'after',revision:2}}]);}return response(current);});
 const v=await mount(t,'replacement-confirm');
 await act(async()=>v.button('确认生效').click());
 let dialog=document.querySelector('[role="dialog"]');assert.ok(dialog);assert.match(dialog.textContent,/摄影新版/);assert.match(dialog.textContent,/摄影教程采用分步清单/);
 await act(async()=>[...dialog.querySelectorAll('button')].find(button=>button.textContent==='取消').click());assert.equal(writes.length,0);
 await act(async()=>v.button('确认生效').click());dialog=document.querySelector('[role="dialog"]');
 await act(async()=>[...dialog.querySelectorAll('button')].find(button=>button.textContent==='确认替代').click());
 assert.equal(writes[0].conditionsHash,'unrestricted');assert.equal(writes[0].replacementHash,'replacement');assert.equal(writes[0].profileRevision,4);
 assert.match(v.container.textContent,/已替代/);assert.match(v.container.textContent,/后续版本 v2/);
});

test('condition edits survive revision conflict and recall preview sends the selected task type',async t=>{
 const rule={version:1,taskTypes:['writing'],allKeywords:[],excludeKeywords:[]};
 let current=state('condition-edit',1,[{...entry(),conditions:rule,conditionsHash:'writing'}]);const requests=[];
 t.mock.method(globalThis,'fetch',async(url,options={})=>{requests.push({url,options});if(String(url).endsWith('/edit')){current=state('condition-edit',2,[{...entry(),revision:2,conditions:rule,conditionsHash:'writing'}]);return response({detail:'版本已改变'},409);}if(String(url).includes('/context?'))return response({entries:[]});return response(current);});
 const v=await mount(t,'condition-edit');
 await act(async()=>v.button('编辑').click());
 await fill(v.container.querySelector('.memory-editor .memory-condition-fields input'),'摄影、教程');
 await act(async()=>v.button('保存修订').click());
 assert.equal(v.container.querySelector('.memory-editor .memory-condition-fields input').value,'摄影、教程');
 const body=JSON.parse(requests.find(row=>row.url.endsWith('/edit')).options.body);assert.deepEqual(body.conditions.allKeywords,['摄影','教程']);
 await choose(v.container,'预览任务类型','写作');
 await act(async()=>v.button('查看可用经验').click());
 assert.ok(requests.some(row=>String(row.url).includes('taskType=writing')));
});

test.after(()=>window.happyDOM.abort());


test('token recall is explicitly estimated while v1 historical receipts retain character units',()=>{
 const base={version:1,budgetChars:5000,usedChars:12,selectedCount:1};
 assert.equal(lib.memoryRecallSummary(base),'1条 · 12/5000字');
 assert.equal(lib.memoryRecallSummary({...base,version:2,usedTokens:350,budgetTokens:4000}),'1条 · 估算 350/4000 token');
 assert.equal(lib.memoryRecallSummary({...base,version:2,selectedCount:0,reason:'prompt-budget'}),'本轮提示已超出估算预算');
});

test('extraction uses the original profile and report version, preserves a manual draft and stays folded',async t=>{
 const {default:Panel}=await loadTsModule('../src/components/ChatAnalysisPanel.tsx');
 const binding={id:'extraction-binding',sourceHash:'material-version',persona:'original-profile',platform:'douyin',accountId:'A',accountName:'隔离样例',sessionId:'analysis-extraction',contentIds:['n1'],kind:'account-analysis',createdAt:'2026-10-26',markdown:'合成分析材料',result:{versionHash:'version-1',turnId:'t',at:'2026-10-26',markdown:'## 经验候选\n- [作品ID: n1] 摄影教程先展示成品，仅单个样本需复核。',notice:''}};
 const calls=[],changes=[];const receive=event=>changes.push(event.detail);window.addEventListener('easel:workbench-changed',receive);t.after(()=>window.removeEventListener('easel:workbench-changed',receive));
 const receipt={status:'completed',reason:'selected',profileName:'original-profile',profileId:'original-profile',profileRevision:2,createdCount:1,existingCount:0};
 t.mock.method(globalThis,'fetch',async(url,options={})=>{calls.push({url,options});if(String(url).includes('/conversations?'))return response({conversations:[binding]});if(String(url).endsWith('/extract-analysis'))return response({extraction:receipt,state:state('original-profile',2)});throw Error('Unexpected request '+url);});
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);t.after(async()=>{await act(async()=>root.unmount());container.remove();});
 await act(async()=>root.render(createElement(Panel,{session:{id:'analysis-extraction',persona:'changed-profile',messages:[],analysisContext:binding}})));
 const details=container.querySelector('.analysis-memory-candidate');assert.equal(details.open,false);
 const field=details.querySelector('textarea');await fill(field,'我的手工候选草稿');
 await act(async()=>[...details.querySelectorAll('button')].find(button=>button.textContent==='提取经验候选').click());
 const writes=calls.filter(call=>call.options.method==='POST');assert.equal(writes.length,1);assert.match(writes[0].url,/original-profile/);
 assert.deepEqual(JSON.parse(writes[0].options.body),{bindingId:'extraction-binding',sourceHash:'version-1'});
 assert.equal(field.value,'我的手工候选草稿');assert.equal(details.open,false);assert.match(details.textContent,/新增1条 · 已有0条/);
 assert.ok(changes.some(change=>change.name==='original-profile'&&change.revision===2));
});

test('automatic writeback publishes a bodyless experience invalidation receipt',async t=>{
 const {saveAnalysisChatResult}=await loadTsModule('../src/lib/analysisConversations.ts');
 const events=[];const listener=event=>events.push(event.detail);window.addEventListener('easel:workbench-changed',listener);t.after(()=>window.removeEventListener('easel:workbench-changed',listener));
 t.mock.method(globalThis,'fetch',async()=>response({id:'binding',experienceExtraction:{status:'completed',reason:'selected',profileName:'auto-profile',profileId:'pid',profileRevision:3}}));
 await saveAnalysisChatResult({id:'s',analysisContext:{id:'binding',platform:'douyin',accountId:'A'}},{role:'assistant',turnId:'t',content:'原始合成报告正文'});
 assert.deepEqual(events.filter(event=>event.domain==='profile-memory'),[{domain:'profile-memory',name:'auto-profile',profileId:'pid',revision:3,reason:'analysis-extraction'}]);
 assert.equal(lib.extractionSummary({status:'completed',reason:'no-explicit-candidates'}),'没有明确的经验候选');
 assert.equal(lib.extractionSummary({status:'completed',reason:'previously-deleted'}),'候选已删除，未重新创建');
});

test('related entries remain folded, reference versions and do not retain deleted bodies',async t=>{
 const name='related-extraction';const old={...entry('prior'),revision:2,text:'可供比较的原结论'};
 const fresh={...entry('fresh'),relatedCandidates:[{id:'prior',revision:1,kind:'lexical-overlap'},{id:'removed',revision:1,kind:'normalized-text'}]};
 let current=state(name,3,[fresh,old]);t.mock.method(globalThis,'fetch',async()=>response(current));
 const v=await mount(t,name);let details=[...v.container.querySelectorAll('details')].find(node=>node.textContent.includes('相近条目'));
 assert.equal(details.open,false);assert.match(details.textContent,/字面相近，未自动合并/);assert.match(details.textContent,/引用 v1 · 当前 v2/);assert.match(details.textContent,/原条目已删除/);
 current=state(name,4,[fresh]);await act(async()=>publishWorkbenchChange({domain:'profile-memory',name,revision:4,reason:'delete'}));
 details=[...v.container.querySelectorAll('details')].find(node=>node.textContent.includes('相近条目'));assert.doesNotMatch(details.textContent,/可供比较的原结论/);
 assert.equal(details.querySelectorAll('button').length,0);
});
