import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';
globalThis.window=new Window({url:'https://easel.test/'});
globalThis.document=window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const { createRoot }=await import('react-dom/client');
const { default: Panel }=await loadTsModule('../src/components/agent-office/OfficeWorkflowPanel.tsx',import.meta.url);
const agent=(id,state,source='live')=>({id,name:id,state,source,role:'成员',task:''});
async function fixture(t,agents,mode='live',stale=false) {
 const opened=[];const selected=[];
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
 await act(async()=>root.render(createElement(Panel,{agents,events:[],mode,stale,elapsed:0,selectedId:null,onSelect:id=>selected.push(id),onOpenProcess:id=>opened.push(id),displayName:a=>a.name})));
 t.after(async()=>{await act(async()=>root.unmount());container.remove();});
 return {region:container.querySelector('[aria-label="需要处理"]'),opened,selected};
}
test('attention counts only explicit error, stopped and unknown; waiting is separate and opens the correct process',async t=>{
 const v=await fixture(t,[agent('failed','error'),agent('halted','stopped'),agent('uncertain','unknown'),agent('pending','waiting'),agent('running','working'),agent('finished','done'),agent('synthetic','error','demo')]);
 assert.match(v.region.querySelector('h3').textContent,/需要处理 3 位/);
 assert.deepEqual([...v.region.querySelectorAll('.workflow-attention-group h4')].map(e=>e.textContent),['报告问题 · 1','已停止 · 1','状态待核对 · 1']);
 assert.doesNotMatch(v.region.textContent,/synthetic|running|finished/);
 assert.match(v.region.textContent,/不代表执行失败/);
 assert.match(v.region.textContent,/不能据此判断正在等待审批/);
 assert.match(v.region.querySelector('summary').textContent,/等待中的成员 · 1/);
 await act(async()=>v.region.querySelector('[aria-label="已停止"] button').click());
 await act(async()=>v.region.querySelector('.workflow-waiting-summary button').click());
 assert.deepEqual(v.opened,['halted','pending']);assert.deepEqual(v.selected,[]);
});
test('missing tasks and parent evidence do not become alerts, and empty scope does not claim global health',async t=>{
 const v=await fixture(t,[agent('running','working'),agent('thinking','thinking')]);
 assert.match(v.region.querySelector('h3').textContent,/0 位/);
 assert.equal(v.region.querySelectorAll('.workflow-attention-group').length,0);
 assert.match(v.region.textContent,/未观测到的成员不在统计范围/);
 assert.match(v.region.textContent,/缺少任务说明或上级关系不会计为故障/);
});
test('stale snapshots present historical status and retain inspection rather than claiming live alerts',async t=>{
 const v=await fixture(t,[agent('old','error')],'live',true);
 assert.match(v.region.querySelector('h3').textContent,/历史快照/);
 assert.match(v.region.textContent,/更新已中断，不代表当前状态/);
 assert.match(v.region.querySelector('button').textContent,/已保留过程/);
 await act(async()=>v.region.querySelector('button').click());assert.deepEqual(v.opened,['old']);
});
test('demo remains explicitly simulated even when stale and excludes live incidents',async t=>{
 const v=await fixture(t,[agent('fake','error','demo'),agent('real','error')],'demo',true);
 assert.match(v.region.querySelector('h3').textContent,/模拟 · 需要处理 1 位/);
 assert.match(v.region.textContent,/演示脚本状态，非真实告警/);
 assert.doesNotMatch(v.region.textContent,/real|历史快照/);
 await act(async()=>v.region.querySelector('button').click());assert.deepEqual(v.opened,['fake']);
});
