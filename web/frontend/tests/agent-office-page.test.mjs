import { selectOption, optionValues } from './select-helpers.mjs';
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
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const moduleUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const raw = fs.readFileSync(new URL('../src/components/AgentOfficePage.tsx', import.meta.url), 'utf8');
let sequence = 0;

async function fixture(t, overrides = {}, snapshots = {}) {
  const harness = {
    snapshots, hookCalls: [], outputModes: [], leases: 0, releases: 0, refreshes: 0,
    scene: null, sceneHistory: [], sceneMounts: 0, sceneUnmounts: 0, frames: new Map(), nextFrame: 0,
    now: 0, cancelled: 0, fetches: [], opened: [], composer: null, controlTargets: [],
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
      const h=globalThis.__officePage; h.scene=props; h.sceneHistory.push(props);
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
    const target = specifier === './agent-office/OfficeOutputMonitor' ? moduleUrl('export default function Output(props){globalThis.__officePage.outputModes.push(props.mode);return null;}')
      : specifier === './agent-office/OfficeAgentControls' ? moduleUrl('export default function EmbeddedPanel(props){globalThis.__officePage.controlTargets.push(props);return null;}')
      : specifier === './agent-office/OfficeTaskComposer' ? moduleUrl('export default function Composer(props){globalThis.__officePage.composer=props;return null;}') : specifier === '../hooks/useAgentOffice' ? hook
      : specifier === './agent-office/AgentOfficeScene' ? scene
        : specifier === '../lib/agentOffice' ? await tsModuleUrl(new URL('../src/lib/agentOffice.ts', import.meta.url))
          : specifier.startsWith('.') ? await tsModuleUrl(new URL('../src/components/' + specifier + (specifier.includes('/lib/') ? '.ts' : '.tsx'), import.meta.url)) : import.meta.resolve(specifier);
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
    async input(element, value) {
      if (element.getAttribute('role') === 'combobox') return selectOption(element, value);
      const prototype = element.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
      await act(async () => element.dispatchEvent(new window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })));
    },
    async advance(ms) { await act(async () => { harness.now += ms; const callbacks = [...harness.frames.values()]; harness.frames.clear(); for (const callback of callbacks) callback(harness.now); }); },
    async select(id) { const select = container.querySelector('.office-session-select [role="combobox"]'); await selectOption(select, id); },
  };
}

function session(id, extra = {}) { return { id, title: `会话 ${id}`, created: 1, messages: [], ...extra }; }
function snapshot(agents, extra = {}) { return { agents, loading: false, error: null, observedAt: '2026-09-30T08:00:00Z', coverage: '来自本轮结构化执行记录，未上报角色不补全', ...extra }; }
function agent(id, extra = {}) { return { id, name: `Agent ${id}`, role: '协作角色', task: `正在处理任务 ${id}`, state: 'working', source: 'live', ...extra }; }

test('a run-record link enters live mode for the exact session and preserves its turn when opening records', async t => {
  const opened = [];
  const view = await fixture(t, { initialSessionId: 'two', sessions: [session('one'), session('two')], onOpenActivity: (...args) => opened.push(args) }, { two: snapshot([agent('worker')], { turnId: 'turn-two' }) });
  assert.ok(view.harness.hookCalls.every(call => call.enabled && call.sessionId === 'two'));
  assert.equal(view.harness.frames.size, 0);
  await view.click(view.button('查看运行记录'));
  assert.deepEqual(opened, [['two', 'turn-two']]);
});

test('a deleted run-record target stays empty without showing a different session', async t => {
  const view = await fixture(t, { initialSessionId: 'deleted', sessions: [session('one')] }, { one: snapshot([agent('must-not-appear')]) });
  assert.ok(view.harness.hookCalls.every(call => !call.enabled && call.sessionId === null));
  assert.equal(view.harness.scene.agents.length, 0);
});

test('disabled demos use only live data and output mode from the first render while retaining independent study entries', async t => {
  const events = [
    { id: 'real-event', agentId: 'real', kind: 'call', title: '真实读取材料', status: 'called', source: 'live' },
    { id: 'wrong-source', agentId: 'real', kind: 'call', title: '不得显示的模拟调用', status: 'called', source: 'demo' },
  ];
  const view = await fixture(t, { demoEnabled: false }, { one: snapshot([agent('real'), agent('demo', { source: 'demo', name: '不得显示的模拟成员' })], { events, turnId: 'real-turn' }) });
  const h = view.harness;
  assert.ok(h.sceneHistory.every(scene => scene.agents.length === 1 && scene.agents[0].id === 'real' && scene.demoSeek === undefined));
  assert.ok(h.outputModes.length > 0 && h.outputModes.every(mode => mode === 'live'));
  assert.ok(h.hookCalls.every(call => call.enabled && call.sessionId === 'one'));
  assert.equal(h.frames.size, 0);
  assert.equal(view.button('演示模式'), undefined);
  assert.equal(view.button('重播演示'), undefined);
  assert.equal(view.container.querySelector('.office-demo-team-select, .office-demo-seek, .office-demo-phases'), null);
  assert.ok(view.button('角色与工位样板'));
  assert.ok(view.button('模型厂商 3D 形象审核'));
  assert.doesNotMatch(view.container.textContent, /不得显示的模拟/);
  await view.click(view.container.querySelector('.office-status-button'));
  const dialog = document.querySelector('[role="dialog"]');
  assert.match(dialog.textContent, /真实读取材料/);
  assert.doesNotMatch(dialog.textContent, /不得显示的模拟/);
});

test('disabling a running demo cancels its clock and late frames cannot repopulate an empty live scene', async t => {
  const view = await fixture(t);
  const lateFrame = [...view.harness.frames.values()][0];
  assert.equal(typeof lateFrame, 'function');
  const before = view.harness.sceneHistory.length;
  await view.render({ demoEnabled: false });
  assert.ok(view.harness.sceneHistory.slice(before).every(scene => scene.agents.length === 0 && scene.demoSeek === undefined && !scene.paused));
  assert.equal(view.harness.frames.size, 0);
  assert.match(view.container.querySelector('.office-scene-notice').textContent, /当前没有可观察的 Agent/);
  await act(async () => { lateFrame(60_000); document.dispatchEvent(new window.Event('visibilitychange')); });
  assert.equal(view.harness.frames.size, 0);
  assert.equal(view.harness.scene.paused, false);
  assert.equal(view.harness.scene.agents.length, 0);
  await view.render({ demoEnabled: true });
  assert.equal(view.button('实时观测').getAttribute('aria-pressed'), 'true');
  assert.equal(view.harness.frames.size, 0, 'enabling availability must not automatically restart the demo');
});

test('disabling a paused demo closes its process and clears selection and focus even when a live ID matches', async t => {
  const view = await fixture(t);
  await view.click([...view.container.querySelectorAll('.office-member-list button')].find(button => button.textContent.includes('Quill')));
  await view.click(view.button('并行协作'));
  await view.click(view.container.querySelector('.office-status-button'));
  assert.ok(document.querySelector('[role="dialog"]'));
  assert.equal(view.harness.scene.selectedId, 'writer');
  assert.equal(view.harness.scene.focusId, 'writer');
  assert.equal(view.harness.scene.paused, true);
  view.harness.snapshots.one = snapshot([agent('real-first'), agent('writer')], { turnId: 'real-turn' });
  const before = view.harness.sceneHistory.length;
  await view.render({ demoEnabled: false });
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.ok(view.harness.sceneHistory.slice(before).every(scene => scene.selectedId === 'real-first' && scene.focusId === null && !scene.paused));
  assert.equal(view.harness.sceneMounts, 1);
  assert.equal(view.harness.sceneUnmounts, 0);
  assert.doesNotMatch(view.container.querySelector('.office-event-list').textContent, /演示/);
});

test('changing demo availability preserves an existing live selection, focus, pause and process', async t => {
  const view = await fixture(t);
  view.harness.snapshots.one = snapshot([agent('real-first'), agent('real-second')], { turnId: 'real-turn' });
  await view.click(view.button('实时观测'));
  await view.click(view.container.querySelectorAll('.office-member-list button')[1]);
  await view.click(view.button('暂停动画'));
  await view.click(view.container.querySelector('.office-status-button'));
  const dialog = document.querySelector('[role="dialog"]');
  await view.render({ demoEnabled: false });
  await view.render({ demoEnabled: true });
  assert.equal(view.harness.scene.selectedId, 'real-second');
  assert.equal(view.harness.scene.focusId, 'real-second');
  assert.equal(view.harness.scene.paused, true);
  assert.equal(document.querySelector('[role="dialog"]'), dialog);
  assert.equal(view.harness.sceneMounts, 1);
  assert.equal(view.harness.frames.size, 0);
});

test('disabled demos retain honest empty and failed observations without filling missing members', async t => {
  const view = await fixture(t, { demoEnabled: false, sessions: [session('backup', { importedFromBackup: true })] });
  assert.match(view.container.querySelector('.office-scene-notice').textContent, /还没有可观察的会话/);
  assert.equal(view.harness.leases, 0);
  await view.render({ sessions: [session('one')], activeSessionId: 'one' });
  assert.match(view.container.querySelector('.office-scene-notice').textContent, /当前没有可观察的 Agent/);
  view.harness.snapshots.one = snapshot([], { error: '后台暂时不可用' });
  await view.render();
  assert.match(view.container.querySelector('.office-observation-error').textContent, /后台暂时不可用.*未填入模拟角色/);
  assert.equal(view.harness.scene.agents.length, 0);
  assert.equal(view.button('演示模式'), undefined);
  assert.ok(view.harness.outputModes.every(mode => mode === 'live'));
  assert.equal(view.harness.frames.size, 0);
});

test('status opens exact employee process and changing the observed session closes it', async t => {
  const view = await fixture(t, { sessions:[session('one'), session('two')] });
  view.harness.snapshots.one = snapshot([agent('root:one')], {turnId:'turn-one',events:[]});
  view.harness.snapshots.two = snapshot([agent('root:two')], {turnId:'turn-two',events:[]});
  await view.click(view.button('实时观测'));
  await view.click(view.container.querySelector('.office-status-button'));
  assert.match(document.querySelector('[role="dialog"]').textContent,/turn-one/);
  assert.doesNotMatch(document.querySelector('[role="dialog"]').textContent,/turn-two/);
  await view.select('two');
  assert.equal(document.querySelector('[role="dialog"]'),null);
});

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

test('close-up follows roster and scene selections while keeping the detail panel on the same employee', async t => {
  const view = await fixture(t);
  await view.click(view.button('近看选中员工'));
  assert.equal(view.harness.scene.focusId, view.harness.scene.selectedId);
  const writer = [...view.container.querySelectorAll('.office-member-list button')].find(button => button.textContent.includes('Quill'));
  await view.click(writer);
  assert.equal(view.harness.scene.selectedId, 'writer');
  assert.equal(view.harness.scene.focusId, 'writer');
  assert.equal(view.container.querySelector('.office-agent-detail h3').textContent, 'Quill');
  assert.equal(view.button('查看全办公室').getAttribute('aria-pressed'), 'true');
  await view.click(view.container.querySelector('[data-scene-agent="researcher"]'));
  assert.equal(view.harness.scene.selectedId, 'researcher');
  assert.equal(view.harness.scene.focusId, 'researcher');
  assert.equal(view.container.querySelector('.office-agent-detail h3').textContent, 'Scout');
  await view.click(view.button('查看全办公室'));
  assert.equal(view.harness.scene.focusId, null);
});

test('a focused live employee disappearing resets close-up and does not restore it if that identity returns', async t => {
  const view = await fixture(t);
  const root = agent('root:one');
  const child = agent('child', { parentId: root.id });
  view.harness.snapshots.one = snapshot([root, child], { turnId: 'turn-old' });
  await view.click(view.button('实时观测'));
  await view.click(view.container.querySelector('[data-scene-agent="child"]'));
  await view.click(view.button('近看选中员工'));
  assert.equal(view.harness.scene.focusId, 'child');
  view.harness.snapshots.one = snapshot([root], { turnId: 'turn-next' });
  await view.render();
  assert.equal(view.harness.scene.focusId, null);
  assert.equal(view.harness.scene.selectedId, root.id);
  assert.equal(view.button('近看选中员工').getAttribute('aria-pressed'), 'false');
  assert.equal(view.container.querySelector('.office-agent-detail h3').textContent, root.name);
  view.harness.snapshots.one = snapshot([root, child], { turnId: 'turn-next' });
  await view.render();
  assert.equal(view.harness.scene.focusId, null, 'removed focus is cleared, not merely hidden');
  await view.click(view.button('近看选中员工'));
  view.harness.snapshots.one = snapshot([], { turnId: 'turn-empty' });
  await view.render();
  assert.equal(view.harness.scene.focusId, null);
  assert.equal(view.button('近看选中员工').disabled, true);
});

test('demo playback, replay, camera reset and unmount clean up the animation frame', async (t) => {
  const view = await fixture(t);
  const { harness: h } = view;
  assert.equal(h.frames.size, 1);
  await view.advance(0);
  await view.advance(1200);
  assert.equal(Number(view.container.querySelector('.office-demo-seek').value), 1.2);
  await view.click(view.button('暂停动画'));
  assert.equal(h.scene.paused, true);
  assert.equal(h.frames.size, 0);
  await view.click(view.button('播放动画'));
  assert.equal(h.frames.size, 1);
  const beforeReset = h.scene.resetKey;
  await view.click(view.button('视角复位'));
  assert.equal(h.scene.resetKey, beforeReset + 1);
  await view.click(view.button('重播演示'));
  assert.equal(Number(view.container.querySelector('.office-demo-seek').value), 0);
  assert.equal(h.scene.paused, false);
  await view.advance(0);
  await view.advance(48_000);
  assert.equal(h.scene.agents.filter((item) => item.state === 'done').length, 6);
  assert.equal(h.scene.paused, true);
  assert.equal(h.frames.size, 0);
  assert.match(view.container.textContent, /演示完成 · 可重播/);
  await view.click(view.button('播放动画'));
  assert.equal(Number(view.container.querySelector('.office-demo-seek').value), 0);
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
  assert.deepEqual(await optionValues(view.container.querySelector('.office-session-select [role="combobox"]')), ['one', 'two']);
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
  assert.equal(view.container.querySelector('.office-session-select [role="combobox"]').disabled, true);
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
  assert.equal(h.scene.stale, true);
  assert.equal(h.scene.observedAt, '2026-09-30T08:00:00Z');
  assert.equal(view.container.querySelector('.office-action-summary'), null, 'missing action evidence does not create a duplicate status row');
  assert.match(view.container.querySelector('.office-task-focus-source').textContent, /上次快照/);
  assert.match(view.container.querySelector('.office-work-preview').textContent, /上次快照/);
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
  assert.equal(h.scene.stale, false);
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
  const before = Number(view.container.querySelector('.office-demo-seek').value);
  await act(async () => { hidden = true; document.dispatchEvent(new window.Event('visibilitychange')); });
  assert.equal(view.harness.frames.size, 0);
  await view.advance(120000);
  await act(async () => { hidden = false; document.dispatchEvent(new window.Event('visibilitychange')); });
  await view.advance(0);
  assert.equal(Number(view.container.querySelector('.office-demo-seek').value), before);
  await view.advance(1000);
  assert.equal(Number(view.container.querySelector('.office-demo-seek').value), before + 1);
});

test('stopped tasks show their terminal state and are not counted as waiting', async t => {
  const view = await fixture(t);
  view.harness.snapshots.one = snapshot([agent('stopped', { state: 'stopped' })]);
  await view.click(view.button('实时观测'));
  assert.match(view.container.querySelector('.office-agent-detail').textContent, /已停止/);
  const waiting = [...view.container.querySelectorAll('.office-stats>div')].find(row => row.querySelector('dt').textContent === '等待');
  assert.equal(waiting.querySelector('dd').textContent, '0');
});

for (const count of [9, 12, 20, 50]) test(`${count} live members have complete roster, bounded scene and cross-zone focus`, async t => {
  const view = await fixture(t);
  const agents = Array.from({ length: count }, (_, index) => agent(`live-${index + 1}`));
  view.harness.snapshots.one = snapshot(agents, { observedAgentCount: count, identityScanLimited: count === 50 });
  await view.click(view.button('实时观测'));
  assert.equal(view.harness.scene.agents.length, 8);
  assert.equal(view.container.querySelectorAll('.office-member-list button').length, count);
  assert.match(view.container.querySelector('.office-zone-summary').textContent, new RegExp(`已观测 ${count} 人`));
  if (count === 50) assert.match(view.container.querySelector('.office-coverage-note').textContent, /实际参与人数可能更多/);
  await view.click([...view.container.querySelectorAll('.office-member-list button')].at(-1));
  assert.equal(view.harness.scene.selectedId, agents.at(-1).id);
  assert.equal(view.harness.scene.focusId, agents.at(-1).id);
  assert.ok(view.harness.scene.agents.some(agent => agent.id === agents.at(-1).id));
  assert.equal(view.harness.scene.agents.length, count % 8 || 8);
  assert.equal(view.button('下一分区').disabled, true);
  assert.match(view.container.querySelector('.office-agent-detail').textContent, new RegExp(agents.at(-1).name));
  await view.click(view.button('上一分区'));
  assert.equal(view.harness.scene.selectedId, view.harness.scene.agents[0].id);
  assert.equal(view.harness.scene.focusId, view.harness.scene.selectedId);
  assert.equal(view.harness.sceneMounts, 1);
  assert.deepEqual(view.harness.fetches, []);
});

test('all fifty simulated members can be searched and selected across zones, including editing a shared card', async t => {
  const view = await fixture(t);
  await view.input(view.container.querySelector('.office-demo-team-select [role="combobox"]'), '50');
  assert.equal(view.container.querySelectorAll('.office-member-list button').length, 50);
  assert.equal(view.harness.scene.agents.length, 8);
  assert.match(view.container.querySelector('.office-source-copy').textContent, /50 个角色的协作演示/);
  await view.advance(0); await view.advance(15000);
  assert.equal(view.harness.scene.agents.find(agent => agent.id === 'researcher:demo:07').action.kind, 'reading');
  assert.equal(view.harness.scene.agents.find(agent => agent.id === 'designer:demo:08').action.kind, 'designing');
  await view.input(view.container.querySelector('.office-member-search input'), ':demo:50');
  const rows = view.container.querySelectorAll('.office-member-list button');
  assert.equal(rows.length, 1);
  await view.click(rows[0]);
  assert.match(view.harness.scene.selectedId, /:demo:50$/);
  assert.equal(view.harness.scene.focusId, view.harness.scene.selectedId);
  assert.equal(view.harness.scene.agents.length, 2);
  assert.equal(view.container.querySelector('[aria-label="切换办公室分区"]').value, '6');
  const selected = view.harness.scene.selectedId;
  await view.click(view.button('编辑角色卡'));
  assert.ok(document.querySelector('[role="dialog"]'));
  assert.equal(view.harness.scene.selectedId, selected);
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(view.harness.scene.selectedId, selected);
  await view.click(view.button('清空搜索'));
  assert.equal(view.container.querySelectorAll('.office-member-list button').length, 50);
  await view.input(view.container.querySelector('.office-member-search input'), '不存在的名字');
  assert.equal(view.container.querySelectorAll('.office-member-list button').length, 0);
  assert.match(view.container.querySelector('.office-member-empty').textContent, /没有匹配成员/);
  assert.equal(view.harness.scene.selectedId, selected, 'filtering the roster must not discard the selection');
  assert.equal(view.harness.sceneMounts, 1);
  assert.deepEqual(view.harness.fetches, []);
});

test('live reorder or shrinking roster keeps the selected identity in its visible zone and clears vanished focus', async t => {
  const view = await fixture(t);
  const agents = Array.from({ length: 20 }, (_, index) => agent(`member-${index}`));
  view.harness.snapshots.one = snapshot(agents);
  await view.click(view.button('实时观测'));
  await view.click([...view.container.querySelectorAll('.office-member-list button')].at(-1));
  view.harness.snapshots.one = snapshot([...agents].reverse());
  await view.render();
  assert.equal(view.harness.scene.selectedId, 'member-19');
  assert.equal(view.harness.scene.agents[0].id, 'member-19');
  assert.equal(view.harness.scene.focusId, 'member-19');
  view.harness.snapshots.one = snapshot(agents.slice(0, 3));
  await view.render();
  assert.equal(view.harness.scene.selectedId, 'member-0');
  assert.equal(view.harness.scene.focusId, null);
  assert.equal(view.harness.scene.agents.length, 3);
});

test('demo stage navigation synchronizes task, events and scene time without losing selection or camera', async t => {
  const view = await fixture(t);
  await view.click([...view.container.querySelectorAll('.office-member-list button')].find(button => button.textContent.includes('Quill')));
  const resetKey = view.harness.scene.resetKey;
  const range = view.container.querySelector('.office-demo-seek');
  await view.click(view.button('并行协作'));
  assert.equal(range.value, '18');
  assert.equal(view.harness.scene.demoSeek.seconds, 18);
  assert.equal(view.harness.scene.paused, true);
  assert.equal(view.harness.frames.size, 0);
  assert.equal(view.harness.scene.selectedId, 'writer');
  assert.equal(view.harness.scene.focusId, 'writer');
  assert.equal(view.harness.scene.agents.find(a => a.id === 'writer').action.kind, 'writing');
  assert.match(range.getAttribute('aria-valuetext'), /并行协作.*暂停/);
  const revision = view.harness.scene.demoSeek.revision;
  await view.click(view.button('完成'));
  assert.ok(view.harness.scene.agents.every(agent => agent.state === 'done'));
  assert.equal(view.harness.scene.demoSeek.seconds, 48);
  await view.click(view.button('任务分工'));
  assert.equal(view.harness.scene.demoSeek.seconds, 0);
  assert.ok(view.harness.scene.demoSeek.revision > revision);
  assert.doesNotMatch(view.container.querySelector('.office-event-list').textContent, /演示 00:(1[89]|[234]\d)/);
  assert.doesNotMatch(view.container.querySelector('.office-feedback').textContent, /已完成/);
  await view.input(range, '28.5');
  assert.equal(view.harness.scene.demoSeek.seconds, 28.5);
  assert.equal(view.harness.scene.paused, true);
  await view.click(view.button('播放动画'));
  await view.advance(0); await view.advance(1000);
  assert.equal(Number(range.value), 29.5, 'play resumes from the chosen time');
  await view.click(view.button('重播演示'));
  assert.equal(view.harness.scene.demoSeek.seconds, 0);
  assert.equal(view.harness.scene.selectedId, 'writer');
  assert.equal(view.harness.scene.focusId, 'writer');
  assert.equal(view.harness.scene.resetKey, resetKey);
  assert.equal(view.harness.sceneMounts, 1);
  assert.deepEqual(view.harness.fetches, []);
});

test('demo time is resynchronized after team and mode changes without leaking seek into live observation', async t => {
  const view = await fixture(t);
  await view.click(view.button('检查与审阅'));
  const revision = view.harness.scene.demoSeek.revision;
  await view.input(view.container.querySelector('.office-demo-team-select [role="combobox"]'), '50');
  assert.equal(view.harness.scene.demoSeek.seconds, 28);
  assert.ok(view.harness.scene.demoSeek.revision > revision);
  assert.equal(view.harness.scene.paused, true);
  await view.click(view.button('实时观测'));
  assert.equal(view.harness.scene.demoSeek, undefined);
  await view.click(view.button('演示模式'));
  assert.equal(view.harness.scene.demoSeek.seconds, 28);
  assert.equal(view.container.querySelectorAll('.office-member-list button').length, 50);
  assert.equal(view.harness.sceneMounts, 1);
});

test('task focus selects the same observed member for the scene, process and control target, and focuses the output region', async t => {
  const view = await fixture(t, { demoEnabled: false }, { one: snapshot([agent('first'), agent('second')], {
    events: [{ id: 'second-result', agentId: 'second', source: 'live', kind: 'result', status: 'returned', title: '已上报的第二位成员回执' }],
  }) });
  await view.input(view.container.querySelector('.office-task-focus [role="combobox"]'), 'second');
  assert.equal(view.harness.scene.selectedId, 'second');
  assert.equal(view.harness.controlTargets.at(-1).agent.id, 'second');
  assert.equal(view.harness.controlTargets.at(-1).observationKey, '2026-09-30T08:00:00Z');
  assert.match(view.container.querySelector('.office-task-focus').textContent, /已上报的第二位成员回执/);
  await view.click(view.button('查看工作过程'));
  assert.match(document.querySelector('[role="dialog"]').textContent, /Agent second/);
  await act(async () => document.querySelector('[aria-label="关闭员工过程"]').click());
  await view.click(view.button('查看产出与位置 ↓'));
  assert.equal(document.activeElement, view.container.querySelector('.office-output-anchor'));
  assert.deepEqual(view.harness.fetches, []);
});

test('live task submission selects only an accepted session and passes its existing stream and stop status', async t => {
  const submitted = [];
  const stream = { phase: 'running', turnId: 'turn-two', blocks: [] };
  const stop = () => {};
  const view = await fixture(t, { demoEnabled: false, sessions: [session('one'), session('two')], streams: { two: stream },
    stoppingSessions: { two: true }, stopErrors: { two: '等待确认' }, onStopTask: stop,
    onStartTask: request => { submitted.push(request); return request.message === 'reject' ? null : 'two'; },
  });
  assert.equal(view.harness.composer.session.id, 'one');
  let accepted;
  const request = { sessionId: null, message: '开始新任务', modelRef: 'channel/model' };
  await act(async () => { accepted = view.harness.composer.onSubmit(request); });
  assert.equal(accepted, true);
  assert.deepEqual(submitted, [request]);
  assert.equal(view.harness.composer.session.id, 'two');
  assert.equal(view.harness.composer.stream, stream);
  assert.equal(view.harness.composer.stopping, true);
  assert.equal(view.harness.composer.stopError, '等待确认');
  assert.equal(view.harness.composer.onStop, stop);
  await act(async () => { accepted = view.harness.composer.onSubmit({ sessionId: 'two', message: 'reject' }); });
  assert.equal(accepted, false);
  assert.equal(view.harness.composer.session.id, 'two');
  assert.deepEqual(view.harness.fetches, []);
});

test.after(async () => { await window.happyDOM.abort(); window.close(); });
