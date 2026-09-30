import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// Actual components and API decoding in a simulated DOM with synthetic HTTP
// responses. These checks do not claim a browser or real gateway was exercised.
globalThis.window = new Window({ url: 'https://easel.test/workbench/index.html' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: Controls } = await loadTsModule('../src/components/agent-office/OfficeAgentControls.tsx', import.meta.url);
const { decodeOfficeControls, fetchOfficeControls, saveOfficeAgentModel, stopOfficeAgent } = await loadTsModule('../src/lib/officeControls.ts', import.meta.url);
const identity = { sessionId: 'session-a', turnId: 'turn-a', agentId: 'child-a' };
const agent = { id: identity.agentId, parentId: 'root:session-a', name: 'Agent', role: '协作', task: '检查', source: 'live', state: 'working' };
const options = [
  { id: 'configured/old', provider: 'configured', model: 'old', label: '原模型', configured: true },
  { id: 'configured/new', provider: 'configured', model: 'new', label: '新模型', configured: true },
  { id: 'configured/missing', provider: 'configured', model: 'missing', label: '不可用模型', configured: false },
  { id: 'other/model', provider: 'other', model: 'model', label: '另一渠道模型', configured: true },
  { id: 'unconfigured/model', provider: 'unconfigured', model: 'model', label: '未配置渠道', configured: false },
];
function capability(expected = identity) {
  return { ...expected, model: { available: true, scope: 'next_turn', currentModelRef: 'configured/old', options, reason: '' },
    stop: { available: true, scope: 'agent', reason: '' } };
}
function response(value, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => value }; }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(t, props = {}) {
  const h = { requests: [], changes: 0, controls: capability(), get: null,
    post: async (_url, body) => response({ ...body, confirmed: true, applied: true, scope: 'agent' }) };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    h.requests.push({ url, ...init, body });
    return init.method === 'POST' ? h.post(url, body) : h.get ? h.get(url) : response(h.controls);
  });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  let mounted = true;
  let current = { agent, sessionId: identity.sessionId, turnId: identity.turnId, stale: false, onChanged: () => h.changes++, ...props };
  const render = async (patch = {}) => { current = { ...current, ...patch }; await act(async () => root.render(createElement(Controls, current))); };
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); } };
  t.after(async () => { await unmount(); container.remove(); });
  const select = label => document.getElementById([...container.querySelectorAll('label')].find(item => item.textContent === label).htmlFor);
  return { h, container, render, unmount, select,
    button: label => [...container.querySelectorAll('button')].find(item => item.textContent === label),
    click: async element => act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))),
    async choose(label, value) {
      await act(async () => { const field = select(label); field.value = value; field.dispatchEvent(new window.Event('change', { bubbles: true })); });
    },
  };
}

test('capabilities and both mutation receipts reject each foreign or missing identity coordinate', async t => {
  let payload;
  t.mock.method(globalThis, 'fetch', async () => response(payload));
  for (const key of ['sessionId', 'turnId', 'agentId']) {
    for (const invalid of ['foreign', undefined]) {
      payload = { ...capability(), [key]: invalid, applied: true, confirmed: true, modelRef: 'configured/new', scope: 'agent' };
      assert.throws(() => decodeOfficeControls(payload, identity), /不属于当前会话、轮次或 Agent/);
      await assert.rejects(fetchOfficeControls(identity, new AbortController().signal), /不属于当前/);
      await assert.rejects(saveOfficeAgentModel(identity, 'configured/new', new AbortController().signal), /不属于当前/);
      await assert.rejects(stopOfficeAgent(identity, new AbortController().signal), /不属于当前/);
    }
  }
});

test('subsequent-call capability and matching receipt preserve scope without a current-run guarantee', async t => {
  const view = await fixture(t, { agent: { ...agent, state: 'done' } });
  view.h.controls.model.scope = 'subsequent_calls';
  const decoded = decodeOfficeControls(view.h.controls, identity);
  assert.equal(decoded.model.scope, 'subsequent_calls'); assert.equal(decoded.model.available, true);
  view.h.post = async (_url, body) => response({ ...body, applied: true, scope: 'subsequent_calls' });
  await view.render();
  assert.match(view.container.textContent, /保存到该 Agent 会话，后续模型调用使用所选渠道；不会重新运行已完成任务/);
  assert.doesNotMatch(view.container.textContent, /当前运行中的模型不变/);
  await view.choose('使用模型', 'configured/new'); await view.click(view.button('保存模型分配'));
  assert.match(view.container.textContent, /模型分配已保存并确认/);
  assert.match(view.container.querySelector('.office-control-message').textContent, /后续模型调用使用所选渠道/);
  assert.doesNotMatch(view.container.textContent, /当前运行中的模型不变/);
  assert.equal(view.h.changes, 1);
});

test('HTTP failures never accept success-shaped receipts, and non-JSON failures retain useful context', async t => {
  let reply = response({ ...identity, confirmed: true, applied: true, scope: 'agent', modelRef: 'configured/new', detail: '网关未确认' }, 503);
  t.mock.method(globalThis, 'fetch', async () => reply);
  await assert.rejects(stopOfficeAgent(identity, new AbortController().signal), /网关未确认/);
  await assert.rejects(saveOfficeAgentModel(identity, 'configured/new', new AbortController().signal), /网关未确认/);
  reply = { ok: false, status: 502, json: async () => { throw new SyntaxError('HTML error page'); } };
  await assert.rejects(stopOfficeAgent(identity, new AbortController().signal), /HTTP 502/);
  reply = { ...reply, ok: true, status: 200 };
  await assert.rejects(stopOfficeAgent(identity, new AbortController().signal), /操作尚未确认/);
});

test('a request canceled before dispatch never reaches the mutation endpoint', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => response({ ...identity, confirmed: true, scope: 'agent' }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(stopOfficeAgent(identity, controller.signal), { name: 'AbortError' });
  assert.equal(fetch.mock.callCount(), 0);
});

test('a mutation timeout aborts transport and reports an unconfirmed result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let transportSignal;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    transportSignal = init.signal;
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  });
  const result = stopOfficeAgent(identity, new AbortController().signal);
  const rejected = assert.rejects(result, /请求超时，结果尚未确认/);
  t.mock.timers.tick(12000);
  await rejected;
  assert.equal(transportSignal.aborted, true);
});

test('model controls expose configured channels and models only and reset when changing channel', async t => {
  const view = await fixture(t, { agent: { ...agent, state: 'done' } });
  view.h.post = async (_url, body) => response({ ...body, applied: true, scope: 'next_turn' });
  await view.render();
  assert.deepEqual([...view.select('模型渠道').options].map(item => item.value), ['', 'configured', 'other']);
  assert.deepEqual([...view.select('使用模型').options].map(item => item.value), ['', 'configured/old', 'configured/new']);
  await view.choose('使用模型', 'configured/new'); assert.equal(view.button('保存模型分配').disabled, false);
  await view.choose('模型渠道', 'other');
  assert.equal(view.select('使用模型').value, ''); assert.equal(view.button('保存模型分配').disabled, true);
  await view.choose('使用模型', 'other/model'); await view.click(view.button('保存模型分配'));
  const post = view.h.requests.find(item => item.method === 'POST');
  assert.equal(post.url, '/workbench/api/agent-office/model');
  assert.deepEqual(post.body, { ...identity, modelRef: 'other/model' });
  assert.match(view.container.textContent, /模型分配已保存并确认/);
});

test('a stale snapshot disables model saving and stopping even when capabilities were available', async t => {
  const view = await fixture(t);
  await view.render(); await view.choose('使用模型', 'configured/new'); await view.render({ stale: true });
  assert.equal(view.select('模型渠道').disabled, true); assert.equal(view.select('使用模型').disabled, true);
  assert.equal(view.button('保存模型分配').disabled, true); assert.equal(view.button('停止此 Agent').disabled, true);
  await view.click(view.button('保存模型分配')); await view.click(view.button('停止此 Agent'));
  assert.equal(view.h.requests.filter(item => item.method === 'POST').length, 0);
});

test('natural lifecycle changes refresh capabilities and lock controls until the new capability arrives', async t => {
  const view = await fixture(t);
  view.h.controls.model.available = false; view.h.controls.model.reason = '请先停止该 Agent';
  await view.render(); assert.equal(view.button('保存模型分配'), undefined);
  const pending = deferred(); view.h.get = () => pending.promise;
  await view.render({ agent: { ...agent, state: 'done' } });
  assert.equal(view.h.requests.filter(item => item.method === 'GET').length, 2);
  assert.match(view.container.textContent, /正在核验可用控制/);
  assert.equal(view.button('停止此 Agent').disabled, true);
  await act(async () => pending.resolve(response({ ...capability(), stop: { available: false, scope: 'agent', reason: '已结束' } })));
  assert.ok(view.button('保存模型分配')); assert.equal(view.select('模型渠道').disabled, false);
});

test('two clicks in the same React batch dispatch only one stop; a confirmed stop blocks repeats', async t => {
  const view = await fixture(t); const pending = deferred(); view.h.post = () => pending.promise;
  await view.render(); const button = view.button('停止此 Agent');
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(view.h.requests.filter(item => item.method === 'POST').length, 1);
  assert.equal(view.button('等待后台确认…').disabled, true);
  await act(async () => pending.resolve(response({ ...identity, confirmed: true, scope: 'agent' })));
  await view.click(view.button('停止此 Agent'));
  assert.equal(view.h.requests.filter(item => item.method === 'POST').length, 1);
  assert.equal(view.h.changes, 1); assert.match(view.container.textContent, /后台已确认该 Agent 停止/);
});

test('HTTP and identity failures show an error without reporting a successful stop', async t => {
  const view = await fixture(t); await view.render();
  for (const reply of [response({ ...identity, confirmed: true, scope: 'agent' }, 503),
    response({ ...identity, turnId: 'another-turn', confirmed: true, scope: 'agent' })]) {
    view.h.post = async () => reply; await view.click(view.button('停止此 Agent'));
    assert.ok(view.container.querySelector('[role="alert"]'));
    assert.doesNotMatch(view.container.textContent, /后台已确认该 Agent 停止/);
    assert.equal(view.button('停止此 Agent').disabled, false);
  }
  assert.equal(view.h.changes, 0);
});

test('a child cannot submit a session-wide stop even when the capability advertises it', async t => {
  const view = await fixture(t); view.h.controls.stop.scope = 'session'; await view.render();
  assert.match(view.container.textContent, /不能作为该员工的独立停止/);
  assert.equal(view.button('停止此 Agent').disabled, true); await view.click(view.button('停止此 Agent'));
  assert.equal(view.h.requests.filter(item => item.method === 'POST').length, 0);
});

test('switching the session or turn aborts pending mutation and ignores its late confirmation', async t => {
  for (const key of ['sessionId', 'turnId']) {
    const view = await fixture(t); const pending = deferred(); view.h.post = () => pending.promise;
    await view.render(); await view.click(view.button('停止此 Agent'));
    const post = view.h.requests.find(item => item.method === 'POST');
    view.h.controls = capability({ ...identity, [key]: 'next-value' });
    await view.render({ [key]: 'next-value' }); assert.equal(post.signal.aborted, true);
    await act(async () => pending.resolve(response({ ...identity, confirmed: true, scope: 'agent' })));
    assert.equal(view.h.changes, 0); assert.doesNotMatch(view.container.textContent, /后台已确认该 Agent 停止/);
    await view.unmount();
  }
});

test('navigating to model settings during a pending save aborts it on unmount and suppresses the late receipt', async t => {
  let navigated = 0;
  const view = await fixture(t, { agent: { ...agent, state: 'done' }, onOpenModelSettings: () => navigated++ });
  const pending = deferred(); view.h.post = () => pending.promise;
  await view.render(); await view.choose('使用模型', 'configured/new'); await view.click(view.button('保存模型分配'));
  const post = view.h.requests.find(item => item.method === 'POST');
  await view.click(view.button('管理模型渠道 ↗')); assert.equal(navigated, 1);
  await view.unmount(); assert.equal(post.signal.aborted, true);
  await act(async () => pending.resolve(response({ ...identity, applied: true, modelRef: 'configured/new', scope: 'next_turn' })));
  assert.equal(view.h.changes, 0); assert.equal(view.container.textContent, '');
});

test('unmounting during capability loading aborts the GET without triggering updates', async t => {
  const view = await fixture(t); const pending = deferred(); view.h.get = () => pending.promise;
  await view.render(); const get = view.h.requests[0]; await view.unmount();
  assert.equal(get.signal.aborted, true);
  await act(async () => pending.resolve(response(capability())));
  assert.equal(view.h.changes, 0); assert.equal(view.container.textContent, '');
});

test.after(() => window.close());
