import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';
globalThis.window = new Window({url:'https://easel.test/'});globalThis.document=window.document;globalThis.HTMLElement=window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const {default:AddMenu}=await loadTsModule('../src/components/ComposerAddMenu.tsx',import.meta.url);
const {default:Attachments}=await loadTsModule('../src/components/ComposerAttachments.tsx',import.meta.url);
const {default:Quotes}=await loadTsModule('../src/components/ChatQuoteDraft.tsx',import.meta.url);
async function mount(t,Component,props){const container=document.createElement('div');document.body.append(container);const root=createRoot(container);await act(async()=>root.render(createElement(Component,props)));t.after(async()=>{await act(async()=>root.unmount());container.remove();});return container;}
const key=async(element,value)=>act(async()=>element.dispatchEvent(new window.KeyboardEvent('keydown',{key:value,bubbles:true})));
test('add menu routes actual upload kinds and skills, supports keyboard and closes on Escape/outside',async t=>{
 const actions=[];const c=await mount(t,AddMenu,{disabled:false,uploading:false,onUpload:k=>actions.push(k),onSkills:()=>actions.push('skills')});const trigger=c.querySelector('button');
 for(const [index,kind] of ['media','files','folder','skills'].entries()){
  await act(async()=>trigger.click());const items=document.querySelectorAll('[role=menuitem]');assert.equal(items.length,4);assert.equal(document.activeElement,items[0]);
  await key(items[0],'End');assert.equal(document.activeElement,items[3]);await key(items[3],'Home');assert.equal(document.activeElement,items[0]);
  await act(async()=>items[index].click());assert.equal(document.querySelector('[role=menu]'),null);assert.equal(actions.at(-1),kind);
 }
 await act(async()=>trigger.click());await key(document.activeElement,'Escape');assert.equal(document.querySelector('[role=menu]'),null);assert.equal(document.activeElement,trigger);
 await act(async()=>trigger.click());await act(async()=>document.body.dispatchEvent(new window.PointerEvent('pointerdown',{bubbles:true})));assert.equal(document.querySelector('[role=menu]'),null);
});
test('attachments expose real media URL and document name, preview closes with Escape and removal is independent',async t=>{
 const files=[{id:'img',name:'QA.png',path:'_inbox/QA.png'},{id:'doc',name:'完整的验收文件名称.txt',path:'_inbox/QA.txt'}],removed=[];
 const c=await mount(t,Attachments,{files,onRemove:p=>removed.push(p)});const image=c.querySelector('.composer-attachment-visual img');assert.equal(image.alt,'QA.png');assert.match(image.src,/_inbox/);assert.match(c.textContent,/完整的验收文件名称.txt/);
 const open=c.querySelector('[aria-label="查看附件 QA.png"]');await act(async()=>open.click());assert.ok(document.querySelector('[role=dialog] img'));assert.deepEqual(removed,[]);
 await key(document,'Escape');assert.equal(document.querySelector('[role=dialog]'),null);
 await act(async()=>c.querySelector('[aria-label="移除 QA.png"]').click());assert.deepEqual(removed,['_inbox/QA.png']);assert.equal(document.querySelector('[role=dialog]'),null);
});
test('quote info is a transient hover/focus tooltip and excludes expanded quote content',async t=>{
 const c=await mount(t,Quotes,{sessionId:'qa-quote',quotes:['引用原文'],comment:'评论'});const details=c.querySelector('details'),info=c.querySelector('[aria-label="引用使用说明"]');assert.equal(document.querySelector('[role=tooltip]'),null);
 await act(async()=>{details.open=true;info.dispatchEvent(new window.PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}));});assert.equal(details.open,false);assert.match(document.querySelector('[role=tooltip]').textContent,/添加引用不会自动发送/);
 await act(async()=>info.dispatchEvent(new window.PointerEvent('pointerout',{bubbles:true,pointerType:'mouse'})));assert.equal(document.querySelector('[role=tooltip]'),null);
 await act(async()=>info.focus());assert.ok(document.querySelector('[role=tooltip]'));await key(info,'Escape');assert.equal(document.querySelector('[role=tooltip]'),null);
 await act(async()=>{info.blur();info.click();});assert.equal(document.querySelector('[role=tooltip]'),null,'click must not lock tooltip open');
});
