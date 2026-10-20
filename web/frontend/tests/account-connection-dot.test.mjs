import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';
globalThis.window = new Window({ url: 'https://easel.test' });
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: Dot } = await loadTsModule('../src/components/AccountConnectionDot.tsx', import.meta.url);
async function fixture(t, props) {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const render = async next => act(async () => root.render(createElement(Dot, next))); await render(props);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  return { host, render, button: () => host.querySelector('button'), tip: () => host.querySelector('[role=tooltip]') };
}
test('unknown uses animated checking state, with evidence and time available on click only', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('a visual status must not start network checks'));
  const v = await fixture(t, { connection: 'unknown', message: '网络超时', checkedAt: 1000 });
  assert.ok(v.host.querySelector('.is-checking')); assert.equal(v.host.querySelector('.is-unknown'), null); assert.equal(v.tip(), null);
  await act(async () => v.button().click());
  assert.match(v.tip().textContent, /正在确认连接.*不代表未登录.*上次核验.*网络超时/);
  await act(async () => v.button().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(v.tip(), null); assert.equal(v.button().getAttribute('aria-expanded'), 'false');
});
test('keyboard focus and hover explain status; outside click dismisses the pinned explanation', async t => {
  const v = await fixture(t, { connection: 'online', checkedAt: 1000 });
  await act(async () => v.button().focus()); assert.match(v.tip().textContent, /已连接/);
  await act(async () => { v.button().blur(); v.host.querySelector('.account-connection-dot').dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })); });
  assert.ok(v.tip());
  await act(async () => document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }))); assert.equal(v.tip(), null);
});
test('only confirmed online or offline uses green or red, active checking overrides both', async t => {
  const v = await fixture(t, { connection: 'online' }); assert.ok(v.host.querySelector('.is-online'));
  await v.render({ connection: 'login_required' }); assert.ok(v.host.querySelector('.is-login_required')); assert.match(v.button().title, /^未登录/);
  await v.render({ connection: 'login_required', checking: true }); assert.ok(v.host.querySelector('.is-checking')); assert.match(v.button().title, /^正在检测/);
});
