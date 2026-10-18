import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// Actual editor/page components in a simulated DOM. Network and callbacks are
// controlled substitutes; no real model inference or browser layout is tested.
globalThis.window = new JSDOM('<!doctype html><body></body>', {url:'http://127.0.0.1/'}).window;
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis,'navigator',{value:window.navigator,configurable:true});
Object.defineProperty(globalThis,'localStorage',{value:window.localStorage,configurable:true});
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = callback => setTimeout(callback,0);
window.matchMedia = () => ({matches:false});
window.HTMLElement.prototype.scrollTo = function({top}) { this.scrollTop=top; };
const {createRoot} = await import('react-dom/client');
const {default:ChatPage} = await loadTsModule('../src/components/ChatPage.tsx',import.meta.url);
const {editBranchPlan,remapEditedMessage,editBranchSeed} = await loadTsModule('../src/lib/chatEditing.ts',import.meta.url);
const {streamChat,prepareChatBranch} = await loadTsModule('../src/lib/api.ts',import.meta.url);
const {loadSessions,saveSessions} = await loadTsModule('../src/lib/store.ts',import.meta.url);
const attachment={id:'original-file',name:'reference.txt',path:'original/path'};
const source=()=>({id:'source',title:'原对话',created:1,messages:[
 {role:'user',content:'第一条',attachments:[attachment]}, {role:'assistant',content:'此前回答',turnId:'old-a',thinking:'隐藏思考'},
 {role:'user',content:'旧问题',selectedSkills:['card-quote'],skillRequirements:{'card-quote':'保留出处'},requestedThinkingLevel:'high',requestedModelRef:'provider/model'},
 {role:'assistant',content:'被编辑位置之后的旧回答'}, {role:'user',content:'后续问题'}, {role:'assistant',content:'后续回答'},
]});
function fixture(t) {
 t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({records:[],options:[]})));
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
 t.after(async()=>{await act(async()=>root.unmount());container.remove();localStorage.clear();});
 const calls=[];let props={session:source(),onSend(){return true;},onStop(){},onResend(){},onEdit:async(...args)=>{calls.push(args);return false;}};
 const render=async patch=>{props={...props,...patch};await act(async()=>root.render(createElement(ChatPage,props)));};
 const click=async element=>{assert.ok(element);await act(async()=>element.click());};
 const type=async value=>{const input=container.querySelector('[aria-label="重新编辑消息"]:is(textarea)');await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(input,value);input.dispatchEvent(new window.Event('input',{bubbles:true}));});};
 const key=async(key,extra={})=>act(async()=>container.querySelector('.chat-message-editor textarea').dispatchEvent(new window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra})));
 return {container,calls,render,click,type,key,edit:async(index=1)=>click(container.querySelectorAll('button[aria-label="重新编辑消息"]')[index]),button:label=>[...container.querySelectorAll('.chat-message-editor button')].find(b=>b.textContent===label)};
}
test('editing an earlier user turn focuses original text, cancels without changing history and returns focus',async t=>{
 const v=fixture(t);await v.render();assert.equal(v.container.querySelectorAll('button[aria-label="重新编辑消息"]').length,3);await v.edit();
 assert.equal(document.activeElement.value,'旧问题');await v.type('暂存修改');await v.key('Escape');
 await new Promise(resolve=>setTimeout(resolve,5));assert.equal(v.container.querySelector('.chat-message-editor'),null);assert.equal(v.calls.length,0);
 assert.equal(document.activeElement.getAttribute('aria-label'),'重新编辑消息');assert.match(v.container.textContent,/后续回答/);
 await v.edit();assert.equal(v.container.querySelector('.chat-message-editor textarea').value,'旧问题');
});
test('empty edits stay local; Shift+Enter and IME do not send, Enter sends exact message index',async t=>{
 const v=fixture(t);await v.render();await v.edit();await v.type('  ');assert.equal(v.button('发送').disabled,true);await v.key('Enter');assert.equal(v.calls.length,0);
 await v.type('修改一\n修改二');await v.key('Enter',{shiftKey:true});await v.key('Enter',{isComposing:true});assert.equal(v.calls.length,0);
 await v.key('Enter');assert.equal(v.calls.length,1);assert.equal(v.calls[0][0],2);assert.equal(v.calls[0][1],'修改一\n修改二');assert.equal(v.calls[0][2].aborted,false);assert.match(v.container.textContent,/本次未发送/);
});
test('pending edits disable duplicate submit and Cancel aborts preparation',async t=>{
 const v=fixture(t);let resolve,signal,calls=0;await v.render({onEdit:async(index,text,abort)=>{calls++;signal=abort;return new Promise(done=>{resolve=done;});}});
 await v.edit();await v.type('新文本');await v.click(v.button('发送'));assert.equal(v.button('发送中…').disabled,true);await v.key('Enter');assert.equal(calls,1);
 await v.click(v.button('取消'));assert.equal(signal.aborted,true);assert.equal(v.container.querySelector('.chat-message-editor'),null);
 await act(async()=>resolve(false));assert.match(v.container.textContent,/旧问题/);
});
test('failures keep edited text and controls usable; switching sessions aborts old preparation',async t=>{
 const v=fixture(t);await v.render({onEdit:async()=>{throw new Error('附件不存在');}});await v.edit();await v.type('保留修改');await v.click(v.button('发送'));
 assert.match(v.container.textContent,/附件不存在/);assert.equal(v.container.querySelector('.chat-message-editor textarea').value,'保留修改');assert.equal(v.button('发送').disabled,false);
 let signal;await v.render({onEdit:async(i,text,abort)=>{signal=abort;return new Promise(()=>{});}});await v.click(v.button('发送'));
 await v.render({session:{...source(),id:'other'}});assert.equal(signal.aborted,true);assert.equal(v.container.querySelector('.chat-message-editor textarea').value,'旧问题');
});
test('generation, pending recovery and stopping disable editing; imported backups have no edit action',async t=>{
 const v=fixture(t);for(const patch of [{stream:{content:'生成中',thinking:'',activity:'',questions:[]}},{stream:undefined,stopping:true},{stopping:false,session:{...source(),pendingTurnId:'recover'}}]){
  await v.render(patch);assert.ok([...v.container.querySelectorAll('button[aria-label="重新编辑消息"]')].every(button=>button.disabled));
 }
 await v.render({session:{...source(),importedFromBackup:true}});assert.equal(v.container.querySelector('button[aria-label="重新编辑消息"]'),null);
});
test('branch contains only preceding turns and deduplicates attachments without mutating source',()=>{
 const original=source(),before=JSON.stringify(original),plan=editBranchPlan(original,2,'  新问题  ');
 assert.equal(plan.text,'新问题');assert.deepEqual(plan.prefix.map(m=>m.content),['第一条','此前回答']);assert.deepEqual(plan.attachments,[attachment]);
 const newFile={...attachment,id:'new',path:'branch/path'};const prefix=plan.prefix.map(m=>remapEditedMessage(m,{[attachment.path]:newFile}));
 assert.equal(prefix[0].attachments[0],newFile);assert.equal(prefix[1].turnId,undefined);assert.equal(prefix[1].thinking,undefined);assert.equal(JSON.stringify(original),before);
 const branch={id:'branch',created:2,title:'分支',messages:[...prefix,{...plan.original,content:plan.text}],editBranch:{sourceSessionId:'source',prefixLength:2}};
 const seed=editBranchSeed(branch,2);assert.deepEqual(seed.history,[{role:'user',content:'第一条'},{role:'assistant',content:'此前回答'}]);assert.ok(!JSON.stringify(seed.history).includes('隐藏思考'));
 assert.equal(editBranchSeed(branch,3),undefined);assert.throws(()=>remapEditedMessage(plan.prefix[0],{}),/复制不完整/);
 saveSessions([branch,original]);const restored=loadSessions()[0];assert.deepEqual(restored.editBranch,branch.editBranch);
});
test('plans reject read-only, live, oversized, stale indices and unresolved legacy attachment prompts',()=>{
 for(const [session,index,text] of [[{...source(),importedFromBackup:true},2,'x'],[{...source(),pendingTurnId:'run'},2,'x'],[source(),1,'x'],[source(),-1,'x'],[source(),2,'  '],[{...source(),messages:[{role:'user',content:'x'.repeat(200001)},...source().messages]},3,'x']]) assert.throws(()=>editBranchPlan(session,index,text));
 const legacy=source();legacy.messages[0]={role:'user',content:'旧消息',agentContent:'旧消息【附件素材】PRIVATE_PATH'};assert.throws(()=>editBranchPlan(legacy,2,'x'),/重新上传/);
});
test('branch banner returns to correct source and requests attach history to both engines',async t=>{
 const v=fixture(t);let opened;await v.render({session:{...source(),editBranch:{sourceSessionId:'original-id',prefixLength:2}},onOpenSource:id=>{opened=id;}});
 await v.click([...v.container.querySelectorAll('button')].find(b=>b.textContent==='查看原对话'));assert.equal(opened,'original-id');
 for(const engine of ['openclaw','codex']) {
  let body;globalThis.fetch=async(url,options)=>{body=JSON.parse(options.body);return new Response('event: done\ndata: {}\n\n');};
  const history=[{role:'user',content:'只带此前消息'}];
  await new Promise((resolve,reject)=>streamChat('修改消息',undefined,'new',()=>{},resolve,reject,undefined,undefined,undefined,'turn',false,undefined,[],undefined,undefined,[],{},undefined,undefined,undefined,undefined,undefined,undefined,engine,history));
  assert.deepEqual(body.history,history);assert.equal(body.message,'修改消息');assert.equal(body.sessionId,'new');
 }
 let request;globalThis.fetch=async(url,options)=>{request={url,body:JSON.parse(options.body)};return new Response(JSON.stringify({sessionId:'fresh',attachments:{}}));};
 await prepareChatBranch('original',[],new AbortController().signal);assert.equal(request.url,'/api/chat/branch');assert.deepEqual(request.body,{sourceSessionId:'original',attachments:[]});
});

test('only the answer to submitted breakdown material uses the report reader, with inert controls on backups', async t => {
 const v=fixture(t);
 const messages=[{role:'user',kind:'breakdown',content:'桌面越来越乱。'},
  {role:'assistant',content:'# 内容拆解报告：桌面\n\n- **原文依据**：“桌面越来越乱”'},
  {role:'user',content:'继续改写'}, {role:'assistant',content:'普通追问的回复'}];
 await v.render({session:{...source(),messages}});
 assert.equal(v.container.querySelectorAll('.breakdown-report').length,1);
 assert.match(v.container.querySelector('.breakdown-quote-check').textContent,/1 处引用.*1 处逐字找到/);
 assert.ok([...v.container.querySelectorAll('button')].some(button=>button.textContent.includes('存入选题库')));
 await v.render({session:{...source(),messages,importedFromBackup:true}});
 assert.equal(v.container.querySelectorAll('.breakdown-report').length,1);
 assert.equal([...v.container.querySelectorAll('button')].some(button=>button.textContent.includes('存入选题库')),false);
 await v.render({session:{...source(),messages:messages.slice(0,2),importedFromBackup:true,backupIncomplete:true}});
 assert.match(v.container.querySelector('.breakdown-report').textContent,/部分内容/);
 assert.equal(v.container.querySelector('.breakdown-quote-check'),null);
 await v.render({session:{...source(),messages:[messages[0],{...messages[1],stopped:true}]}});
 assert.match(v.container.querySelector('.breakdown-report').textContent,/部分内容/);
 assert.equal(v.container.querySelector('.breakdown-quote-check'),null);
 await v.render({session:{...source(),messages:messages.slice(0,1),pendingTurnId:'pending'},stream:{content:'# 内容拆解报告：生成中',thinking:'',activity:'进入运行器',questions:[]}});
 assert.match(v.container.querySelector('.breakdown-report').textContent,/部分内容/);
 assert.equal(v.container.querySelector('.breakdown-quote-check'),null);
 assert.equal([...v.container.querySelectorAll('button')].some(button=>button.textContent.includes('存入选题库')),false);
});
