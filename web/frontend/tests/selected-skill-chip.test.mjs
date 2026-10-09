import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';
globalThis.window=new Window({url:'https://easel.test/'});globalThis.document=window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const {default:Chip}=await loadTsModule('../src/components/SelectedSkillChip.tsx',import.meta.url);
const guide={what:'来自已安装技能的实际说明',whenToUse:['需要核对证据时'],needs:{inputs:['原始内容'],api:null,media:[],accounts:[],tools:[],os:[],prep:[]},howToStart:['提供材料'],whatYouGet:['分析结果'],examples:['实际示例'],steps:[],terms:[]};
async function fixture(t,{requirement='',fail=false}={}) {
 const requests=[],saved=[];let removed=0;
 t.mock.method(globalThis,'fetch',async url=>{requests.push(String(url));return {ok:true,json:async()=>({name:'custom-skill',guide})};});
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
 const props={skillName:'custom-skill',requirement,onSaveRequirement:text=>{saved.push(text);return !fail;},onRemove:()=>removed++};
 await act(async()=>root.render(createElement(Chip,props)));t.after(async()=>{await act(async()=>root.unmount());container.remove();});
 const trigger=container.querySelector('.composer-skill-detail-trigger');
 const button=label=>[...document.querySelectorAll('.selected-skill-popover button')].find(item=>item.textContent===label);
 return {container,requests,saved,removed:()=>removed,trigger,button,panel:()=>document.querySelector('.selected-skill-popover'),open:async()=>{await act(async()=>trigger.click());await act(async()=>button('编辑补充要求').click());},input:async text=>act(async()=>{const input=document.querySelector('.selected-skill-popover textarea');Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(input,text);input.dispatchEvent(new window.Event('input',{bubbles:true}));})};
}
test('hover and focus do not reveal selected skill details; click reads the guide',async t=>{
 const v=await fixture(t);assert.deepEqual(v.requests,[]);
 await act(async()=>v.trigger.dispatchEvent(new window.MouseEvent('mouseover',{bubbles:true})));
 await act(async()=>new Promise(resolve=>setTimeout(resolve,180)));
 assert.deepEqual(v.requests,[]);assert.equal(v.panel(),null);
 await act(async()=>v.trigger.focus());assert.equal(v.panel(),null);
 await act(async()=>v.trigger.click());await act(async()=>new Promise(resolve=>setTimeout(resolve,180)));assert.deepEqual(v.requests,['/api/skill/custom-skill']);assert.match(v.panel().textContent,/来自已安装技能的实际说明/);assert.doesNotMatch(v.panel().textContent,/填入创作框/);
 assert.equal(v.panel().querySelector('textarea'),null);assert.deepEqual(v.saved,[]);
});
test('click edits only the session requirement, saving trims text, and clearing uses an empty requirement',async t=>{
 const v=await fixture(t,{requirement:'旧要求'});await v.open();assert.equal(document.activeElement,v.panel().querySelector('textarea'));
 assert.equal(v.panel().querySelector('textarea').value,'旧要求');assert.equal(v.panel().querySelector('textarea').maxLength,2000);assert.match(v.panel().textContent,/不修改全局 SKILL.md/);
 await v.input('  下一次请引用原文  ');await act(async()=>v.button('保存补充要求').click());assert.deepEqual(v.saved,['下一次请引用原文']);assert.equal(v.panel(),null);assert.equal(document.activeElement,v.trigger);
 await v.open();await act(async()=>v.button('清除补充要求').click());assert.deepEqual(v.saved,['下一次请引用原文','']);
});
test('save failure preserves the draft, and Escape cancels without another write',async t=>{
 const v=await fixture(t,{fail:true});await v.open();await v.input('保留这段未保存的要求');await act(async()=>v.button('保存补充要求').click());
 assert.equal(v.panel().querySelector('textarea').value,'保留这段未保存的要求');assert.match(v.panel().querySelector('[role=alert]').textContent,/尚未完成保存/);
 await act(async()=>document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));assert.equal(v.panel(),null);assert.deepEqual(v.saved,['保留这段未保存的要求']);assert.equal(document.activeElement,v.trigger);
});
test('keyboard focus stays closed; explicit click opens and remove focus closes details',async t=>{
 const v=await fixture(t);await act(async()=>v.trigger.focus());assert.equal(v.panel(),null);await act(async()=>v.trigger.click());assert.ok(v.panel());
 const remove=v.container.querySelector('[aria-label="移除技能 custom-skill"]');await act(async()=>remove.focus());assert.equal(v.panel(),null);
 const outside=document.createElement('button');document.body.append(outside);t.after(()=>outside.remove());await act(async()=>outside.focus());assert.equal(v.panel(),null);assert.equal(document.activeElement,outside);
 await act(async()=>remove.click());assert.equal(v.removed(),1);assert.deepEqual(v.saved,[]);
});

 test('remove hover closes a visible preview and never opens one; one click removes the skill',async t=>{
 const v=await fixture(t);const remove=v.container.querySelector('[aria-label="移除技能 custom-skill"]');
 await act(async()=>remove.dispatchEvent(new window.MouseEvent('mouseover',{bubbles:true})));assert.equal(v.panel(),null);
 await act(async()=>v.trigger.dispatchEvent(new window.MouseEvent('mouseover',{bubbles:true})));assert.equal(v.panel(),null);await act(async()=>v.trigger.click());assert.ok(v.panel());
 await act(async()=>remove.dispatchEvent(new window.MouseEvent('mouseover',{bubbles:true})));assert.equal(Boolean(v.panel()),false);
 await act(async()=>remove.click());assert.equal(v.removed(),1);assert.deepEqual(v.saved,[]);
 });
