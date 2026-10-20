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
  const render=async(sid='a',extra={},streaming=false)=>act(async()=>root.render(createElement(ChatRunProvider,{sessionId:sid,turnId:'t1',engine:'openclaw',streaming,enabled:true},createElement(Capsule,{onGoal(){},...extra}),createElement(Activity,{sessionId:sid,turnId:'t1'}),createElement(Execution,{sessionId:sid,turnId:'t1',streaming}))));
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

test('progress groups keep completed and remaining tasks accessible without an empty checklist message',async t=>{
  const v=await setup(t);
  await v.respond(0,{...snapshot(),plan:[...plan,...Array.from({length:4},(_,i)=>({step:`后续任务${i+1}`,status:'pending'}))]});
  await v.click('.chat-progress-capsule');
  const groups=()=>[...v.container.querySelectorAll('.chat-progress-group')];
  assert.deepEqual(groups().map(button=>button.getAttribute('aria-expanded')),['false','false']);
  assert.equal(v.container.querySelector('li[data-state=completed]').closest('ol').hidden,true);
  for(const button of groups()) await act(async()=>button.click());
  assert.equal(v.container.querySelector('li[data-state=completed]').closest('ol').hidden,false);
  assert.equal(v.container.querySelectorAll('ol[hidden]').length,0);
  await act(async()=>window.dispatchEvent(new window.CustomEvent('easel:execution',{detail:{...snapshot(),plan:[],progress:['接口请求未完成']}})));
  await v.render('a',{failed:true});
  assert.doesNotMatch(v.container.textContent,/没有结构化清单|尚未提交结构化清单/);
  assert.equal(v.container.querySelectorAll('.chat-progress-summary').length,1);
  assert.equal(v.container.querySelector('.chat-progress-summary').textContent,'本轮失败');
  assert.equal(v.container.querySelector('.chat-progress-history p').textContent,'接口请求未完成');
  assert.equal(v.container.querySelector('.chat-progress-history [hidden]').hidden,true);
});

const silence='已180秒未收到新事件；当前阶段尚未确认，可能正在等待输入、工具或模型响应。请查看本轮状态与操作记录；任务未自动重发或终止。';
const handshake=['请求已收到，等待运行器确认','已进入运行器，等待模型事件'];
const question='等待你回答问题，请查看输入框上方的选项卡。';
test('screenshot noise becomes one short status without a duplicate history',async t=>{
  const v=await setup(t);
  await v.respond(0,{...snapshot(),plan:[],progress:[...handshake,question,silence,silence]});
  await v.render('a',{activity:silence},true);await v.click('.chat-progress-capsule');
  assert.equal(v.container.querySelector('.chat-progress-summary').textContent,'等待进度更新');
  assert.equal(v.container.querySelector('.chat-progress-capsule').dataset.state,'running');
  assert.equal(v.container.querySelector('.chat-progress-history'),null);
  assert.doesNotMatch(v.container.textContent,/180秒|运行器|选项卡|自动重发|当前阶段尚未确认/);
});
test('real progress is preserved, deduplicated and collapsed with accessible controls',async t=>{
  const v=await setup(t);
  await v.respond(0,{...snapshot(),plan:[],progress:['已读取配置','已核对渠道','已读取配置','正在检查返回结果']});
  await v.click('.chat-progress-capsule');
  assert.equal(v.container.querySelector('.chat-progress-summary').textContent,'正在检查返回结果');
  const toggle=v.container.querySelector('.chat-progress-history-toggle');
  const history=document.getElementById(toggle.getAttribute('aria-controls'));
  assert.equal(toggle.textContent,'较早进度 · 2');assert.equal(history.hidden,true);
  await v.click('.chat-progress-history-toggle');
  assert.equal(history.hidden,false);assert.equal(toggle.getAttribute('aria-expanded'),'true');
  assert.deepEqual([...history.querySelectorAll('p')].map(p=>p.textContent),['已核对渠道','已读取配置']);
  assert.equal(v.container.querySelectorAll('.chat-progress-popover p').length,2);
});
test('handshake-only execution stays running without inventing a model phase',async t=>{
  const v=await setup(t);await v.respond(0,{...snapshot(),plan:[],progress:handshake});
  await v.render('a',{activity:handshake[1]},true);await v.click('.chat-progress-capsule');
  assert.equal(v.container.querySelector('.chat-progress-summary').textContent,'正在执行');
  assert.equal(v.container.querySelector('.chat-progress-history'),null);
  assert.doesNotMatch(v.container.textContent,/正在思考|模型已响应|清单已完成/);
});
test('an idle handshake-only record does not leave an empty progress control',async t=>{
  const v=await setup(t);await v.respond(0,{...snapshot(),plan:[],progress:handshake});
  await v.render('a',{activity:handshake[1]});
  assert.equal(v.container.querySelector('.chat-progress-capsule'),null);
});
test('a current user question stays visible while old question notices do not clutter history',async t=>{
  const v=await setup(t);await v.respond(0,{...snapshot(),plan:[],progress:[...handshake,question]});
  await act(async()=>window.dispatchEvent(new window.CustomEvent('easel:execution',{detail:{...snapshot(),progress:[...handshake,question]}})));
  await v.render('a',{},true);await v.click('.chat-progress-capsule');
  assert.match(v.container.querySelector('.chat-progress-capsule').textContent,/等待你回答/);
  assert.match(v.container.querySelector('.chat-progress-popover').textContent,/实现任务清单/);
  assert.equal(v.container.querySelector('.chat-progress-history'),null);
});
test('timeline progress takes precedence and matching plan updates are not repeated in history',async t=>{
  const v=await setup(t);await v.respond(0,{...snapshot(),progress:['旧快照'],timeline:[{id:'p1',order:0,type:'progress',text:'实现任务清单'},{id:'p2',order:1,type:'progress',text:silence}]});
  await v.click('.chat-progress-capsule');
  assert.equal(v.container.querySelector('.chat-progress-history'),null);
  assert.doesNotMatch(v.container.textContent,/旧快照|180秒/);
  assert.equal(v.container.querySelector('.chat-progress-capsule').textContent.includes('实现任务清单'),true);
});
test('an operation-only timeline does not hide legacy progress; explicit failures remain readable',async t=>{
  const v=await setup(t);await v.respond(0,{...snapshot(),plan:[],timeline:[],progress:['网络中断，等待重连','服务商限流，请稍后重试']});
  await v.render('a',{failed:true});await v.click('.chat-progress-capsule');
  await v.click('.chat-progress-history-toggle');
  assert.match(v.container.querySelector('.chat-progress-history').textContent,/网络中断，等待重连.*服务商限流，请稍后重试/);
  assert.equal(v.container.querySelector('.chat-progress-summary').textContent,'本轮失败');
});
