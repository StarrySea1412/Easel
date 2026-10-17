import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: Card } = await loadTsModule('../src/components/SessionHoverCard.tsx', import.meta.url);
const { default: Sidebar } = await loadTsModule('../src/components/Sidebar.tsx', import.meta.url);
const session = { id: 'hover-a', title: '测试会话', created: Date.now(), messages: [{ role: 'user', content: '原文', selectedSkills: ['chosen', 'executed'] }] };
const wait = () => act(async () => new Promise(resolve => setTimeout(resolve, 230)));
async function mount(t, Component, props) {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Component, props)));
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  return { container, root };
}

test('hover distinguishes selected skills from execution and retains newest same-session evidence', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ records: [
    { sessionId: session.id, invocation: [{ skill: 'executed', status: 'failed', evidence: [] }] },
    { sessionId: session.id, invocation: [{ skill: 'executed', status: 'executed', evidence: [] }] },
    { sessionId: 'another', invocation: [{ skill: 'foreign', status: 'executed', evidence: [] }] },
  ] }) }));
  const anchor = document.createElement('button'); document.body.append(anchor); t.after(() => anchor.remove());
  await mount(t, Card, { session, anchor }); await wait();
  const card = document.querySelector('[role=tooltip]');
  assert.match(card.textContent, /最近技能记录.*执行失败/);
  assert.match(card.textContent, /已选择.*chosen/);
  assert.doesNotMatch(card.textContent, /foreign|执行成功/);
  assert.equal(anchor.getAttribute('aria-describedby'), card.id);
  assert.match(card.textContent, /未置顶 · 1 轮/);
});

test('backup hover uses selected skills without contacting live audit and clamps to viewport', async t => {
  const calls = []; t.mock.method(globalThis, 'fetch', async url => { calls.push(url); throw new Error('should not fetch'); });
  const anchor = document.createElement('button'); document.body.append(anchor); t.after(() => anchor.remove());
  anchor.getBoundingClientRect = () => ({ right: 9000, top: 9000 });
  await mount(t, Card, { session: { ...session, importedFromBackup: true, pinnedAt: 1 }, anchor }); await wait();
  const card = document.querySelector('[role=tooltip]');
  assert.match(card.textContent, /备份未包含技能执行记录/);
  assert.match(card.textContent, /已置顶/); assert.deepEqual(calls, []);
  assert.ok(parseFloat(card.style.left) < window.innerWidth);
  assert.ok(parseFloat(card.style.top) < window.innerHeight);
});

test('closing hover aborts reads and clears the accessible description', async t => {
  let signal;
  t.mock.method(globalThis, 'fetch', async (_url, options) => { signal = options.signal; return new Promise(() => {}); });
  const anchor = document.createElement('button'); document.body.append(anchor); t.after(() => anchor.remove());
  const view = await mount(t, Card, { session, anchor }); await wait();
  await act(async () => view.root.render(null));
  assert.equal(signal.aborted, true); assert.equal(anchor.hasAttribute('aria-describedby'), false);
});

test('keyboard preview closes for menus; quick pin never selects a different session', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ records: [] }) }));
  const selected = [], pinned = [];
  const view = await mount(t, Sidebar, { currentPage: 'chat', sessions: [session], activeSessionId: 'other', activeSessionHasMessages: true,
    personas: [], selectedPersona: '', gatewayStatus: '', onSessionSelect: id => selected.push(id),
    onSessionPin: (...args) => pinned.push(args), onPageChange() {}, onPersonaChange() {}, onNewProfile() {}, onNewChat() {}, onSessionRename() {}, onSessionArchive() {}, onSessionDelete() {} });
  await act(async () => view.container.querySelector('[aria-label="展开对话列表"]').click());
  const title = view.container.querySelector('.session-select');
  await act(async () => title.focus()); assert.ok(document.querySelector('.session-hover-card[role=dialog]'));
  const pin = view.container.querySelector('.session-quick-pin');
  await act(async () => pin.focus()); assert.equal(document.querySelector('.session-hover-card'), null);
  await act(async () => pin.click()); assert.deepEqual(pinned, [[session.id, true]]); assert.deepEqual(selected, []);
  await act(async () => title.focus());
  await act(async () => title.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(document.querySelector('.session-hover-card'), null);
  await act(async () => view.container.querySelector('.session-menu-trigger').click());
  assert.ok(document.querySelector('[role=menu]')); assert.equal(document.querySelector('.session-hover-card'), null);
});

test('hover preview stays reachable across the pointer gap and edits its title without selecting the chat',async t=>{
  t.mock.method(globalThis,'fetch',async()=>({ok:true,json:async()=>({records:[]})}));
  const saved=[],selected=[];
  const view=await mount(t,Sidebar,{currentPage:'chat',sessions:[session],activeSessionId:'other',activeSessionHasMessages:true,personas:[],selectedPersona:'',gatewayStatus:'connected',onSessionSelect:id=>selected.push(id),onSessionRename:(id,title)=>saved.push({id,title}),onPageChange(){},onPersonaChange(){},onNewProfile(){},onNewChat(){},onSessionPin(){},onSessionArchive(){},onSessionDelete(){}});
  await act(async()=>view.container.querySelector('[aria-label="展开对话列表"]').click());
  const title=view.container.querySelector('.session-select');
  await act(async()=>title.focus());
  const card=()=>document.querySelector('.session-hover-card');
  await act(async()=>title.dispatchEvent(new window.PointerEvent('pointerout',{bubbles:true,relatedTarget:document.body})));
  await act(async()=>card().dispatchEvent(new window.PointerEvent('pointerover',{bubbles:true,relatedTarget:document.body})));
  await wait();assert.ok(card(),'moving into preview cancels delayed dismissal');
  await act(async()=>card().querySelector('.session-hover-rename').click());
  const input=card().querySelector('input');assert.equal(input.value,session.title);
  await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,'  可直接修改的标题  ');input.dispatchEvent(new window.Event('input',{bubbles:true}));});
  await act(async()=>card().dispatchEvent(new window.PointerEvent('pointerout',{bubbles:true,relatedTarget:document.body})));
  await wait();assert.ok(card()?.querySelector('input'),'editing remains open when pointer leaves');
  await act(async()=>input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})));
  assert.deepEqual(saved,[{id:session.id,title:'可直接修改的标题'}]);assert.deepEqual(selected,[]);
  assert.equal(document.activeElement,title);
  await act(async()=>card().querySelector('.session-hover-rename').click());
  await act(async()=>view.container.querySelector('[aria-label="收起对话列表"]').click());
  await act(async()=>view.container.querySelector('[aria-label="展开对话列表"]').click());
  await act(async()=>view.container.querySelector('.session-select').focus());
  assert.ok(card()?.querySelector('.session-hover-rename'),'closing sidebar cancels hidden preview editing');
  assert.equal(saved.length,1);
});

test('hover-card rename rejects blank titles, ignores composing Enter and cancels without closing the narrow sidebar',async t=>{
  t.mock.method(globalThis,'fetch',async()=>({ok:true,json:async()=>({records:[]})}));
  t.mock.method(window,'matchMedia',()=>({matches:true}));
  const saved=[],selected=[];
  const view=await mount(t,Sidebar,{currentPage:'chat',sessions:[session],activeSessionId:'other',activeSessionHasMessages:true,personas:[],selectedPersona:'',gatewayStatus:'connected',onSessionSelect:id=>selected.push(id),onSessionRename:(id,title)=>saved.push({id,title}),onPageChange(){},onPersonaChange(){},onNewProfile(){},onNewChat(){},onSessionPin(){},onSessionArchive(){},onSessionDelete(){}});
  await act(async()=>view.container.querySelector('[aria-label="展开对话列表"]').click());
  // The row keeps no quick-rename button; the hover card's title pencil is the entry.
  assert.equal(view.container.querySelector('.session-quick-rename'),null,'no duplicate rename icon in the row');
  const title=view.container.querySelector('.session-select');
  await act(async()=>title.focus());
  const card=()=>document.querySelector('.session-hover-card');
  await act(async()=>card().querySelector('.session-hover-rename').click());
  const input=card().querySelector('input.session-rename-input');
  assert.ok(input,'the card hosts the rename editor');
  await act(async()=>input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true})));
  assert.deepEqual(saved,[]);
  await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,'   ');input.dispatchEvent(new window.Event('input',{bubbles:true}));});
  await act(async()=>input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})));
  assert.match(document.querySelector('[role=alert]').textContent,/标题不能为空/);assert.deepEqual(saved,[]);
  await act(async()=>input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  assert.equal(document.querySelector('input.session-rename-input'),null);
  assert.ok(view.container.querySelector('.sidebar-conversations'));assert.deepEqual(selected,[]);
});
