import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';
import { selectOption, optionValues } from './select-helpers.mjs';
globalThis.window=new Window({url:'https://easel.test/'});globalThis.document=window.document;
globalThis.localStorage=window.localStorage;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const {default:Picker}=await loadTsModule('../src/components/ui/ModelRoutePicker.tsx',import.meta.url);
const {default:Routing}=await loadTsModule('../src/components/settings/AgentModelRoutingSettings.tsx',import.meta.url);
const {default:Activity}=await loadTsModule('../src/components/ActivityPage.tsx',import.meta.url);
const options=[{id:'a/one',provider:'a',model:'one',label:'One',channelName:'渠道甲',configured:true},{id:'b/two',provider:'b',model:'two',label:'Two',channelName:'渠道乙',configured:true}];

test('drag order persists in the configured channel picker without changing its model selection',async t=>{
 localStorage.clear();const container=document.createElement('div');document.body.append(container);const root=createRoot(container);let changed=0;
 const render=()=>act(async()=>root.render(createElement(Picker,{options,selection:{provider:'a',modelRef:'a/one'},onChange:()=>changed++})));
 t.after(async()=>{await act(async()=>root.unmount());container.remove();});await render();
 const rows=container.querySelectorAll('.channel-order-editor li');
 const transfer={setData(){},effectAllowed:'',dropEffect:''};
 const event=kind=>{const e=new window.Event(kind,{bubbles:true,cancelable:true});Object.defineProperty(e,'dataTransfer',{value:transfer});return e;};
 await act(async()=>rows[1].dispatchEvent(event('dragstart')));
 await act(async()=>rows[0].dispatchEvent(event('drop')));
 assert.equal(changed,0);assert.deepEqual(await optionValues(container.querySelector('[role="combobox"]')),['','b','a']);
 assert.deepEqual(JSON.parse(localStorage.getItem('easel:agent-channel-order')),['b','a']);
 await act(async()=>root.render(null));await render();assert.deepEqual(await optionValues(container.querySelector('[role="combobox"]')),['','b','a']);
 await act(async()=>container.querySelector('[aria-label="上移渠道 渠道甲"]').click());
 assert.deepEqual(await optionValues(container.querySelector('[role="combobox"]')),['','a','b']);
});

test('two independent Agent assignments can save the same channel and model',async t=>{
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);const saved=[];
 t.after(async()=>{await act(async()=>root.unmount());container.remove();});
 const capability={available:true,scope:'subsequent_calls',currentModelRef:'b/two',options,reason:''};
 await act(async()=>root.render(createElement('div',{},['root','subagent'].map(id=>createElement(Routing,{key:id,capability,onSave:ref=>saved.push([id,ref])})))));
 for(const section of container.querySelectorAll('.office-model-router')){
  await selectOption(section.querySelectorAll('[role="combobox"]')[0],'a');
  await selectOption(section.querySelectorAll('[role="combobox"]')[1],'a/one');
  await act(async()=>[...section.querySelectorAll('button')].find(button=>button.textContent==='保存模型分配').click());
 }
 assert.deepEqual(saved,[['root','a/one'],['subagent','a/one']]);
});

test('activity uses one compact custom session selector with state and turn counts',async t=>{
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
 t.after(async()=>{await act(async()=>root.unmount());container.remove();});
 const sessions=['first','second'].map((id,index)=>({id,title:`会话${index+1}`,importedFromBackup:true,messages:Array.from({length:index+1},()=>({role:'user',content:'fixture'}))}));
 await act(async()=>root.render(createElement(Activity,{sessions,activeSessionId:'first',streams:{}})));
 assert.equal(container.querySelector('.activity-session-rows'),null);
 const trigger=container.querySelector('[aria-label="运行会话"]');
 await act(async()=>trigger.click());assert.match(document.querySelector('[role="listbox"]').textContent,/2 轮对话/);
 await act(async()=>trigger.click());await selectOption(trigger,'second');
 assert.equal(container.querySelector('.activity-detail h2').textContent,'会话2');
});
