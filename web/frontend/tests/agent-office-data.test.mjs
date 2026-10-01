import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { createDemoOfficeAgents, createDemoOfficeEvents, decodeOfficeSnapshot, DEMO_DURATION_SECONDS } = await loadTsModule('../src/lib/agentOffice.ts', import.meta.url);
const { useAgentOffice } = await loadTsModule('../src/hooks/useAgentOffice.ts', import.meta.url);

function payload(id = 'one', status = 'running') {
  return { sessionId: id, turnId: 'turn', observedAt: '2026-09-30T00:00:00Z',
    agents: [{ id: 'root', name: '主 Agent', role: 'root', task: '当前任务', status }],
    coverage: { subagents: 'not_observed', detail: '未观察到可核验子 Agent' } };
}

test('live decoding requires exact session identity and unique explicit agent identities', () => {
  assert.throws(() => decodeOfficeSnapshot(payload('another'), 'one'), /不属于当前会话/);
  const duplicate = payload(); duplicate.agents.push(duplicate.agents[0]);
  assert.throws(() => decodeOfficeSnapshot(duplicate, 'one'), /身份数据无效/);
  assert.throws(() => decodeOfficeSnapshot({ ...payload(), agents: [{ id: 'skill', role: 'skill' }] }, 'one'), /身份数据无效/);
  for (const id of ['', 'bad identity', 'bad\nidentity', 'x'.repeat(161), {}, null]) {
    assert.throws(() => decodeOfficeSnapshot({ ...payload(), agents: [{ id, role: 'subagent' }] }, 'one'), /身份数据无效/);
  }
});

function teamPayload(count) {
  const raw = payload();
  raw.agents.push(...Array.from({ length: count - 1 }, (_, index) => ({ id: `child-${index}`, parentId: 'root', role: 'subagent', status: 'running' })));
  raw.coverage.observedAgentCount = count;
  return raw;
}

for (const count of [9, 12, 20, 50, 65, 100]) test(`all ${count} confirmed identities are decoded independently of the visible room capacity`, () => {
  const result = decodeOfficeSnapshot(teamPayload(count), 'one');
  assert.equal(result.agents.length, count);
  assert.equal(new Set(result.agents.map(agent => agent.id)).size, count);
  assert.equal(result.agents.at(-1).parentId, 'root');
  assert.equal(result.observedAgentCount, count);
  assert.equal(result.identityScanLimited, false);
});

test('partial identity coverage remains explicit and counts only decoded identities', () => {
  const raw = teamPayload(50);
  raw.coverage.identityScanLimited = true;
  raw.coverage.observedAgentCount = 9000;
  raw.warnings = ['会话日志超过读取上限，子 Agent 身份可能未完整捕获。'];
  const result = decodeOfficeSnapshot(raw, 'one');
  assert.equal(result.observedAgentCount, 50);
  assert.equal(result.identityScanLimited, true);
  assert.match(result.coverage, /超过读取上限/);
});

test('unknown statuses are never promoted to completion and unproven relationships are omitted', () => {
  const raw = payload();
  raw.agents.push({ id: 'child', parentId: 'root', name: '研究员', role: 'subagent', task: '检索', status: 'accepted', secret: 'must-not-forward' });
  raw.agents.push({ id: 'unknown-parent', parentId: 'absent', role: 'subagent', status: 'finished-maybe' });
  const result = decodeOfficeSnapshot(raw, 'one');
  assert.equal(result.agents[1].state, 'unknown');
  assert.equal(result.agents[1].parentId, 'root');
  assert.equal(result.agents[2].parentId, undefined);
  assert.equal(result.agents[1].secret, undefined);
  assert.ok(result.agents.every(agent => agent.source === 'live'));
  assert.match(result.coverage, /未观察到/);
});

test('demo choreography is deterministic, has stable identities and never impersonates live evidence', () => {
  const initial = createDemoOfficeAgents(0);
  const issue = createDemoOfficeAgents(34);
  const complete = createDemoOfficeAgents(DEMO_DURATION_SECONDS);
  assert.equal(initial.length, 6);
  assert.ok(initial.every(agent => agent.source === 'demo'));
  assert.deepEqual(initial.map(agent => agent.id), complete.map(agent => agent.id));
  assert.equal(issue.find(agent => agent.id === 'tester').state, 'error');
  assert.ok(complete.every(agent => agent.state === 'done'));
  assert.deepEqual(createDemoOfficeAgents(-10), initial);
  assert.deepEqual(createDemoOfficeAgents(NaN), initial);
  assert.deepEqual(createDemoOfficeAgents(100), complete);
});

test('a stopped task remains stopped rather than waiting for more work', () => {
  assert.equal(decodeOfficeSnapshot(payload('one', 'stopped'), 'one').agents[0].state, 'stopped');
  assert.equal(decodeOfficeSnapshot(payload('one', 'waiting'), 'one').agents[0].state, 'waiting');
});

test('call records omit unknown agent identities and never elevate returned evidence to success', () => {
  const data = payload();
  data.events = [
    { id: 'known', agentId: 'root', kind: 'result', status: 'returned', title: '工具返回：read', raw: 'secret output' },
    { id: 'foreign', agentId: 'another-session', kind: 'call', status: 'called', title: '不得显示外部任务' },
    { id: 'bad-kind', agentId: 'root', kind: 'skill', status: 'done' },
  ];
  const result = decodeOfficeSnapshot(data, 'one');
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].status, 'returned');
  assert.equal(result.events[0].raw, undefined);
  assert.equal(result.events[0].source, 'live');
});

test('demo calls are chronological prefixes and replay starts without future calls', () => {
  const early = createDemoOfficeEvents(4), later = createDemoOfficeEvents(48);
  assert.deepEqual(later.slice(0, early.length), early);
  assert.ok(later.every(event => event.source === 'demo' && createDemoOfficeAgents(0).some(agent => agent.id === event.agentId)));
  assert.ok(later.some(event => event.status === 'failed'));
  assert.equal(createDemoOfficeEvents(0).length, 1);
});

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

async function fixture(t) {
  const requests = [], timers = new Map(); let nextTimer = 0, current;
  let hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  t.mock.method(globalThis, 'fetch', (_url, options) => {
    const response = deferred(); requests.push({ ...response, url: _url, signal: options.signal, cache: options.cache }); return response.promise;
  });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  function Harness({ id, enabled = true }) { current = useAgentOffice(id, enabled); return createElement('output', null, JSON.stringify(current)); }
  const render = async (id, enabled = true) => act(async () => root.render(createElement(Harness, { id, enabled })));
  t.after(async () => { await act(async () => root.unmount()); host.remove(); delete document.hidden; });
  return {
    requests, timers, render, state: () => current,
    reply: async (index, value) => act(async () => requests[index].resolve({ ok: true, json: async () => value })),
    fail: async index => act(async () => requests[index].reject(new Error('网络暂不可用'))),
    tick: async ms => act(async () => { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); } }),
    hidden: async value => act(async () => { hidden = value; document.dispatchEvent(new window.Event('visibilitychange')); }),
    unmount: async () => act(async () => root.unmount()),
  };
}

test('demo and empty selection make no requests; changing live sessions aborts and isolates late responses', async t => {
  const f = await fixture(t);
  await f.render('one', false); await f.render(null); assert.equal(f.requests.length, 0);
  await f.render('one'); assert.equal(f.requests[0].cache, 'no-store');
  await f.render('two'); assert.equal(f.requests[0].signal.aborted, true);
  assert.deepEqual(f.state().agents, []);
  await f.reply(0, payload('one')); assert.deepEqual(f.state().agents, []);
  await f.reply(1, payload('two')); assert.equal(f.state().agents[0].task, '当前任务');
  await f.render('two', false); assert.deepEqual(f.state().agents, []);
  assert.equal(f.timers.size, 0);
});

test('failed polling retains the last snapshot and stale warning until a successful response', async t => {
  const f = await fixture(t);
  await f.render('one'); await f.reply(0, payload());
  await f.tick(2000); await f.fail(1);
  assert.equal(f.state().agents[0].state, 'working');
  assert.match(f.state().error, /网络/);
  await f.tick(2000); assert.equal(f.requests.length, 3);
  assert.match(f.state().error, /网络/, 'starting another request cannot erase stale-data warning');
  await f.reply(2, payload('one', 'completed'));
  assert.equal(f.state().error, null); assert.equal(f.state().agents[0].state, 'done');
});

test('large and limited identity snapshots survive polling errors and clear on session changes', async t => {
  const f = await fixture(t);
  const raw = teamPayload(100); raw.coverage.identityScanLimited = true;
  await f.render('one'); await f.reply(0, raw);
  assert.equal(f.state().agents.length, 100);
  assert.equal(f.state().observedAgentCount, 100);
  assert.equal(f.state().identityScanLimited, true);
  await f.tick(2000); await f.fail(1);
  assert.equal(f.state().agents.length, 100);
  assert.equal(f.state().identityScanLimited, true);
  await f.render('two');
  assert.equal(f.state().agents.length, 0);
  assert.equal(f.state().observedAgentCount, 0);
  assert.equal(f.state().identityScanLimited, false);
});

test('visibility, manual refresh and unmount do not leave overlapping polls or listeners', async t => {
  const f = await fixture(t);
  await f.hidden(true); await f.render('one'); assert.equal(f.requests.length, 0);
  await f.hidden(false); assert.equal(f.requests.length, 1);
  await f.hidden(false); assert.equal(f.requests.length, 1);
  await act(async () => f.state().refresh()); assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.requests.length, 2);
  await f.reply(1, payload()); await f.hidden(true); assert.equal(f.timers.size, 0);
  await f.hidden(false); assert.equal(f.requests.length, 3);
  await f.unmount(); assert.equal(f.requests[2].signal.aborted, true); assert.equal(f.timers.size, 0);
  await f.hidden(false); assert.equal(f.requests.length, 3);
});

test('a request that ignores abort cannot publish a late timeout result', async t => {
  const f = await fixture(t);
  await f.render('one'); await f.tick(12000); assert.equal(f.requests[0].signal.aborted, true);
  await f.reply(0, payload());
  assert.deepEqual(f.state().agents, []); assert.match(f.state().error, /超时/); assert.equal(f.state().loading, false);
});
