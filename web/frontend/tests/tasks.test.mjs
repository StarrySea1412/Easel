import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';
globalThis.window=new Window({url:'https://easel.test/'});globalThis.document=window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const {mergeTaskSessions,planNeedsAttention}=await loadTsModule('../src/lib/tasks.ts',import.meta.url);
const {default:GoalCard}=await loadTsModule('../src/components/GoalCard.tsx',import.meta.url);
const {default:GoalPanel}=await loadTsModule('../src/components/ChatGoalPanel.tsx',import.meta.url);
const {default:GoalOptions}=await loadTsModule('../src/components/ChatGoalComposer.tsx',import.meta.url);
const {useChatGoalComposer}=await loadTsModule('../src/hooks/useChatGoalComposer.ts',import.meta.url);
// Exercise goal persistence independently; shared input/keyboard behavior is in composer tests.
function GoalComposer({seed,goal,modelRef='',onConfigured,blocked=false,...props}){
  const state=useChatGoalComposer({...props,modelRef,blocked,editor:{seed,goal,onConfigured}});
  return createElement('form',{onSubmit:event=>{event.preventDefault();void state.save();}},
    createElement(GoalOptions,{state,goal,blocked,onExit:props.onClose}),
    createElement('button',{type:'submit',className:'btn-primary',disabled:!state.canSubmit},state.label));
}
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

test('conversation goal panel shows reported steps and blockers separately from quality acceptance',async t=>{
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);let changed=0;
  const requests=[];t.mock.method(globalThis,'fetch',async(url,options)=>{requests.push(JSON.parse(options.body));return new Response('{}');});
  const g={...goal,status:'active',phase:'running',steps:[{id:'a',title:'核对材料',status:'completed'},{id:'b',title:'生成页面',status:'in_progress'},{id:'c',title:'等待截图',status:'blocked',detail:'需要提供原图'}]};
  await act(async()=>root.render(createElement(GoalPanel,{goal:g,runs:[],onChanged:()=>changed++,onClose:()=>{},onEdit:()=>{}})));
  assert.match(host.textContent,/1\/3/);assert.match(host.textContent,/需要提供原图/);assert.match(host.textContent,/最终验收单独确认/);
  assert.equal(host.querySelectorAll('li.completed').length,1);
  await act(async()=>host.querySelector('[aria-label="暂停目标"]').click());assert.equal(requests[0].action,'stop');assert.equal(changed,1);
  assert.ok(!host.textContent.includes('100%'));
  await act(async()=>root.unmount());host.remove();
});

test('goal setup binds current chat, stays saved after failed start and retries without creating a duplicate',async t=>{
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);const requests=[];let closed=0,configured=0;
  t.mock.method(globalThis,'fetch',async(url,options={})=>{
    if(String(url).includes('/agent-office/models'))return new Response(JSON.stringify({available:true,scope:'next_turn',currentModelRef:'fixture/model',options:[{id:'fixture/model',provider:'fixture',model:'model',configured:true,label:'模拟模型'}]}));
    requests.push({url,body:JSON.parse(options.body),method:options.method});
    if(String(url).endsWith('/goals'))return new Response(JSON.stringify({...goal,id:'created'}));
    if(requests.length===2)return new Response(JSON.stringify({detail:'执行保护暂不可用'}),{status:409});
    return new Response('{}');
  });
  await act(async()=>root.render(createElement(GoalComposer,{sessionId:'original-chat',engine:'openclaw',seed:'完成原对话的8张卡片',modelRef:'fixture/model',onClose:()=>closed++,onChanged:()=>{},onConfigured:()=>configured++})));
  assert.equal(document.querySelector('[role=dialog]'),null,'goal setup stays in composer without modal or focus trap');
  assert.equal(document.querySelector('details'),null,'goal mode exposes no settings form');
  const form=host.querySelector('form');
  await act(async()=>form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));
  assert.equal(requests[0].body.sessionId,'original-chat');assert.equal(requests[0].body.goal.modelRef,'fixture/model');assert.equal(configured,1);assert.equal(closed,0);
  assert.match(document.querySelector('[role=alert]').textContent,/已保存/);
  await act(async()=>form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));
  assert.equal(requests.filter(r=>String(r.url).endsWith('/goals')).length,1);assert.equal(closed,1);
  await act(async()=>root.unmount());host.remove();
});

test('inline goal never silently substitutes an unavailable explicit model and does not run while blocked',async t=>{
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);const requests=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{requests.push({url,options});return new Response(JSON.stringify({available:true,scope:'next_turn',currentModelRef:'fixture/expensive',options:[{id:'fixture/expensive',provider:'fixture',model:'expensive',configured:true}]}));});
  const props={sessionId:'safe',engine:'openclaw',seed:'只用指定模型',modelRef:'fixture/missing',onClose:()=>{},onChanged:()=>{}};
  await act(async()=>root.render(createElement(GoalComposer,props)));
  assert.match(host.querySelector('[role=alert]').textContent,/不会自动更换模型/);
  assert.equal(host.querySelector('button[type=submit]')?.disabled??host.querySelector('.btn-primary').disabled,true);
  await act(async()=>host.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));
  assert.equal(requests.length,1);
  await act(async()=>root.render(createElement(GoalComposer,{...props,blocked:true})));
  assert.match(host.textContent,/请先暂停/);assert.equal(host.querySelector('.btn-primary').disabled,true);
  await act(async()=>root.unmount());host.remove();
});

test('budget-limited goal shows the limit state and active goals explain user-message priority',async()=>{
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  await act(async()=>root.render(createElement(GoalPanel,{goal:{...goal,status:'blocked',phase:'budget',reason:'已达到目标轮次或时长上限。'},runs:[],onChanged:()=>{},onClose:()=>{},onEdit:()=>{}})));
  assert.match(host.textContent,/已达执行上限/);
  assert.match(host.textContent,/已达到目标轮次或时长上限。/);
  assert.ok(!host.textContent.includes('已完成'));
  await act(async()=>root.render(createElement(GoalPanel,{goal:{...goal,status:'active',phase:'queued',reason:''},runs:[],onChanged:()=>{},onClose:()=>{},onEdit:()=>{}})));
  assert.match(host.textContent,/你的消息会优先处理/);
  assert.match(host.textContent,/\/goal pause/);
  // A terminal goal keeps its real state even when the phase still says budget.
  await act(async()=>root.render(createElement(GoalPanel,{goal:{...goal,status:'cancelled',phase:'budget',reason:'已取消'},runs:[],onChanged:()=>{},onClose:()=>{},onEdit:()=>{}})));
  assert.match(host.textContent,/已取消/);
  assert.ok(!host.textContent.includes('已达执行上限'));
  await act(async()=>root.unmount());host.remove();
});

test('plan attention follows the latest triggered run without inventing unread state',()=>{
  const schedule={kind:'monthly',timezone:'Asia/Shanghai',time:'09:00',minutes:60,weekdays:[0],day:1};
  const history=[{at:1,status:'queued',reason:'',trigger:'schedule',goalId:'g1'}];
  const plan={id:'p1',title:'月度盘点',enabled:true,nextAt:2,goal,schedule,missedPolicy:'skip',freshnessSeconds:900,history};
  assert.equal(planNeedsAttention(plan,[{...goal,id:'g1',status:'active'}]),false);
  assert.equal(planNeedsAttention(plan,[{...goal,id:'g1',status:'blocked'}]),true);
  assert.equal(planNeedsAttention(plan,[]),false);
  assert.equal(planNeedsAttention({...plan,history:[]},[{...goal,id:'g1',status:'blocked'}]),false);
});
