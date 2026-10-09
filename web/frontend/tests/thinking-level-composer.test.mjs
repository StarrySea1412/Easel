import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { act, createElement, StrictMode } from 'react';
import { loadTsModule } from './load-ts.mjs';

// Real Composer and browser storage contract in a simulated DOM. Keyboard
// default behavior is checked here; actual Tab movement/layout need browser QA.
globalThis.window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://easel.test/' }).window;
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
const { createRoot } = await import('react-dom/client');
const { default: Composer } = await loadTsModule('../src/components/ChatComposer.tsx', import.meta.url);
const { THINKING_LEVELS } = await loadTsModule('../src/lib/thinkingLevel.ts', import.meta.url);
const KEY = 'easel_thinking_level';
let sequence = 0;

async function fixture(t, preference, { strict = false } = {}) {
  const values = new Map(preference === undefined ? [] : [[KEY, preference]]);
  const storage = { values, writes: [], blocked: false, failWrite: false,
    getItem(key) { if (this.blocked) throw new Error('denied'); return values.get(key) ?? null; },
    setItem(key, value) { if (this.failWrite) throw new Error('full'); this.writes.push([key, value]); values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  t.mock.method(globalThis, 'fetch', async url => ({ ok: true, json: async () => url === '/api/upload/limits' ? { max_mb: 50 } : [] }));
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container), sent = [];
  let sessionId = `thinking-composer-${++sequence}`, busy = {};
  const render = async (patch = {}) => {
    busy = { ...busy, ...patch };
    const node = createElement(Composer, { sessionId, isStreaming: false, ...busy, onStop() {}, onSend: (...args) => { sent.push(args); return true; } });
    await act(async () => root.render(strict ? createElement(StrictMode, null, node) : node));
  };
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const click = async element => { assert.ok(element); await act(async () => element.click()); };
  const key = async (element, value, options = {}) => {
    assert.ok(element); const event = new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options });
    await act(async () => element.dispatchEvent(event)); return event;
  };
  return { container, storage, sent, render, click, key,
    trigger: () => container.querySelector('.thinking-level-trigger'),
    menu: () => container.querySelector('[role=listbox]'),
    option: level => [...container.querySelectorAll('[role=option]')].find(element => element.querySelector('small')?.textContent === level),
    async reload() { await act(async () => root.render(null)); await render(); },
    async navigate() { sessionId += '-next'; await render(); },
    async type(value) { const input = container.querySelector('textarea'); await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    }); },
  };
}

test('StrictMode mount and remount read a saved preference without saving or replacing it', async t => {
  const view = await fixture(t, 'high', { strict: true }); await view.render();
  assert.equal(view.trigger().getAttribute('aria-label'), '思考强度：高');
  await view.reload(); await view.navigate();
  assert.equal(view.trigger().getAttribute('aria-label'), '思考强度：高');
  assert.deepEqual(view.storage.writes.filter(([key]) => key === KEY), []);
});

test('invalid saved strength falls back to medium without rewriting until an explicit selection', async t => {
  const view = await fixture(t, 'old-invalid-level', { strict: true }); await view.render();
  assert.equal(view.trigger().getAttribute('aria-label'), '思考强度：中');
  assert.equal(view.storage.values.get(KEY), 'old-invalid-level');
  await view.click(view.trigger()); await view.click(view.option('ultra'));
  assert.equal(view.storage.values.get(KEY), 'ultra');
  assert.deepEqual(view.storage.writes.filter(([key]) => key === KEY), [[KEY, 'ultra']]);
});

test('strength selection survives navigation/reload and sends the exact level as the fifth argument', async t => {
  const view = await fixture(t); await view.render(); await view.click(view.trigger());
  assert.equal(view.container.querySelector('select'), null, 'shared custom selector contract');
  assert.deepEqual([...view.container.querySelectorAll('[role=option] small')].map(element => element.textContent), THINKING_LEVELS);
  await view.click(view.option('xhigh')); assert.equal(view.menu(), null);
  await view.navigate(); await view.reload();
  assert.equal(view.trigger().getAttribute('aria-label'), '思考强度：极高');
  await view.type('需要深度核查'); await view.click(view.container.querySelector('[aria-label=发送消息]'));
  assert.deepEqual(view.sent[0], ['需要深度核查', [], [], {}, 'xhigh']);
});

test('keyboard listbox has active selection, arrows/Home/End, Enter, and Escape focus return', async t => {
  const view = await fixture(t, 'high'); await view.render(); view.trigger().focus();
  assert.equal((await view.key(view.trigger(), 'ArrowDown')).defaultPrevented, true);
  assert.equal(document.activeElement, view.menu());
  const active = () => document.getElementById(view.menu().getAttribute('aria-activedescendant')).querySelector('small').textContent;
  assert.equal(active(), 'high'); await view.key(view.menu(), 'ArrowDown'); assert.equal(active(), 'xhigh');
  await view.key(view.menu(), 'Home'); assert.equal(active(), 'off');
  await view.key(view.menu(), 'ArrowUp'); assert.equal(active(), 'ultra');
  await view.key(view.menu(), 'End'); assert.equal(active(), 'ultra');
  await view.key(view.menu(), 'Enter'); assert.equal(view.menu(), null);
  assert.equal(document.activeElement, view.trigger()); assert.equal(view.storage.values.get(KEY), 'ultra');
  await view.key(view.trigger(), ' '); await view.key(view.menu(), 'ArrowLeft');
  await view.key(view.menu(), 'Escape'); assert.equal(view.menu(), null);
  assert.equal(document.activeElement, view.trigger()); assert.equal(view.storage.values.get(KEY), 'ultra', 'Escape does not apply active option');
});

test('Tab and Shift+Tab are not intercepted; menu closes only after default focus leaves it', async t => {
  const view = await fixture(t); await view.render();
  for (const shiftKey of [false, true]) {
    await view.click(view.trigger()); assert.equal(document.activeElement, view.menu());
    const event = await view.key(view.menu(), 'Tab', { shiftKey });
    assert.equal(event.defaultPrevented, false); assert.ok(view.menu(), 'focused listbox remains during default Tab navigation');
    await act(async () => view.container.querySelector('textarea').focus());
    assert.equal(view.menu(), null); assert.equal(document.activeElement, view.container.querySelector('textarea'));
  }
});

test('becoming streaming or stopping closes an open picker and rejects stale option clicks', async t => {
  const view = await fixture(t, 'low'); await view.render();
  for (const patch of [{ isStreaming: true }, { stopping: true }]) {
    await view.render({ isStreaming: false, stopping: false }); await view.click(view.trigger());
    const stale = view.option('max'); await view.render(patch);
    assert.equal(view.menu(), null); assert.equal(view.trigger().disabled, true);
    assert.equal(view.trigger().getAttribute('aria-expanded'), 'false'); await view.click(stale);
    assert.equal(view.storage.values.get(KEY), 'low');
    await view.render({ isStreaming: false, stopping: false }); assert.equal(view.menu(), null);
  }
});

test('outside pointer closes menu without changing the current strength', async t => {
  const view = await fixture(t, 'adaptive'); await view.render(); await view.click(view.trigger());
  await act(async () => document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true })));
  assert.equal(view.menu(), null); assert.equal(view.storage.values.get(KEY), 'adaptive');
});

test('narrow-screen style permits wrapped tools and anchors the bounded popup to the tool row', () => {
  const style = fs.readFileSync(new URL('../src/styles/chat-composer.css', import.meta.url), 'utf8');
  assert.match(style, /\.composer-tools\s*\{[^}]*flex-wrap:wrap[^}]*min-width:0[^}]*position:relative/s);
  assert.match(style, /\.thinking-level-menu\s*\{[^}]*max-width:min\(210px, calc\(100vw - 28px\)\)[^}]*box-sizing:border-box/s);
  assert.match(style, /@media\(max-width:640px\)[\s\S]*\.thinking-level-picker\s*\{\s*position:static/s);
});
