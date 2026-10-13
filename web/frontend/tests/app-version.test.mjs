import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: AppVersion } = await loadTsModule('../src/components/AppVersion.tsx', import.meta.url);
const revision = '8b6bcea7a09a13e2598e44874a3b5cdddcc42a51';
const released = { version: '0.2.7', revision, build: revision.slice(0, 12), development: false };

async function fixture(t, respond = () => released, path = '/') {
  window.location.href = `https://easel.test${path}`;
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    const body = await respond();
    return { ok: true, json: async () => body };
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(AppVersion)));
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  });
  return { trigger: container.querySelector('button'), requests };
}

test('version identifies the actual server build without caching and opens accessible lightweight details', async t => {
  const view = await fixture(t, undefined, '/easel/index.html');
  assert.equal(view.trigger.textContent, 'v0.2.7');
  assert.equal(view.requests[0].url, '/easel/api/version');
  assert.equal(view.requests[0].options.cache, 'no-store');
  await act(async () => view.trigger.click());
  const dialog = document.querySelector('[role=dialog]');
  assert.ok(dialog);
  assert.equal(view.trigger.getAttribute('aria-controls'), dialog.id);
  assert.equal(document.activeElement, dialog);
  assert.equal(dialog.querySelector('code').textContent, '8b6bcea7a09a');
  assert.equal(dialog.querySelector('code').title, revision);
  assert.equal(dialog.textContent.includes('开发环境'), false);
  await act(async () => dialog.querySelector('[aria-label=关闭版本详情]').click());
  assert.equal(document.querySelector('[role=dialog]'), null);
  assert.equal(document.activeElement, view.trigger);
});

test('keyboard details close with Escape or outside pointer and stay within a narrow viewport', async t => {
  const view = await fixture(t);
  const oldWidth = window.innerWidth;
  window.innerWidth = 180;
  t.after(() => { window.innerWidth = oldWidth; });
  await act(async () => {
    view.trigger.focus();
    view.trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  });
  const dialog = document.querySelector('[role=dialog]');
  assert.equal(dialog.style.width, '156px');
  assert.equal(dialog.style.left, '12px');
  await act(async () => dialog.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(document.querySelector('[role=dialog]'), null);
  assert.equal(document.activeElement, view.trigger);
  await act(async () => view.trigger.click());
  await act(async () => document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true })));
  assert.equal(document.querySelector('[role=dialog]'), null);
});

test('development builds remain distinct and a refocused window reads the newly deployed revision', async t => {
  let value = { ...released, development: true };
  const view = await fixture(t, () => value);
  await act(async () => view.trigger.click());
  assert.equal(view.trigger.querySelector('small').textContent, '开发版');
  assert.ok(document.querySelector('[role=dialog]').textContent.includes('开发版'));
  assert.equal(document.querySelector('[role=dialog] code').textContent, released.build);
  value = { version: '0.2.8', revision: 'a'.repeat(40), build: 'a'.repeat(12), development: false };
  await act(async () => window.dispatchEvent(new window.Event('focus')));
  assert.equal(view.requests.length, 2);
  assert.equal(view.trigger.textContent, 'v0.2.8');
  assert.equal(document.querySelector('[role=dialog] code').textContent, value.build);
  assert.equal(document.querySelector('[role=dialog]').textContent.includes('开发版'), false);
});

test('failed or malformed version reads show unknown rather than an invented version', async t => {
  let fail = true;
  const view = await fixture(t, () => { if (fail) throw new Error('offline'); return { ...released, version: 'stale build' }; });
  assert.equal(view.trigger.textContent, '版本未知');
  await act(async () => view.trigger.click());
  assert.equal(document.querySelector('[role=dialog] p').textContent, '暂时无法读取版本');
  assert.equal(document.querySelector('[role=dialog] code'), null);
  fail = false;
  await act(async () => window.dispatchEvent(new window.Event('focus')));
  assert.equal(view.trigger.textContent, '版本未知');
  assert.equal(document.querySelector('[role=alert]'), null);
});

test('SHA-256 repositories retain their full revision in build details', async t => {
  const value = { ...released, revision: 'b'.repeat(64), build: 'b'.repeat(12) };
  const view = await fixture(t, () => value);
  assert.equal(view.trigger.textContent, 'v0.2.7');
  await act(async () => view.trigger.click());
  assert.equal(document.querySelector('[role=dialog] code').title, value.revision);
});
