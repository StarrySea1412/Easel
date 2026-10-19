import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window=new Window({url:'https://easel.test/'});
globalThis.document=window.document;
globalThis.localStorage=window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const {ChatPageReader:Panel}=await loadTsModule('../src/components/ChatBrowserPanel.tsx',import.meta.url);
const {getChatDraft,setChatDraftText}=await loadTsModule('../src/lib/chatDrafts.ts',import.meta.url);

async function setup(t,id){
  const requests=[];
  t.mock.method(globalThis,'fetch',(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject})));
  const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
  await act(async()=>root.render(createElement(Panel,{sessionId:id})));
  t.after(async()=>{await act(async()=>root.unmount());container.remove();});
  return {container,requests,
    read:async url=>act(async()=>{const input=container.querySelector('input');Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,url);input.dispatchEvent(new window.Event('input',{bubbles:true}));}),
    submit:()=>act(async()=>container.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}))),
    respond:(index,data)=>act(async()=>requests[index].resolve(new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}}))),
    click:text=>act(async()=>[...container.querySelectorAll('button')].find(button=>button.textContent===text).click())};
}
const page={ok:true,title:'页面证据',url:'https://example.com/article',text:'外部资料 <script>不执行</script>\n来源正文',chars:30,source:'http',reason:null};

test('reading shows exact evidence and adding analysis preserves the main draft without calling a model',async t=>{
  const view=await setup(t,'browser-main');setChatDraftText('browser-main','原有草稿');setChatDraftText('other','其他对话');
  await view.read(page.url);await view.submit();
  assert.equal(view.requests.length,1);assert.match(view.requests[0].url,/api\/breakdown\/link$/);
  await view.respond(0,page);
  assert.equal(view.container.querySelector('script'),null);assert.equal(view.container.querySelector('article').textContent,page.text);
  await view.click('分析此页');
  const draft=getChatDraft('browser-main');assert.match(draft.text,/^原有草稿/);assert.match(draft.text,/请分析引用的网页/);
  assert.match(draft.quotes[0],/https:\/\/example.com\/article/);assert.match(draft.quotes[0],/外部内容/);assert.match(draft.quotes[0],/读取时间/);
  assert.equal(getChatDraft('other').text,'其他对话');assert.equal(view.requests.length,1,'no model request before the user sends the draft');
});

test('failed reads retain the successful snapshot and expose failure instead of replacing it with a shell',async t=>{
  const view=await setup(t,'browser-failure');await view.read(page.url);await view.submit();await view.respond(0,page);
  await view.read('https://example.com/blocked');await view.submit();await view.respond(1,{ok:false,reason:'页面需要验证',text:'',source:null});
  assert.match(view.container.querySelector('[role=alert]').textContent,/页面需要验证/);
  assert.equal(view.container.querySelector('article').textContent,page.text);
});

test('credential-bearing addresses are rejected before any network request',async t=>{
  const view=await setup(t,'browser-invalid');await view.read('https://user:password@example.com/');await view.submit();
  assert.equal(view.requests.length,0);assert.match(view.container.querySelector('[role=alert]').textContent,/不含账号密码/);
});
