import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';
const { setSessionPinned } = await loadTsModule('../src/lib/store.ts', import.meta.url);

// Real Sidebar with simulated DOM and controlled account snapshots. These checks
// exercise both columns and navigation, not real viewport pixels or live sessions.
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.sessionStorage = window.sessionStorage;
globalThis.localStorage = window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: Sidebar } = await loadTsModule('../src/components/Sidebar.tsx', import.meta.url);
const CONVERSATIONS = 'easel:sidebar-conversations-open-v2';
const TOOLBAR = 'easel:sidebar-toolbar-expanded-v2';
const session = (id, title, patch = {}) => ({ id, title, messages: [{ role: 'user', content: '已有实际会话文字' }], created: 1, ...patch });

async function fixture(t, props = {}, preferences = {}) {
  sessionStorage.clear(); localStorage.clear();
  for (const [key, value] of Object.entries(preferences)) localStorage.setItem(key, value);
  const visits = [], selected = [], requests = [];
  const actions = { newChats: 0, pins: [], archives: [], deleted: [] };
  t.mock.method(globalThis, 'fetch', async url => { requests.push(url); return { ok: true, json: async () => [] }; });
  const container = document.createElement('div'); document.body.append(container);
  let root = createRoot(container);
  const base = {
    currentPage: 'chat', onPageChange: page => { visits.push(page); base.currentPage = page; root.render(createElement(Sidebar, base)); },
    personas: [], selectedPersona: '', onPersonaChange: () => {}, onNewProfile: () => {},
    sessions: [session('s1', '今天的对话'), session('s2', '此前的调研'), session('hidden', '未启用的空会话', { messages: [] })],
    activeSessionId: 's1', activeSessionHasMessages: true,
    onSessionSelect: id => selected.push(id), onSessionDelete: () => {}, onSessionRename: () => {}, onSessionArchive: () => {},
    onSessionPin: (id, pinned) => { actions.pins.push([id, pinned]); base.sessions = setSessionPinned(base.sessions, id, pinned, 100); root.render(createElement(Sidebar, base)); },
    onNewChat: () => actions.newChats++, gatewayStatus: 'connected', ...props,
  };
  await act(async () => root.render(createElement(Sidebar, base)));
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  return {
    container, visits, selected, requests, actions,
    shell: () => container.querySelector('.sidebar-shell'),
    byLabel: label => container.querySelector(`[aria-label="${label}"]`),
    async clickLabel(label) { const button = container.querySelector(`[aria-label="${label}"]`); assert.ok(button, `missing control: ${label}`); await act(async () => button.click()); },
    async clickText(label) { const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === label); assert.ok(button, `missing button: ${label}`); await act(async () => button.click()); },
    async remount() { await act(async () => root.unmount()); root = createRoot(container); await act(async () => root.render(createElement(Sidebar, base))); },
    async update(patch) { Object.assign(base, patch); await act(async () => root.render(createElement(Sidebar, base))); },
  };
}

test('new installations start with both columns collapsed and reveal real conversations on request', async t => {
  const view = await fixture(t);
  assert.equal(view.shell().classList.contains('is-expanded'), false);
  assert.equal(view.shell().classList.contains('is-toolbar-expanded'), false);
  assert.ok(view.container.querySelector('.sidebar-toolbar'));
  assert.equal(view.container.querySelector('.sidebar-conversations'), null);
  assert.equal(view.byLabel('展开对话列表').getAttribute('aria-expanded'), 'false');
  await view.clickLabel('展开对话列表');
  assert.ok(view.container.querySelector('.sidebar-conversations'));
  assert.ok(view.container.querySelector('.sidebar-conversations .session-select'));
  assert.equal(view.byLabel('展开工具栏').getAttribute('aria-expanded'), 'false');
  assert.equal(view.byLabel('收起对话列表').getAttribute('aria-expanded'), 'true');
  assert.ok(view.container.textContent.includes('今天的对话'));
  assert.ok(view.container.textContent.includes('此前的调研'));
  assert.equal(view.container.textContent.includes('未启用的空会话'), false);
  assert.deepEqual(view.requests, []);
});

for (const page of ['chat', 'dashboard', 'settings', 'accounts', 'analysis', 'agent-office']) test(`${page} ignores legacy expansion and starts with both columns collapsed`, async t => {
  const view = await fixture(t, { currentPage: page }, { [CONVERSATIONS]: 'true', [TOOLBAR]: 'true' });
  assert.equal(view.container.querySelector('.sidebar-conversations'), null);
  assert.equal(view.shell().classList.contains('is-toolbar-expanded'), false);
  assert.equal(localStorage.getItem(CONVERSATIONS), 'true');
  await view.clickLabel('展开对话列表');
  assert.ok(view.container.querySelector('.sidebar-conversations'));
  await view.remount();
  assert.equal(view.container.querySelector('.sidebar-conversations'), null);
  assert.equal(localStorage.getItem(CONVERSATIONS), 'true');
});

for (const savedOpen of [true, false]) test(`navigation collapses conversations even when the legacy chat preference was ${savedOpen}`, async t => {
  const view = await fixture(t, {}, { [CONVERSATIONS]: String(savedOpen), [TOOLBAR]: 'true' });
  await view.clickLabel('展开工具栏');
  for (const page of ['settings', 'accounts', 'analysis', 'agent-office', 'chat']) {
    await view.update({ currentPage: page });
    assert.equal(view.container.querySelector('.sidebar-conversations'), null);
    await view.clickLabel('展开对话列表');
    assert.ok(view.container.querySelector('.sidebar-conversations'));
    assert.equal(localStorage.getItem(CONVERSATIONS), String(savedOpen), 'manual expansion stores no preference');
  }
  assert.ok(view.shell().classList.contains('is-toolbar-expanded'));
  await view.update({ currentPage: 'settings' });
  await view.update({ currentPage: 'chat' });
  assert.equal(view.shell().classList.contains('is-expanded'), false);
});

test('automatic collapse restores focus if navigation removes the focused conversation control', async t => {
  const view = await fixture(t);
  await view.clickLabel('展开对话列表');
  await act(async () => view.byLabel('收起对话列表').focus());
  await view.update({ currentPage: 'settings' });
  assert.equal(document.activeElement, view.byLabel('展开对话列表'));
});

test('mobile navigation keeps returning chat unobscured despite legacy expansion', async t => {
  t.mock.method(window, 'matchMedia', () => ({ matches: true }));
  const view = await fixture(t, {}, { [CONVERSATIONS]: 'true' });
  await view.update({ currentPage: 'settings' });
  await view.clickLabel('展开对话列表');
  await view.update({ currentPage: 'chat' });
  assert.equal(view.container.querySelector('.sidebar-conversations'), null);
  assert.equal(localStorage.getItem(CONVERSATIONS), 'true');
  await view.clickLabel('展开对话列表');
  assert.ok(view.byLabel('收起对话列表'));
});

test('a legacy expanded rail cannot override the compact first screen', async t => {
  const view = await fixture(t, {}, { 'easel:sidebar-expanded': 'true' });
  assert.equal(view.shell().classList.contains('is-expanded'), false);
  assert.ok(view.byLabel('展开对话列表'));
});

for (const savedOpen of [undefined, 'true']) test(`initial ${savedOpen ? 'restored' : 'default'} conversations preserve existing page focus`, async t => {
  const input = document.createElement('input'); document.body.append(input); input.focus();
  t.after(() => input.remove());
  const view = await fixture(t, {}, savedOpen ? { [CONVERSATIONS]: savedOpen } : {});
  assert.ok(view.byLabel('展开对话列表'));
  assert.equal(document.activeElement, input);
});

for (const narrow of [false, true]) test(`${narrow ? 'small-screen' : 'desktop'} conversation toggles hand focus to the newly visible control`, async t => {
  t.mock.method(window, 'matchMedia', () => ({ matches: narrow }));
  const view = await fixture(t, {}, { [CONVERSATIONS]: 'false' });
  const expand = view.byLabel('展开对话列表');
  await act(async () => { expand.focus(); expand.click(); });
  const collapse = view.byLabel('收起对话列表');
  assert.ok(collapse);
  assert.equal(expand.isConnected, false);
  assert.equal(document.activeElement, collapse, 'activation must not strand focus on the document body');
  await act(async () => collapse.click());
  assert.equal(document.activeElement, view.byLabel('展开对话列表'));
  assert.equal(view.container.querySelector('.sidebar-conversations'), null);
  assert.equal(view.shell().classList.contains('is-toolbar-expanded'), false);
});

test('toolbar and conversations toggle independently through all four combinations', async t => {
  const view = await fixture(t);
  const state = () => [view.shell().classList.contains('is-toolbar-expanded'), view.shell().classList.contains('is-expanded')];
  assert.deepEqual(state(), [false, false]);
  await view.clickLabel('展开对话列表');
  assert.deepEqual(state(), [false, true]);
  const firstSession = view.container.querySelector('.session-select');
  await view.clickLabel('展开工具栏');
  assert.deepEqual(state(), [true, true]);
  assert.equal(view.container.querySelector('.session-select'), firstSession, 'toolbar toggle preserves the conversation DOM');
  await view.clickLabel('收起对话列表');
  assert.deepEqual(state(), [true, false]);
  assert.equal(view.container.querySelector('.sidebar-conversations'), null);
  assert.ok(view.byLabel('工作台') && view.byLabel('更多') && view.byLabel('设置'));
  await view.clickLabel('收起工具栏');
  assert.deepEqual(state(), [false, false]);
  await view.clickLabel('展开对话列表');
  assert.deepEqual(state(), [false, true]);
  assert.deepEqual(view.selected, []);
});

test('manual expansion stays within the mounted page and both columns reset on remount', async t => {
  const view = await fixture(t);
  await view.clickLabel('展开工具栏');
  await view.clickLabel('展开对话列表');
  assert.ok(view.shell().classList.contains('is-toolbar-expanded'));
  assert.ok(view.shell().classList.contains('is-expanded'));
  assert.equal(localStorage.getItem(TOOLBAR), null);
  assert.equal(localStorage.getItem(CONVERSATIONS), null);
  await view.remount();
  assert.equal(view.shell().classList.contains('is-toolbar-expanded'), false);
  assert.equal(view.shell().classList.contains('is-expanded'), false);
});

test('invalid legacy preferences still start with both columns compact', async t => {
  const view = await fixture(t, {}, { [TOOLBAR]: '{invalid', [CONVERSATIONS]: '{invalid' });
  assert.equal(view.shell().classList.contains('is-expanded'), false);
  assert.equal(view.shell().classList.contains('is-toolbar-expanded'), false);
});

for (const expanded of [true, false]) test(`all eleven workspaces remain reachable with conversations ${expanded ? 'expanded' : 'collapsed'}`, async t => {
  const view = await fixture(t, {}, { [CONVERSATIONS]: String(expanded) });
  if (expanded) await view.clickLabel('展开对话列表');
  for (const [label, page] of [['工作台', 'dashboard'], ['对话', 'chat'], ['生图工坊', 'image'], ['Agent 办公室', 'agent-office'], ['设置', 'settings']]) {
    await view.clickLabel(label); assert.equal(view.visits.at(-1), page);
  }
  for (const [label, page] of [['技能库', 'skills'], ['内容库', 'outputs'], ['内容分析', 'analysis'], ['运行记录', 'activity'], ['画像', 'profile']]) {
    await view.clickLabel('更多');
    const menu = document.querySelector('[role="menu"][aria-label="更多工作区"]');
    assert.ok(menu);
    const item = [...menu.querySelectorAll('[role="menuitem"]')].find(button => button.textContent.trim() === label);
    assert.ok(item, `${label} remains discoverable in More`);
    await act(async () => item.click());
    assert.equal(view.visits.at(-1), page);
    assert.equal(document.querySelector('.sidebar-more-menu'), null);
  }
  await view.clickLabel('账号');
  const accountLink = document.querySelector('.sidebar-account-open'); assert.ok(accountLink);
  await act(async () => accountLink.click());
  assert.equal(view.visits.at(-1), 'accounts');
  assert.equal(new Set(view.visits).size, 11);
  assert.equal(view.shell().classList.contains('is-expanded'), false, 'account navigation automatically collapses the conversation column');
  assert.equal(localStorage.getItem(CONVERSATIONS), String(expanded), 'navigation does not rewrite obsolete layout preferences');
});

test('selecting an existing conversation and creating a new one invoke their separate actions', async t => {
  const view = await fixture(t);
  await view.clickLabel('展开对话列表');
  await view.clickText('此前的调研');
  assert.deepEqual(view.selected, ['s2']);
  assert.deepEqual(view.visits, []);
  assert.ok(view.container.querySelector('.sidebar-conversations'), 'session switching preserves the expanded list');
  await view.clickText('新建对话');
  assert.equal(view.actions.newChats, 1);
  assert.deepEqual(view.selected, ['s2']);
  assert.equal(view.container.querySelectorAll('.session-select').length, 2);
  assert.deepEqual(view.requests, []);
});

test('active workspaces inside More retain an explicit selected state', async t => {
  const view = await fixture(t, { currentPage: 'analysis' });
  assert.ok(view.byLabel('更多').classList.contains('active'));
  await view.clickLabel('更多');
  const current = document.querySelector('[role="menuitem"][aria-current="page"]');
  assert.equal(current.textContent.trim(), '内容分析');
});

test('small-screen backdrop and Escape dismiss conversations while preserving toolbar state', async t => {
  t.mock.method(window, 'matchMedia', () => ({ matches: true }));
  const view = await fixture(t);
  await view.clickLabel('展开工具栏');
  await view.clickLabel('展开对话列表');
  await view.clickLabel('关闭侧边栏遮罩');
  assert.equal(view.container.querySelector('.sidebar-conversations'), null);
  assert.ok(view.shell().classList.contains('is-toolbar-expanded'));
  assert.equal(document.activeElement, view.byLabel('展开对话列表'));
  await view.clickLabel('展开对话列表');
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(view.container.querySelector('.sidebar-conversations'), null);
  assert.ok(view.shell().classList.contains('is-toolbar-expanded'));
  await view.clickLabel('展开对话列表');
  await view.clickLabel('对话');
  assert.deepEqual(view.visits, ['chat']);
  assert.equal(view.container.querySelector('.sidebar-conversations'), null);
  assert.ok(view.byLabel('工作台'));
});

test('small-screen session selection and new chat preserve the expanded conversation list', async t => {
  t.mock.method(window, 'matchMedia', () => ({ matches: true }));
  const view = await fixture(t, {}, { [TOOLBAR]: 'true' });
  await view.clickLabel('展开工具栏');
  await view.clickLabel('展开对话列表');
  await view.clickText('今天的对话');
  assert.deepEqual(view.selected, ['s1']);
  assert.ok(view.container.querySelector('.sidebar-conversations'));
  await view.clickText('新建对话');
  assert.equal(view.actions.newChats, 1);
  assert.ok(view.container.querySelector('.sidebar-conversations'));
  assert.ok(view.shell().classList.contains('is-toolbar-expanded'));
});

test('conversation loading follows each running session and disappears when its run ends',async t=>{
 const view=await fixture(t,{runningSessions:['s2']});await view.clickLabel('展开对话列表');
 const row=()=>[...view.container.querySelectorAll('.session-item')].find(item=>item.textContent.includes('此前的调研'));
 assert.ok(row().querySelector('[aria-label="正在对话"]'));
 await view.update({activeSessionId:'s2'});assert.ok(row().querySelector('[aria-label="正在对话"]'));
 await view.update({runningSessions:[],stoppingSessions:['s2']});assert.ok(row().querySelector('[aria-label="正在停止"]'));
 await view.update({stoppingSessions:[]});assert.equal(view.container.querySelector('.session-running-indicator'),null);
});

test('pinning moves one conversation into its own section without selecting it or losing running state', async t => {
  const view = await fixture(t, { runningSessions: ['s2'] });
  await view.clickLabel('展开对话列表');
  await view.clickLabel('对话操作：此前的调研');
  const menu = document.querySelector('.session-menu');
  assert.ok(menu);
  assert.equal(document.activeElement.textContent.trim(), '置顶');
  await act(async () => [...menu.querySelectorAll('button')].find(button => button.textContent.trim() === '置顶').click());
  assert.deepEqual(view.actions.pins, [['s2', true]]);
  assert.deepEqual(view.selected, []);
  const pinned = view.container.querySelector('.sidebar-pinned');
  assert.equal(pinned.querySelectorAll('.session-select').length, 1);
  assert.equal(pinned.querySelector('.session-select').textContent, '此前的调研');
  assert.ok(pinned.querySelector('[aria-label="正在对话"]'));
  assert.equal(view.container.querySelector('.sidebar-recent .session-select').textContent, '今天的对话');
  assert.equal(view.container.querySelectorAll('.session-select').length, 2);
  assert.equal(document.activeElement, pinned.querySelector('.session-menu-trigger'));
  await view.clickLabel('对话操作：此前的调研');
  await view.clickText('取消置顶');
  assert.equal(view.container.querySelector('.sidebar-pinned'), null);
  assert.deepEqual([...view.container.querySelectorAll('.session-select')].map(button => button.textContent), ['今天的对话', '此前的调研']);
  assert.deepEqual(view.selected, []);
});

test('pin order survives updates, archive restoration and empty-session selection changes', async t => {
  const items = [session('s1', '较后置顶', { pinnedAt: 20 }), session('s2', '较早置顶', { pinnedAt: 10 }), session('empty', '置顶空对话', { pinnedAt: 30, messages: [] })];
  const view = await fixture(t, { sessions: items });
  await view.clickLabel('展开对话列表');
  const titles = () => [...view.container.querySelectorAll('.sidebar-pinned .session-select')].map(button => button.textContent);
  assert.deepEqual(titles(), ['较早置顶', '较后置顶', '置顶空对话']);
  await view.update({ sessions: [session('new', '新对话'), ...items], activeSessionId: 'new' });
  assert.deepEqual(titles(), ['较早置顶', '较后置顶', '置顶空对话']);
  await view.update({ sessions: items.map(item => item.id === 's2' ? { ...item, archived: true } : item) });
  assert.deepEqual(titles(), ['较后置顶', '置顶空对话']);
  await view.clickText('已归档 · 1');
  await view.clickLabel('对话操作：较早置顶');
  assert.ok(document.querySelector('.session-menu').textContent.includes('取消归档'));
  assert.equal(document.querySelector('.session-menu').textContent.includes('置顶'), false);
  await act(async () => document.querySelector('.session-menu').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await view.update({ sessions: items });
  assert.deepEqual(titles(), ['较早置顶', '较后置顶', '置顶空对话']);
  await view.update({ sessions: items.filter(item => item.id !== 's2') });
  assert.deepEqual(titles(), ['较后置顶', '置顶空对话']);
});

test('conversation menu supports keyboard navigation, dismissal and the existing actions without selection', async t => {
  t.mock.method(window, 'matchMedia', () => ({ matches: true }));
  const calls = [];
  const view = await fixture(t, { onSessionArchive: (...args) => calls.push(['archive', ...args]), onSessionDelete: id => calls.push(['delete', id]), onSessionRename: (...args) => calls.push(['rename', ...args]) });
  await view.clickLabel('展开对话列表');
  const trigger = view.byLabel('对话操作：此前的调研');
  await act(async () => trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
  const menu = () => document.querySelector('.session-menu');
  assert.equal(document.activeElement.textContent.trim(), '置顶');
  await act(async () => menu().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true })));
  assert.equal(document.activeElement.textContent.trim(), '删除');
  await act(async () => menu().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(menu(), null);
  assert.equal(document.activeElement, trigger);
  assert.ok(view.container.querySelector('.sidebar-conversations'), 'Escape closes the menu before the mobile sidebar');
  await view.clickLabel('对话操作：此前的调研');
  await act(async () => document.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true })));
  assert.equal(menu(), null);
  await view.clickLabel('对话操作：此前的调研');
  await view.clickText('归档');
  await view.clickLabel('对话操作：此前的调研');
  await view.clickText('删除');
  await view.clickLabel('对话操作：此前的调研');
  await view.clickText('重命名');
  assert.equal(view.container.querySelector('.session-rename-input').value, '此前的调研');
  await view.clickText('保存标题');
  assert.deepEqual(calls, [['archive', 's2', true], ['delete', 's2'], ['rename', 's2', '此前的调研']]);
  assert.deepEqual(view.selected, []);
});
