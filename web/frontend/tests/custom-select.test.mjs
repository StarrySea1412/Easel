import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement, useState } from 'react';
import { loadTsModule } from './load-ts.mjs';
globalThis.window=new Window({url:'https://easel.test/'});globalThis.document=window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const {NativeSelect:Select}=await loadTsModule('../src/components/ui/Select.tsx',import.meta.url);
const {default:ContentAnalysisDemo}=await loadTsModule('../src/components/ContentAnalysisDemo.tsx',import.meta.url);
async function fixture(t,disabled=false){
 const changes=[];const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
 function Form(){const [value,setValue]=useState('a');return createElement('form',{},createElement('label',{htmlFor:'theme'},'主题'),createElement(Select,{id:'theme',name:'theme',value,disabled,onChange:e=>{changes.push(e.target.value);setValue(e.target.value);}},createElement('option',{value:'a'},'Alpha'),createElement('option',{value:'skip',disabled:true},'Disabled'),createElement('option',{value:'b'},'Beta'),createElement('option',{value:'c'},'Charlie')),createElement('button',{type:'button'},'Other'));}
 await act(async()=>root.render(createElement(Form)));t.after(async()=>{await act(async()=>root.unmount());container.remove();});
 const trigger=container.querySelector('[role=combobox]');
 return {container,trigger,changes,key:async key=>act(async()=>trigger.dispatchEvent(new window.KeyboardEvent('keydown',{key,bubbles:true}))),open:async()=>act(async()=>{trigger.focus();trigger.click();})};
}
test('custom listbox selection emits normal select events, updates form value and restores trigger focus',async t=>{
 const v=await fixture(t);assert.equal(v.container.querySelector('select').style.display,'none');
 assert.equal(v.container.querySelector('label').htmlFor,v.trigger.id);
 await v.open();assert.equal(v.trigger.getAttribute('aria-expanded'),'true');
 await act(async()=>document.querySelector('[role=option][data-value=b]').click());
 assert.deepEqual(v.changes,['b']);assert.equal(v.trigger.value,'b');assert.match(v.trigger.textContent,/Beta/);
 assert.equal(new window.FormData(v.container.querySelector('form')).get('theme'),'b');
 assert.equal(document.activeElement,v.trigger);assert.equal(document.querySelector('[role=listbox]'),null);
});
test('keyboard navigation skips disabled choices and supports Home End Escape and Tab without committing previews',async t=>{
 const v=await fixture(t);await v.open();await v.key('ArrowDown');await v.key('Enter');assert.deepEqual(v.changes,['b']);
 await v.key('End');await v.key('Enter');assert.deepEqual(v.changes,['b','c']);
 await v.key('Home');await v.key('Escape');assert.equal(v.trigger.value,'c');assert.equal(document.querySelector('[role=listbox]'),null);
 await v.open();await v.key('Tab');assert.equal(document.querySelector('[role=listbox]'),null);assert.deepEqual(v.changes,['b','c']);
});
test('outside pointer closes without stealing focus; disabled controls never open',async t=>{
 const v=await fixture(t);await v.open();
 const other=v.container.querySelector('button:not([role])');
 await act(async()=>{other.focus();other.dispatchEvent(new window.PointerEvent('pointerdown',{bubbles:true}));});
 assert.equal(document.querySelector('[role=listbox]'),null);assert.equal(document.activeElement,other);
 const w=await fixture(t,true);await w.open();assert.equal(w.trigger.disabled,true);assert.equal(document.querySelector('[role=listbox]'),null);
});
test('popup flips above the trigger near viewport edge and clamps horizontally',async t=>{
 const v=await fixture(t);v.trigger.getBoundingClientRect=()=>({top:window.innerHeight-45,bottom:window.innerHeight-5,left:window.innerWidth-30,width:220,height:40});
 await v.open();const popup=document.querySelector('[role=listbox]');
 assert.ok(Number.parseFloat(popup.style.top)<window.innerHeight-45);
 assert.ok(Number.parseFloat(popup.style.left)+Number.parseFloat(popup.style.width)<=window.innerWidth-8);
});

test('content analysis theme menu filters works through the visible custom control',async t=>{
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
 await act(async()=>root.render(createElement(ContentAnalysisDemo,{section:'works',onSection:()=>{},onUseMyData:()=>{}})));
 t.after(async()=>{await act(async()=>root.unmount());container.remove();});
 const before=container.querySelectorAll('tbody tr').length;
 const trigger=container.querySelector('.ca-demo-table-tools [role=combobox]');
 await act(async()=>trigger.click());
 const option=[...document.querySelectorAll('[role=listbox] [role=option]')].find(item=>item.dataset.value);
 const selected=option.dataset.value;
 await act(async()=>option.click());
 assert.equal(trigger.value,selected);
 const after=container.querySelectorAll('tbody tr').length;
 assert.ok(after>0&&after<before,'theme selection reduces the visible works');
 assert.equal(document.querySelector('[role=listbox]'),null);
});

test('uncontrolled explicit empty values survive initial render and later selection',async t=>{
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
 await act(async()=>root.render(createElement(Select,{defaultValue:'',name:'filter'},createElement('option',{value:'a'},'Alpha'),createElement('option',{value:''},'All items'))));
 t.after(async()=>{await act(async()=>root.unmount());container.remove();});
 const trigger=container.querySelector('[role=combobox]');
 assert.equal(trigger.value,'');assert.match(trigger.textContent,/All items/);
 await act(async()=>trigger.click());await act(async()=>document.querySelector('[role=option][data-value=a]').click());assert.equal(trigger.value,'a');
 await act(async()=>trigger.click());await act(async()=>document.querySelector('[role=option][data-value=""]').click());assert.equal(trigger.value,'');assert.match(trigger.textContent,/All items/);
});

test('required native form validation rejects a missing choice, explains it on the visible control, and clears after selection',async t=>{
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
 let submitted=0;
 await act(async()=>root.render(createElement('form',{onSubmit:e=>{e.preventDefault();submitted++;}},createElement(Select,{required:true,defaultValue:'',name:'required-choice'},createElement('option',{value:''},'Choose a theme'),createElement('option',{value:'a'},'Alpha')),createElement('button',{type:'submit'},'Save'))));
 t.after(async()=>{await act(async()=>root.unmount());container.remove();});
 const form=container.querySelector('form'),trigger=container.querySelector('[role=combobox]');
 let valid;
 await act(async()=>{valid=form.checkValidity();});assert.equal(valid,false);assert.equal(document.activeElement,trigger);
 assert.equal(trigger.getAttribute('aria-invalid'),'true');assert.match(document.getElementById(trigger.getAttribute('aria-describedby')).textContent,/请选择/);
 await act(async()=>form.requestSubmit());assert.equal(submitted,0);
 await act(async()=>trigger.click());await act(async()=>document.querySelector('[role=option][data-value=a]').click());
 assert.equal(form.checkValidity(),true);assert.equal(container.querySelector('[role=alert]'),null);
 await act(async()=>form.requestSubmit());assert.equal(submitted,1);
});
