import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {act,createElement} from 'react';
import {loadTsModule} from './load-ts.mjs';
globalThis.window=new Window({url:'https://easel.test/'});globalThis.document=window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
globalThis.CustomEvent=window.CustomEvent;
Object.defineProperty(globalThis,'navigator',{value:window.navigator,configurable:true});
const {createRoot}=await import('react-dom/client');
const {default:Failures,FailureMessage,FailureRecordDialog}=await loadTsModule('../src/components/FailureRecords.tsx',import.meta.url);
const {default:Tasks}=await loadTsModule('../src/components/TaskOverview.tsx',import.meta.url);
const id='a'.repeat(32),related='b'.repeat(32);
const failure={id,at:'2026-10-20T01:00:00Z',operation:'clawhub',stage:'download',status:502,version:'0.4.0',revision:'test-sha',body:'PRIVATE_BODY',token:'PRIVATE_TOKEN'};
async function setup(t,Component,props={}){
 const requests=[];t.mock.method(globalThis,'fetch',(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject})));
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
 await act(async()=>root.render(createElement(Component,props)));
 t.after(async()=>{await act(async()=>root.unmount());container.remove();});
 return {container,requests,respond:async(i,body,status=200)=>act(async()=>requests[i].resolve(new Response(JSON.stringify(body),{status}))),click:async label=>{const b=[...container.querySelectorAll('button')].find(b=>b.textContent===label);assert.ok(b,label);await act(async()=>b.click());}};
}
test('failure copy includes only diagnostic fields and related timeline uses saved IDs',async t=>{
 let copied='';t.mock.method(navigator.clipboard,'writeText',async value=>{copied=value;});
 const v=await setup(t,Failures,{eventId:id});await v.respond(0,{events:[failure,{id:related,at:'2026-10-20T00:59:59Z',relatedEventId:id,stage:'submit'},{id:'c'.repeat(32),at:failure.at,stage:'unrelated'}]});
 await v.click('复制诊断摘要');const summary=JSON.parse(copied);assert.equal(summary.version,'0.4.0');assert.equal(summary.revision,'test-sha');
 assert.equal(summary.token,undefined);assert.equal(summary.body,undefined);assert.doesNotMatch(v.container.textContent,/PRIVATE_/);
 assert.match(v.container.querySelector('.failure-detail ol').textContent,/submit.*download/);assert.doesNotMatch(v.container.querySelector('.failure-detail ol').textContent,/unrelated/);
 await v.click('刷新');await v.respond(1,{},503);assert.match(v.container.textContent,/读取失败，已有记录保留/);assert.match(v.container.textContent,/test-sha/);
});
test('a rotated error ID is retrieved exactly instead of silently selecting a different failure',async t=>{
 const v=await setup(t,Failures,{eventId:id});await v.respond(0,{events:[{...failure,id:related}]});assert.match(v.requests[1].url,new RegExp('eventId='+id));
 await v.respond(1,{events:[failure]});assert.match(v.container.querySelector('.failure-detail').textContent,new RegExp(id));
});
test('error-number links open the diagnostic dialog; Escape restores trigger focus',async t=>{
 const View=()=>createElement('div',null,createElement(FailureMessage,{text:'导入失败。错误编号：'+id}),createElement(FailureRecordDialog));
 const v=await setup(t,View);const trigger=v.container.querySelector('button');await act(async()=>{trigger.focus();trigger.click();});
 await v.respond(0,{events:[failure]});const dialog=document.querySelector('[role="dialog"]');assert.ok(dialog);assert.equal(document.activeElement.getAttribute('aria-label'),'关闭问题详情');
 await act(async()=>dialog.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));assert.equal(document.querySelector('[role="dialog"]'),null);assert.equal(document.activeElement,trigger);
});
test('task sources keep their receipt meaning and route back to their owning pages',async t=>{
 const calls=[];const v=await setup(t,Tasks,{onChat:id=>calls.push(id),onSchedules:()=>calls.push('schedule'),onPublish:()=>calls.push('publish')});
 await v.respond(0,{goals:[{id:'g',title:'目标一',status:'paused',reason:'待确认',sessionId:'original'}],plans:[{id:'p',title:'每日计划',enabled:true,history:[{status:'failed'}]}],runs:[]});
 await v.respond(1,[{receiptId:'r',platform:'bilibili',title:'提交回执',outcome:'submitted'}]);
 assert.match(v.container.textContent,/已启用/);assert.match(v.container.textContent,/最近触发：failed/);assert.match(v.container.textContent,/不代表上次执行成功/);
 await v.click('打开原对话 →');await v.click('打开定时任务 →');await v.click('打开发布页 →');assert.deepEqual(calls,['original','schedule','publish']);
 await v.click('刷新');await v.respond(2,{},503);await v.respond(3,[]);assert.match(v.container.textContent,/保留上次快照/);assert.match(v.container.textContent,/目标一/);
});
