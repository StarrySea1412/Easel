import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// MessageBubble: markdown stays sanitized, attachment-only user turns render
// nothing, streaming states show live panels, and copy/retry actions report.
// jsdom (not happy-dom) hosts DOMPurify, matching backup-chat-page conventions.
globalThis.window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://easel.test/' }).window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: MessageBubble } = await loadTsModule('../src/components/MessageBubble.tsx', import.meta.url);
const { default: ChatSkillEvidence } = await loadTsModule('../src/components/ChatSkillEvidence.tsx', import.meta.url);

async function mount(t, props) {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(MessageBubble, props)));
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  return container;
}

test('attachment-only user turn renders nothing; text turns show content', async t => {
  const empty = await mount(t, { message: { role: 'user', content: '  ', attachments: [{ id: 'x', name: 'f.txt', path: '_inbox/f.txt' }] } });
  assert.equal(empty.querySelector('.message-bubble'), null, 'no bubble for attachment-only turn');

  const visible = await mount(t, { message: { role: 'user', content: '你好' } });
  assert.match(visible.textContent, /你好/);
});

test('assistant markdown renders as sanitized html without raw script injection', async t => {
  const container = await mount(t, { message: { role: 'assistant', content: '# 标题\n\n<script>alert(1)</script>\n\n正文 **加粗**' } });
  assert.equal(container.querySelector('script'), null, 'script tags are stripped');
  assert.equal(container.querySelectorAll('h1').length, 1);
  assert.ok(container.textContent.includes('加粗') || container.querySelector('strong'), 'markdown is rendered');
});

test('streaming bubble shows typing indicator before any content arrives', async t => {
  const container = await mount(t, { message: { role: 'assistant', content: '' }, isStreaming: true });
  assert.ok(container.querySelector('.typing-indicator'), 'typing dots appear');
  assert.match(container.textContent, /等待模型响应/);
});

test('waiting turns show a running clock and completed failures retain a frozen duration', async t => {
  t.mock.method(Date, 'now', () => 100000);
  const waiting = await mount(t, { message: { role: 'assistant', content: '', startedAt: 92000 }, isStreaming: true });
  assert.match(waiting.textContent, /已用时 8秒/);
  const failed = await mount(t, { message: { role: 'assistant', content: '', startedAt: 1000, elapsedMs: 65000,
    error: { code: 'fixture', message: '失败' } } });
  assert.match(failed.textContent, /耗时 1分5秒/);
  const old = await mount(t, { message: { role: 'assistant', content: 'old' } });
  assert.equal(old.querySelector('.message-turn-elapsed'), null);
});

test('streaming with live activity shows the pulse and heartbeat hint, not the wait state', async t => {
  const container = await mount(t, {
    message: { role: 'assistant', content: '部分回复' }, isStreaming: true,
    activity: '正在执行技能', stillWorking: '未卡住',
  });
  assert.match(container.textContent, /正在执行技能/);
  assert.match(container.textContent, /未卡住/);
  assert.equal(container.querySelector('.typing-indicator'), null);
  assert.ok(container.querySelector('.streaming-cursor'), 'cursor shows during streaming');
});

test('work progress keeps the observed event order and labels heartbeat separately', async t => {
  const container = await mount(t, {
    message: { role: 'assistant', content: '部分回复' }, isStreaming: true,
    activity: '已进入运行器，等待模型事件',
    activitySteps: ['请求已接收，等待运行器确认', '已进入运行器，等待模型事件'],
    stillWorking: '连接保持中 · 暂无新进度',
  });
  const panel = container.querySelector('.work-progress');
  assert.ok(panel);
  assert.equal(panel.querySelectorAll('.work-progress-step').length, 2);
  assert.match(panel.textContent, /已接收请求/);
  assert.match(panel.textContent, /最新事件 · 实时/);
  assert.match(panel.textContent, /连接保持中/);
  assert.match(panel.textContent, /心跳提示，不代表新的工作步骤/);
  assert.equal(panel.querySelectorAll('.work-progress-step.is-current').length, 1);
});

test('finished work progress exposes a saved terminal state without a live pulse', async t => {
  const container = await mount(t, {
    message: { role: 'assistant', content: '', stopped: true, activity: '请求已接收，等待运行器确认\n正在自动续接' },
  });
  const panel = container.querySelector('.work-progress-history');
  assert.ok(panel);
  assert.match(panel.textContent, /已停止/);
  assert.match(panel.textContent, /备份记录|服务事件/);
  assert.equal(panel.querySelector('.live-pulse'), null);
});

test('persisted thinking panel labels estimated tokens and expands on click', async t => {
  const container = await mount(t, { message: { role: 'assistant', content: '答案', thinking: '推理过程' } });
  const toggle = container.querySelector('.model-thinking-toggle');
  assert.match(toggle.textContent, /≈ 4 tokens/);
  assert.match(toggle.textContent, /已保留/);
  assert.equal(container.querySelector('.model-thinking-body'), null, 'collapsed by default after streaming');
  await act(async () => toggle.click());
  assert.ok(container.querySelector('.model-thinking-body'), 'expands on click');
  assert.match(container.querySelector('.model-thinking-text').textContent, /推理过程/);
});

test('copy action reflects copied state and retry only appears when allowed', async t => {
  const attempts = []; const copied = [];
  const container = await mount(t, {
    message: { role: 'assistant', content: '内容' },
    actions: { onCopy: async () => copied.push(1), onRetry: () => attempts.push(1), canModify: true },
  });
  const buttons = [...container.querySelectorAll('.msg-action')];
  assert.equal(buttons.length, 2, 'copy + retry are both visible');
  await act(async () => buttons.find(b => b.title === '复制').click());
  assert.equal(copied.length, 1);
  assert.match(container.textContent, /已复制/);

  const noRetry = await mount(t, {
    message: { role: 'assistant', content: '内容' },
    actions: { onCopy: async () => {}, canModify: false },
  });
  assert.equal([...noRetry.querySelectorAll('.msg-action')].find(b => b.title === '重新生成'), undefined);
});

test('assistant error renders an alert with code and authentication guidance', async t => {
  const container = await mount(t, {
    message: { role: 'assistant', content: '', error: { message: '密钥无效', code: 'AUTH_FAILED', category: 'authentication' } },
  });
  const alert = container.querySelector('[role="alert"]');
  assert.ok(alert);
  assert.match(alert.textContent, /密钥无效/);
  assert.match(alert.textContent, /错误代码：AUTH_FAILED/);
  assert.match(alert.textContent, /请先检查服务凭据与授权/);
});

test('skill status shares the copy/retry action bar; the evidence panel opens on hover with the invocation verdict', async t => {
  const container = await mount(t, {
    message: { role: 'assistant', content: '内容' },
    actions: { onCopy() {}, onRetry() {}, canModify: true },
    status: createElement(ChatSkillEvidence, {
      sessionId: 'sample', turnId: 'turn', streaming: false, selectedSkills: ['card-quote'],
      record: { sessionId: 'sample', turnId: 'turn', status: 'complete', invocation: [{ skill: 'card-quote', status: 'loaded', evidence: [] }] },
    }),
  });
  const bar = container.querySelector('.msg-actions');
  const icon = container.querySelector('.chat-skill-status-icon');
  assert.equal(container.querySelectorAll('.msg-actions').length, 1);
  assert.ok(bar.contains(icon));
  assert.equal(bar.querySelectorAll('.msg-action').length, 2);
  assert.equal(icon.getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelector('.chat-skill-evidence'), null);
  assert.match(icon.getAttribute('aria-label'), /card-quote：已读取说明/);
  await act(async () => { icon.dispatchEvent(new window.PointerEvent('pointerover', { bubbles: true })); });
  assert.equal(icon.getAttribute('aria-expanded'), 'true');
  const panel = document.querySelector('.chat-skill-evidence');
  assert.ok(panel, 'hover opens the floating evidence panel');
  assert.match(panel.textContent, /本轮未观察到 Skill 调用证据/, 'reading a guide is not an invocation');
  assert.match(panel.textContent, /选择 Skill 或读取说明不等于执行成功/);
  await act(async () => { icon.dispatchEvent(new window.PointerEvent('pointerout', { bubbles: true })); });
  await act(async () => new Promise(resolve => setTimeout(resolve, 260)));
  assert.equal(document.querySelector('.chat-skill-evidence'), null, 'leaving the pointer closes the panel');
});

test('opening an unloaded skill verdict loads the audit once and reports what was actually called', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    assert.match(String(url), /\/api\/skill-audits\?/);
    calls += 1;
    return { ok: true, json: async () => ({ records: [{ sessionId: 'sample', turnId: 'turn', status: 'complete', invocation: [{ skill: 'card-quote', status: 'executed', evidence: [{ summary: '调用了 card-quote 工具' }] }] }] }) };
  });
  const container = await mount(t, {
    message: { role: 'assistant', content: '内容' },
    status: createElement(ChatSkillEvidence, { sessionId: 'sample', turnId: 'turn', streaming: false, selectedSkills: ['card-quote'] }),
  });
  const icon = container.querySelector('.chat-skill-status-icon');
  await act(async () => { icon.dispatchEvent(new window.PointerEvent('pointerover', { bubbles: true })); });
  await act(async () => new Promise(resolve => setTimeout(resolve, 30)));
  const panel = document.querySelector('.chat-skill-evidence');
  assert.ok(panel, 'the panel opens without a click');
  assert.equal(calls, 1, 'opening loads the audit automatically, once');
  assert.match(panel.textContent, /本轮已调用：card-quote/);
  assert.match(panel.textContent, /执行成功（有证据）/);
  assert.match(panel.textContent, /调用了 card-quote 工具/);
  await act(async () => { panel.dispatchEvent(new window.PointerEvent('pointerout', { bubbles: true })); });
  await act(async () => new Promise(resolve => setTimeout(resolve, 260)));
  assert.equal(document.querySelector('.chat-skill-evidence'), null);
});
