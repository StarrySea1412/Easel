import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: Navigation } = await loadTsModule('../src/components/ChatTurnNavigation.tsx', import.meta.url);
const { chatTurnNodes } = await loadTsModule('../src/lib/chatNavigation.ts', import.meta.url);
test('preview summaries belong to their user turn and live output updates only the latest node', () => {
  const messages = [
    { role: 'assistant', content: 'orphan reply' },
    { role: 'user', content: '第一问' }, { role: 'assistant', content: '# 方案\n\n**第一轮回复**' },
    { role: 'user', content: '第二问' }, { role: 'assistant', content: '<b>第二轮回复</b>' },
  ];
  const nodes = chatTurnNodes(messages, '新流式正文');
  assert.equal(nodes[0].reply, '方案 第一轮回复');
  assert.equal(nodes[1].reply, '新流式正文');
  assert.equal(nodes[0].messageIndex, 1);
  assert.equal(chatTurnNodes([{ role: 'user', content: '第三问' }])[0].reply, undefined);
  assert.equal(chatTurnNodes([{ role: 'user', content: '长回复' }], '甲'.repeat(500))[0].reply.length, 240);
});
test('hover card shows question and answer, remains open while streamed text updates, and dismisses on click', async t => {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); const jumps = [];
  const render = async reply => act(async () => root.render(createElement(Navigation, {
    nodes: [{ messageIndex: 0, number: 1, label: '问题标题', reply }], current: 0, following: true,
    onJump: index => jumps.push(index), onLatest() {},
  })));
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await render('部分回复');
  const tick = container.querySelector('.chat-turn-tick');
  await act(async () => tick.dispatchEvent(new window.PointerEvent('pointerover', { bubbles: true })));
  assert.equal(container.querySelector('[role="tooltip"] strong').textContent, '问题标题');
  assert.equal(container.querySelector('[role="tooltip"] p').textContent, '部分回复');
  assert.equal(container.querySelector('[role="tooltip"] small'), null, 'requested footer hint is removed');
  await render('部分回复继续更新');
  assert.equal(container.querySelector('[role="tooltip"] p').textContent, '部分回复继续更新');
  await act(async () => tick.click());
  assert.deepEqual(jumps, [0]); assert.equal(container.querySelector('[role="tooltip"]'), null);
});
test('keyboard preview survives pointer leave and closes when focus moves outside', async t => {
  const container = document.createElement('div'); document.body.append(container);
  const outside = document.createElement('button'); document.body.append(outside);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); outside.remove(); });
  await act(async () => root.render(createElement(Navigation, { nodes: [{ messageIndex: 0, number: 1, label: '问题' }], current: 0, following: true, onJump() {}, onLatest() {} })));
  await act(async () => container.querySelector('.chat-turn-tick').focus());
  await act(async () => container.querySelector('.chat-turn-ticks').dispatchEvent(new window.PointerEvent('pointerout', { bubbles: true, relatedTarget: outside })));
  assert.match(container.querySelector('[role="tooltip"]').textContent, /本轮暂无回复/);
  await act(async () => outside.focus());
  assert.equal(container.querySelector('[role="tooltip"]'), null);
});
