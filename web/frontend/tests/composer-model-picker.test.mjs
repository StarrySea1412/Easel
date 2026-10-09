import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement, StrictMode } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://easel.test/' }).window;
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
const { createRoot } = await import('react-dom/client');
const { default: Composer } = await loadTsModule('../src/components/ChatComposer.tsx', import.meta.url);
const KEY = 'easel_chat_model_ref'; const REF = 'relay/vendor/model:v2'; let sequence = 0;
const option = { id: REF, provider: 'relay', model: 'vendor/model:v2', label: '实际模型', configured: true };

async function fixture(t, saved) {
  const values = new Map(saved ? [[KEY, saved]] : []), writes = [], calls = [], sent = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); writes.push([key, value]); }, removeItem: key => values.delete(key) } });
  const h = { options: [option, { ...option, id: 'relay/unconfigured', model: 'unconfigured', configured: false }], capability: true, healthState: 'success' };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push([url, init]); const data = String(url).includes('/agent-office/models') ? { available: h.capability, scope: 'next_turn', options: h.options }
      : String(url).endsWith('/models/health') ? { results: [{ modelRef: REF, mode: 'text', state: h.healthState }], schedules: [] }
        : String(url).includes('/models/connection?') ? { modelRef: REF, state: h.healthState, channelName: '测试渠道', detail: '仅获取模型列表，推理未测。' }
        : url === '/api/upload/limits' ? { max_mb: 50 } : [];
    return { ok: true, json: async () => data };
  });
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  let sessionId = `model-picker-${++sequence}`, props = {};
  const render = async patch => { props = { ...props, ...patch }; await act(async () => root.render(createElement(StrictMode, null, createElement(Composer, { sessionId, isStreaming: false, onStop() {}, onSend: (...args) => { sent.push(args); return true; }, ...props })))); };
  let mounted = true;
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); container.remove(); } };
  t.after(unmount);
  return { h, container, calls, writes, values, sent, render, unmount, trigger: () => container.querySelector('[aria-label="本轮使用模型"]'),
    async reload() { await act(async () => root.render(null)); await render(); },
    async navigate() { sessionId += '-new'; await render(); },
    async key(key) { const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }); await act(async () => this.trigger().dispatchEvent(event)); return event; },
    async type(text) { const input = container.querySelector('textarea'); await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, text); input.dispatchEvent(new window.Event('input', { bubbles: true })); }); },
    async send() { await act(async () => container.querySelector('[aria-label="发送消息"]').click()); },
  };
}

test('configured complete models are keyboard selectable, stored explicitly and sent as sixth argument', async t => {
  const view = await fixture(t); await view.render(); assert.deepEqual(view.writes.filter(([key]) => key === KEY), []);
  view.trigger().focus(); await view.key('ArrowDown');
  assert.equal(document.querySelectorAll('.easel-select-option').length, 2, 'default and configured only');
  await view.key('ArrowDown'); await view.key('Enter');
  assert.equal(view.values.get(KEY), REF); assert.match(view.container.textContent, /渠道已连通/);
  await view.navigate(); await view.reload(); await view.type('完整路由任务'); await view.send();
  assert.deepEqual(view.sent[0], ['完整路由任务', [], [], {}, 'medium', REF]);
  assert.ok(view.calls.every(([, init]) => !init?.body), 'mount and selection only read backend state');
});

test('removed saved model preserves draft until user explicitly restores session configuration', async t => {
  const view = await fixture(t, 'old/missing'); await view.render(); await view.type('不应被自动换模型'); await view.send();
  assert.deepEqual(view.sent, []); assert.match(view.container.querySelector('[role=alert]').textContent, /草稿已保留/); assert.equal(view.values.get(KEY), 'old/missing');
  await view.key('Home'); await view.key('Enter'); await view.send();
  assert.equal(view.sent[0].length, 5); assert.equal(view.sent[0][0], '不应被自动换模型'); assert.equal(view.values.get(KEY), '');
});

test('streaming allows next-message model selection; stopping locks selector without changing preference', async t => {
  const view = await fixture(t, REF); await view.render(); await view.key('ArrowDown'); assert.ok(document.querySelector('.easel-select-popup'));
  await view.render({ isStreaming: true }); assert.equal(view.trigger().disabled, false);
  await view.render({ isStreaming: true, stopping: true }); assert.equal(view.trigger().disabled, true); assert.equal(document.querySelector('.easel-select-popup'), null);
  await view.key('Home'); assert.equal(view.values.get(KEY), REF);
});

test('composer reads channel models by GET, refreshes status and stops reads after unmount', async t => {
  const timers = [];
  t.mock.method(globalThis, 'setInterval', (callback, delay) => { const timer = { callback, delay, cleared: false }; timers.push(timer); return timer; });
  t.mock.method(globalThis, 'clearInterval', timer => { timer.cleared = true; });
  const view = await fixture(t, REF); await view.render(); assert.match(view.container.textContent, /渠道已连通/);
  const timer = timers.find(item => !item.cleared); assert.ok(timer); assert.equal(timer.delay, 60000);
  view.h.healthState = 'failed'; await act(async () => timer.callback()); assert.match(view.container.querySelector('.composer-model-health').getAttribute('aria-label'), /失败/);
  assert.ok(view.calls.every(([, init]) => !init?.body), 'status refresh never probes a model');
  await view.unmount(); assert.equal(timer.cleared, true);
  const count = view.calls.length; await act(async () => timer.callback()); assert.equal(view.calls.length, count);
});

test('unavailable model choices explain the next step even without a saved override', async t => {
  const view = await fixture(t); view.h.capability = false; let opened = 0;
  await view.render({ onOpenModels: () => { opened++; } });
  assert.match(view.container.querySelector('[role=status]').textContent, /重新读取/);
  const button = [...view.container.querySelectorAll('button')].find(item => item.textContent === '配置模型');
  assert.ok(button); await act(async () => button.click()); assert.equal(opened, 1);
  await view.key('ArrowDown');
  assert.equal(document.querySelectorAll('.easel-select-option[aria-disabled=true]').length, 1);
  assert.equal(view.values.get(KEY), undefined);
  assert.ok(view.calls.every(([, init]) => !init?.body), 'guidance does not save or probe models');
});

test('channel details open only on click, omit duplicate native tooltip and close with Escape', async t => {
  const view = await fixture(t, REF); await view.render();
  const trigger = view.container.querySelector('.composer-model-health');
  assert.equal(trigger.hasAttribute('title'), false); assert.equal(trigger.hasAttribute('data-tooltip'), false);
  await act(async () => trigger.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })));
  assert.equal(document.querySelector('.composer-channel-popover'), null);
  await act(async () => trigger.click());
  const panel = document.querySelector('[role=dialog][aria-label="渠道状态详情"]');
  assert.match(panel.textContent, /测试渠道/); assert.match(panel.textContent, /推理未测/);
  assert.ok(parseFloat(panel.style.left) >= 12);
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(document.querySelector('.composer-channel-popover'), null);
});

test('running composer has one primary action and switches from stop to queue then back', async t => {
  const view = await fixture(t, REF); await view.render({ isStreaming: true });
  const actions = () => [...view.container.querySelectorAll('.composer-send-actions button')];
  assert.equal(actions().length, 1); assert.equal(actions()[0].getAttribute('aria-label'), '停止生成');
  await view.type('下一条独立消息');
  assert.equal(actions().length, 1); assert.equal(actions()[0].getAttribute('aria-label'), '排队发送');
  await act(async () => actions()[0].click());
  assert.equal(actions().length, 1); assert.equal(actions()[0].getAttribute('aria-label'), '停止生成');
  await view.type('停止中保留草稿'); await view.render({ stopping: true });
  assert.equal(actions().length, 1); assert.equal(actions()[0].disabled, true);
});
