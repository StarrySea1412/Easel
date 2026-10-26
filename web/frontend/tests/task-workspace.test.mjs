import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {act,createElement} from 'react';
import {loadTsModule} from './load-ts.mjs';

globalThis.window=new Window({url:'https://easel.test/'});
globalThis.document=window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const {default:Workspace}=await loadTsModule('../src/components/TaskWorkspacePage.tsx',import.meta.url);
const {useTaskSnapshot}=await loadTsModule('../src/hooks/useTaskSnapshot.ts',import.meta.url);
const {mergeTaskSessions,mergeSessionTombstones}=await loadTsModule('../src/lib/tasks.ts',import.meta.url);
const {taskBucket,parseTaskWorkspaceHash,taskWorkspaceHash}=await loadTsModule('../src/lib/taskWorkspace.ts',import.meta.url);
const goal={id:'g1',sessionId:'s1',title:'研究与交付',objective:'核对材料并产出报告',modelRef:'fixture/model',criteria:[{type:'review',label:'内容质量',value:''}],checks:[],maxIterations:8,maxSeconds:1200,maxTools:40,maxImages:0,iterations:2,activeSeconds:10,toolsUsed:2,imagesUsed:0,status:'paused',phase:'idle',reason:'用户暂停',createdAt:1};
const active={...goal,id:'g2',sessionId:'s2',title:'进行中的图片准备',status:'active',phase:'running',reason:''};
const history={...goal,id:'g3',sessionId:'s3',title:'历史任务',status:'completed',phase:'review',reason:''};
const sync={loading:false,refreshing:false,readAt:1000,error:''};
const data={goals:[history,active,goal],runs:[],plans:[],serverTime:1000};

test('task inbox treats unconfirmed work as attention and preserves explicit route identity',()=>{
  assert.equal(taskBucket(history,[]),'history');
  assert.equal(taskBucket(history,[{goalId:history.id,state:'unconfirmed'}]),'attention');
  assert.equal(taskBucket(active,[]),'active');
  assert.equal(taskBucket({...active,phase:'waiting_input'},[]),'attention');
  assert.deepEqual(parseTaskWorkspaceHash(taskWorkspaceHash('g-123')),{goalId:'g-123'});
  assert.equal(parseTaskWorkspaceHash('#/tasks/<script>'),null);
  assert.equal(parseTaskWorkspaceHash('#/tasks/a/b'),null);
});

test('late task history cannot reinsert a deleted session or alter an imported backup',()=>{
  const original=[{id:'backup',importedFromBackup:true,title:'只读',messages:[]}];
  const late=[{id:'deleted',messages:[{turnId:'late'}]},{id:'backup',messages:[{turnId:'late'}]}];
  assert.equal(mergeTaskSessions(original,late,id=>id==='deleted'),original);
  assert.equal(original[0].messages.length,0);
});

test('server deletion removes an existing live cache while preserving a read-only backup',()=>{
  const local=[{id:'removed',messages:[]},{id:'backup',importedFromBackup:true,messages:[]},{id:'kept',messages:[]}];
  const result=mergeTaskSessions(local,[{id:'removed',messages:[{turnId:'late'}]}],id=>id==='removed'||id==='backup');
  assert.deepEqual(result.map(s=>s.id),['backup','kept']);
  const older={id:'removed',at:1,revision:2},newer={id:'removed',at:2,revision:3};
  assert.deepEqual(mergeSessionTombstones([newer],[older],[]),[newer]);
});

function button(host,label){const found=[...host.querySelectorAll('button')].find(element=>element.textContent.trim()===label);assert.ok(found,`button ${label} exists`);return found;}
const noAction=()=>{};
function props(patch={}){return {data,sessions:[],sync,onSelect:noAction,onRefresh:noAction,onOpenChat:noAction,onOpenActivity:noAction,onOpenOffice:noAction,onNew:noAction,onSchedules:noAction,...patch};}

test('workspace keeps task identity across filtering, rejects missing links, and resets details on task switch',async()=>{
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);const selections=[],opened=[];
  const initial=props({selectedId:goal.id,onSelect:id=>selections.push(id),onOpenChat:id=>opened.push(id)});
  await act(async()=>root.render(createElement(Workspace,initial)));
  await act(async()=>button(host,'验收与控制').click());
  assert.ok(host.querySelector('.goal-card'));
  await act(async()=>button(host,'回到对话 ↗').click());assert.deepEqual(opened,['s1']);
  await act(async()=>root.render(createElement(Workspace,{...initial,selectedId:active.id})));
  assert.equal(host.querySelector('.goal-card'),null,'new task does not inherit previous detail tab or error');
  assert.equal(host.querySelector('.task-workspace-detail h2').textContent,active.title);
  await act(async()=>host.querySelector('[aria-label="任务筛选"] button:last-child').click());
  assert.equal(selections.at(-1),undefined);
  assert.equal(host.querySelectorAll('.task-workspace-index li').length,1);
  await act(async()=>root.render(createElement(Workspace,{...initial,selectedId:'missing'})));
  assert.match(host.textContent,/未找到这条任务/);
  assert.equal(host.querySelector('.goal-card'),null,'missing route cannot operate another goal');
  await act(async()=>root.unmount());host.remove();
});

test('stale snapshots block resume and approval while keeping stop available; queued work never resumes',async t=>{
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host),requests=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return new Response('{}');});
  const render=async(g,runs=[])=>act(async()=>root.render(createElement(Workspace,props({data:{...data,goals:[g],runs},selectedId:g.id,sync:{...sync,error:'任务状态读取失败'}}))));
  await render(goal);await act(async()=>button(host,'验收与控制').click());
  assert.equal(button(host,'继续目标').disabled,true);
  await render({...goal,id:'review',phase:'review'});await act(async()=>button(host,'验收与控制').click());
  assert.equal(button(host,'我已检查，确认通过').disabled,true);
  await render(active,[{id:'r',goalId:active.id,sessionId:active.sessionId,turnId:'t',iteration:1,state:'queued',startedAt:1}]);await act(async()=>button(host,'验收与控制').click());
  assert.ok(![...host.querySelectorAll('button')].some(element=>element.textContent==='继续目标'));
  assert.equal(button(host,'停止目标').disabled,false);
  await act(async()=>button(host,'停止目标').click());
  assert.equal(requests.at(-1).body.action,'stop');assert.match(requests.at(-1).url,/g2\/action$/);
  await act(async()=>root.unmount());host.remove();
});

test('run links carry their actual session and turn, and unconfirmed receipts are not completed',async()=>{
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host),links=[];
  await act(async()=>root.render(createElement(Workspace,props({selectedId:goal.id,data:{...data,runs:[{id:'r1',goalId:goal.id,sessionId:'s1',turnId:'turn-1',state:'unconfirmed',iteration:1,startedAt:1,text:'进程失联，未重发'}]},onOpenActivity:(...args)=>links.push(args)}))));
  await act(async()=>button(host,'执行记录1').click());
  assert.match(host.querySelector('.task-workspace-runs').textContent,/等待核实/);
  await act(async()=>button(host,'查看本轮核验').click());assert.deepEqual(links,[['s1','turn-1']]);
  await act(async()=>root.unmount());host.remove();
});

test('deleted conversation retains task evidence without offering a broken conversation jump',async()=>{
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  await act(async()=>root.render(createElement(Workspace,props({selectedId:goal.id,data:{...data,goals:[{...goal,status:'cancelled',sessionDeleted:true,reason:'原对话已删除'}]}}))));
  assert.match(host.textContent,/原对话已删除/);
  assert.ok(![...host.querySelectorAll('button')].some(element=>element.textContent==='回到对话 ↗'));
  await act(async()=>button(host,'验收与控制').click());
  assert.ok(![...host.querySelectorAll('button')].some(element=>element.textContent==='继续目标'));
  await act(async()=>root.unmount());host.remove();
});

test('session metadata still carries deletions when task reads fail and older reads omit them',async t=>{
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);let exposed,second=false;
  const marker={id:'removed',at:1,revision:10};
  t.mock.method(globalThis,'fetch',async url=>{
    if(String(url).endsWith('/sessions'))return new Response(JSON.stringify({sessions:[],deletedSessions:second?[]:[marker]}));
    if(!second)throw Error('isolated task read unavailable');
    return new Response(JSON.stringify(data));
  });
  function Harness(){exposed=useTaskSnapshot();return createElement('div',null);}
  await act(async()=>root.render(createElement(Harness)));
  assert.deepEqual(exposed.snapshot.deletedSessions,[marker]);assert.match(exposed.sync.error,/任务状态读取失败/);
  second=true;await act(async()=>exposed.refresh());
  assert.deepEqual(exposed.snapshot.deletedSessions,[marker]);
  assert.equal(exposed.snapshot.goals.length,data.goals.length);
  await act(async()=>root.unmount());host.remove();
});

test('shared snapshot preserves successful task reads when session sync fails and ignores late aborted reads',async t=>{
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);let exposed;let generation=0;let resolveOld;
  const response=value=>new Response(JSON.stringify(value));
  t.mock.method(globalThis,'fetch',async url=>{
    if(String(url).endsWith('/sessions')){if(generation===0)throw new Error('sessions offline');return response({sessions:[]});}
    if(generation===1)return await new Promise(resolve=>{resolveOld=()=>resolve(response({...data,goals:[history]}));});
    return response({...data,goals:[generation===0?goal:active]});
  });
  function Harness(){exposed=useTaskSnapshot();return createElement('div',null,exposed.snapshot.goals[0]?.title);}
  await act(async()=>root.render(createElement(Harness)));
  assert.equal(exposed.snapshot.goals[0].id,goal.id);assert.match(exposed.sync.error,/对话同步失败/);assert.ok(exposed.sync.readAt);
  generation=1;await act(async()=>exposed.refresh());assert.ok(resolveOld);
  generation=2;await act(async()=>exposed.refresh());assert.equal(exposed.snapshot.goals[0].id,active.id);
  await act(async()=>resolveOld());assert.equal(exposed.snapshot.goals[0].id,active.id,'aborted request cannot overwrite newer snapshot');
  assert.equal(exposed.sync.error,'');
  await act(async()=>root.unmount());host.remove();
});
