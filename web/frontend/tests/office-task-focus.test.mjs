import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';
import { selectOption } from './select-helpers.mjs';

// Behavioral checks of the real summary; layout and WebGL need browser QA.
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { officeTaskFocusData } = await loadTsModule('../src/components/agent-office/officeTaskFocusData.ts');
const { default: OfficeTaskFocus } = await loadTsModule('../src/components/agent-office/OfficeTaskFocus.tsx');

const agent = (id, patch = {}) => ({ id, name: `成员 ${id}`, role: '协作成员', task: `任务 ${id}`, state: 'working', source: 'live', ...patch });
const event = (id, agentId, patch = {}) => ({ id, agentId, kind: 'result', title: `回执 ${id}`, status: 'returned', source: 'live', ...patch });

test('task focus uses the selected source and explicit member, preserving receipt sequence without inferring completion', () => {
  const members = [agent('one'), agent('two', { state: 'waiting' }), agent('one', { source: 'demo', state: 'done' })];
  const receipts = [
    event('first', 'one', { at: '2026-10-08T08:00:00Z' }),
    event('other-member', 'two'),
    event('error', 'one', { status: 'failed' }),
    event('wrong-source', 'one', { source: 'demo' }),
    event('not-returned', 'one', { kind: 'call', status: 'called' }),
    event('unobserved-member', 'missing'),
  ];
  const focus = officeTaskFocusData(members, receipts, 'one', 'live');
  assert.deepEqual(focus.members.map(item => item.id), ['one', 'two']);
  assert.equal(focus.latestReturn.id, 'error');
  assert.equal(focus.agent.state, 'working', 'a failed tool receipt must not rewrite the member state');
  assert.deepEqual([focus.active, focus.waiting, focus.done], [1, 1, 0]);
  assert.equal(officeTaskFocusData(members, receipts, 'two', 'live').latestReturn.id, 'other-member');
  assert.equal(officeTaskFocusData(members, receipts, 'one', 'demo').latestReturn.id, 'wrong-source');
});

test('missing or mixed-source observations do not synthesize a task or completion percentage', () => {
  const empty = officeTaskFocusData([agent('example', { source: 'demo' })], [event('orphan', 'missing')], 'example', 'live');
  assert.equal(empty.agent, undefined);
  assert.equal(empty.latestReturn, undefined);
  assert.deepEqual(empty.members, []);
  assert.deepEqual([empty.active, empty.waiting, empty.done], [0, 0, 0]);
  const fallback = officeTaskFocusData([agent('known')], [], 'vanished', 'live');
  assert.equal(fallback.agent.id, 'known');
  assert.equal(fallback.latestReturn, undefined);
});

async function fixture(t, patch = {}) {
  const opened = [], selected = [];
  let outputs = 0;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let props = {
    agents: [agent('one'), agent('two', { state: 'waiting' })], events: [], selectedId: 'one', mode: 'live', stale: false,
    displayName: member => member.name, onSelect: id => selected.push(id), onOpenProcess: id => opened.push(id),
    onOpenOutputs: () => outputs++, children: createElement('button', { type: 'button' }, '执行控制槽'), ...patch,
  };
  const render = async next => { props = { ...props, ...next }; await act(async () => root.render(createElement(OfficeTaskFocus, props))); };
  await render({});
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  return { host, render, opened, selected, outputs: () => outputs, click: async text => {
    const button = [...host.querySelectorAll('button')].find(item => item.textContent === text);
    assert.ok(button, text);
    await act(async () => button.click());
  } };
}

test('member selection, process and output actions retain their precise targets', async t => {
  const view = await fixture(t, { events: [event('failed-step', 'one', { status: 'failed', title: '只读文件失败，尚无结果' })] });
  assert.match(view.host.textContent, /报告错误/);
  assert.match(view.host.textContent, /工具返回不等于任务完成/);
  assert.match(view.host.textContent, /整个工作区/);
  assert.match(view.host.textContent, /工作中/);
  await selectOption(view.host.querySelector('[role="combobox"]'), 'two');
  assert.deepEqual(view.selected, ['two']);
  await view.render({ selectedId: 'two' });
  assert.match(view.host.querySelector('.office-task-focus-current').textContent, /成员 two.*等待中.*任务 two/);
  assert.doesNotMatch(view.host.querySelector('.office-task-focus-records').textContent, /只读文件失败/);
  await view.click('查看工作过程 ↗');
  assert.deepEqual(view.opened, ['two']);
  await view.click('查看产出与位置 ↓');
  assert.equal(view.outputs(), 1);
  assert.ok([...view.host.querySelectorAll('button')].some(button => button.textContent === '执行控制槽'));
});

test('stale and demo boundaries remain visible while unavailable identities have no controls', async t => {
  const view = await fixture(t, { stale: true });
  assert.match(view.host.querySelector('.office-task-focus-source').textContent, /上次快照/);
  assert.match(view.host.querySelector('.office-task-focus-current').textContent, /快照/);
  await view.render({ mode: 'demo', stale: false, agents: [agent('one', { source: 'demo' })], events: [event('demo-return', 'one', { source: 'demo' })] });
  assert.match(view.host.textContent, /已返回 · 模拟/);
  assert.match(view.host.textContent, /未调用真实模型/);
  await view.render({ mode: 'live' });
  assert.match(view.host.textContent, /收到成员身份与任务记录后/);
  assert.equal(view.host.querySelector('[role="combobox"]'), null);
  assert.doesNotMatch(view.host.textContent, /执行控制槽|任务 one|回执 demo-return/);
  await view.click('查看工作区产出 ↓');
  assert.equal(view.outputs(), 1);
});

test.after(async () => { await window.happyDOM.abort(); window.close(); });
