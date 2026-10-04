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

test('persisted thinking panel keeps character count and expands on click', async t => {
  const container = await mount(t, { message: { role: 'assistant', content: '答案', thinking: '推理过程' } });
  const toggle = container.querySelector('.model-thinking-toggle');
  assert.match(toggle.textContent, /4 字符/);
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
