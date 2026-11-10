import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {act,createElement} from 'react';
import {loadTsModule} from './load-ts.mjs';

globalThis.window=new Window({url:'https://easel.test/'});
globalThis.document=window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const {default:QuestionCards}=await loadTsModule('../src/components/QuestionCards.tsx');
const item=(id='permission',multiSelect=false)=>({questionId:id,header:'生图授权',question:'请选择本轮如何继续',multiSelect,
  options:[{label:'生成三张',description:'按已确认参考图生成'},{label:'先看文案',description:'暂不生成图片'}]});

async function setup(t,questions=[{id:'ask-1',expiresAtMs:160000,questions:[item()]}]){
  let now=100000;const timers=new Set(),requests=[],done=[];
  t.mock.method(Date,'now',()=>now);
  t.mock.method(window,'setInterval',fn=>{timers.add(fn);return fn;});
  t.mock.method(window,'clearInterval',fn=>timers.delete(fn));
  t.mock.method(globalThis,'fetch',(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject})));
  const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
  const render=async rows=>act(async()=>root.render(createElement(QuestionCards,{questions:rows,onDone:id=>done.push(id)})));
  await render(questions);
  t.after(async()=>{await act(async()=>root.unmount());container.remove();assert.equal(timers.size,0);});
  const buttons=()=>[...container.querySelectorAll('.question-card__option')];
  const submit=()=>container.querySelector('[type=submit]');
  const fill=async(text,index=0)=>act(async()=>{
    const input=container.querySelectorAll('textarea')[index];
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(input,text);
    input.dispatchEvent(new window.Event('input',{bubbles:true}));
  });
  const click=async(index)=>act(async()=>buttons()[index].click());
  const send=async()=>act(async()=>submit().click());
  const advance=async(ms,tick=true)=>act(async()=>{now+=ms;if(tick)for(const fn of timers)fn();});
  const respond=async(data,status=200,index=0)=>act(async()=>requests[index].resolve(new Response(JSON.stringify(data),{status})));
  return {container,requests,done,render,buttons,submit,fill,click,send,advance,respond,timers};
}

test('free text is immediately available and submits directly without a fill step',async t=>{
  const v=await setup(t);assert.equal(v.container.querySelectorAll('textarea').length,1);
  assert.equal(v.submit().disabled,true);assert.equal(v.requests.length,0);
  await v.fill('  先确认玩法，不要生图  ');assert.equal(v.submit().disabled,false);
  await v.send();assert.deepEqual(JSON.parse(v.requests[0].options.body),{questionId:'ask-1',answers:{permission:['先确认玩法，不要生图']}});
  assert.equal(v.submit().textContent,'提交中…');assert.deepEqual(v.done,[]);
  await v.respond({ok:true});assert.deepEqual(v.done,['ask-1']);assert.equal(v.container.textContent,'');
});

test('single choice and typed answer stay exclusive; every question is required',async t=>{
  const v=await setup(t,[{id:'ask-1',questions:[item('a'),item('b',true)]}]);
  await v.click(0);await v.fill('自定义回答',0);assert.equal(v.buttons()[0].getAttribute('aria-pressed'),'false');
  assert.equal(v.submit().disabled,true);
  await v.click(2);await v.click(3);await v.click(2);await v.fill('补充限制',1);
  assert.equal(v.submit().disabled,false);await v.send();
  assert.deepEqual(JSON.parse(v.requests[0].options.body).answers,{a:['自定义回答'],b:['先看文案','补充限制']});
});

test('choosing a single option replaces an unsubmitted custom answer',async t=>{
  const v=await setup(t);await v.fill('另一个回答');await v.click(1);
  assert.equal(v.container.querySelector('textarea').value,'');await v.send();
  assert.deepEqual(JSON.parse(v.requests[0].options.body).answers,{permission:['先看文案']});
});

test('countdown uses the original absolute deadline after replay and tab suspension',async t=>{
  const row={id:'ask-1',expiresAtMs:160000,questions:[item()]};const v=await setup(t,[row]);
  assert.match(v.container.querySelector('[role=timer]').textContent,/1:00/);
  await v.fill('不要自动提交');await v.advance(59000);
  await v.render([{...row}]);assert.match(v.container.querySelector('[role=timer]').textContent,/0:01/);
  await v.advance(10000,false);
  await act(async()=>window.dispatchEvent(new window.Event('focus')));
  assert.match(v.container.textContent,/已到期/);assert.equal(v.submit().disabled,true);
  assert.equal(v.container.querySelector('textarea').value,'不要自动提交');assert.equal(v.container.querySelector('textarea').readOnly,true);
  assert.equal(v.requests.length,0);await v.send();assert.equal(v.requests.length,0);
});

test('submission checks deadline even before the browser timer has updated',async t=>{
  const v=await setup(t);await v.click(0);await v.advance(60000,false);await v.send();
  assert.equal(v.requests.length,0);assert.equal(v.submit().disabled,true);
});

test('missing or invalid expiry never invents a timer or submits an option automatically',async t=>{
  const v=await setup(t,[{id:'ask-1',expiresAtMs:null,questions:[item()]}]);
  assert.equal(v.container.querySelector('[role=timer]'),null);assert.equal(v.timers.size,0);
  await v.advance(3600000);assert.equal(v.requests.length,0);await v.fill('继续等待');await v.send();assert.equal(v.requests.length,1);
});

test('failed answer retains text for retry and repeated submits send only once',async t=>{
  const v=await setup(t);await v.fill('保留这个回答');
  await act(async()=>{const form=v.container.querySelector('form');form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));});
  assert.equal(v.requests.length,1);await v.respond({ok:false,error:'原问题暂不可用'});
  assert.match(v.container.querySelector('[role=alert]').textContent,/原问题暂不可用/);
  assert.equal(v.container.querySelector('textarea').value,'保留这个回答');assert.equal(v.submit().disabled,false);
  await v.send();assert.equal(v.requests.length,2);await v.respond({ok:true},200,1);assert.deepEqual(v.done,['ask-1']);
});

test('Ctrl+Enter submits while plain Enter and IME composition do not',async t=>{
  const v=await setup(t);await v.fill('键盘回复');const input=v.container.querySelector('textarea');
  await act(async()=>input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})));
  await act(async()=>input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,isComposing:true,bubbles:true})));
  assert.equal(v.requests.length,0);
  await act(async()=>input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true})));
  assert.equal(v.requests.length,1);
});

test('a different request starts with empty answers and its own deadline',async t=>{
  const v=await setup(t);await v.fill('旧轮次回答');
  await v.render([{id:'ask-new',expiresAtMs:190000,questions:[item()]}]);
  assert.equal(v.container.querySelector('textarea').value,'');assert.equal(v.submit().disabled,true);
  assert.match(v.container.querySelector('[role=timer]').textContent,/1:30/);assert.equal(v.requests.length,0);
});
