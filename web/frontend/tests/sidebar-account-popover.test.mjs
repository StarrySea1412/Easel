import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// Component behavior with simulated DOM and controlled HTTP responses. These
// checks do not claim an online platform session or real-browser validation.
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: SidebarAccountPopover } = await loadTsModule('../src/components/SidebarAccountPopover.tsx', import.meta.url);
const platforms = ['xiaohongshu', 'kuaishou', 'weixin-channels', 'zhihu', 'bilibili', 'douyin', 'wechat-oa'];
const accounts = connected => platforms.map(platform => ({ platform, loggedIn: platform === connected, note: 'PRIVATE_SESSION_SHOULD_NOT_RENDER' }));
const response = value => ({ ok: true, json: async () => value });

async function fixture(t) {
  const requests = [];
  const state = { read: async () => response(accounts()), visits: 0 };
  t.mock.method(globalThis, 'fetch', async (url, options) => { requests.push({ url, options }); return state.read(); });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(SidebarAccountPopover, { active: false, onNavigate: () => state.visits++ })));
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const trigger = container.querySelector('button');
  return { state, requests, trigger,
    panel: () => document.querySelector('.sidebar-account-popover'),
    open: async () => act(async () => trigger.click()),
    escape: async () => act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))),
  };
}

test('account preview only reads an uncached local snapshot and identifies all seven logged-out brands', async t => {
  const view = await fixture(t);
  assert.deepEqual(view.requests, []);
  await view.open();
  assert.deepEqual(view.requests.map(item => item.url), ['/api/accounts']);
  assert.equal(view.requests[0].options.cache, 'no-store');
  assert.match(view.panel().textContent, /7 个平台均未登录/);
  assert.match(view.panel().textContent, /本地登录快照 · 待在线校验/);
  assert.equal(view.panel().querySelectorAll('img.sidebar-account-brand').length, 7);
  assert.doesNotMatch(view.panel().textContent, /PRIVATE_SESSION_SHOULD_NOT_RENDER/);
  await act(async () => view.panel().querySelector('.sidebar-account-open').click());
  assert.equal(view.state.visits, 1);
  assert.equal(view.panel(), null);
});

test('reopening clears old success while a fresh snapshot is pending, and failures never reuse it', async t => {
  const view = await fixture(t);
  view.state.read = async () => response(accounts('xiaohongshu'));
  await view.open();
  assert.match(view.panel().textContent, /1 个平台记录为已登录/);
  await view.escape();
  assert.equal(document.activeElement, view.trigger);
  let fail;
  view.state.read = () => new Promise((_, reject) => { fail = reject; });
  await view.open();
  assert.match(view.panel().textContent, /正在读取本次账号快照/);
  assert.doesNotMatch(view.panel().textContent, /1 个平台记录为已登录/);
  await act(async () => fail(new Error('PRIVATE_BACKEND_DETAIL')));
  assert.match(view.panel().textContent, /本次快照读取失败/);
  assert.doesNotMatch(view.panel().textContent, /已登录 · 待校验|PRIVATE_BACKEND_DETAIL/);
  assert.deepEqual(view.requests.map(item => item.url), ['/api/accounts', '/api/accounts']);
});

test('a late response from a closed preview cannot overwrite the new opening', async t => {
  const view = await fixture(t);
  let finishOld;
  view.state.read = () => new Promise(resolve => { finishOld = resolve; });
  await view.open();
  await view.escape();
  view.state.read = async () => response(accounts());
  await view.open();
  await act(async () => finishOld(response(accounts('douyin'))));
  assert.match(view.panel().textContent, /7 个平台均未登录/);
  assert.doesNotMatch(view.panel().textContent, /1 个平台记录为已登录/);
});

test('focus opens the preview, arrow moves into it, and outside pointer dismisses it', async t => {
  const view = await fixture(t);
  await act(async () => view.trigger.focus());
  assert.ok(view.panel());
  await act(async () => view.trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  assert.equal(document.activeElement, view.panel().querySelector('[aria-label="关闭账号预览"]'));
  await act(async () => document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true })));
  assert.equal(view.panel(), null);
  assert.equal(document.activeElement, view.trigger);
});

test('mouse hover opens the snapshot and leaving both surfaces dismisses it', async t => {
  const view = await fixture(t);
  await act(async () => view.trigger.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })));
  assert.ok(view.panel());
  assert.equal(view.requests.length, 1);
  await act(async () => {
    view.trigger.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    await new Promise(resolve => setTimeout(resolve, 220));
  });
  assert.equal(view.panel(), null);
});

test('missing platform statuses stay unknown instead of claiming all platforms are logged out', async t => {
  const view = await fixture(t);
  view.state.read = async () => response([]);
  await view.open();
  assert.match(view.panel().textContent, /尚无可确认的已登录平台/);
  assert.doesNotMatch(view.panel().textContent, /7 个平台均未登录/);
  assert.equal([...view.panel().querySelectorAll('li small')].filter(item => item.textContent === '待读取').length, 7);
});
