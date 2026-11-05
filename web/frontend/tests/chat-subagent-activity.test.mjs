import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {act,createElement} from 'react';
import {loadTsModule} from './load-ts.mjs';

globalThis.window=new Window({url:'https://easel.test/'});globalThis.document=window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const {default:Row}=await loadTsModule('../src/components/ChatSubagentActivity.tsx',import.meta.url);
const agent={id:'subagent:12345678901234567890',parentId:'root:a',name:'Explore',task:'检索前端路由与页面',state:'working',source:'live'};
const result=(sid='a',turn='t1',id=agent.id)=>({sessionId:sid,turnId:turn,agentId:id,
  operations:[{id:'read',name:'read',kind:'read',status:'returned',path:'src/routes.ts',command:'',output:'child file contents',diff:''}],
  progress:['正在检查路由文件'],warnings:[],observedModel:{source:'observed',provider:'openai',model:'child-model',channel:'child-channel',observedAt:'2026-10-20T00:00:00Z'}});

async function fixture(t){
  const requests=[],timers=new Map();let next=0;
  t.mock.method(globalThis,'setTimeout',(fn,ms)=>{timers.set(++next,{fn,ms});return next;});
  t.mock.method(globalThis,'clearTimeout',id=>timers.delete(id));
  t.mock.method(globalThis,'fetch',(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject})));
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  const render=async(sid='a',turn='t1',value=agent)=>act(async()=>root.render(createElement(Row,{key:`${sid}:${turn}:${value.id}`,sessionId:sid,turnId:turn,agent:value,stale:false,events:[{id:'parent',agentId:'root:a',title:'PARENT_OPERATION'},{id:'spawn',agentId:agent.id,title:'委派已接受',kind:'spawn'}]})));
  await render();
  t.after(async()=>{await act(async()=>root.unmount());host.remove();});
  const click=async selector=>act(async()=>host.querySelector(selector).click());
  const reply=async(index,data=result())=>act(async()=>requests[index].resolve(Response.json(data)));
  const tick=async ms=>act(async()=>{for(const[id,timer]of [...timers])if(timer.ms===ms){timers.delete(id);timer.fn();}});
  return{host,requests,timers,render,click,reply,tick};
}

test('compact row reads exact child only when opened; operations and output expand inline',async t=>{
  const v=await fixture(t);assert.equal(v.requests.length,0);assert.match(v.host.textContent,/子智能体Explore.*检索前端/);
  await v.click('.chat-subagent-trigger');
  const query=new URL(v.requests[0].url,'https://easel.test').searchParams;
  assert.deepEqual(Object.fromEntries(query),{sessionId:'a',turnId:'t1',agentId:agent.id});
  assert.equal(v.requests[0].options.cache,'no-store');
  await v.reply(0);assert.match(v.host.textContent,/正在检查路由文件/);assert.match(v.host.textContent,/child-model.*child-channel/);
  assert.doesNotMatch(v.host.textContent,/PARENT_OPERATION/);
  const details=v.host.querySelector('.chat-execution-row');
  await act(async()=>{details.open=true;details.dispatchEvent(new window.Event('toggle'));});
  assert.match(v.host.textContent,/child file contents/);
});

test('Escape collapses and restores focus while aborting the in-flight child request',async t=>{
  const v=await fixture(t);await v.click('.chat-subagent-trigger');
  await act(async()=>v.host.querySelector('.chat-subagent-row').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  assert.equal(v.host.querySelector('.chat-subagent-trigger').getAttribute('aria-expanded'),'false');
  assert.equal(document.activeElement,v.host.querySelector('.chat-subagent-trigger'));
  assert.equal(v.requests[0].options.signal.aborted,true);assert.equal(v.timers.size,0);
  await v.reply(0);assert.doesNotMatch(v.host.textContent,/child file contents/);
});

test('foreign detail response is rejected, with retry and no foreign content displayed',async t=>{
  const v=await fixture(t);await v.click('.chat-subagent-trigger');await v.reply(0,result('foreign'));
  assert.match(v.host.textContent,/不属于当前对话/);assert.doesNotMatch(v.host.textContent,/正在检查路由文件|child-model/);
  await v.click('.chat-subagent-detail-meta button');await v.reply(1);
  assert.match(v.host.textContent,/正在检查路由文件/);assert.doesNotMatch(v.host.textContent,/不属于当前对话/);
});

test('poll failure keeps last observations and retry; polling does not overlap',async t=>{
  const v=await fixture(t);await v.click('.chat-subagent-trigger');await v.tick(2000);assert.equal(v.requests.length,1);
  await v.reply(0);await v.tick(2000);assert.equal(v.requests.length,2);
  await act(async()=>v.requests[1].reject(new Error('暂时断网')));
  assert.match(v.host.textContent,/暂时断网.*保留上次/);assert.match(v.host.textContent,/正在检查路由文件/);
  await v.click('.chat-subagent-detail-meta button');await v.reply(2);
  assert.doesNotMatch(v.host.textContent,/暂时断网/);
});

test('changing conversation, turn or child discards previous detail and aborts late replies',async t=>{
  const v=await fixture(t);await v.click('.chat-subagent-trigger');await v.reply(0);
  await v.tick(2000);await v.render('b','t2',{...agent,id:'subagent:99999999999999999999',task:'另一项任务'});
  assert.equal(v.requests[1].options.signal.aborted,true);assert.doesNotMatch(v.host.textContent,/正在检查路由文件|child-model/);
  await v.reply(1);assert.doesNotMatch(v.host.textContent,/正在检查路由文件/);
  await v.click('.chat-subagent-trigger');assert.match(v.requests[2].url,/sessionId=b&turnId=t2/);
});

test('timeout is retryable and missing child transcript retains only matching parent receipts',async t=>{
  const v=await fixture(t);await v.render('a','t1',{...agent,state:'unknown',latestReply:{text:'来自子任务的摘要',source:'parent_tool_receipt'}});
  await v.click('.chat-subagent-trigger');await v.tick(12000);
  await act(async()=>v.requests[0].reject(new Error('aborted')));
  assert.match(v.host.textContent,/读取子任务超时/);assert.match(v.host.textContent,/来自子任务的摘要/);
  assert.doesNotMatch(v.host.textContent,/PARENT_OPERATION/);
  await v.click('.chat-subagent-detail-meta button');await v.reply(1,{...result(),operations:[],progress:[],warnings:['子任务记录尚未落盘']});
  assert.match(v.host.textContent,/尚无可展示.*来自子任务的摘要/s);assert.equal([...v.timers.values()].some(timer=>timer.ms===2000),false);
});
