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
const {useChatGoalComposer}=await loadTsModule('../src/hooks/useChatGoalComposer.ts',import.meta.url);

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

test('model review is labelled as a recommendation inside existing stage records',async()=>{
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  const reviewed={...stage,id:'review',title:'审查结果',review:{decision:'pass',summary:'合成建议通过，仍需人工检查',findings:[]}};
  await act(async()=>root.render(createElement(Board,{stages:[reviewed]})));
  assert.match(host.querySelector('.task-stage-status').textContent,/模型建议通过/);
  assert.equal(host.querySelector('details').open,false);
  assert.match(host.querySelector('details').textContent,/仍需人工检查/);
  await act(async()=>root.render(createElement(Board,{stages:[{...reviewed,status:'blocked',review:{decision:'revise',summary:'合成：需补充说明',findings:['合成：缺少实际检查步骤']}}]})));
  assert.match(host.querySelector('.task-stage-status').textContent,/需要处理 · 模型建议返工/);
  assert.match(host.querySelector('details').textContent,/缺少实际检查步骤/);
  await act(async()=>root.unmount());host.remove();
});

function Composer(props){
  const state=useChatGoalComposer(props);
  return createElement('div',null,createElement(Options,{state,onExit:()=>{}}),createElement(ChatGoalNotice,{state,blocked:false}),
    createElement('button',{'data-start':true,disabled:!state.canSubmit,onClick:()=>void state.save()},'开始'));
}

test('parallel choice keeps compact goal controls and sends the separate workflow with shared limits',async t=>{
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host),requests=[];
  t.mock.method(globalThis,'fetch',async(url,options={})=>{
    if(String(url).includes('/agent-office/models'))return new Response(JSON.stringify({available:true,scope:'next_turn',options:[{id:'fixture/model',provider:'fixture',model:'model',configured:true}]}));
    requests.push(JSON.parse(options.body));return new Response(JSON.stringify({id:'parallel'}));
  });
  await act(async()=>root.render(createElement(Composer,{sessionId:'parent',engine:'openclaw',modelRef:'fixture/model',editor:{seed:'隔离合成并行目标'},blocked:false})));
  await act(async()=>host.querySelector('[aria-label="目标推进方式"]').click());
  await act(async()=>[...document.querySelectorAll('[role=option]')].find(item=>item.textContent==='并行协作').click());
  assert.match(host.querySelector('[aria-label="目标推进方式"]').title,/并行协作/);
  assert.equal(host.querySelector('[data-start]').disabled,false,host.textContent);
  await act(async()=>host.querySelector('[data-start]').click());
  assert.equal(requests[0].goal.workflow,'parallel-reviewed-delivery');
  assert.equal(requests[0].goal.maxSeconds,1200);assert.equal(requests[0].goal.maxTools,40);
  assert.equal(requests[0].goal.maxIterations,8);assert.equal(requests[0].goal.criteria[0].type,'review');
  await act(async()=>root.unmount());host.remove();
});
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
  assert.equal(requests[0].body.goal.workflow,'reviewed-delivery');
  assert.equal(requests[0].body.goal.maxIterations,8);
  assert.match(host.textContent,/已保存/);
  await act(async()=>host.querySelector('[data-start]').click());
  assert.equal(requests.filter(r=>r.url.endsWith('/goals')).length,1);
  await act(async()=>root.render(createElement(Composer,{...props,sessionId:'two'})));
  await act(async()=>host.querySelector('[aria-label="目标推进方式"]').click());
  assert.equal(document.querySelector('[role=option][aria-selected=true]').textContent,'直接推进');
  await act(async()=>root.unmount());host.remove();
});
