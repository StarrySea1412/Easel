import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { tsModuleUrl } from './load-ts.mjs';

// Actual Page + deterministic demo data; Scene, observation hook and RAF are
// controlled substitutes. These checks do not prove WebGL rendering, layout,
// backend polling or real browser interactions.
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const moduleUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const raw = fs.readFileSync(new URL('../src/components/AgentOfficePage.tsx', import.meta.url), 'utf8');
let sequence = 0;

async function fixture(t, overrides = {}) {
  const harness = {
    snapshots: {}, hookCalls: [], leases: 0, releases: 0, refreshes: 0,
    scene: null, sceneMounts: 0, sceneUnmounts: 0, frames: new Map(), nextFrame: 0,
    now: 0, cancelled: 0, fetches: [], opened: [],
  };
  globalThis.__officePage = harness;
  t.mock.method(globalThis, 'fetch', async (...args) => { harness.fetches.push(args); throw new Error('Page tests must not fetch'); });
  t.mock.method(window, 'requestAnimationFrame', (callback) => {
    const id = ++harness.nextFrame;
    harness.frames.set(id, callback);
    return id;
  });
  t.mock.method(window, 'cancelAnimationFrame', (id) => { harness.cancelled++; harness.frames.delete(id); });
  const react = JSON.stringify(import.meta.resolve('react'));
  const hook = moduleUrl(`import { useEffect } from ${react};
    export function useAgentOffice(sessionId, enabled) {
      const h = globalThis.__officePage;
      h.hookCalls.push({sessionId,enabled});
      useEffect(() => { if (!enabled || !sessionId) return; h.leases++; return () => { h.leases--; h.releases++; }; }, [sessionId, enabled]);
      const empty = {agents:[],loading:false,error:null,observedAt:null,coverage:'仅展示已观察到的 Agent'};
      return {...(enabled && sessionId ? h.snapshots[sessionId] || empty : empty), refresh:() => {h.refreshes++;}};
    }`);
  const scene = moduleUrl(`import { createElement, useEffect, useState } from ${react};
    export default function Scene(props) {
      const h=globalThis.__officePage; h.scene=props;
      const [unavailable,setUnavailable]=useState(false);
      useEffect(() => {h.sceneMounts++;return () => {h.sceneUnmounts++;};}, []);
      return createElement('div', {'data-testid':'office-scene'},
        ...props.agents.map(agent => createElement('button', {key:agent.id,'data-scene-agent':agent.id,onClick:()=>props.onSelect(agent.id)},agent.name)),
        unavailable?createElement('p', {className:'agent-office-scene__fallback',role:'status'},'三维场景暂不可用'):null,
        createElement('button', {'data-scene-unavailable':true,onClick:()=>setUnavailable(true)},'simulate unavailable'));
    }`);
  let code = ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const parsed = ts.createSourceFile('AgentOfficePage.js', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const replacements = [];
  for (const statement of parsed.statements.filter(ts.isImportDeclaration)) {
    const specifier = statement.moduleSpecifier.text;
    if (specifier.endsWith('.css')) {
      replacements.push({ start: statement.getStart(parsed), end: statement.end, text: '' });
      continue;
    }
    const target = specifier === '../hooks/useAgentOffice' ? hook
      : specifier === './agent-office/AgentOfficeScene' ? scene
        : specifier === '../lib/agentOffice' ? await tsModuleUrl(new URL('../src/lib/agentOffice.ts', import.meta.url))
          : import.meta.resolve(specifier);
    replacements.push({ start: statement.moduleSpecifier.getStart(parsed), end: statement.moduleSpecifier.end, text: JSON.stringify(target) });
  }
  for (const item of replacements.reverse()) code = code.slice(0, item.start) + item.text + code.slice(item.end);
  const { default: Page } = await import(moduleUrl(code) + `#office-${++sequence}`);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let mounted = true;
  let props = { sessions: [session('one')], activeSessionId: 'one', streams: {}, onOpenChat: (id) => harness.opened.push(id), ...overrides };
  const render = async (patch = {}) => { props = { ...props, ...patch }; await act(async () => root.render(createElement(Page, props))); };
  const unmount = async () => { if (mounted) { await act(async () => root.unmount()); mounted = false; } };
  t.after(async () => { await unmount(); container.remove(); });
  await render();
  return {
    harness, container, render, unmount,
    button: (text) => [...container.querySelectorAll('button')].find((button) => button.textContent.replace(/[▶Ⅱ↺⌖↗]/g, '').trim() === text),
    click: async (button) => act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))),
    async advance(ms) { await act(async () => { harness.now += ms; const callbacks = [...harness.frames.values()]; harness.frames.clear(); for (const callback of callbacks) callback(harness.now); }); },
    async select(id) { const select = container.querySelector('.office-session-select select'); await act(async () => { select.value = id; select.dispatchEvent(new window.Event('change', { bubbles: true })); }); },
  };
}

function session(id, extra = {}) { return { id, title: `会话 ${id}`, created: 1, messages: [], ...extra }; }
function snapshot(agents, extra = {}) { return { agents, loading: false, error: null, observedAt: '2026-09-30T08:00:00Z', coverage: '来自本轮结构化执行记录，未上报角色不补全', ...extra }; }
function agent(id, extra = {}) { return { id, name: `Agent ${id}`, role: '协作角色', task: `正在处理任务 ${id}`, state: 'working', source: 'live', ...extra }; }

test('the office defaults to a conspicuously simulated six-agent scene and selection updates the detail panel', async (t) => {
  const view = await fixture(t);
  const { harness: h } = view;
  assert.match(view.container.querySelector('[aria-label="办公室数据来源"]').textContent, /演示 · 模拟任务/);
  assert.match(view.container.textContent, /不代表真实 Agent 调用或执行结果/);
  assert.equal(h.scene.agents.length, 6);
  assert.ok(h.scene.agents.every((item) => item.source === 'demo'));
  assert.ok(h.hookCalls.every((call) => call.enabled === false && call.sessionId === null));
  assert.equal(h.leases, 0);
  assert.deepEqual(h.fetches, []);
  assert.deepEqual([...view.container.querySelectorAll('.office-stats dd')].map((item) => item.textContent), ['2', '4', '0']);

  const rows = [...view.container.querySelectorAll('.office-member-list button')];
  await view.click(rows.find((button) => button.textContent.includes('Quill')));
  assert.equal(h.scene.selectedId, 'writer');
  assert.match(view.container.querySelector('.office-agent-detail').textContent, /Quill/);
  assert.match(view.container.querySelector('.office-agent-detail').textContent, /Easel/);
  await view.click(view.container.querySelector('[data-scene-agent="researcher"]'));
  assert.equal(view.container.querySelector('.office-agent-detail h3').textContent, 'Scout');
  assert.equal(rows.find((button) => button.textContent.includes('Scout')).getAttribute('aria-pressed'), 'true');
});

test('demo playback, replay, camera reset and unmount clean up the animation frame', async (t) => {
  const view = await fixture(t);
  const { harness: h } = view;
  assert.equal(h.frames.size, 1);
  await view.advance(0);
  await view.advance(1200);
  assert.equal(Number(view.container.querySelector('progress').value), 1.2);
  await view.click(view.button('暂停动画'));
  assert.equal(h.scene.paused, true);
  assert.equal(h.frames.size, 0);
  await view.click(view.button('播放动画'));
  assert.equal(h.frames.size, 1);
  const beforeReset = h.scene.resetKey;
  await view.click(view.button('视角复位'));
  assert.equal(h.scene.resetKey, beforeReset + 1);
  await view.click(view.button('重播演示'));
  assert.equal(Number(view.container.querySelector('progress').value), 0);
  assert.equal(h.scene.paused, false);
  await view.advance(0);
  await view.advance(48_000);
  assert.equal(h.scene.agents.filter((item) => item.state === 'done').length, 6);
  assert.equal(h.scene.paused, true);
  assert.equal(h.frames.size, 0);
  assert.match(view.container.textContent, /演示完成 · 可重播/);
  await view.click(view.button('播放动画'));
  assert.equal(Number(view.container.querySelector('progress').value), 0);
  await view.unmount();
  assert.equal(h.frames.size, 0);
  assert.equal(h.sceneUnmounts, 1);
});

test('live mode excludes imported sessions, observes only the selection and does not invent agents for an active stream', async (t) => {
  const view = await fixture(t, {
    sessions: [session('backup', { importedFromBackup: true }), session('one'), session('two')],
    activeSessionId: 'backup', streams: { two: { content: 'local stream' } },
  });
  const { harness: h } = view;
  h.snapshots.one = snapshot([agent('root'), agent('worker', { parentId: 'root', state: 'thinking' })]);
  await view.click(view.button('实时观测'));
  assert.equal(h.frames.size, 0);
  assert.equal(h.leases, 1);
  assert.deepEqual([...view.container.querySelectorAll('.office-session-select option')].map((item) => item.value), ['one', 'two']);
  assert.equal(h.scene.agents.length, 2);
  assert.ok(h.scene.agents.every((item) => item.source === 'live'));
  await view.click(view.button('暂停动画'));
  assert.equal(h.leases, 1, 'pausing motion must not stop observation');
  assert.equal(h.scene.paused, true);
  await view.select('two');
  assert.equal(h.leases, 1);
  assert.equal(h.releases, 1);
  assert.equal(h.hookCalls.at(-1).sessionId, 'two');
  assert.deepEqual(h.scene.agents, []);
  assert.match(view.container.textContent, /当前没有可观察的 Agent/);
  await view.click(view.button('查看所选会话'));
  assert.deepEqual(h.opened, ['two']);
  await view.click(view.button('演示模式'));
  assert.equal(h.leases, 0);
  assert.equal(h.releases, 2);
  assert.equal(h.scene.agents.length, 6);
  assert.deepEqual(h.fetches, []);
});

test('no ordinary session leaves observation disabled with an honest empty office', async (t) => {
  const view = await fixture(t, { sessions: [session('backup', { importedFromBackup: true })], activeSessionId: 'backup' });
  await view.click(view.button('实时观测'));
  assert.equal(view.harness.hookCalls.at(-1).sessionId, null);
  assert.equal(view.harness.hookCalls.at(-1).enabled, false);
  assert.equal(view.harness.leases, 0);
  assert.deepEqual(view.harness.scene.agents, []);
  assert.match(view.container.textContent, /还没有可观察的会话/);
  assert.equal(view.container.querySelector('.office-session-select select').disabled, true);
  assert.equal(view.button('查看所选会话').disabled, true);
});

test('observation errors retain and freeze the last snapshot while labeling it stale and allowing retry', async (t) => {
  const view = await fixture(t);
  const { harness: h } = view;
  h.snapshots.one = snapshot([agent('old')], { error: '模拟 API 连接中断' });
  await view.click(view.button('实时观测'));
  assert.equal(h.scene.agents.length, 1);
  assert.equal(h.scene.paused, true);
  assert.match(view.container.querySelector('[role="alert"]').textContent, /保留上次快照/);
  assert.match(view.container.querySelector('[role="alert"]').textContent, /并非当前实时执行状态/);
  assert.match(view.container.querySelector('.office-agent-detail').textContent, /快照中的任务/);
  assert.ok(view.container.querySelector('[aria-label="上次快照统计"]'));
  assert.equal(view.button('快照已暂停').disabled, true);
  await view.click(view.button('重新获取'));
  assert.equal(h.refreshes, 1);
  h.snapshots.one = snapshot([agent('new', { state: 'done' })]);
  await view.render();
  assert.equal(view.container.querySelector('[role="alert"]'), null);
  assert.equal(h.scene.agents[0].id, 'new');
  assert.equal(h.scene.paused, false);
  await view.unmount();
  assert.equal(h.leases, 0);
  assert.equal(h.releases, 1);
});

test('a scene initialization failure keeps the text roster and task selection available', async (t) => {
  const view = await fixture(t);
  await view.click(view.container.querySelector('[data-scene-unavailable]'));
  assert.match(view.container.querySelector('.agent-office-scene__fallback').textContent, /三维场景暂不可用/);
  const row = [...view.container.querySelectorAll('.office-member-list button')].find((button) => button.textContent.includes('Pixel'));
  await view.click(row);
  assert.equal(view.container.querySelector('.office-agent-detail h3').textContent, 'Pixel');
  assert.deepEqual(view.harness.fetches, []);
});

test('call history filters current and all agents, omits unknown identities and keeps returned distinct from success', async t => {
  const openedActivity = [];
  const view = await fixture(t, { onOpenActivity: id => openedActivity.push(id) });
  view.harness.snapshots.one = snapshot([agent('a'), agent('b')], { events: [
    { id: '1', agentId: 'a', kind: 'call', title: '调用工具：read', status: 'called', source: 'live' },
    { id: '2', agentId: 'b', kind: 'result', title: '工具返回：write', status: 'returned', source: 'live' },
    { id: '3', agentId: 'foreign', kind: 'call', title: '另一会话的秘密', status: 'called', source: 'live' },
  ] });
  await view.click(view.button('实时观测'));
  assert.match(view.container.querySelector('.office-event-list').textContent, /read/);
  assert.doesNotMatch(view.container.querySelector('.office-event-list').textContent, /write|秘密/);
  await view.click(view.button('全部'));
  assert.match(view.container.querySelector('.office-event-list').textContent, /write.*已返回/);
  assert.doesNotMatch(view.container.querySelector('.office-event-list').textContent, /成功|秘密/);
  await view.click(view.button('查看运行记录'));
  assert.deepEqual(openedActivity, ['one']);
  await view.click(view.button('演示模式'));
  assert.match(view.container.querySelector('.office-call-history').textContent, /模拟|演示/);
  assert.doesNotMatch(view.container.querySelector('.office-event-list').textContent, /write/);
});

test('hidden time does not advance the demo or skip its call sequence on return', async t => {
  let hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  t.after(() => { delete document.hidden; });
  const view = await fixture(t);
  await view.advance(0); await view.advance(3000);
  const before = view.container.querySelector('progress').value;
  await act(async () => { hidden = true; document.dispatchEvent(new window.Event('visibilitychange')); });
  assert.equal(view.harness.frames.size, 0);
  await view.advance(120000);
  await act(async () => { hidden = false; document.dispatchEvent(new window.Event('visibilitychange')); });
  await view.advance(0);
  assert.equal(view.container.querySelector('progress').value, before);
  await view.advance(1000);
  assert.equal(view.container.querySelector('progress').value, before + 1);
});

test('stopped tasks show their terminal state and are not counted as waiting', async t => {
  const view = await fixture(t);
  view.harness.snapshots.one = snapshot([agent('stopped', { state: 'stopped' })]);
  await view.click(view.button('实时观测'));
  assert.match(view.container.querySelector('.office-agent-detail').textContent, /已停止/);
  const waiting = [...view.container.querySelectorAll('.office-stats>div')].find(row => row.querySelector('dt').textContent === '等待');
  assert.equal(waiting.querySelector('dd').textContent, '0');
});

test.after(async () => { await window.happyDOM.abort(); window.close(); });
