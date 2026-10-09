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

test('only Ultra enables the highlighted theme and particles, and leaving Ultra removes them', async t => {
  const view = await fixture(t, 'high'); await view.render(); await view.click(view.trigger());
  assert.equal(view.container.querySelector('.is-ultra'), null);
  assert.equal(view.container.querySelector('.thinking-level-particles'), null);
  await view.choose('ultra');
  assert.ok(view.container.querySelector('.thinking-level-picker.is-ultra'));
  assert.equal(view.container.querySelectorAll('.thinking-level-particles i').length, 9);
  await view.choose('max');
  assert.equal(view.container.querySelector('.is-ultra'), null);
  assert.equal(view.container.querySelector('.thinking-level-particles'), null);
});

async function fixture(t, preference, { strict = false, selectedModel } = {}) {
  const values = new Map(preference === undefined ? [] : [[KEY, preference]]);
  if (selectedModel) values.set('easel_chat_model_ref', selectedModel.id);
  const storage = { values, writes: [], blocked: false, failWrite: false,
    getItem(key) { if (this.blocked) throw new Error('denied'); return values.get(key) ?? null; },
    setItem(key, value) { if (this.failWrite) throw new Error('full'); this.writes.push([key, value]); values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  t.mock.method(globalThis, 'fetch', async url => ({ ok: true, json: async () => url === '/api/upload/limits' ? { max_mb: 50 }
    : String(url).includes('/agent-office/models') ? { available: true, scope: 'next_turn', options: selectedModel ? [selectedModel] : [] } : [] }));
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
    menu: () => container.querySelector('.thinking-level-menu[role=dialog]'),
    slider: () => container.querySelector('input[type=range][aria-label="思考强度"]'),
    async choose(level, element = this.slider()) { assert.ok(element); await act(async () => {
      if (level === 'adaptive') { container.querySelector('.thinking-level-adaptive').click(); return; }
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(element, String(THINKING_LEVELS.filter(value => value !== 'adaptive').indexOf(level)));
      element.dispatchEvent(new window.Event('input', { bubbles: true }));
    }); },
    async reload() { await act(async () => root.render(null)); await render(); },
    async navigate() { sessionId += '-next'; await render(); },
    async type(value) { const input = container.querySelector('textarea'); await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    }); },
  };
}

test('known unsupported strength preserves the draft and explains runtime choices without sending', async t => {
  const view = await fixture(t, 'ultra', {selectedModel:{id:'relay/grok-4.7',provider:'relay',model:'grok-4.7',configured:true,thinkingLevels:['off']}});
  await view.render(); await view.type('需要保留的草稿');
  await view.click(view.container.querySelector('[aria-label="发送消息"]'));
  assert.equal(view.sent.length, 0);
  assert.match(view.container.textContent, /不支持 Ultra/);
  assert.match(view.container.textContent, /网关声明可选：关闭/);
  assert.equal(view.container.querySelector('textarea').value, '需要保留的草稿');
  await view.click(view.trigger());
  assert.equal(view.container.querySelector('.thinking-level-adaptive').disabled, true);
  assert.equal(view.container.querySelector('[aria-label="选择Ultra思考强度"]').disabled, true);
  assert.ok(view.container.querySelector('[aria-label="思考强度能力说明"]'));
  await view.click(view.container.querySelector('[aria-label="选择关闭思考强度"]'));
  assert.equal(view.sent.length, 0);
  await view.key(view.slider(), 'Home');
  await view.click(view.container.querySelector('[aria-label="发送消息"]'));
  assert.equal(view.sent.length, 1);
  assert.equal(view.sent[0][4], 'off');
});

test('reset explicitly selects an allowed default for an off-only runtime model', async t => {
  const view = await fixture(t, 'ultra', {selectedModel:{id:'relay/grok-4.7',provider:'relay',model:'grok-4.7',configured:true,thinkingLevels:['off']}});
  await view.render(); await view.click(view.trigger());
  const reset = view.container.querySelector('.thinking-level-reset');
  assert.equal(reset.disabled, false);
  assert.match(reset.title, /关闭/);
  await view.click(reset);
  assert.equal(view.trigger().getAttribute('aria-label'), '思考强度：关闭');
  assert.equal(view.sent.length, 0);
  assert.equal(view.storage.values.get(KEY), 'off');
});

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
  await view.click(view.trigger()); await view.choose('ultra');
  assert.equal(view.storage.values.get(KEY), 'ultra');
  assert.deepEqual(view.storage.writes.filter(([key]) => key === KEY), [[KEY, 'ultra']]);
});

test('strength selection survives navigation/reload and sends the exact level as the fifth argument', async t => {
  const view = await fixture(t); await view.render(); await view.click(view.trigger());
  assert.equal(view.container.querySelector('select'), null, 'no native select is exposed');
  assert.equal(view.container.querySelector('[role=listbox]'), null, 'strength is a slider rather than a disguised listbox');
  await view.choose('xhigh'); assert.ok(view.menu(), 'sliding keeps the compact popup open');
  await view.navigate(); await view.reload();
  assert.equal(view.trigger().getAttribute('aria-label'), '思考强度：极高');
  await view.type('需要深度核查'); await view.click(view.container.querySelector('[aria-label=发送消息]'));
  assert.deepEqual(view.sent[0], ['需要深度核查', [], [], {}, 'xhigh']);
});

test('keyboard slider saves arrows/Home/End immediately, clamps at the endpoints and returns focus on Enter or Escape', async t => {
  const view = await fixture(t, 'high'); await view.render(); view.trigger().focus();
  assert.equal((await view.key(view.trigger(), 'ArrowDown')).defaultPrevented, true);
  assert.equal(document.activeElement, view.slider());
  assert.equal(view.slider().getAttribute('aria-valuetext'), '高');
  await view.key(view.slider(), 'ArrowRight'); assert.equal(view.storage.values.get(KEY), 'xhigh');
  await view.key(view.slider(), 'Home'); assert.equal(view.storage.values.get(KEY), 'off');
  await view.key(view.slider(), 'ArrowLeft'); assert.equal(view.slider().value, '0');
  await view.key(view.slider(), 'End'); assert.equal(view.storage.values.get(KEY), 'ultra');
  await view.key(view.slider(), 'ArrowRight'); assert.equal(view.slider().value, '7');
  await view.key(view.slider(), 'Enter'); assert.equal(view.menu(), null);
  assert.equal(document.activeElement, view.trigger()); assert.equal(view.storage.values.get(KEY), 'ultra');
  await view.key(view.trigger(), ' '); await view.key(view.slider(), 'ArrowLeft');
  await view.key(view.slider(), 'Escape'); assert.equal(view.menu(), null);
  assert.equal(document.activeElement, view.trigger()); assert.equal(view.storage.values.get(KEY), 'max', 'Escape retains the last explicit slider choice');
});

test('Tab and Shift+Tab are not intercepted; menu closes only after default focus leaves it', async t => {
  const view = await fixture(t); await view.render();
  for (const shiftKey of [false, true]) {
    await view.click(view.trigger()); assert.equal(document.activeElement, view.slider());
    const event = await view.key(view.slider(), 'Tab', { shiftKey });
    assert.equal(event.defaultPrevented, false); assert.ok(view.menu(), 'popup remains during default Tab navigation');
    await act(async () => view.container.querySelector('textarea').focus());
    assert.equal(view.menu(), null); assert.equal(document.activeElement, view.container.querySelector('textarea'));
  }
});

test('streaming keeps next-message controls available; stopping closes the popup and rejects stale interactions', async t => {
  const view = await fixture(t, 'low'); await view.render();
  await view.render({ isStreaming: true }); await view.click(view.trigger());
  assert.ok(view.menu()); assert.equal(view.trigger().disabled, false);
  await view.click(view.trigger());
  for (const patch of [{ stopping: true }]) {
    await view.render({ isStreaming: false, stopping: false }); await view.click(view.trigger());
    const stale = view.slider(), staleReset = view.container.querySelector('.thinking-level-reset'); await view.render(patch);
    assert.equal(view.menu(), null); assert.equal(view.trigger().disabled, true);
    assert.equal(view.trigger().getAttribute('aria-expanded'), 'false'); await view.choose('max', stale); await view.click(staleReset);
    assert.equal(view.storage.values.get(KEY), 'low');
    await view.render({ isStreaming: false, stopping: false }); assert.equal(view.menu(), null);
  }
});

test('outside pointer closes menu without changing the current strength', async t => {
  const view = await fixture(t, 'adaptive'); await view.render(); await view.click(view.trigger());
  await act(async () => document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true })));
  assert.equal(view.menu(), null); assert.equal(view.storage.values.get(KEY), 'adaptive');
});

test('eight strength stops and a separate adaptive button persist all nine values', async t => {
  const view = await fixture(t); await view.render(); await view.click(view.trigger());
  assert.equal(view.slider().min, '0'); assert.equal(view.slider().max, String(THINKING_LEVELS.length - 2)); assert.equal(view.slider().step, '1');
  for (const level of THINKING_LEVELS) {
    await view.choose(level);
    assert.equal(view.storage.values.get(KEY), level);
    if (level === 'adaptive') assert.equal(view.container.querySelector('.thinking-level-adaptive').getAttribute('aria-pressed'), 'true');
    else assert.equal(view.slider().value, String(THINKING_LEVELS.filter(value => value !== 'adaptive').indexOf(level)));
    assert.match(view.trigger().getAttribute('aria-label'), /^思考强度：/);
  }
  await view.click(view.container.querySelector('.thinking-level-reset'));
  assert.equal(view.storage.values.get(KEY), 'medium');
  assert.equal(view.slider().getAttribute('aria-valuetext'), '中');
  assert.equal(view.container.querySelector('.thinking-level-reset').disabled, true);
  assert.equal(document.activeElement, view.slider());
});

test('the compact popup identifies the selected configured model without claiming it has run', async t => {
  const selectedModel = { id: 'relay/actual-v2', provider: 'relay', model: 'actual-v2', configured: true, label: '实际模型' };
  const view = await fixture(t, 'high', { selectedModel }); await view.render(); await view.click(view.trigger());
  assert.equal(view.menu().querySelector('.thinking-level-model > span').textContent, selectedModel.model);
  assert.equal(view.menu().querySelector('.thinking-level-model > span').title, '所选模型：actual-v2');
  assert.match(view.menu().querySelector('.inline-info').textContent, /能力信息尚未提供/);
  assert.equal(view.menu().querySelectorAll('[role=option]').length, 0);
  assert.equal(view.sent.length, 0);
});

test('session configuration has an honest model fallback and contains no invented model name', async t => {
  const view = await fixture(t); await view.render(); await view.click(view.trigger());
  assert.equal(view.menu().querySelector('.thinking-level-model > span').textContent, '沿用会话模型');
  assert.equal(view.menu().querySelector('.thinking-level-heading strong').textContent, '中');
});

test('narrow-screen style permits wrapped tools and anchors the bounded popup to the tool row', () => {
  const style = fs.readFileSync(new URL('../src/styles/chat-composer.css', import.meta.url), 'utf8') + fs.readFileSync(new URL('../src/styles/thinking-level-picker.css', import.meta.url), 'utf8');
  assert.match(style, /\.composer-tools\s*\{[^}]*flex-wrap:wrap[^}]*min-width:0[^}]*position:relative/s);
  assert.match(style, /\.thinking-level-menu\s*\{[^}]*max-width:min\(260px, calc\(100vw - 28px\)\)[^}]*box-sizing:border-box/s);
  assert.match(style, /\.thinking-level-picker\s*\{\s*position:relative/s);
});
