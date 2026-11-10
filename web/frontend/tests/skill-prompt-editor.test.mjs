import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {act,createElement,useState} from 'react';
import {loadTsModule} from './load-ts.mjs';
globalThis.window=new Window({url:'https://easel.test/'});globalThis.document=window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const {default:Editor}=await loadTsModule('../src/components/SkillPromptEditor.tsx');
const initial={name:'test-skill',body:'Original skill',promptRevision:'a'.repeat(64)};
async function setup(t){
  const requests=[];t.mock.method(globalThis,'fetch',(url,options)=>new Promise(resolve=>requests.push({url,options,resolve})));
  const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
  function Harness(){const[detail,setDetail]=useState(initial);return createElement(Editor,{detail,onSaved:setDetail});}
  await act(async()=>root.render(createElement(Harness)));
  t.after(async()=>{await act(async()=>root.unmount());container.remove();window.sessionStorage.clear();});
  const button=text=>[...container.querySelectorAll('button')].find(b=>b.textContent===text);
  const click=async text=>act(async()=>button(text).click());
  const fill=async text=>act(async()=>{const input=container.querySelector('textarea');Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(input,text);input.dispatchEvent(new window.Event('input',{bubbles:true}));});
  return{container,requests,click,fill,button};
}
test('editing and cancel never write; save deduplicates, persists exact skill body and replaces revision',async t=>{
  const v=await setup(t);await v.click('修改提示词');await v.click('取消');assert.equal(v.requests.length,0);
  await v.click('修改提示词');assert.equal(document.activeElement,v.container.querySelector('textarea'));
  await act(async()=>{v.button('保存提示词').click();v.button('保存提示词')?.click();});
  assert.equal(v.requests.length,1);const req=v.requests[0];assert.equal(req.url,'/api/skill/test-skill/prompt');
  assert.deepEqual(JSON.parse(req.options.body),{body:initial.body,promptRevision:initial.promptRevision});
  await act(async()=>req.resolve(new Response(JSON.stringify({...initial,promptRevision:'b'.repeat(64),promptCustomized:true}))));
  assert.equal(v.container.querySelector('textarea'),null);assert.match(v.container.textContent,/提示词已保存/);
  await v.click('修改提示词');await v.click('保存提示词');assert.equal(JSON.parse(v.requests[1].options.body).promptRevision,'b'.repeat(64));
});
test('rejected save retains input and is available to retry without reporting success',async t=>{
  const v=await setup(t);await v.click('修改提示词');await v.click('保存提示词');
  await act(async()=>v.requests[0].resolve(new Response(JSON.stringify({detail:'此技能已被其他页面修改'}),{status:409})));
  assert.equal(v.container.querySelector('textarea').value,initial.body);assert.match(v.container.querySelector('[role=alert]').textContent,/其他页面/);
  assert.doesNotMatch(v.container.textContent,/提示词已保存/);assert.equal(v.button('保存提示词').disabled,false);
});
