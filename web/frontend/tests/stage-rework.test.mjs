import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {act,createElement} from 'react';
import {loadTsModule} from './load-ts.mjs';

globalThis.window=new Window({url:'https://easel.test/'});
globalThis.document=window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const {default:Recovery}=await loadTsModule('../src/components/TaskStageRecovery.tsx',import.meta.url);
const stages=['research','build','review','deliver'].map((id,i)=>({id,title:['研究依据','制作结果','审查结果','整理交付'][i],roleId:id,objective:'合成阶段目标',status:'completed',attempts:1,criteria:[],checks:[],handoff:'合成旧回执'}));
const goal={id:'one',sessionId:'s',revision:1,stages,status:'blocked',phase:'review',iterations:4,maxIterations:10};
const button=(host,label)=>[...host.querySelectorAll('button')].find(item=>item.textContent===label);
async function mount(props={}) {
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  const render=async patch=>act(async()=>root.render(createElement(Recovery,{goal,runs:[],disabled:false,onChanged:()=>{},...props,...patch})));
  await render();
  return {host,render,close:async()=>{await act(async()=>root.unmount());host.remove();}};
}
async function choose(host) {
  await act(async()=>host.querySelectorAll('.task-stage-content button')[1].click());
}
async function reason(host,text) {
  await act(async()=>{const input=host.querySelector('textarea');const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;setter.call(input,text);input.dispatchEvent(new window.Event('input',{bubbles:true}));input.dispatchEvent(new window.Event('change',{bubbles:true}));});
}

test('requires explicit cause and confirmation, preserves retry ID, and never starts the goal',async t=>{
  const requests=[];let refreshed=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    requests.push({url:String(url),body:JSON.parse(options.body)});
    return new Response(JSON.stringify(requests.length===1?{detail:'合成临时失败'}:{}),{status:requests.length===1?409:200});
  });
  const view=await mount({onChanged:()=>refreshed++}),{host}=view;
  assert.equal(host.querySelector('form'),null);assert.equal(requests.length,0);
  await choose(host);
  assert.match(host.querySelector('form').textContent,/制作结果 → 审查结果 → 整理交付/);
  assert.equal(button(host,'确认重做').disabled,true);
  await reason(host,'补充合成文件的检查说明');
  assert.equal(button(host,'确认重做').disabled,false);
  await act(async()=>button(host,'确认重做').click());
  assert.match(host.textContent,/合成临时失败/);assert.equal(host.querySelector('textarea').value,'补充合成文件的检查说明');
  await act(async()=>button(host,'确认重做').click());
  assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);
  assert.equal(requests[0].body.stageId,'build');assert.equal(requests[0].body.revision,1);
  assert.ok(requests.every(item=>item.url.endsWith('/rework')));
  assert.equal(refreshed,1);assert.equal(host.querySelector('form'),null);assert.match(host.textContent,/继续目标/);
  await view.close();
});

test('cancel and changed goal revision never submit stale confirmation',async t=>{
  t.mock.method(globalThis,'fetch',()=>{throw new Error('不得请求');});
  const view=await mount(),{host}=view;
  await choose(host);await reason(host,'合成原因');
  await view.render({goal:{...goal,revision:2}});
  assert.equal(button(host,'确认重做').disabled,true);assert.match(host.textContent,/版本已变化/);
  await act(async()=>button(host,'取消').click());assert.equal(host.querySelector('form'),null);
  await view.close();
});

test('live, stale, active and deleted tasks cannot start stage recovery',async()=>{
  for(const patch of [{disabled:true},{goal:{...goal,status:'active'}},{runs:[{state:'unconfirmed'}]}]) {
    const view=await mount(patch);
    assert.ok([...view.host.querySelectorAll('button')].every(item=>item.disabled));
    await view.close();
  }
  for(const patch of [{goal:{...goal,status:'completed'}},{goal:{...goal,sessionDeleted:true}}]) {
    const view=await mount(patch);
    assert.equal(button(view.host,'从此阶段重做'),undefined);
    await view.close();
  }
});

test('superseded receipts are folded and fetched only on demand',async t=>{
  let reads=0;
  t.mock.method(globalThis,'fetch',async url=>{
    reads++;assert.match(String(url),/\/goals\/one\/reworks$/);
    return new Response(JSON.stringify({receipts:[{id:'saved',fromRevision:1,toRevision:2,request:{reason:'合成修改原因'},stages}]}));
  });
  const view=await mount({goal:{...goal,lastRework:{id:'saved'}}}),{host}=view;
  assert.equal(reads,0);const history=host.querySelector('.task-stage-history');assert.equal(history.open,false);
  await act(async()=>{history.open=true;await new Promise(resolve=>setTimeout(resolve,0));});
  assert.equal(reads,1);assert.match(history.textContent,/版本 1 → 2/);assert.match(history.textContent,/合成修改原因/);
  await view.close();
});
