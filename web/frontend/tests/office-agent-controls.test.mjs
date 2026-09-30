import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// Actual controls and request decoding with a synthetic capability API. These
// checks do not prove a real gateway supports routing or stopping a child run.
globalThis.window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://easel.test/' }).window;
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
const { createRoot } = await import('react-dom/client');
const { default: Controls } = await loadTsModule('../src/components/agent-office/OfficeAgentControls.tsx', import.meta.url);
const { decodeOfficeControls } = await loadTsModule('../src/lib/officeControls.ts', import.meta.url);
const identity = { sessionId: 'session-one', turnId: 'turn-one', agentId: 'child-one' };
const agent = { id: identity.agentId, parentId: 'root:session-one', name: '研究 Agent', role: '协作', task: '研究', source: 'live', state: 'working' };
const options = [
  { id: 'channel-a/old-model', provider: 'channel-a', model: 'old-model', label: '原模型', configured: true },
  { id: 'channel-a/new-model', provider: 'channel-a', model: 'new-model', label: '新模型', configured: true },
  { id: 'channel-b/large-model', provider: 'channel-b', model: 'large-model', label: '另一渠道模型', configured: true },
  { id: 'channel-c/missing', provider: 'channel-c', model: 'missing', label: '缺配置模型', configured: false },
];
function capability(expected = identity) { return { ...expected,
  model: { available: true, scope: 'next_turn', currentModelRef: options[0].id, options, reason: '' },
  stop: { available: true, scope: 'agent', reason: '' },
}; }
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

async function fixture(t, props = {}) {
  const h = { requests: [], changes: 0, opened: 0, controls: capability(),
    get: null, post: async (_path, body) => ({ ...body, applied: false, confirmed: false, scope: 'unavailable', message: '' }) };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    h.requests.push({ url, ...init, body });
    const value = init.method === 'POST' ? await h.post(url, body) : h.get ? await h.get(url) : h.controls;
    return { ok: true, json: async () => value };
  });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  let current = { agent, sessionId: identity.sessionId, turnId: identity.turnId, stale: false,
    onChanged: () => h.changes++, onOpenModelSettings: () => h.opened++, ...props };
  const render = async (patch = {}) => { current = { ...current, ...patch }; await act(async () => root.render(createElement(Controls, current))); };
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  return { h, container, render,
    button: text => [...container.querySelectorAll('button')].find(item => item.textContent === text),
    click: async element => act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))),
    async choose(label, value) {
      const field = [...container.querySelectorAll('label')].find(item => item.textContent === label);
      const select = container.querySelector(`[id="${field.htmlFor}"]`);
      await act(async () => { select.value = value; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
    },
  };
}

test('demo and missing turn identities do not read or mutate backend controls', async t => {
  const view = await fixture(t, { agent: { ...agent, source: 'demo' } });
  await view.render(); assert.equal(view.h.requests.length, 0);
  assert.match(view.container.textContent, /不连接真实模型/);
  await view.render({ agent, turnId: null }); assert.equal(view.h.requests.length, 0);
  assert.match(view.container.textContent, /缺少可核验/);
});

test('unavailable capabilities explain the limitation without an enabled fake stop', async t => {
  const view = await fixture(t);
  view.h.controls = { ...identity, model: { available: false, scope: 'unavailable', options: [], reason: '当前网关不支持独立模型' },
    stop: { available: false, scope: 'unavailable', reason: '当前网关没有单 Agent 停止能力' } };
  await view.render();
  assert.match(view.container.textContent, /当前网关没有单 Agent 停止能力/);
  assert.match(view.container.textContent, /当前网关不支持独立模型/);
  assert.equal(view.button('停止此 Agent').disabled, true);
  assert.equal(view.h.requests.filter(item => item.method === 'POST').length, 0);
  await view.click(view.button('管理模型渠道 ↗')); assert.equal(view.h.opened, 1);
});

test('model selection posts the backend reference and declares only future scope after confirmed application', async t => {
  const view = await fixture(t);
  const pending = deferred(); view.h.post = () => pending.promise;
  await view.render();
  await view.choose('模型渠道', 'channel-b'); await view.choose('使用模型', 'channel-b/large-model');
  await view.click(view.button('保存模型分配'));
  assert.equal(view.button('保存并确认中…').disabled, true);
  const post = view.h.requests.find(item => item.method === 'POST');
  assert.equal(post.url, '/api/agent-office/model');
  assert.deepEqual(post.body, { ...identity, modelRef: 'channel-b/large-model' });
  assert.equal(JSON.stringify(post.body).includes('key'), false);
  view.h.controls.model = { ...view.h.controls.model, currentModelRef: 'channel-b/large-model' };
  await act(async () => pending.resolve({ ...identity, applied: true, modelRef: 'channel-b/large-model', scope: 'next_turn' }));
  assert.match(view.container.textContent, /模型分配已保存并确认/);
  assert.match(view.container.textContent, /当前运行中的模型不变/);
  assert.equal(view.h.changes, 1);
  assert.equal(agent.state, 'working');
});

test('an unconfirmed or different model receipt never reports assignment success', async t => {
  const view = await fixture(t);
  view.h.post = async (_path, body) => ({ ...body, applied: true, modelRef: 'different/model', scope: 'next_turn' });
  await view.render(); await view.choose('使用模型', 'channel-a/new-model');
  await view.click(view.button('保存模型分配'));
  assert.match(view.container.querySelector('[role=alert]').textContent, /尚未确认模型分配/);
  assert.doesNotMatch(view.container.textContent, /模型分配已保存并确认/);
});

test('a child cannot invoke whole-session stop or treat its receipt as independent confirmation', async t => {
  const view = await fixture(t);
  view.h.controls.stop.scope = 'session';
  await view.render();
  assert.equal(view.button('停止此 Agent').disabled, true);
  assert.match(view.container.textContent, /不能作为该员工的独立停止/);
  view.h.controls.stop.scope = 'agent';
  await view.click(view.button('刷新控制状态'));
  view.h.post = async () => ({ ...identity, confirmed: true, scope: 'session' });
  await view.click(view.button('停止此 Agent'));
  assert.match(view.container.querySelector('[role=alert]').textContent, /停止结果尚未确认/);
  assert.doesNotMatch(view.container.textContent, /后台已确认该 Agent 停止/);
});

test('only an exact confirmed stop receipt reports success and locks repeat requests', async t => {
  const view = await fixture(t);
  const pending = deferred(); view.h.post = () => pending.promise;
  await view.render(); await view.click(view.button('停止此 Agent'));
  assert.equal(view.button('等待后台确认…').disabled, true);
  assert.doesNotMatch(view.container.textContent, /后台已确认/);
  await act(async () => pending.resolve({ ...identity, confirmed: true, scope: 'agent' }));
  assert.match(view.container.textContent, /后台已确认该 Agent 停止/);
  assert.equal(view.button('停止此 Agent').disabled, true);
  assert.equal(view.h.requests.filter(item => item.method === 'POST').length, 1);
  assert.equal(view.h.changes, 1);
});

test('accepted but unconfirmed stop leaves the observed state unchanged', async t => {
  const view = await fixture(t);
  view.h.post = async () => ({ ...identity, confirmed: false, scope: 'agent', message: '请求已提交' });
  await view.render(); await view.click(view.button('停止此 Agent'));
  assert.match(view.container.querySelector('[role=alert]').textContent, /停止结果尚未确认/);
  assert.doesNotMatch(view.container.textContent, /后台已确认/);
  assert.equal(agent.state, 'working');
});

test('stale snapshots and terminal agents cannot trigger new execution controls', async t => {
  const view = await fixture(t, { stale: true });
  await view.render();
  assert.equal(view.button('停止此 Agent').disabled, true);
  await view.render({ stale: false, agent: { ...agent, state: 'done' } });
  assert.equal(view.button('停止此 Agent').disabled, true);
  assert.equal(view.h.requests.filter(item => item.method === 'POST').length, 0);
});

test('switching agent ignores a previous stop receipt and aborts its request', async t => {
  const view = await fixture(t);
  const pending = deferred(); view.h.post = () => pending.promise;
  await view.render(); await view.click(view.button('停止此 Agent'));
  const post = view.h.requests.find(item => item.method === 'POST');
  const other = { ...identity, agentId: 'child-two' };
  view.h.controls = capability(other);
  await view.render({ agent: { ...agent, id: other.agentId } });
  assert.equal(post.signal.aborted, true);
  await act(async () => pending.resolve({ ...identity, confirmed: true, scope: 'agent' }));
  assert.doesNotMatch(view.container.textContent, /后台已确认该 Agent 停止/);
  assert.equal(view.h.changes, 0);
});

test('root session stop is explicitly named as a whole-turn action', async t => {
  const root = { ...identity, agentId: 'root:session-one' };
  const view = await fixture(t, { agent: { ...agent, id: root.agentId, parentId: undefined } });
  view.h.controls = capability(root); view.h.controls.stop.scope = 'session';
  view.h.post = async () => ({ ...root, confirmed: true, scope: 'session' });
  await view.render(); assert.match(view.container.textContent, /停止当前会话整轮任务/);
  await view.click(view.button('停止本轮会话'));
  assert.match(view.container.textContent, /后台已确认本轮会话停止/);
});

test('capability decoding rejects foreign identities and ignores unknown or falsely truthy permissions', () => {
  assert.throws(() => decodeOfficeControls({ ...capability(), turnId: 'another-turn' }, identity), /不属于当前/);
  const raw = capability(); raw.stop.available = 'true'; raw.model.scope = 'current_running_agent';
  raw.model.options.push({ id: 'bad', provider: 'untrusted', model: 'model', configured: 'true', privateKey: 'must-not-forward' });
  const decoded = decodeOfficeControls(raw, identity);
  assert.equal(decoded.stop.available, false); assert.equal(decoded.model.available, false);
  assert.equal(decoded.model.options.at(-1).configured, false);
  assert.equal(JSON.stringify(decoded).includes('must-not-forward'), false);
});

test.after(() => window.close());
