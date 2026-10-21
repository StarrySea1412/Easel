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
const option = { id: REF, provider: 'relay', model: 'vendor/model:v2', label: '实际模型', configured: true, channelName: 'happy' };

async function fixture(t, saved) {
  const values = new Map(saved ? [[KEY, saved]] : []), writes = [], calls = [], sent = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); writes.push([key, value]); }, removeItem: key => values.delete(key) } });
  const h = { options: [option, { ...option, id: 'relay/unconfigured', model: 'unconfigured', configured: false }], capability: true, healthState: 'success', reason: '' };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push([url, init]); const data = String(url).includes('/agent-office/models') ? { available: h.capability, scope: 'next_turn', defaultModelRef: REF, options: h.options, ...(h.reason ? { reason: h.reason } : {}) }
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
  return { h, container, calls, writes, values, sent, render, unmount, trigger: () => container.querySelector('[aria-label="选择模型"]'),
    async reload() { await act(async () => root.render(null)); await render(); },
    async navigate() { sessionId += '-new'; await render(); },
    async key(key) { const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }); await act(async () => this.trigger().dispatchEvent(event)); return event; },
    async type(text) { const input = container.querySelector('textarea'); await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, text); input.dispatchEvent(new window.Event('input', { bubbles: true })); }); },
    async send() { await act(async () => container.querySelector('[aria-label="发送消息"]').click()); },
  };
}

test('configured complete models are keyboard selectable, stored explicitly and sent as sixth argument', async t => {
  const view = await fixture(t, REF); await view.render(); assert.deepEqual(view.writes.filter(([key]) => key === KEY), []);
  view.trigger().focus(); await view.key('ArrowDown');
  assert.equal(document.querySelectorAll('.easel-select-options [role=option]').length, 1, 'only current channel model');
  await view.key('Enter');
  assert.equal(view.values.get(KEY), REF); assert.match(view.container.textContent, /渠道已连通/);
  await view.navigate(); await view.reload(); await view.type('完整路由任务'); await view.send();
  assert.deepEqual(view.sent[0], ['完整路由任务', [], [], {}, undefined, REF]);
  assert.ok(view.calls.every(([, init]) => !init?.body), 'mount and selection only read backend state');
});

test('removed saved model preserves draft until user chooses an available model', async t => {
  const view = await fixture(t, 'old/missing'); await view.render(); await view.type('不应被自动换模型'); await view.send();
  assert.deepEqual(view.sent, []); assert.match(view.container.querySelector('[role=alert]').textContent, /草稿已保留/); assert.equal(view.values.get(KEY), 'old/missing');
  await view.key('Home'); await view.key('Enter'); await view.send();
  assert.equal(view.sent[0][5], REF); assert.equal(view.sent[0][0], '不应被自动换模型'); assert.equal(view.values.get(KEY), REF);
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
  view.h.healthState = 'failed'; await act(async () => timer.callback());
  assert.match(view.container.querySelector('.composer-model-health-label').textContent, /失败/);
  assert.ok(view.trigger().querySelector('.composer-model-health.failed'));
  assert.ok(view.calls.every(([, init]) => !init?.body), 'status refresh never probes a model');
  await view.unmount(); assert.equal(timer.cleared, true);
  const count = view.calls.length; await act(async () => timer.callback()); assert.equal(view.calls.length, count);
});

test('unconfigured model entry opens settings directly without a separate warning row or probe', async t => {
  const view = await fixture(t); view.h.capability = false; let opened = 0;
  view.h.options = [];
  await view.render({ onOpenModels: () => { opened++; } });
  assert.equal(view.container.querySelector('.composer-model-warning'), null);
  const button = view.container.querySelector('[aria-label="模型设置"]');
  assert.ok(button); await act(async () => button.click()); assert.equal(opened, 1);
  assert.equal(view.values.get(KEY), undefined);
  assert.ok(view.calls.every(([, init]) => !init?.body), 'guidance does not save or probe models');
});

test('disabled configured models remain visible but cannot be selected or sent', async t => {
  const view=await fixture(t, REF);view.h.options=[{...option,enabled:false}];
  await view.render();await view.type('保留任务草稿');await view.send();
  assert.deepEqual(view.sent,[]);
  await act(async()=>view.trigger().click());
  const item=[...document.querySelectorAll('[role=option]')].find(item=>item.textContent.includes('已停用'));
  assert.ok(item);assert.equal(item.getAttribute('aria-disabled'),'true');
  await act(async()=>item.click());assert.equal(view.values.get(KEY),REF);
  assert.ok(view.calls.every(([,init])=>!init?.body));
});

test('status belongs to the model selector and its settings action targets that model', async t => {
  const view = await fixture(t, REF), opened=[];
  await view.render({ onOpenModels: ref => opened.push(ref) });
  assert.ok(view.trigger().querySelector('.composer-model-health'));
  assert.equal(view.container.querySelector('button.composer-model-health'), null);
  assert.match(document.getElementById(view.trigger().getAttribute('aria-describedby')).textContent, /happy · 渠道已连通/);
  await act(async () => view.trigger().click());
  assert.doesNotMatch(document.querySelector('.easel-select-popup').textContent, /渠道状态与详情/);
  await act(async () => document.querySelector('.easel-select-footer [role=option]').click());
  await act(async () => [...document.querySelectorAll('[role=menuitem]')].find(item => item.textContent.includes('模型设置')).click());
  assert.deepEqual(opened, [REF]);
  assert.equal(document.querySelector('[aria-label="渠道状态详情"]'), null);
  assert.ok(view.calls.every(([, init]) => !init?.body));
});

test('model menu shows current channel only and opens enabled channels from the management footer', async t => {
  const view=await fixture(t, REF),opened=[];
  view.h.options=[option,{...option,id:'other/vendor/model:v2',provider:'other',channelName:'另一渠道'},{...option,id:'relay/second',model:'second'},{...option,id:'disabled/model',provider:'disabled',channelName:'关闭渠道',enabled:false}];
  await view.render({onOpenModels:ref=>opened.push(ref)});
  await act(async()=>view.trigger().click());
  const popup=document.querySelector('.easel-select-popup');
  assert.deepEqual([...popup.querySelectorAll('.easel-select-options .easel-select-option-label')].map(e=>e.textContent),['vendor/model:v2','second']);
  assert.equal(popup.querySelectorAll('.easel-select-group-label').length,1);
  assert.doesNotMatch(popup.textContent,/仅用于本轮|自动沿用|渠道 .* ·/);
  const footer=popup.querySelector('.easel-select-footer [role=option]');
  assert.equal(footer.textContent,'管理模型›');
  await act(async()=>footer.dispatchEvent(new window.Event('pointermove',{bubbles:true})));
  assert.deepEqual([...document.querySelectorAll('[role=menuitem]')].map(e=>e.textContent),['happy✓','另一渠道','模型设置']);
  await act(async()=>[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent==='另一渠道').click());
  assert.equal(view.values.get(KEY),'other/vendor/model:v2');
  assert.equal(document.querySelector('[role=menu]'),null);
  assert.equal(document.querySelectorAll('.easel-select-group-label').length,1);
  assert.equal(document.querySelector('.easel-select-group-label').textContent,'另一渠道');
  assert.deepEqual([...document.querySelectorAll('.easel-select-options .easel-select-option-label')].map(e=>e.textContent),['vendor/model:v2']);
  await view.key('End'); await view.key('ArrowRight'); await view.key('End'); await view.key('Enter');
  assert.deepEqual(opened,['other/vendor/model:v2']);
  assert.equal(document.querySelector('.easel-select-popup'),null);
  assert.ok(view.calls.every(([,init])=>!init?.body));
});

test('default channel models are shown without saving a forced override, and channel selection works by keyboard', async t => {
  const view=await fixture(t);
  view.h.options=[{...option,id:'other/model',provider:'other',model:'model',channelName:'另一渠道'},option];
  await view.render();
  assert.match(view.trigger().textContent,/happy/);
  assert.equal(view.values.has(KEY),false);
  await view.key('ArrowDown');
  assert.equal(document.querySelector('.easel-select-group-label').textContent,'happy');
  await view.key('End'); await view.key('ArrowRight'); await view.key('Home'); await view.key('Enter');
  assert.equal(view.values.get(KEY),'other/model');
  await view.key('Escape');
  assert.equal(document.querySelector('.easel-select-popup'),null);
});

test('a passed channel test stays green and the menu names the real blocker instead of asking to check the connection', async t => {
  const view = await fixture(t, REF);
  view.h.capability = false; view.h.healthState = 'success';
  view.h.reason = '运行网关当前未连接，暂时无法核验本轮指定模型；改用「自动沿用」仍可发送。';
  await view.render();
  assert.ok(view.trigger().querySelector('.composer-model-health.success'), 'a passed inference is success, not unverified');
  const info = view.container.querySelector('[aria-label="模型状态详情"]');
  assert.ok(info); assert.match(info.getAttribute('title'), /运行网关当前未连接/);
  await act(async () => view.trigger().click());
  const popup = document.querySelector('.easel-select-popup'); assert.ok(popup);
  assert.doesNotMatch(popup.textContent, /请在模型设置中检查连接/);
  assert.doesNotMatch(popup.textContent, /自动沿用|仅用于本轮|推理未测/);
  assert.ok(view.calls.every(([, init]) => !init?.body), 'guidance never probes a model');
});

test('unavailable runtime permits saving a channel choice but never silently sends with another model', async t => {
  const view=await fixture(t, REF);
  view.h.capability=false;
  view.h.options=[option,{...option,id:'other/model',provider:'other',model:'model',channelName:'另一渠道'}];
  await view.render();
  await view.key('End'); await view.key('ArrowRight'); await view.key('ArrowDown'); await view.key('Enter');
  assert.equal(view.values.get(KEY),'other/model');
  await view.key('Escape'); await view.type('保留指定渠道'); await view.send();
  assert.deepEqual(view.sent,[]);
  assert.match(view.container.querySelector('[role=alert]').textContent,/草稿已保留/);
  assert.ok(view.calls.every(([,init])=>!init?.body));
});

test('running composer keeps stop beside queue-send when a draft is present', async t => {
  const view = await fixture(t, REF); await view.render({ isStreaming: true });
  const actions = () => [...view.container.querySelectorAll('.composer-send-actions button')];
  assert.equal(actions().length, 1); assert.equal(actions()[0].getAttribute('aria-label'), '停止生成');
  await view.type('下一条独立消息');
  assert.equal(actions().length, 2); assert.equal(actions()[0].getAttribute('aria-label'), '停止生成');
  assert.equal(actions()[1].getAttribute('aria-label'), '排队发送');
  await act(async () => actions()[1].click());
  assert.equal(actions().length, 1); assert.equal(actions()[0].getAttribute('aria-label'), '停止生成');
  await view.type('停止中保留草稿'); await view.render({ stopping: true });
  assert.equal(actions().length, 2); assert.ok(actions().every(button => button.disabled));
});
