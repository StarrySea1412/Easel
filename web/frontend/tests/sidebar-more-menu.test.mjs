import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';
globalThis.window=new Window({url:'https://easel.test/'});globalThis.document=window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const {default:More}=await loadTsModule('../src/components/SidebarMoreMenu.tsx',import.meta.url);
async function fixture(t){const opened=[];const container=document.createElement('div');document.body.append(container);const root=createRoot(container);await act(async()=>root.render(createElement(More,{currentPage:'analysis',onNavigate:page=>opened.push(page)})));t.after(async()=>{await act(async()=>root.unmount());container.remove();});return {trigger:container.querySelector('button'),opened,key:async key=>act(async()=>document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown',{key,bubbles:true}))) };}
test('more menu keeps secondary workspaces reachable through explicit labels and closes after navigation',async t=>{
 const v=await fixture(t);assert.ok(v.trigger.classList.contains('active'));
 await act(async()=>v.trigger.click());const menu=document.querySelector('[role=menu]');
 assert.deepEqual([...menu.querySelectorAll('[role=menuitem]')].map(x=>x.textContent),['技能库','内容库','内容分析','运行记录','画像']);
 await act(async()=>menu.querySelector('[aria-current=page]').click());
 assert.deepEqual(v.opened,['analysis']);assert.equal(document.querySelector('[role=menu]'),null);assert.equal(document.activeElement,v.trigger);
});
test('more menu supports Arrow keys Home End Escape and keeps focus outside when dismissed',async t=>{
 const v=await fixture(t);await act(async()=>{v.trigger.focus();v.trigger.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));});
 assert.equal(document.activeElement.textContent,'技能库');await v.key('ArrowDown');assert.equal(document.activeElement.textContent,'内容库');
 await v.key('End');assert.equal(document.activeElement.textContent,'画像');await v.key('Home');assert.equal(document.activeElement.textContent,'技能库');
 await v.key('Escape');assert.equal(document.querySelector('[role=menu]'),null);assert.equal(document.activeElement,v.trigger);
 await act(async()=>v.trigger.click());await act(async()=>document.body.dispatchEvent(new window.PointerEvent('pointerdown',{bubbles:true})));assert.equal(document.querySelector('[role=menu]'),null);
});
