import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// Real Sidebar with the grouped collapsible navigation; fetch stands in for
// nothing (the sidebar is data-pure apart from props).
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.sessionStorage = window.sessionStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: Sidebar } = await loadTsModule('../src/components/Sidebar.tsx', import.meta.url);

const session = (id, title, patch = {}) => ({ id, title, messages: [], created: 1, ...patch });

async function fixture(t, props = {}) {
  window.sessionStorage.clear();
  const visits = [];
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const base = {
    currentPage: 'dashboard', onPageChange: page => visits.push(page),
    personas: [], selectedPersona: '', onPersonaChange: () => {}, onNewProfile: () => {},
    sessions: [session('s1', '今天的对话', { messages: [{ role: 'user', content: 'hi' }] })],
    activeSessionId: 's1', activeSessionHasMessages: true,
    onSessionSelect: () => {}, onSessionDelete: () => {}, onSessionRename: () => {}, onSessionArchive: () => {},
    onNewChat: () => {}, gatewayStatus: 'connected', ...props,
  };
  await act(async () => root.render(createElement(Sidebar, base)));
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  return {
    container, visits,
    nav: () => container.querySelector('[aria-label="主导航"]'),
    label: text => [...container.querySelectorAll('button')].find(button => (button.textContent || '').trim() === text),
    visible: text => Boolean([...container.querySelectorAll('button')].find(button => (button.textContent || '').trim() === text && button.closest('.nav-group'))),
    click: async text => act(async () => { const button = [...container.querySelectorAll('button')].find(b => (b.textContent || '').trim() === text); assert.ok(button, `missing button: ${text}`); button.click(); }),
  };
}

test('chat stays a top-level item in the leading create group', async t => {
  const view = await fixture(t);
  const items = [...view.container.querySelectorAll('.nav-group')];
  assert.equal(items.length, 4);
  const create = items[0];
  assert.deepEqual([...create.querySelectorAll('.nav-item')].map(b => (b.textContent || '').trim()), ['工作台', '对话', '生图工坊']);
  assert.ok(create.querySelector('.nav-item.active'), 'dashboard marks its own item active');
});

test('config group is collapsed by default and others stay expanded', async t => {
  const view = await fixture(t);
  assert.equal(view.visible('设置'), false);
  for (const name of ['对话', '技能库', '运行记录']) assert.ok(view.visible(name), `${name} should be visible`);
});

test('toggling a group collapses and persists across remount', async t => {
  const view = await fixture(t);
  await view.click('工具');
  assert.equal(view.visible('技能库'), false);
  // remount reads the stored state
  const container2 = document.createElement('div'); document.body.append(container2);
  const root2 = createRoot(container2);
  await act(async () => root2.render(createElement(Sidebar, {
    currentPage: 'dashboard', onPageChange: () => {}, personas: [], selectedPersona: '', onPersonaChange: () => {},
    onNewProfile: () => {}, sessions: [], activeSessionId: null, activeSessionHasMessages: false,
    onSessionSelect: () => {}, onSessionDelete: () => {}, onSessionRename: () => {}, onSessionArchive: () => {},
    onNewChat: () => {}, gatewayStatus: 'connected',
  })));
  assert.equal([...container2.querySelectorAll('button')].some(b => (b.textContent || '').trim() === '技能库'), false);
  await act(async () => root2.unmount()); container2.remove();
});

test('the group containing the current page cannot be collapsed', async t => {
  const view = await fixture(t, { currentPage: 'skills' });
  assert.ok(view.visible('技能库'), 'active group shows its items');
  await view.click('工具'); // no-op for the active group
  assert.ok(view.visible('技能库'), 'active group stays expanded');
  assert.equal(window.sessionStorage.getItem('easel_nav_collapsed'), null, 'blocked toggle writes nothing');
});

test('invalid stored collapse state falls back to defaults', async t => {
  window.sessionStorage.setItem('easel_nav_collapsed', JSON.stringify(['nope']));
  const view = await fixture(t);
  assert.equal(view.visible('设置'), false, 'defaults apply for unknown stored keys');
  assert.ok(view.visible('技能库'));
});

test('clicking a nav item reports the page and keeps the session list', async t => {
  const view = await fixture(t);
  await view.click('对话');
  assert.deepEqual(view.visits, ['chat']);
  assert.ok(view.container.textContent.includes('最近对话'));
  assert.ok(view.container.textContent.includes('今天的对话'));
});
