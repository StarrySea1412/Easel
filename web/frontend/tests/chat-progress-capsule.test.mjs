import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {act,createElement} from 'react';
import {loadTsModule} from './load-ts.mjs';
globalThis.window=new Window({url:'https://easel.test/'});globalThis.document=window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const {ChatRunProvider}=await loadTsModule('../src/components/ChatRunContext.tsx',import.meta.url);
const {default:Capsule}=await loadTsModule('../src/components/ChatProgressCapsule.tsx',import.meta.url);
const {default:Activity}=await loadTsModule('../src/components/ChatAgentActivity.tsx',import.meta.url);
const {default:Execution}=await loadTsModule('../src/components/ChatExecutionPanel.tsx',import.meta.url);
const plan=[{step:'核对现有实现',status:'completed'},{step:'实现任务清单',status:'inProgress'},{step:'验证实际结果',status:'pending'}];
const identity={provider:'openai',model:'test-record-model',channel:'qa-channel',source:'observed',observedAt:'2026-10-20T00:00:00Z',evidence:'fixture receipt'};
const snapshot=(sid='a')=>({sessionId:sid,turnId:'t1',operations:[],plan,progress:['真实服务事件'],warnings:[]});
async function setup(t){
  const requests=[];
  t.mock.method(globalThis,'fetch',(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject})));
  const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
  const render=async(sid='a',extra={})=>act(async()=>root.render(createElement(ChatRunProvider,{sessionId:sid,turnId:'t1',engine:'openclaw',streaming:false,enabled:true},createElement(Capsule,{onGoal(){},...extra}),createElement(Activity,{sessionId:sid,turnId:'t1'}),createElement(Execution,{sessionId:sid,turnId:'t1',streaming:false}))));
  await render();t.after(async()=>{await act(async()=>root.unmount());container.remove();});
  const respond=async(index,value)=>act(async()=>requests[index].resolve(new Response(JSON.stringify(value))));
  const click=async(selector)=>act(async()=>container.querySelector(selector).click());
  return {container,requests,render,respond,click};
}
test('capsule and inline operations share one reader; only explicit plan updates check steps',async t=>{
  const v=await setup(t);
  assert.equal(v.requests.filter(r=>String(r.url).includes('/execution/')).length,1);
  await v.respond(0,snapshot());
  assert.match(v.container.querySelector('.chat-progress-capsule').textContent,/实现任务清单.*1\/3/);
  assert.equal(v.container.querySelector('.chat-progress-popover'),null);
  await v.click('.chat-progress-capsule');
  assert.equal(v.container.querySelectorAll('.chat-progress-popover li').length,3);
  await act(async()=>window.dispatchEvent(new window.CustomEvent('easel:execution',{detail:{...snapshot(),operations:[{id:'tool',name:'exec',status:'completed',command:'qa',path:'',output:'ok',diff:''}]}})));
  assert.match(v.container.querySelector('.chat-progress-capsule').textContent,/1\/3/);
  await act(async()=>window.dispatchEvent(new window.CustomEvent('easel:execution',{detail:{...snapshot(),plan:plan.map(step=>({...step,status:'completed'}))}})));
  assert.match(v.container.querySelector('.chat-progress-capsule').textContent,/清单已完成.*3\/3/);
  assert.equal(v.container.querySelector('.chat-progress-capsule').getAttribute('aria-expanded'),'true');
});
test('Escape closes and restores focus, session switch immediately removes former plan and identities',async t=>{
  const v=await setup(t);await v.respond(0,snapshot());await v.click('.chat-progress-capsule');
  await act(async()=>v.container.querySelector('.chat-progress-anchor').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  assert.equal(v.container.querySelector('.chat-progress-popover'),null);
  assert.equal(document.activeElement,v.container.querySelector('.chat-progress-capsule'));
  await v.render('b');assert.doesNotMatch(v.container.textContent,/实现任务清单|test-record-model/);
  assert.equal(v.requests[0].options.signal.aborted,true);
});
test('observed root and child actions use exact office turn; config and foreign snapshots never become identities',async t=>{
  const v=await setup(t);await v.respond(0,snapshot());
  const index=v.requests.findIndex(r=>String(r.url).includes('/agent-office?'));
  await v.respond(index,{sessionId:'a',turnId:'t1',agents:[{id:'root:a',name:'主Agent',role:'root',status:'thinking',task:'qa',observedModel:identity},{id:'child',parentId:'root:a',name:'校验者',role:'subagent',status:'running',task:'核验',observedModel:{...identity,source:'configured'}}],events:[]});
  assert.match(v.container.textContent,/主 Agent.*正在思考/);assert.match(v.container.textContent,/test-record-model/);assert.match(v.container.textContent,/qa-channel/);assert.match(v.container.textContent,/子 Agent.*校验者/);assert.match(v.container.textContent,/模型未上报/);
  assert.equal(v.container.querySelector('[data-agent-id="child"] [data-provider-brand]'),null);
});
test('stopped and failed runs preserve unchecked steps and expose interrupted progress reads',async t=>{
  const v=await setup(t);await v.respond(0,snapshot());await v.render('a',{stopped:true});await v.click('.chat-progress-capsule');assert.match(v.container.textContent,/本轮已停止，未完成步骤保留/);
  await v.render('a',{failed:true});assert.match(v.container.textContent,/本轮失败，未完成步骤保留/);assert.match(v.container.querySelector('.chat-progress-capsule').textContent,/1\/3/);
});
