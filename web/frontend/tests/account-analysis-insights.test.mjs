import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: Workbench } = await loadTsModule('../src/components/ContentAnalysisWorkbench.tsx', import.meta.url);
const { default: Insights } = await loadTsModule('../src/components/AccountAnalysisInsights.tsx', import.meta.url);
const accounts = ['a', 'b'].map(accountId => ({ platform:'bilibili', accountId, name:accountId, contentCount:2 }));
const saved = { model:'test-model', at:'2026-10-08T00:00:00Z', notice:'建议待验证', facts:[{id:'f1', text:'两篇作品共有 120 次播放', contentIds:['one','two']}], insights:[{factIds:['f1'],observation:'教程可能适合做成系列',action:'补充下一期预告'}] };
const report = (id, insights = null) => ({ account:accounts.find(a=>a.accountId===id), contents:['one','two'].map(id=>({id,title:`作品 ${id}`,body:'实际材料',tags:[],format:'视频',metrics:{},period:'lifetime',diagnostics:[]})), overview:{contentCount:2,metricCoverage:{},totals:{}},themes:[],experiments:[],quality:{identity:'user_declared',warnings:[]},platformProfile:{platform:'bilibili',label:'B站',version:'2026-10-08',focus:['标题承诺与内容兑现'],materialNeeds:['观看留存'],limitations:['没有留存曲线不能判断流失位置']},accountInsights:insights });
const response = value => ({ok:true,json:async()=>value});
async function fixture(t, initial=saved) {
 const state = { section:'review', saved:initial, requests:[], insights:async()=>response(saved) };
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  state.requests.push({url,options});
  if(url.endsWith('/accounts')) return response({accounts});
  if(url.includes('/report?')) return response(report(new URL(url,'https://easel.test').searchParams.get('accountId'),state.saved));
  if(url.endsWith('/insights')) return state.insights();
  throw new Error(`Unexpected ${url}`);
 });
 const container=document.createElement('div'); document.body.append(container);
 const root=createRoot(container);
 const render=()=>root.render(createElement(Workbench,{platform:'bilibili',section:state.section,onSection:section=>{state.section=section;render();},onNavigateIdeas:()=>{}}));
 await act(async()=>render());
 t.after(async()=>{await act(async()=>root.unmount());container.remove();});
 return {state,container,button:text=>Array.from(container.querySelectorAll('button')).find(b=>b.textContent===text)};
}

test('saved insight shows platform limits and fact evidence, opens original content and pre-fills an experiment',async t=>{
 const v=await fixture(t);
 assert.match(v.container.textContent,/B站的复盘重点/);
 assert.match(v.container.textContent,/没有留存曲线不能判断流失位置/);
 assert.match(v.container.textContent,/已保存结果/);
 assert.match(v.container.textContent,/两篇作品共有 120 次播放/);
 await act(async()=>v.button('查看作品：作品 one →').click());
 assert.equal(v.state.section,'works');
 assert.match(v.container.querySelector('.ca-work-detail').textContent,/实际正文/);
 // Return through a fresh fixture to exercise the review action directly.
 const w=await fixture(t);
 await act(async()=>w.button('建立验证实验 →').click());
 assert.equal(w.state.section,'experiments');
 assert.equal(w.container.querySelectorAll('textarea')[0].value,'教程可能适合做成系列');
 assert.equal(w.container.querySelectorAll('textarea')[1].value,'补充下一期预告');
 assert.equal(w.container.querySelectorAll('input[type=checkbox]:checked').length,2);
});

test('generation sends only the selected account identity, disables duplicate request, then reads persisted report',async t=>{
 const v=await fixture(t,null);
 let finish;
 v.state.insights=()=>new Promise(resolve=>{finish=resolve;});
 await act(async()=>v.button('生成账号解读').click());
 assert.equal(v.button('正在分析当前账号…').disabled,true);
 const req=v.state.requests.find(r=>r.url.endsWith('/insights'));
 assert.deepEqual(JSON.parse(req.options.body),{platform:'bilibili',accountId:'a'});
 v.state.saved=saved;
 await act(async()=>finish(response(saved)));
 assert.match(v.container.textContent,/已保存结果/);
 assert.equal(v.container.querySelector('[aria-label="跨作品 AI 解读"]').closest('details').open,true);
 assert.equal(v.state.requests.filter(r=>r.url.includes('/report?')).length,2);
});

test('account switch drops a late insight response and refresh removes an invalidated saved result',async t=>{
 const v=await fixture(t,null);
 let finish;
 v.state.insights=()=>new Promise(resolve=>{finish=resolve;});
 await act(async()=>v.button('生成账号解读').click());
 const select=v.container.querySelector('.ca-account-filter select');
 await act(async()=>{select.value='b';select.dispatchEvent(new window.Event('change',{bubbles:true}));});
 await act(async()=>finish(response(saved)));
 assert.equal(v.container.querySelector('.ca-account-filter select').value,'b');
 assert.doesNotMatch(v.container.textContent,/已保存结果/);
 assert.equal(v.state.requests.filter(r=>r.url.includes('/report?')).length,2);
 v.state.saved=saved;
 await act(async()=>v.button('刷新记录').click());
 assert.match(v.container.textContent,/已保存结果/);
 v.state.saved=null;
 await act(async()=>v.button('刷新记录').click());
 assert.doesNotMatch(v.container.textContent,/已保存结果/);
 assert.match(v.container.textContent,/旧结果失效/);
});

test('server failure exposes a retryable error without inventing results',async t=>{
 const v=await fixture(t,null);
 v.state.insights=async()=>({ok:false,status:409,json:async()=>({detail:'材料已更新，请重试'})});
 await act(async()=>v.button('生成账号解读').click());
 assert.match(v.container.querySelector('[role=alert]').textContent,/材料已更新/);
 assert.equal(v.button('生成账号解读').disabled,false);
 assert.doesNotMatch(v.container.textContent,/已保存结果/);
});

test('comments alone qualify as real text while placeholder titles do not',async t=>{
 const container=document.createElement('div');document.body.append(container);
 const root=createRoot(container);
 t.after(async()=>{await act(async()=>root.unmount());container.remove();});
 const data=report('a');
 data.contents=data.contents.map(c=>({...c,title:'未提供标题',body:'',comments:['真实评论材料']}));
 let calls=0;
 const render=()=>root.render(createElement(Insights,{report:data,busy:false,onRequest:()=>calls++,onChoose:()=>{},onPlan:()=>{}}));
 await act(async()=>render());
 let button=Array.from(container.querySelectorAll('button')).find(b=>b.textContent==='生成账号解读');
 assert.equal(button.disabled,false);
 await act(async()=>button.click());
 assert.equal(calls,1);
 data.contents=data.contents.map(c=>({...c,comments:[]}));
 await act(async()=>render());
 button=Array.from(container.querySelectorAll('button')).find(b=>b.textContent==='生成账号解读');
 assert.equal(button.disabled,true);
});


test('failed model generation stays in the insight section, retains saved result and retries generation',async t=>{
 const v=await fixture(t);
 v.state.insights=async()=>({ok:false,json:async()=>({detail:'本次引用只覆盖单篇作品；已有有效结果保留。'})});
 await act(async()=>v.button('重新生成账号解读').click());
 const panel=v.container.querySelector('[aria-label="跨作品 AI 解读"]');
 assert.match(panel.querySelector('[role=alert]').textContent,/单篇作品/);
 assert.match(panel.textContent,/已保存结果/);
 assert.equal(v.button('重新读取'),undefined);
 v.state.insights=async()=>response(saved);
 await act(async()=>v.button('重新生成解读').click());
 assert.equal(v.state.requests.filter(r=>r.url.endsWith('/insights')).length,2);
 assert.equal(v.container.querySelector('[aria-label="跨作品 AI 解读"] [role=alert]'),null);
});
