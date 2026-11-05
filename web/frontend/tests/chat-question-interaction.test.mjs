import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {act,createElement} from 'react';
import {loadTsModule} from './load-ts.mjs';

globalThis.window=new Window({url:'http://127.0.0.1/'});globalThis.document=window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const {default:Cards}=await loadTsModule('../src/components/QuestionCards.tsx',import.meta.url);
const {default:Status}=await loadTsModule('../src/components/ChatRunStatus.tsx',import.meta.url);
const {ChatRunContext}=await loadTsModule('../src/hooks/useChatRun.ts',import.meta.url);
const question={id:'ask-live',questions:[{questionId:'style',header:'风格',question:'选择卡片风格？',options:[{label:'克莱因蓝'},{label:'终端绿'}]}]};

test('question renders, requires selection, submits canonical answers and disappears only on success',async t=>{
 const requests=[],done=[];let fail=true;
 t.mock.method(globalThis,'fetch',async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return Response.json(fail?{ok:false,error:'连接暂时中断'}:{ok:true});});
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 t.after(async()=>{await act(async()=>root.unmount());host.remove();});
 await act(async()=>root.render(createElement(Cards,{questions:[question],onDone:id=>done.push(id)})));
 const submit=()=>host.querySelector('.question-card__submit');
 assert.equal(submit().disabled,true);
 await act(async()=>[...host.querySelectorAll('button')].find(button=>button.textContent.includes('克莱因蓝')).click());
 assert.equal(submit().disabled,false);
 await act(async()=>submit().click());
 assert.match(host.textContent,/连接暂时中断/);assert.deepEqual(done,[]);
 assert.deepEqual(requests[0],{url:'/api/chat/question/answer',body:{questionId:'ask-live',answers:{style:['克莱因蓝']}}});
 fail=false;await act(async()=>submit().click());
 assert.deepEqual(done,['ask-live']);assert.equal(host.textContent,'');
});

test('multi-question prompt advances one step at a time, keeps earlier choices and submits all answers',async t=>{
 const requests=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return Response.json({ok:true});});
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 t.after(async()=>{await act(async()=>root.unmount());host.remove();});
 const multi={id:'ask-multi',questions:[
  {questionId:'style',header:'卡片样式',question:'选择主要风格',options:[{label:'紧凑列表'},{label:'信息卡片'}]},
  {questionId:'tone',header:'文字语气',question:'选择文字语气',options:[{label:'直接'},{label:'温和'}]},
 ]};
 await act(async()=>root.render(createElement(Cards,{questions:[multi]})));
 const buttons=()=>[...host.querySelectorAll('button')];
 assert.match(host.textContent,/1 \/ 2/);assert.equal(buttons().find(button=>button.textContent.includes('继续')).disabled,true);
 await act(async()=>buttons().find(button=>button.textContent.includes('紧凑列表')).click());
 await act(async()=>buttons().find(button=>button.textContent.includes('继续')).click());
 assert.match(host.textContent,/2 \/ 2/);assert.match(host.textContent,/选择文字语气/);assert.doesNotMatch(host.textContent,/选择主要风格/);
 await act(async()=>buttons().find(button=>button.textContent.includes('上一步')).click());
 assert.equal(buttons().find(button=>button.textContent.includes('紧凑列表')).getAttribute('aria-checked'),'true');
 await act(async()=>buttons().find(button=>button.textContent.includes('继续')).click());
 await act(async()=>buttons().find(button=>button.textContent.includes('温和')).click());
 await act(async()=>buttons().find(button=>button.textContent.includes('提交回答')).click());
 assert.deepEqual(requests[0],{url:'/api/chat/question/answer',body:{questionId:'ask-multi',answers:{style:['紧凑列表'],tone:['温和']}}});
});

test('run status distinguishes missing question, answerable question, silent tools and unknown stage',async t=>{
 t.mock.method(globalThis,'setInterval',()=>1);t.mock.method(globalThis,'clearInterval',()=>{});
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 t.after(async()=>{await act(async()=>root.unmount());host.remove();});
 const render=async(operations=[],questions=0,streaming=true)=>act(async()=>root.render(createElement(ChatRunContext.Provider,{value:{streaming,execution:{current:{operations}}}},createElement(Status,{questions}))));
 const old=new Date(Date.now()-9*60*1000).toISOString();
 await render([{name:'ask_user',status:'running',startedAt:old}]);
 assert.match(host.textContent,/等待你选择.*尚未收到可回答的选项卡/s);
 await render([],1);assert.match(host.textContent,/请在下方选项卡回答/);
 await render([{name:'exec',kind:'command',status:'running',startedAt:old,command:'echo test',path:''}]);
 assert.match(host.textContent,/工具操作尚未结束/);assert.match(host.textContent,/计时增长不代表/);
 await render();assert.equal(host.textContent,'');
 await render([],0,false);assert.equal(host.textContent,'');
});
