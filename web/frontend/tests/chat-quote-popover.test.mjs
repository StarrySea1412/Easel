import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new Window({url:'https://easel.test/'});
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const {createRoot} = await import('react-dom/client');
const {default:Quotes} = await loadTsModule('../src/components/ChatQuoteDraft.tsx',import.meta.url);
const key = async (element,value) => act(async()=>element.dispatchEvent(new window.KeyboardEvent('keydown',{key:value,bubbles:true})));

async function fixture(t) {
  const container=document.createElement('div'); container.style.overflow='auto'; document.body.append(container);
  const root=createRoot(container); let props={sessionId:'quote-one',quotes:['第一段\n第二段'],comment:'保留评论'};
  const render=async patch=>{props={...props,...patch};await act(async()=>root.render(createElement(Quotes,props)));};
  await render({});
  const trigger=container.querySelector('.composer-quote-trigger');
  let anchor={left:900,top:700,bottom:728};
  trigger.getBoundingClientRect=()=>anchor;
  t.mock.method(window.HTMLElement.prototype,'getBoundingClientRect',function(){
    return this.classList.contains('composer-quote-panel')?{height:Math.min(300,parseFloat(this.style.maxHeight)||400)}:{height:28};
  });
  Object.defineProperties(window,{innerWidth:{value:1440,configurable:true},innerHeight:{value:1000,configurable:true}});
  t.after(async()=>{await act(async()=>root.unmount());container.remove();});
  return {container,trigger,render,anchor:value=>anchor=value,open:async()=>act(async()=>trigger.click()),panel:()=>document.querySelector('.composer-quote-panel')};
}

test('preview is portalled outside scrolling composer with quote/comment intact and keyboard dismissal',async t=>{
  const v=await fixture(t); await key(v.trigger,'ArrowDown');
  const panel=v.panel(); assert.equal(panel.parentNode,document.body);assert.equal(v.container.contains(panel),false);
  assert.equal(document.activeElement,panel);assert.equal(v.trigger.getAttribute('aria-expanded'),'true');
  assert.equal(v.trigger.getAttribute('aria-controls'),panel.id);
  assert.match(panel.textContent,/第一段\n第二段/);assert.match(panel.textContent,/保留评论/);
  assert.equal(panel.style.top,'392px');assert.equal(panel.style.left,'900px');
  await key(panel,'Escape');assert.equal(v.panel(),null);assert.equal(document.activeElement,v.trigger);
  await v.open(); await act(async()=>v.panel().querySelector('[aria-label="关闭引用预览"]').click());
  assert.equal(v.panel(),null);assert.equal(document.activeElement,v.trigger);
});

test('narrow viewport and short visual viewport clamp the panel and reflow on scroll/resize',async t=>{
  const v=await fixture(t);await v.open();
  Object.defineProperty(window,'innerWidth',{value:390,configurable:true});
  v.anchor({left:350,top:20,bottom:48});await act(async()=>window.dispatchEvent(new window.Event('resize')));
  assert.equal(v.panel().style.width,'360px');assert.equal(v.panel().style.left,'18px');assert.equal(v.panel().style.top,'56px');
  const viewport=new window.EventTarget();Object.assign(viewport,{offsetLeft:3,offsetTop:25,width:320,height:180});
  Object.defineProperty(window,'visualViewport',{value:viewport,configurable:true});
  await act(async()=>window.dispatchEvent(new window.Event('scroll')));
  assert.equal(v.panel().style.width,'296px');assert.equal(v.panel().style.left,'15px');
  assert.equal(v.panel().style.top,'56px');assert.equal(v.panel().style.maxHeight,'137px');
  viewport.height=100;await act(async()=>window.dispatchEvent(new window.Event('resize')));
  assert.equal(v.panel().style.top,'37px');assert.equal(v.panel().style.maxHeight,'76px');
  delete window.visualViewport;
});

test('outside/navigation/session changes close the preview and empty quotes remove portal',async t=>{
  const v=await fixture(t);await v.open();
  await act(async()=>v.panel().dispatchEvent(new window.PointerEvent('pointerdown',{bubbles:true})));assert.ok(v.panel());
  await act(async()=>document.body.dispatchEvent(new window.PointerEvent('pointerdown',{bubbles:true})));assert.equal(v.panel(),null);
  await v.open();await act(async()=>window.dispatchEvent(new window.Event('easel:page-navigation')));assert.equal(v.panel(),null);
  await v.open();await v.render({sessionId:'quote-two'});assert.equal(v.panel(),null);
  await v.open();await v.render({quotes:[]});assert.equal(v.panel(),null);assert.equal(v.container.textContent,'');
});

test.after(()=>window.close());
