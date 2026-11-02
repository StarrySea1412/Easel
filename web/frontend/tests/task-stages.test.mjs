import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window=new Window({url:'https://easel.test/'});
globalThis.document=window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const {default:Board}=await loadTsModule('../src/components/TaskStageBoard.tsx',import.meta.url);
const {default:GoalPanel}=await loadTsModule('../src/components/ChatGoalPanel.tsx',import.meta.url);
const {default:Options,ChatGoalNotice}=await loadTsModule('../src/components/ChatGoalComposer.tsx',import.meta.url);
const {useChatGoalComposer,resetWorkflowCache}=await loadTsModule('../src/hooks/useChatGoalComposer.ts',import.meta.url);

const stage={id:'research',title:'研究依据',objective:'核对实际来源',roleId:'researcher',role:{shortName:'研究'},status:'completed',attempts:1,
  criteria:[{type:'file',label:'依据文件',value:'workflows/one/research.md'}],checks:[{state:'passed',detail:'文件已核验'}],handoff:'来源已写入文件'};

test('stage board separates verified handoff from pending artifacts and final quality acceptance',async()=>{
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  await act(async()=>root.render(createElement(Board,{stages:[stage,{...stage,id:'build',title:'制作结果',status:'running',checks:[],handoff:undefined}]})));
  assert.match(host.textContent,/1\/2 阶段已交接/);
  assert.equal(host.querySelectorAll('a').length,1);
  assert.equal(host.querySelector('a').getAttribute('href'),'/api/media/workflows/one/research.md');
  assert.equal(host.querySelector('[aria-current=step] h4').textContent,'制作结果');
  assert.match(host.textContent,/等待本阶段文件核验/);
  await act(async()=>root.unmount());host.remove();
});

function Composer(props){
  const state=useChatGoalComposer(props);
  return createElement('div',null,createElement(Options,{state,onExit:()=>{}}),createElement(ChatGoalNotice,{state,blocked:false}),
    createElement('button',{'data-start':true,disabled:!state.canSubmit,onClick:()=>void state.save()},'开始'));
}
test('chat sidebar shows a flat stage summary and sends evidence review to the full workspace',async()=>{
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);let opened=0;
  const goal={id:'g',sessionId:'s',title:'协作目标',objective:'完成研究和制作',status:'paused',phase:'idle',stages:[stage],steps:[],checks:[],criteria:[],iterations:1,maxIterations:8,activeSeconds:0,maxSeconds:1200,maxTools:40,maxImages:0,toolsUsed:0,imagesUsed:0,reason:'已暂停'};
  await act(async()=>root.render(createElement(GoalPanel,{goal,runs:[],onChanged:()=>{},onEdit:()=>{},onWorkspace:()=>opened++})));
  assert.equal(host.querySelector('aside'),null,'sidebar owns the outer container');
  assert.equal(host.querySelector('details'),null,'summary does not embed evidence or receipt disclosures');
  assert.equal(host.querySelector('.task-stage-receipt'),null);
  assert.match(host.textContent,/研究依据/);assert.match(host.textContent,/交接已核验/);
  assert.ok(!host.textContent.includes('当前阶段步骤'),'empty steps do not create a second progress section');
  await act(async()=>[...host.querySelectorAll('button')].find(button=>button.textContent.includes('任务详情')).click());
  assert.equal(opened,1);await act(async()=>root.unmount());host.remove();
});
test('workflow is sent with its budget, saved-start retry does not create another goal, and session switch clears selection',async t=>{
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host),requests=[];
  let starts=0;
  t.mock.method(globalThis,'fetch',async(url,options={})=>{
    if(String(url).includes('/agent-office/models'))return new Response(JSON.stringify({available:true,scope:'next_turn',options:[{id:'fixture/model',provider:'fixture',model:'model',configured:true,label:'隔离模型'}]}));
    const body=JSON.parse(options.body);requests.push({url:String(url),body});
    if(String(url).endsWith('/goals'))return new Response(JSON.stringify({id:'created'}));
    starts++;return new Response(JSON.stringify(starts===1?{detail:'保护暂不可用'}:{}),{status:starts===1?409:200});
  });
  const props={sessionId:'one',engine:'openclaw',modelRef:'fixture/model',editor:{seed:'交付研究方案'},blocked:false};
  await act(async()=>root.render(createElement(Composer,props)));
  const trigger=host.querySelector('[aria-label="目标推进方式"]');
  await act(async()=>trigger.click());
  await act(async()=>[...document.querySelectorAll('[role=option]')].find(o=>o.textContent.includes('分工协作')).click());
  assert.match(host.querySelector('[aria-label="目标推进方式"]').textContent,/协作/);
  assert.equal(host.querySelector('[data-start]').disabled,false,host.textContent);
  await act(async()=>host.querySelector('[data-start]').click());
  assert.equal(requests[0].body.goal.workflow,'research-delivery');
  assert.equal(requests[0].body.goal.maxIterations,8);
  assert.match(host.textContent,/已保存/);
  await act(async()=>host.querySelector('[data-start]').click());
  assert.equal(requests.filter(r=>r.url.endsWith('/goals')).length,1);
  await act(async()=>root.render(createElement(Composer,{...props,sessionId:'two'})));
  await act(async()=>host.querySelector('[aria-label="目标推进方式"]').click());
  assert.equal(document.querySelector('[role=option][aria-selected=true]').textContent,'直接推进');
  await act(async()=>root.unmount());host.remove();
});
test('workflow picker serves the task-service list, falls back offline, and sends the content pipeline',async t=>{
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host),requests=[];
  t.mock.method(globalThis,'fetch',async(url,options={})=>{
    if(String(url).endsWith('/workflows'))return new Response(JSON.stringify({workflows:[
      {id:'research-delivery',name:'研究 → 制作 → 审查 → 交付',shortName:'分工协作',description:'',roles:['researcher','builder','reviewer','publisher']},
      {id:'content-pipeline',name:'分析 → 稿件 → 图片 → 发布准备',shortName:'内容业务链',description:'',roles:['researcher','copywriter','visual-creator','publisher']}]}));
    if(String(url).includes('/agent-office/models'))return new Response(JSON.stringify({available:true,scope:'next_turn',options:[{id:'fixture/model',provider:'fixture',model:'model',configured:true,label:'隔离模型'}]}));
    const body=JSON.parse(options.body);requests.push({url:String(url),body});
    return new Response(JSON.stringify({id:'created'}));
  });
  const props={sessionId:'one',engine:'openclaw',modelRef:'fixture/model',editor:{seed:'产出小红书发帖准备包'},blocked:false};
  resetWorkflowCache();
  await act(async()=>root.render(createElement(Composer,props)));
  await act(async()=>{});
  await act(async()=>host.querySelector('[aria-label="目标推进方式"]').click());
  const labels=[...document.querySelectorAll('[role=option]')].map(o=>o.textContent);
  assert.ok(labels.includes('内容业务链')&&labels.includes('分工协作'),labels.join('|'));
  await act(async()=>[...document.querySelectorAll('[role=option]')].find(o=>o.textContent.includes('内容业务链')).click());
  assert.match(host.querySelector('[aria-label="目标推进方式"]').textContent,/协作/);
  assert.equal(host.querySelector('[data-start]').disabled,false,host.textContent);
  await act(async()=>host.querySelector('[data-start]').click());
  assert.equal(requests[0].body.goal.workflow,'content-pipeline');
  assert.equal(requests[0].body.goal.maxIterations,8);
  // A failed workflows read keeps the built-in options so the picker stays usable.
  resetWorkflowCache();
  const failing={...props,editor:{seed:'直接推进也可以'}};
  t.mock.method(globalThis,'fetch',async(url,options={})=>{
    if(String(url).endsWith('/workflows'))return new Response(JSON.stringify({detail:'任务请求失败，请重试'}),{status:503});
    if(String(url).includes('/agent-office/models'))return new Response(JSON.stringify({available:true,scope:'next_turn',options:[{id:'fixture/model',provider:'fixture',model:'model',configured:true,label:'隔离模型'}]}));
    return new Response(JSON.stringify({id:'created'}));
  });
  await act(async()=>root.unmount());host.remove();
  const host2=document.createElement('div');document.body.append(host2);const root2=createRoot(host2);
  await act(async()=>root2.render(createElement(Composer,failing)));
  await act(async()=>{});
  await act(async()=>host2.querySelector('[aria-label="目标推进方式"]').click());
  const fallback=[...document.querySelectorAll('[role=option]')].map(o=>o.textContent);
  assert.ok(fallback.includes('分工协作'),fallback.join('|'));
  await act(async()=>root2.unmount());host2.remove();
});

test('blocked current stage keeps the step marker for assistive technology',async()=>{
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  const stages=[stage,{...stage,id:'draft',title:'撰写稿件',status:'blocked',checks:[],handoff:undefined},
    {...stage,id:'visuals',title:'图片规格',status:'pending',checks:[],handoff:undefined}];
  await act(async()=>root.render(createElement(Board,{stages})));
  const current=host.querySelector('[aria-current=step]');
  assert.ok(current,'current stage keeps aria-current');
  assert.match(current.querySelector('h4').textContent,/撰写稿件/);
  const pendings=[...host.querySelectorAll('[aria-current=step]')];
  assert.equal(pendings.length,1,'only the first unfinished stage is current');
  await act(async()=>root.unmount());host.remove();
});
