import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';
globalThis.window=new Window({url:'https://easel.test/'});
globalThis.document=window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const {default:Workbench}=await loadTsModule('../src/components/ContentAnalysisWorkbench.tsx',import.meta.url);
const {default:Capabilities}=await loadTsModule('../src/components/AnalysisCapabilities.tsx',import.meta.url);
const {ANALYSIS_RESEARCH}=await loadTsModule('../src/lib/analysisPlatforms.ts',import.meta.url);
const {validateAnalysisReport,topicEvidence,topicIdeaNote}=await loadTsModule('../src/lib/contentAnalysis.ts',import.meta.url);
const response=data=>({ok:true,json:async()=>data});
const account=(platform='xiaohongshu',accountId='same-id')=>({platform,accountId,name:'示例作者',contentCount:3});
const topic={id:'tag-one',label:'分步教程',kind:'tag',status:'exploratory',evidenceIds:['one','two'],counterexampleIds:['three'],sampleCount:2,totalCount:3,metric:'collects',metricLabel:'每百次观看收藏事件',value:5,baselineValue:2,period:'lifetime',comparison:'同形式同龄无投放',missingCount:1,observation:'实际样本收藏事件较多',hypothesis:'分步结构可能满足收藏需求',action:'下一篇只补一个步骤清单',reviewAt:'2026-10-16T02:00:00Z',stopRule:'样本不足或窗口不齐时停止比较',limitations:['小样本不能证明因果']};
function report(platform='xiaohongshu',accountId='same-id') {return {account:account(platform,accountId),contents:['one','two','three'].map(id=>({id,title:`${platform}作品 ${id}`,body:'真实内容材料',tags:['教程'],format:'图文',period:'lifetime',metrics:{views:100,collects:5},diagnostics:[]})),overview:{contentCount:3,metricCoverage:{},totals:{}},themes:[],experiments:[],quality:{identity:'user_declared',warnings:[]},professional:{scope:{platform,accountId},capabilities:[{id:'body',question:'正文是否交付实际步骤？',required:['真实正文'],available:3,total:3,status:'available',limitation:'只做材料观察'}],quality:{total:3,comparable:2,excluded:[{id:'three',reasons:['窗口未知']}],observedFrom:'2026-10-01T00:00:00Z',observedTo:'2026-10-09T00:00:00Z'},metricDefinitions:[{key:'collects',label:'收藏次数',unit:'次',formula:'收藏事件合计 / 观看合计 × 100',limitation:'事件不是独立人数'}],cohorts:[{id:'c',label:'同龄图文',contentIds:['one','two'],period:'lifetime',ageDays:2,format:'图文',paid:false}],topics:[structuredClone(topic)]}};}
async function fixture(t,{platform='xiaohongshu',fetcher}={}) {
 const state={platform,section:'review',requests:[]};
 t.mock.method(globalThis,'fetch',async(url,options)=>{state.requests.push({url,options});if(fetcher)return fetcher(url,options);if(url.endsWith('/accounts'))return response({accounts:[account('xiaohongshu'),account('douyin'),account('xiaohongshu','other')]});if(url.includes('/report?')){const query=new URL(url,'https://easel.test').searchParams;return response(report(query.get('platform'),query.get('accountId')));}return response({ok:true});});
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
 const render=()=>root.render(createElement(Workbench,{platform:state.platform,section:state.section,onSection:section=>{state.section=section;render();},onNavigateIdeas:()=>{}}));
 await act(async()=>render());t.after(async()=>{await act(async()=>root.unmount());container.remove();});
 return {state,container,render,button:text=>Array.from(container.querySelectorAll('button')).find(b=>b.textContent===text)};
}
test('all seven platforms show required materials and official source boundaries without an account',async t=>{
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);t.after(async()=>{await act(async()=>root.unmount());container.remove();});
 for(const [platform,research] of Object.entries(ANALYSIS_RESEARCH)){await act(async()=>root.render(createElement(Capabilities,{platform,report:null,onAdd:()=>{}})));assert.match(container.textContent,/我能分析作品的什么问题/);assert.match(container.textContent,/需补充材料/);assert.match(container.textContent,/资料未披露/);assert.match(container.textContent,/2026-10-09/);assert.equal(container.querySelector('a').href,research.source);assert.equal(container.querySelectorAll('.ca-capability-card').length,7);}
});
test('professional card exposes sample, window, missing values, counterexamples and source content',async t=>{
 const v=await fixture(t);assert.ok(v.container.textContent.includes("引用样本 2/3"));assert.match(v.container.textContent,/lifetime/);assert.match(v.container.textContent,/指标缺失作品1 篇/);assert.match(v.container.textContent,/同条件对照作品/);assert.match(v.container.textContent,/7 天回收/);assert.match(v.container.textContent,/小样本不能证明因果/);
 await act(async()=>v.button('xiaohongshu作品 three · three →').click());assert.equal(v.state.section,'works');assert.match(v.container.querySelector('.ca-work-detail').textContent,/xiaohongshu作品 three/);
});
test('saving a topic freezes scope, samples, counterexamples and limits in the idea note',async t=>{
 const v=await fixture(t);await act(async()=>v.button('保存题材与证据').click());const request=v.state.requests.find(r=>r.url.endsWith('/api/ideas'));const payload=JSON.parse(request.options.body);assert.equal(payload.title,'分步教程');assert.match(payload.note,/平台：xiaohongshu · 账号：same-id/);const snapshot=JSON.parse(payload.note.slice(payload.note.indexOf('{')));assert.deepEqual(snapshot.scope,{platform:'xiaohongshu',accountId:'same-id'});assert.deepEqual(snapshot.topic.counterexampleIds,['three']);assert.equal(snapshot.topic.sampleCount,2);assert.equal(snapshot.topic.stopRule,topic.stopRule);assert.match(v.container.textContent,/后续采集不会改写此版本/);
});
test('topic prefill fixes primary metric and original content ids and sends evidence when saving experiment',async t=>{
 const v=await fixture(t);await act(async()=>v.button('预填 7 天实验').click());assert.equal(v.state.section,'experiments');assert.equal(v.container.querySelectorAll('textarea')[0].value,topic.hypothesis);assert.equal(v.container.querySelectorAll('textarea')[1].value,topic.action);assert.equal(v.container.querySelector('input[type=date]').value,'2026-10-16');assert.equal(v.container.querySelectorAll('input[type=checkbox]:checked').length,2);assert.equal(v.container.querySelector('select').disabled,false);const selects=v.container.querySelectorAll('select');assert.equal(selects[1].value,'collects');assert.equal(selects[1].disabled,true);
 await act(async()=>v.container.querySelector('form.ca-entry').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));const payload=JSON.parse(v.state.requests.find(r=>r.url.endsWith('/experiments')).options.body);assert.deepEqual(payload.contentIds,['one','two']);assert.deepEqual(payload.evidence.scope,{platform:'xiaohongshu',accountId:'same-id'});assert.equal(payload.evidence.topic.id,'tag-one');assert.equal(payload.metric,'collects');
});
test('a response with a different platform or account is blocked instead of shown',async t=>{
 const v=await fixture(t,{fetcher:async url=>url.endsWith('/accounts')?response({accounts:[account()]}):response(report('douyin'))});assert.match(v.container.querySelector('[role=alert]').textContent,/平台或账号不一致/);assert.equal(v.container.querySelector('.ca-topic-card'),null);assert.doesNotMatch(v.container.textContent,/douyin作品/);assert.throws(()=>validateAnalysisReport({...report(),professional:{...report().professional,scope:{platform:'xiaohongshu',accountId:'other'}}},'xiaohongshu','same-id'),/不一致/);
});
test('platform switch with the same account id discards a delayed previous report',async t=>{
 let finish;const v=await fixture(t,{fetcher:async url=>{if(url.endsWith('/accounts'))return response({accounts:[account(),account('douyin')]});const platform=new URL(url,'https://easel.test').searchParams.get('platform');return platform==='xiaohongshu'?new Promise(resolve=>{finish=resolve;}):response(report('douyin'));}});await act(async()=>{v.state.platform='douyin';v.render();});await act(async()=>finish(response(report())));assert.match(v.container.textContent,/douyin作品/);assert.doesNotMatch(v.container.textContent,/xiaohongshu作品/);assert.match(v.container.querySelector('a').href,/creator.douyin.com/);
});
test('a pending topic save cannot post a success notice into a newly selected platform',async t=>{
 let finish;const v=await fixture(t,{fetcher:async url=>{if(url.endsWith('/accounts'))return response({accounts:[account(),account('douyin')]});if(url.includes('/report?'))return response(report(new URL(url,'https://easel.test').searchParams.get('platform')));if(url.endsWith('/api/ideas'))return new Promise(resolve=>{finish=resolve;});throw new Error(url);}});await act(async()=>v.button('保存题材与证据').click());await act(async()=>{v.state.platform='douyin';v.render();});await act(async()=>finish(response({ok:true})));assert.doesNotMatch(v.container.textContent,/题材与当前证据快照已加入/);assert.match(v.container.textContent,/douyin作品/);
});
test('old reports show compatibility guidance and evidence snapshots stay unchanged when source changes',async t=>{
 const old=report();delete old.professional;const v=await fixture(t,{fetcher:async url=>url.endsWith('/accounts')?response({accounts:[account()]}):response(old)});assert.match(v.container.textContent,/尚未提供专业证据字段/);assert.equal(v.container.querySelector('.ca-topic-card'),null);const data=report();const snapshot=topicEvidence(data,data.professional.topics[0]);data.professional.topics[0].sampleCount=99;assert.equal(snapshot.topic.sampleCount,2);assert.ok(topicIdeaNote(snapshot).includes("引用样本：2/3"));
});
