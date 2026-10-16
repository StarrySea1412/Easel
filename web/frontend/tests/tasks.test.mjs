import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';
globalThis.window=new Window({url:'https://easel.test/'});globalThis.document=window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const {mergeTaskSessions}=await loadTsModule('../src/lib/tasks.ts',import.meta.url);
const {default:GoalCard}=await loadTsModule('../src/components/GoalCard.tsx',import.meta.url);
const goal={id:'goal',sessionId:'chat',title:'验收目标',objective:'生成选题并交付文件',modelRef:'fixture/model',status:'blocked',phase:'review',iterations:2,maxIterations:5,activeSeconds:20,maxSeconds:1200,maxTools:40,maxImages:0,criteria:[{type:'file',label:'文件',value:'topic/page.html'},{type:'review',label:'质量',value:''}],checks:[{state:'passed',detail:'已核验'},{state:'pending',detail:'等待确认'}],currentTurnId:'turn',reason:'等待用户验收'};
test('task history merges into original chat without replacing local messages or duplicate turn replay',()=>{
  const local=[{id:'chat',title:'原对话名称',messages:[{role:'user',content:'原消息',turnId:'old'}]}];
  const remote=[{id:'chat',title:'目标名称',messages:[{role:'assistant',content:'交付内容',turnId:'turn',taskRunId:'run'}]}];
  const once=mergeTaskSessions(local,remote),twice=mergeTaskSessions(once,remote);
  assert.equal(once[0].title,'原对话名称');assert.equal(once[0].messages.length,2);assert.equal(twice,once);
  const changed=mergeTaskSessions(once,[{...remote[0],messages:[{...remote[0].messages[0],content:'已对账'}]}]);
  assert.equal(changed[0].messages[1].content,'已对账');assert.equal(changed[0].messages[0],local[0].messages[0]);
});
test('imported backup is never converted into a live task session',()=>{
  const local=[{id:'chat',messages:[],importedFromBackup:true}];
  assert.equal(mergeTaskSessions(local,[{id:'chat',messages:[{turnId:'turn'}]}]),local);
});
test('goal review is explicit, tool counts are displayed, and unconfirmed run forbids resume',async t=>{
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);let refresh=0;const requests=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return new Response(JSON.stringify({...goal,status:'completed'}),{headers:{'Content-Type':'application/json'}});});
  const render=async(g,runs=[])=>act(async()=>root.render(createElement(GoalCard,{goal:g,runs,onChange:()=>refresh++})));
  await render(goal);
  assert.match(host.textContent,/验收 1 \/ 2/);assert.match(host.textContent,/fixture\/model/);assert.match(host.textContent,/0 \/ 40/);
  const approve=[...host.querySelectorAll('button')].find(b=>b.textContent.includes('确认通过'));
  await act(async()=>approve.click());assert.equal(requests.at(-1).body.action,'approve');assert.equal(refresh,1);
  await render({...goal,status:'paused'},[{goalId:'goal',state:'unconfirmed'}]);
  assert.ok(![...host.querySelectorAll('button')].some(b=>b.textContent==='继续目标'));
  assert.match(host.textContent,/后台结算中/);
  await act(async()=>root.unmount());host.remove();
});
test('failed start keeps error visible and does not report completion',async t=>{
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);let refresh=0;
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({detail:'保护未加载'}),{status:409,headers:{'Content-Type':'application/json'}}));
  await act(async()=>root.render(createElement(GoalCard,{goal:{...goal,status:'draft',phase:'idle'},runs:[],onChange:()=>refresh++})));
  await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='启动目标').click());
  assert.equal(host.querySelector('[role=alert]').textContent,'保护未加载');assert.equal(refresh,0);
  await act(async()=>root.unmount());host.remove();
});
