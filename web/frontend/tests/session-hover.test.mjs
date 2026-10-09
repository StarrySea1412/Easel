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
  await act(async () => title.focus()); assert.ok(document.querySelector('[role=tooltip]'));
  const pin = view.container.querySelector('.session-quick-pin');
  await act(async () => pin.focus()); assert.equal(document.querySelector('[role=tooltip]'), null);
  await act(async () => pin.click()); assert.deepEqual(pinned, [[session.id, true]]); assert.deepEqual(selected, []);
  await act(async () => title.focus());
  await act(async () => title.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(document.querySelector('[role=tooltip]'), null);
  await act(async () => view.container.querySelector('.session-menu-trigger').click());
  assert.ok(document.querySelector('[role=menu]')); assert.equal(document.querySelector('[role=tooltip]'), null);
});
