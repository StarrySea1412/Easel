import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {act,createElement} from 'react';
import {loadTsModule} from './load-ts.mjs';
globalThis.window=new Window({url:'https://easel.test/'});
globalThis.document=window.document;globalThis.sessionStorage=window.sessionStorage;globalThis.localStorage=window.localStorage;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const {default:Sidebar}=await loadTsModule('../src/components/Sidebar.tsx',import.meta.url);
const session=(id,title,patch={})=>({id,title,messages:[{role:'user',content:'真实会话文字'}],created:1,...patch});
async function fixture(t,patch={}) {
 sessionStorage.clear();localStorage.clear();
 t.mock.method(globalThis,'fetch',async()=>({ok:true,json:async()=>[]}));
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
 const saved=[],pending=[];
 const props={currentPage:'chat',onPageChange:()=>{},personas:[],selectedPersona:'',onPersonaChange:()=>{},onNewProfile:()=>{},sessions:[session('one','原标题一'),session('two','原标题二')],activeSessionId:'one',activeSessionHasMessages:true,onSessionSelect:()=>{},onSessionDelete:()=>{},onSessionRename:(id,title)=>saved.push({id,title}),onSessionArchive:()=>{},onNewChat:()=>{},gatewayStatus:'connected',onGenerateSessionTitle:id=>new Promise((resolve,reject)=>pending.push({id,resolve,reject})),...patch};
 const render=()=>root.render(createElement(Sidebar,props));await act(async()=>render());t.after(async()=>{await act(async()=>root.unmount());container.remove();});
 await act(async()=>container.querySelector('[aria-label="展开对话列表"]').click());
 const button=text=>[...container.querySelectorAll('button')].find(item=>item.textContent.trim()===text);
 const input=()=>container.querySelector('.session-rename-input');
 return {container,saved,pending,props,button,input,async rename(id='one'){const title=props.sessions.find(s=>s.id===id).title;const row=[...container.querySelectorAll('.session-item')].find(item=>item.querySelector('.session-select')?.textContent===title);assert.ok(row);await act(async()=>row.querySelector('[title="重命名"]').click());},async generate(){const control=button('Agent 命名建议');assert.ok(control);await act(async()=>control.click());},async type(value){await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input(),value);input().dispatchEvent(new window.Event('input',{bubbles:true}));});},async click(text){assert.ok(button(text),`missing ${text}`);await act(async()=>button(text).click());},async update(patch){Object.assign(props,patch);await act(async()=>render());}};
}
test('Agent suggestion is offered only in rename form with fee notice, fills a draft and saves only on explicit action',async t=>{
 const v=await fixture(t);assert.equal(v.button('Agent 命名建议'),undefined);assert.deepEqual(v.pending,[]);await v.rename();const button=v.button('Agent 命名建议');assert.match(button.title,/可能产生费用/);await v.generate();assert.equal(v.pending[0].id,'one');assert.equal(v.button('命名中…').disabled,true);await act(async()=>v.button('命名中…').click());assert.equal(v.pending.length,1);await act(async()=>v.pending[0].resolve('模型标题建议'));assert.equal(v.input().value,'模型标题建议');assert.deepEqual(v.saved,[]);await v.click('保存标题');assert.deepEqual(v.saved,[{id:'one',title:'模型标题建议'}]);assert.equal(v.input(),null);
});
test('Enter explicitly saves an Agent suggestion',async t=>{
 const v=await fixture(t);await v.rename();await v.generate();await act(async()=>v.pending[0].resolve('待确认建议'));assert.deepEqual(v.saved,[]);await act(async()=>v.input().dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})));assert.deepEqual(v.saved,[{id:'one',title:'待确认建议'}]);
});
test('leaving the input does not silently save the suggested title',async t=>{
 const v=await fixture(t);await v.rename();await v.generate();await act(async()=>v.pending[0].resolve('尚未确认建议'));const outside=document.createElement('input');document.body.append(outside);t.after(()=>outside.remove());await act(async()=>{v.input().focus();outside.focus();});assert.deepEqual(v.saved,[],'blur is not an explicit title confirmation');assert.equal(v.input()?.value,'尚未确认建议');
});
test('manual editing while generation is pending has priority over the delayed suggestion',async t=>{
 const v=await fixture(t);await v.rename();await v.generate();await v.type('手工输入标题');await act(async()=>v.pending[0].resolve('迟到模型建议'));assert.equal(v.input().value,'手工输入标题');assert.deepEqual(v.saved,[]);
});
test('manual editing and reverting to the original text still invalidates an older suggestion',async t=>{
 const v=await fixture(t);await v.rename();await v.generate();await v.type('手工临时编辑');await v.type('原标题一');await act(async()=>v.pending[0].resolve('不该覆盖的旧建议'));assert.equal(v.input().value,'原标题一');assert.deepEqual(v.saved,[]);
});
for(const cancel of ['取消','Escape'])test(`cancel by ${cancel} and reopening the same rename form invalidates the previous generation`,async t=>{
 const v=await fixture(t);await v.rename();await v.generate();if(cancel==='取消')await v.click('取消');else await act(async()=>v.input().dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));assert.equal(v.input(),null);await v.rename();await act(async()=>v.pending[0].resolve('取消前的旧建议'));assert.equal(v.input().value,'原标题一');assert.deepEqual(v.saved,[]);
});
test('switching to another rename form cannot accept the first session suggestion',async t=>{
 const v=await fixture(t);await v.rename();await v.generate();await v.rename('two');await act(async()=>v.pending[0].resolve('第一会话建议'));assert.equal(v.input().value,'原标题二');assert.deepEqual(v.saved,[]);
});
for(const change of [{activeSessionId:'two'},{currentPage:'dashboard'}])test(`a pending suggestion becomes invalid after ${Object.keys(change)[0]} changes`,async t=>{
 const v=await fixture(t);await v.rename();await v.generate();await v.update(change);await act(async()=>v.pending[0].resolve('切换前的旧建议'));assert.notEqual(v.input()?.value,'切换前的旧建议');assert.deepEqual(v.saved,[]);
});
test('generation failure keeps the original title and exposes retryable error without committing',async t=>{
 const v=await fixture(t);await v.rename();await v.generate();await act(async()=>v.pending[0].reject(new Error('模型服务不可达')));assert.equal(v.input().value,'原标题一');assert.match(v.container.querySelector('[role=alert]').textContent,/模型服务不可达/);assert.equal(v.button('Agent 命名建议').disabled,false);assert.deepEqual(v.saved,[]);
});
test('read-only backup and empty conversations never offer model naming',async t=>{
 const v=await fixture(t,{sessions:[session('one','备份对话',{importedFromBackup:true}),session('two','空对话',{messages:[]})]});await v.rename();assert.equal(v.button('Agent 命名建议'),undefined);await v.click('取消');await v.update({activeSessionId:'two'});await v.rename('two');assert.equal(v.button('Agent 命名建议'),undefined);assert.deepEqual(v.pending,[]);
});
