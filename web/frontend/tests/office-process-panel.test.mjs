import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// Actual selectors/component in a simulated DOM. No browser or backend calls.
const window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://easel.test/' }).window;
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Node: window.Node, getComputedStyle: window.getComputedStyle.bind(window) });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: OfficeProcessPanel } = await loadTsModule('../src/components/agent-office/OfficeProcessPanel.tsx', import.meta.url);
const { selectOfficeProcess, selectOfficeEventSteps } = await loadTsModule('../src/components/agent-office/officeProcessData.ts', import.meta.url);
const rootAgent = { id: 'root:session-a', name: '主 Agent', role: '任务协调', task: '核对资料', state: 'working', source: 'live' };
const childAgent = { id: 'child-a', parentId: 'root:session-a', name: '研究子 Agent', role: '协作 Agent', task: '整理摘要', state: 'thinking', source: 'live' };
const session = {
  id: 'session-a', title: '准确归属', created: 1, pendingTurnId: 'turn-current', messages: [
    { role: 'assistant', turnId: 'turn-old', content: '旧答案', thinking: '准确的旧轮思考', activity: '旧轮已保存步骤' },
    { role: 'assistant', turnId: 'turn-other', content: '其他答案', thinking: '不应使用的另轮思考', activity: '不应使用的另轮步骤' },
  ],
};
const stream = { content: '当前答案', thinking: '模型实际返回的当前思考', activity: '已上报当前活动', questions: [] };
const op1 = 'a'.repeat(24), op2 = 'b'.repeat(24);
function event(id, patch = {}) {
  return { id, agentId: rootAgent.id, kind: 'call', title: '调用工具：read_file', status: 'called', source: 'live', toolName: 'read_file', operationId: op1, ...patch };
}

test('root thinking is read only from the exact session and current turn, with exact history as the sole fallback', () => {
  const current = selectOfficeProcess({ agent: rootAgent, session, stream, turnId: 'turn-current' });
  assert.equal(current.thinking, stream.thinking);
  assert.equal(current.activity, stream.activity);
  assert.equal(current.origin, 'stream');
  const old = selectOfficeProcess({ agent: rootAgent, session, stream, turnId: 'turn-old' });
  assert.equal(old.thinking, '准确的旧轮思考');
  assert.equal(old.activity, '旧轮已保存步骤');
  assert.equal(old.origin, 'history');
  for (const patch of [
    { turnId: 'missing-turn' }, { turnId: null },
    { session: { ...session, id: 'session-b' } },
    { session: { ...session, importedFromBackup: true } },
    { agent: { ...rootAgent, id: 'apparently-root', role: '任务协调' } },
  ]) {
    const result = selectOfficeProcess({ agent: rootAgent, session, stream, turnId: 'turn-current', ...patch });
    assert.equal(result.thinking, '');
    assert.equal(result.activity, '');
    assert.equal(result.origin, 'unavailable');
  }
});

test('a child never inherits the root thinking or activities, including matching parent turn IDs', () => {
  const child = selectOfficeProcess({ agent: childAgent, session, stream, turnId: 'turn-current' });
  assert.equal(child.thinking, '');
  assert.equal(child.activity, '');
  assert.match(child.explanation, /子 Agent 未上报/);
  assert.match(child.explanation, /不使用主 Agent/);
});

test('model thinking remains unavailable when the service sends status text only', () => {
  const result = selectOfficeProcess({ agent: { ...rootAgent, state: 'thinking' }, session, stream: { ...stream, thinking: '', stillWorking: '正在思考…' }, turnId: 'turn-current' });
  assert.equal(result.thinking, '');
  assert.equal(result.activity, stream.activity);
  assert.equal(result.origin, 'stream');
});

test('call/result pairing uses exact operation and tool identity, filters foreign agents/sources and keeps unpaired receipts', () => {
  const events = [
    event('call-one', { at: '2026-10-01T01:00:00Z' }),
    event('foreign-child', { agentId: childAgent.id, kind: 'result', status: 'returned' }),
    event('foreign-demo', { source: 'demo', kind: 'result', status: 'returned' }),
    event('wrong-operation', { kind: 'result', status: 'returned', operationId: op2 }),
    event('wrong-tool', { kind: 'result', status: 'returned', toolName: 'write_file' }),
    event('result-one', { kind: 'result', title: '工具已返回', status: 'returned', at: '2026-10-01T01:00:05Z' }),
    event('call-no-id', { operationId: undefined }),
    event('result-no-id', { kind: 'result', operationId: undefined, status: 'returned' }),
  ];
  const steps = selectOfficeEventSteps(rootAgent, events, 'turn-current');
  assert.equal(steps.length, 5);
  const pair = steps.find(step => step.event.id === 'call-one');
  assert.equal(pair.result.id, 'result-one');
  assert.ok(steps.some(step => step.event.id === 'wrong-operation' && !step.result));
  assert.ok(steps.some(step => step.event.id === 'wrong-tool' && !step.result));
  assert.ok(steps.some(step => step.event.id === 'call-no-id' && !step.result));
  assert.equal(selectOfficeEventSteps(rootAgent, events, null).length, 0, 'live events without a snapshot turn ID are not assigned to a guessed turn');
  assert.equal(selectOfficeEventSteps(childAgent, events, 'turn-current').length, 1);
});

test('ambiguous or invalid operation IDs cannot collapse unrelated calls into an apparent success', () => {
  const duplicate = selectOfficeEventSteps(rootAgent, [event('a'), event('b'), event('result', { kind: 'result', status: 'returned' })], 'turn-current');
  assert.equal(duplicate.length, 3);
  assert.ok(duplicate.every(step => !step.result));
  const invalid = selectOfficeEventSteps(rootAgent, [event('a', { operationId: 'unsafe-op' }), event('result', { kind: 'result', status: 'returned', operationId: 'unsafe-op' })], 'turn-current');
  assert.equal(invalid.length, 2);
});

async function fixture(t, props = {}) {
  const calls = { closed: 0, chat: 0 };
  const trigger = document.createElement('button'); trigger.textContent = '员工状态入口'; document.body.append(trigger); trigger.focus();
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const originalOverflow = document.body.style.overflow;
  let currentProps = { agent: rootAgent, events: [], session, stream, turnId: 'turn-current', stale: false,
    onClose: () => calls.closed++, onOpenChat: () => calls.chat++, ...props };
  let mounted = true;
  const render = async patch => { currentProps = { ...currentProps, ...patch }; await act(async () => root.render(createElement(OfficeProcessPanel, currentProps))); };
  const unmount = async () => { if (mounted) { await act(async () => root.unmount()); mounted = false; } };
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Process panel must not fetch'); });
  t.after(async () => { await unmount(); host.remove(); trigger.remove(); });
  await render();
  return { calls, trigger, originalOverflow, render, unmount,
    dialog: () => document.querySelector('[role="dialog"]'),
    click: async target => act(async () => target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))),
    key: async (key, shiftKey = false) => act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }))),
  };
}

test('dialog keeps long actual thinking readable as text, exposes accurate identity and never dumps tool parameters', async t => {
  const thinking = '实际模型内容 <script>不会执行</script>\n'.repeat(500);
  const view = await fixture(t, {
    agent: { ...rootAgent, appearance: { name: '自定义员工名' } },
    stream: { ...stream, thinking },
    events: [event('read', { rawArguments: { api_key: 'DO_NOT_SHOW_ARGUMENTS' }, rawOutput: 'DO_NOT_SHOW_RAW_OUTPUT' })],
  });
  const dialog = view.dialog();
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.match(document.getElementById(dialog.getAttribute('aria-labelledby')).textContent, /自定义员工名/);
  assert.match(dialog.querySelector('.office-process-identity').textContent, /主 Agent/);
  assert.match(dialog.querySelector('.office-process-identity').textContent, /root:session-a/);
  assert.equal(dialog.querySelector('[data-testid="office-thinking"]').textContent, thinking);
  assert.equal(dialog.querySelector('script'), null);
  assert.doesNotMatch(dialog.textContent, /DO_NOT_SHOW_ARGUMENTS|DO_NOT_SHOW_RAW_OUTPUT/);
  assert.match(dialog.textContent, /未上报的工具输出正文不可见/);
});

test('changing to a child removes root evidence and displays only that child events without stale cached text', async t => {
  const ownEvent = event('child-progress', { agentId: childAgent.id, kind: 'status', title: '子员工已回报状态', status: 'observed' });
  const view = await fixture(t, { events: [event('root-call'), ownEvent] });
  assert.match(view.dialog().textContent, /模型实际返回的当前思考/);
  await view.render({ agent: childAgent });
  assert.doesNotMatch(view.dialog().textContent, /模型实际返回的当前思考|已上报当前活动/);
  assert.match(view.dialog().textContent, /未上报内部思考/);
  assert.match(view.dialog().textContent, /子员工已回报状态/);
  assert.doesNotMatch(view.dialog().textContent, /调用工具：read_file/);
});

test('demo process is explicitly simulated and never borrows a real session model response', async t => {
  const demo = { ...rootAgent, id: 'researcher', source: 'demo' };
  const view = await fixture(t, { agent: demo, events: [event('live'), event('demo', { agentId: 'researcher', source: 'demo', elapsedSeconds: 4, title: '模拟检索' })] });
  const text = view.dialog().textContent;
  assert.match(text, /模拟过程摘要/);
  assert.match(text, /不是模型实际返回的思考/);
  assert.match(text, /模拟检索/);
  assert.doesNotMatch(text, /模型实际返回的当前思考|已上报当前活动/);
  assert.equal(view.dialog().querySelector('.office-process-open-chat'), null);
});

test('error, completion, stopped and stale feedback preserves received evidence without inventing outcomes', async t => {
  const exactSession = { ...session, messages: [...session.messages, { role: 'assistant', turnId: 'turn-error', content: '', thinking: '已收到的思考', activity: '已报告步骤', error: { message: '工具无法读取目标文件', code: 'READ_FAILED' } }] };
  const view = await fixture(t, { agent: { ...rootAgent, state: 'error' }, session: exactSession, turnId: 'turn-error',
    events: [event('call'), event('failed', { kind: 'result', title: '工具失败回执', status: 'failed' })] });
  assert.match(view.dialog().textContent, /本轮已记录错误/);
  assert.match(view.dialog().textContent, /工具无法读取目标文件/);
  assert.match(view.dialog().textContent, /已报告失败/);
  assert.equal(view.dialog().querySelectorAll('.office-process-step').length, 1);
  await view.render({ agent: { ...rootAgent, state: 'stopped' }, stale: true });
  assert.match(view.dialog().textContent, /快照 · 已停止/);
  assert.match(view.dialog().textContent, /观测更新已中断/);
  assert.match(view.dialog().textContent, /已收到的思考/);
  await view.render({ agent: { ...rootAgent, state: 'done' }, stale: false, events: [event('unreturned')] });
  assert.match(view.dialog().textContent, /已上报完成/);
  assert.match(view.dialog().textContent, /尚无匹配回执/);
  assert.doesNotMatch(view.dialog().querySelector('.office-process-timeline').textContent, /已收到回执/);
});

test('modal focuses its close action, traps keyboard focus, handles Escape and restores the opener on unmount', async t => {
  const view = await fixture(t);
  const close = view.dialog().querySelector('[aria-label="关闭员工过程"]');
  const open = view.dialog().querySelector('.office-process-open-chat');
  assert.equal(document.activeElement, close);
  assert.equal(document.body.style.overflow, 'hidden');
  await view.key('Tab', true);
  assert.equal(document.activeElement, open);
  await view.key('Tab');
  assert.equal(document.activeElement, close);
  view.trigger.focus();
  assert.equal(document.activeElement, close, 'programmatic focus cannot escape the modal');
  await view.key('Escape');
  assert.equal(view.calls.closed, 1);
  await view.click(open);
  assert.equal(view.calls.closed, 2);
  assert.equal(view.calls.chat, 1);
  await view.unmount();
  assert.equal(document.activeElement, view.trigger);
  assert.equal(document.body.style.overflow, view.originalOverflow);
  await view.key('Escape');
  assert.equal(view.calls.closed, 2, 'keyboard listener is removed after unmount');
});

test.after(() => window.close());
