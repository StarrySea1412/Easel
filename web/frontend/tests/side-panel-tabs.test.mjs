import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// 辅助对话多实例面板（标签条 / “＋打开标签页”选择器 / 逐标签关闭 / 空态）的组件行为。
globalThis.window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://easel.test/' }).window;
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
Object.defineProperty(navigator, 'clipboard', { value: { async writeText() {} }, configurable: true });
window.matchMedia = () => ({ matches: false });
window.HTMLElement.prototype.scrollTo = function ({ top }) { this.scrollTop = top; };
const { createRoot } = await import('react-dom/client');
const { default: ChatPage } = await loadTsModule('../src/components/ChatPage.tsx', import.meta.url);

function fixture(t) {
  const originalObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  t.after(() => { globalThis.ResizeObserver = originalObserver; });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ records: [] }) }));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  return {
    container,
    render: (element) => act(async () => root.render(element)),
    click: (element) => act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))),
  };
}

const parent = { id: 'p', title: '主对话', created: 1, messages: [{ role: 'user', content: '帮我写文案' }] };
const sideA = { id: 's1', title: '辅助对话', created: 2, parentSessionId: 'p', messages: [] };
const sideB = { id: 's2', title: '辅助对话 2', created: 3, parentSessionId: 'p', messages: [] };

test('the tab bar lists every side chat and switches between them', async t => {
  const view = fixture(t);
  await view.render(createElement(ChatPage, { session: parent, sideSessions: [sideA, sideB] }));
  let tabs = [...view.container.querySelectorAll('.chat-side-tab')];
  assert.deepEqual(tabs.map(b => b.textContent), ['辅助对话', '辅助对话 2']);
  assert.equal(tabs[0].getAttribute('aria-selected'), 'false');
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true', 'the newest side chat is active by default');
  assert.equal(view.container.querySelector('.side-chat-composer textarea').getAttribute('aria-label'), '辅助对话输入');
  await view.click(tabs[0]);
  tabs = [...view.container.querySelectorAll('.chat-side-tab')];
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true', 'clicking a tab switches the active side chat');
  assert.equal(tabs[1].getAttribute('aria-selected'), 'false');
});

test('the + button opens the tab picker and creates a new side chat', async t => {
  const view = fixture(t);
  const calls = [];
  await view.render(createElement(ChatPage, {
    session: parent, sideSessions: [sideA],
    onSideChat: mode => { calls.push(mode); return 's3'; },
  }));
  await view.click(view.container.querySelector('.chat-side-tab-add'));
  const picker = document.body.querySelector('.chat-side-tab-picker');
  assert.ok(picker, 'the picker appears');
  assert.match(picker.textContent, /打开标签页/);
  assert.match(picker.textContent, /选择要在侧边面板中打开的标签/);
  const rows = [...picker.querySelectorAll('.chat-side-tab-picker-row')];
  assert.deepEqual(rows.map(row => row.querySelector('.chat-side-tab-picker-label').firstChild.textContent), ['辅助对话', '目标']);
  assert.equal(rows[1].disabled, true, 'without a goal the goal row is disabled');
  await view.click(rows[0]);
  assert.deepEqual(calls, ['create'], 'the picker always creates a new side chat');
  assert.equal(document.body.querySelector('.chat-side-tab-picker'), null, 'the picker closes after choosing');
});

test('each side chat tab closes from its own button and the panel keeps an empty state', async t => {
  const view = fixture(t);
  const closed = [];
  const props = { session: parent, sideSessions: [sideA, sideB], onSideClose: id => closed.push(id) };
  await view.render(createElement(ChatPage, props));
  await view.click(view.container.querySelector('.chat-side-tab-wrap.is-on .chat-side-tab-close'));
  assert.deepEqual(closed, ['s2'], 'the active tab closes with its own id');
  await view.render(createElement(ChatPage, { ...props, sideSessions: [] }));
  await view.click(view.container.querySelector('.chat-side-trigger'));
  assert.match(view.container.querySelector('.chat-side-panel-empty').textContent, /没有打开的辅助对话/);
  const created = [];
  await view.render(createElement(ChatPage, {
    ...props, sideSessions: [],
    onSideChat: mode => { created.push(mode ?? 'open'); return 's4'; },
  }));
  await view.click(view.container.querySelector('.chat-side-trigger'));
  const button = [...view.container.querySelectorAll('.chat-side-panel-empty button')].find(b => b.textContent === '新建辅助对话');
  assert.ok(button);
  await view.click(button);
  assert.deepEqual(created, ['open', 'create']);
});
