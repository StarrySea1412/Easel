import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement, useState } from 'react';
import { loadTsModule } from './load-ts.mjs';
globalThis.window=new Window({url:'https://easel.test/'});globalThis.document=window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const {default:RadioGroup}=await loadTsModule('../src/components/ui/RadioGroup.tsx',import.meta.url);
async function fixture(t,disabled=false){
 const changes=[];const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
 function Harness(){const [value,setValue]=useState('image');return createElement(RadioGroup,{'aria-label':'创作类型',value,disabled,options:[{value:'image',label:'图片'},{value:'skip',label:'不可用',disabled:true},{value:'video',label:'视频'}],onChange:next=>{changes.push(next);setValue(next);}});}
 await act(async()=>root.render(createElement(Harness)));t.after(async()=>{await act(async()=>root.unmount());container.remove();});
 return {container,changes,radio:value=>container.querySelector(`[role=radio][value=${value}]`),key:async key=>act(async()=>document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown',{key,bubbles:true})))};
}
test('radio group is mutually exclusive, uses one tab stop, and does not repeat changes for the selected value',async t=>{
 const v=await fixture(t);assert.equal(v.container.querySelector('[role=radiogroup]').getAttribute('aria-label'),'创作类型');
 assert.equal(v.container.querySelectorAll('[role=radio][aria-checked=true]').length,1);assert.equal(v.radio('image').tabIndex,0);assert.equal(v.radio('video').tabIndex,-1);
 await act(async()=>v.radio('video').click());assert.deepEqual(v.changes,['video']);assert.equal(v.radio('video').getAttribute('aria-checked'),'true');assert.equal(v.radio('image').getAttribute('aria-checked'),'false');assert.equal(v.radio('video').tabIndex,0);
 await act(async()=>v.radio('video').click());assert.deepEqual(v.changes,['video']);
});
test('arrows skip disabled choices, wrap, and select the focused radio; Home and End move to the edges',async t=>{
 const v=await fixture(t);await act(async()=>v.radio('image').focus());
 await v.key('ArrowRight');assert.equal(document.activeElement,v.radio('video'));assert.equal(v.radio('video').getAttribute('aria-checked'),'true');
 await v.key('ArrowDown');assert.equal(document.activeElement,v.radio('image'));
 await v.key('ArrowLeft');assert.equal(document.activeElement,v.radio('video'));
 await v.key('ArrowUp');assert.equal(document.activeElement,v.radio('image'));
 await v.key('End');assert.equal(document.activeElement,v.radio('video'));
 await v.key('Home');assert.equal(document.activeElement,v.radio('image'));
 assert.equal(v.radio('skip').getAttribute('aria-checked'),'false');assert.equal(v.radio('skip').tabIndex,-1);
});
test('disabled options and a disabled group cannot change selection or participate in tab navigation',async t=>{
 const v=await fixture(t);await act(async()=>v.radio('skip').click());assert.deepEqual(v.changes,[]);
 const w=await fixture(t,true);assert.equal(w.container.querySelector('[role=radiogroup]').getAttribute('aria-disabled'),'true');
 await act(async()=>w.radio('video').click());assert.deepEqual(w.changes,[]);assert.ok([...w.container.querySelectorAll('[role=radio]')].every(button=>button.disabled&&button.tabIndex===-1));
});
