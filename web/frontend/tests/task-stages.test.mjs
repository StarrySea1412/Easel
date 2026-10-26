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
const {default:Options}=await loadTsModule('../src/components/ChatGoalComposer.tsx',import.meta.url);
const {useChatGoalComposer}=await loadTsModule('../src/hooks/useChatGoalComposer.ts',import.meta.url);

const stage={id:'research',title:'研究依据',objective:'核对实际来源',roleId:'researcher',role:{shortName:'研究'},status:'completed',attempts:1,
  criteria:[{type:'file',label:'依据文件',value:'workflows/one/research.md'}],checks:[{state:'passed',detail:'文件已核验'}],handoff:'来源已写入文件'};

test('stage board separates verified handoff from pending artifacts and final quality acceptance',async()=>{
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  await act(async()=>root.render(createElement(Board,{stages:[stage,{...stage,id:'build',title:'制作结果',status:'running',checks:[],handoff:undefined}]})));
  assert.match(host.textContent,/1\/2 阶段已交接/);
  assert.match(host.textContent,/最终质量由你验收/);
  assert.equal(host.querySelectorAll('a').length,1);
  assert.equal(host.querySelector('a').getAttribute('href'),'/api/media/workflows/one/research.md');
  assert.equal(host.querySelector('[aria-current=step] h4').textContent,'制作结果');
  assert.match(host.textContent,/等待本阶段文件核验/);
  await act(async()=>root.unmount());host.remove();
});

function Composer(props){
  const state=useChatGoalComposer(props);
  return createElement('div',null,createElement(Options,{state,blocked:false,onExit:()=>{}}),
    createElement('button',{'data-start':true,disabled:!state.canSubmit,onClick:()=>void state.save()},'开始'));
}
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
  assert.match(host.textContent,/研究依据/);
  assert.equal(host.querySelector('[data-start]').disabled,false,host.textContent);
  await act(async()=>host.querySelector('[data-start]').click());
  assert.equal(requests[0].body.goal.workflow,'research-delivery');
  assert.equal(requests[0].body.goal.maxIterations,8);
  assert.match(host.textContent,/目标已保存/);
  await act(async()=>host.querySelector('[data-start]').click());
  assert.equal(requests.filter(r=>r.url.endsWith('/goals')).length,1);
  await act(async()=>root.render(createElement(Composer,{...props,sessionId:'two'})));
  assert.equal(host.querySelector('[aria-label="目标推进方式"]').textContent.includes('直接推进'),true);
  await act(async()=>root.unmount());host.remove();
});
