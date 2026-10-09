import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {act,createElement} from 'react';
import {loadTsModule} from './load-ts.mjs';
globalThis.window=new Window({url:'http://easel.test/'});
globalThis.document=window.document;
globalThis.localStorage=window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const {default:Tray}=await loadTsModule('../src/components/ChatQueueTray.tsx',import.meta.url);
const q=await loadTsModule('../src/lib/chatQueue.ts',import.meta.url);
const {default:Bubble}=await loadTsModule('../src/components/MessageBubble.tsx',import.meta.url);

async function mount(t,Component,props){
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
 t.after(async()=>{await act(async()=>root.unmount());container.remove();});
 await act(async()=>root.render(createElement(Component,props)));return {container,root};
}
const draft=text=>({text,attachments:[],selectedSkills:[],skillRequirements:{},thinkingLevel:'off'});
const click=async element=>act(async()=>element.click());

test('compact queue delegates editing to the main composer and keeps pause, sorting and deletion',async t=>{
 q.enqueueChat('queue-ui',draft('第一条'));q.enqueueChat('queue-ui',draft('第二条'));
 const edits=[];const {container}=await mount(t,Tray,{sessionId:'queue-ui',onEdit:(...args)=>edits.push(args)});
 assert.equal(container.querySelectorAll('li').length,2);
 assert.equal(container.querySelector('.chat-queue-steer').getAttribute('aria-disabled'),'true');
 let menu=container.querySelector('.chat-queue-menu');menu.open=true;
 await click([...menu.querySelectorAll('button')].find(b=>b.textContent==='关闭排队'));
 assert.equal(q.getChatQueue('queue-ui').paused,true);assert.equal(q.getChatQueue('queue-ui').items.length,2);assert.equal(menu.open,false);
 assert.equal([...container.querySelectorAll('button')].some(b=>/^[上下]移消息$/.test(b.textContent)),false);
 await act(async()=>container.querySelector('.chat-queue-grip').dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})));
 assert.deepEqual(q.getChatQueue('queue-ui').items.map(row=>row.text),['第二条','第一条']);
 await click(container.querySelector('.chat-queue-text'));
 assert.equal(edits[0][1],'第二条');assert.equal(container.querySelector('textarea'),null);
 assert.equal(q.getChatQueue('queue-ui').paused,true);
 await click(container.querySelector('.chat-queue-remove'));assert.equal(q.getChatQueue('queue-ui').items.length,1);
});

test('historical aborted recovers exact same-turn diagnostics while preserving partial content',async t=>{
 const requests=[];
 globalThis.fetch=async url=>{requests.push(url);return new Response(JSON.stringify({turn_id:'failure-turn',error:{code:'model_stream_interrupted',category:'connection',message:'响应流中断，保留已收内容。',stage:'model_response',channel:'anthropic',modelRef:'anthropic/kimi-k3',detail:'Anthropic stream ended before a terminal event'}}));};
 const {container}=await mount(t,Bubble,{sessionId:'failure-session',message:{role:'assistant',content:'已收到正文',turnId:'failure-turn',error:{code:'agent_execution_failed',message:'返回原因：aborted',detail:'aborted'}}});
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});
 assert.match(requests[0],/failure-session\?turn_id=failure-turn/);
 assert.match(container.textContent,/模型响应中断/);assert.match(container.textContent,/失败阶段：模型响应/);assert.match(container.textContent,/anthropic\/kimi-k3/);assert.match(container.textContent,/已收到正文/);
 assert.equal(container.querySelector('details.chat-error-details').open,false);
 assert.match(container.querySelector('details pre').textContent,/terminal event/);
});

test('another turn response never replaces the owning turn error',async t=>{
 globalThis.fetch=async()=>new Response(JSON.stringify({turn_id:'foreign',error:{message:'FOREIGN_ERROR',code:'model_stream_interrupted'}}));
 const {container}=await mount(t,Bubble,{sessionId:'one',message:{role:'assistant',content:'保留',turnId:'mine',error:{code:'agent_execution_failed',message:'返回原因：aborted',detail:'aborted'}}});
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});
 assert.match(container.textContent,/请求被中断/);assert.ok(!container.textContent.includes('FOREIGN_ERROR'));
});


test('compaction indicator animates only confirmed start and distinguishes each terminal outcome',async t=>{
 const {default:Indicator}=await loadTsModule('../src/components/ChatCompactionIndicator.tsx',import.meta.url);
 const {container,root}=await mount(t,Indicator,{});assert.equal(container.textContent,'');
 await act(async()=>root.render(createElement(Indicator,{event:{phase:'start'}})));
 assert.ok(container.querySelector('.is-active'));assert.match(container.textContent,/正在压缩上下文/);assert.ok(!container.textContent.includes('%'));
 for(const [outcome,label] of [['completed','上下文已压缩'],['failed','上下文压缩失败'],['skipped','本次未执行压缩'],['aborted','上下文压缩已中断']]){
  await act(async()=>root.render(createElement(Indicator,{event:{phase:'end',outcome}})));
  assert.equal(container.querySelector('.is-active'),null);assert.equal(container.textContent,label);
 }
});


test('grip drop inserts across multiple messages and arrow keys keep snapshots',async t=>{
 const session='grip-ui'; for(const text of ['一','二','三','四'])q.enqueueChat(session,{...draft(text),modelRef:'relay/model',selectedSkills:['s'],skillRequirements:{s:'keep'}});
 const {container}=await mount(t,Tray,{sessionId:session,onEdit(){}});
 const before=q.getChatQueue(session).items.map(row=>({...row}));
 const transfer={setData(){},effectAllowed:''};const drag=kind=>{const e=new window.Event(kind,{bubbles:true,cancelable:true});Object.defineProperty(e,'dataTransfer',{value:transfer});return e;};
 await act(async()=>container.querySelector('.chat-queue-grip').dispatchEvent(drag('dragstart')));
 await act(async()=>container.querySelectorAll('li')[3].dispatchEvent(drag('drop')));
 assert.deepEqual(q.getChatQueue(session).items.map(row=>row.text),['二','三','四','一']);
 assert.deepEqual(q.getChatQueue(session).items.at(-1),before[0]);
 await act(async()=>container.querySelectorAll('.chat-queue-grip')[3].dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true})));
 assert.deepEqual(q.getChatQueue(session).items.map(row=>row.text),['二','三','一','四']);
});

test('steer is clickable, invokes the selected id and protects repeated clicks',async t=>{
 const session='steer-ui';q.enqueueChat(session,draft('引导内容'));let resolve;let calls=[];
 const {container}=await mount(t,Tray,{sessionId:session,onEdit(){},onSteer:id=>{calls.push(id);return new Promise(r=>resolve=r);}});
 const button=container.querySelector('.chat-queue-steer');await click(button);await click(button);
 assert.deepEqual(calls,[q.getChatQueue(session).items[0].id]);assert.match(button.textContent,/引导中/);
 await act(async()=>resolve(false));assert.equal(q.getChatQueue(session).items.length,1);
});

test('queue menus are exclusive and close outside or on Escape; resume explains editing blockers',async t=>{
 const session='menus-ui';q.enqueueChat(session,draft('一'));q.enqueueChat(session,draft('二'));q.pauseChatQueue(session);
 const {container,root}=await mount(t,Tray,{sessionId:session,onEdit(){}});
 const menus=[...container.querySelectorAll('details')];
 await act(async()=>{menus[0].open=true;menus[0].dispatchEvent(new window.Event('toggle'));});
 await act(async()=>{menus[1].open=true;menus[1].dispatchEvent(new window.Event('toggle'));});
 assert.equal(menus[0].open,false);assert.equal(menus[1].open,true);
 await act(async()=>document.body.dispatchEvent(new window.PointerEvent('pointerdown',{bubbles:true})));
 assert.equal(menus[1].open,false);
 await act(async()=>{menus[1].open=true;document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));});
 assert.equal(menus[1].open,false);
 await act(async()=>root.render(createElement(Tray,{sessionId:session,onEdit(){},editingId:q.getChatQueue(session).items[0].id})));
 const resume=[...container.querySelectorAll('button')].find(button=>button.textContent==='继续排队');
 const notices=[];const handler=event=>notices.push(event.detail.message);window.addEventListener('easel:toast',handler);t.after(()=>window.removeEventListener('easel:toast',handler));
 await click(resume);assert.equal(q.getChatQueue(session).paused,true);assert.match(notices.at(-1),/保存或取消/);
 await act(async()=>root.render(createElement(Tray,{sessionId:session,onEdit(){}})));
 await click(resume);assert.equal(q.getChatQueue(session).paused,false);assert.match(notices.at(-1),/已继续排队/);
});

test('pointer drag moves a complete row preview and commits exact target with snapshots preserved',async t=>{
 const session='pointer-ui';for(const text of ['一','二','三'])q.enqueueChat(session,{...draft(text),modelRef:'relay/model',selectedSkills:['s'],skillRequirements:{s:'keep'}});
 const {container}=await mount(t,Tray,{sessionId:session,onEdit(){}});
 const before=q.getChatQueue(session).items[0],grip=container.querySelector('.chat-queue-grip');
 grip.setPointerCapture=()=>{};
 t.mock.method(window.HTMLElement.prototype,'getBoundingClientRect',function(){return {top:Array.from(this.parentElement?.children||[]).indexOf(this)*42,left:0,width:300,height:36};});
 globalThis.getComputedStyle=window.getComputedStyle.bind(window);
 const pointer=(type,y)=>new window.PointerEvent(type,{button:0,pointerId:1,pointerType:'mouse',clientX:20,clientY:y,bubbles:true});
 await act(async()=>grip.dispatchEvent(pointer('pointerdown',20)));
 await act(async()=>grip.dispatchEvent(pointer('pointermove',100)));
 const ghost=document.querySelector('.chat-queue-drag-preview');
 assert.ok(ghost);assert.match(ghost.textContent,/一.*引导/);assert.equal(ghost.style.transform,'translateY(80px)');
 assert.ok(container.querySelector('.is-drag-placeholder'));
 assert.equal(container.querySelectorAll('li')[1].style.transform,'translateY(-42px)');
 assert.equal(container.querySelectorAll('li')[2].style.transform,'translateY(-42px)');
 assert.equal(ghost.style.height,'36px');
 await act(async()=>grip.dispatchEvent(pointer('pointerup',100)));
 assert.equal(document.querySelector('.chat-queue-drag-preview'),null);
 assert.deepEqual(q.getChatQueue(session).items.map(row=>row.text),['二','三','一']);assert.deepEqual(q.getChatQueue(session).items[2],before);
});

test('thinking uses a complete SVG chevron and an explicitly estimated token count',async t=>{
 const {container}=await mount(t,Bubble,{message:{role:'assistant',content:'结果',thinking:'中文测试 english words'}});
 assert.ok(container.querySelector('svg.model-thinking-chevron path'));
 const count=container.querySelector('.model-thinking-count');assert.match(count.textContent,/≈ \d+ tokens/);assert.doesNotMatch(count.textContent,/字符/);assert.match(count.title,/估算.*非/);
});

test('queue insertion and removal do not animate over neighbours; only reorder animates',async t=>{
 const session='row-motion-ui';for(const text of ['一','二'])q.enqueueChat(session,draft(text));
 const animations=[];
 t.mock.method(window.HTMLElement.prototype,'getBoundingClientRect',function(){return {top:Array.from(this.parentElement?.children||[]).indexOf(this)*36,left:0,width:300,height:32};});
 const original=window.HTMLElement.prototype.animate;
 window.HTMLElement.prototype.animate=function(){animations.push(this.dataset.queueId);};
 t.after(()=>{window.HTMLElement.prototype.animate=original;});
 await mount(t,Tray,{sessionId:session,onEdit(){}});
 await act(async()=>q.enqueueChat(session,draft('三')));assert.deepEqual(animations,[]);
 const first=q.getChatQueue(session).items[0].id;
 await act(async()=>q.moveQueuedMessage(session,first,2));assert.equal(animations.length,3);
 animations.length=0;
 await act(async()=>q.removeQueuedMessage(session,first));assert.deepEqual(animations,[]);
});
