import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// Actual components and hooks in a simulated DOM. Use jsdom for DOMPurify:
// Happy DOM does not provide a reliable security-sanitization environment.
// Clipboard/network/scroll are substitutes, not real browser or layout tests.
globalThis.window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://easel.test/' }).window;
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
Object.defineProperty(navigator, 'clipboard', { value: { async writeText() {} }, configurable: true });
window.matchMedia = () => ({ matches: false });
window.HTMLElement.prototype.scrollTo = function ({ top }) { this.scrollTop = top; };
const { createRoot } = await import('react-dom/client');
const { default: ChatPage } = await loadTsModule('../src/components/ChatPage.tsx', import.meta.url);
const { default: ActivityPage } = await loadTsModule('../src/components/ActivityPage.tsx', import.meta.url);
const { useChatSkillAudits } = await loadTsModule('../src/hooks/useChatSkillAudits.ts', import.meta.url);
const { renderMarkdown } = await loadTsModule('../src/lib/sanitize.ts', import.meta.url);

function fixture(t) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (...args) => {
    requests.push(args);
    return { ok: true, json: async () => ({ records: [] }) };
  });
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return {
    container, requests,
    render: async (element) => act(async () => root.render(element)),
    click: async (element) => act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))),
  };
}

function imported(overrides = {}) {
  return {
    id: 'backup-copy', title: '导入的创作记录', created: 123,
    importedFromBackup: true,
    messages: [
      { role: 'user', content: '第一轮问题', turnId: 'original-turn-a', selectedSkills: ['sample-skill'] },
      { role: 'assistant', content: '第一轮备份答复', turnId: 'original-turn-a' },
      { role: 'user', content: '第二轮问题', turnId: 'original-turn-b' },
      { role: 'assistant', content: '第二轮备份答复', turnId: 'original-turn-b' },
    ],
    ...overrides,
  };
}

function callbacks() {
  const calls = { send: 0, stop: 0, resend: 0, question: 0, audit: 0, newChat: 0 };
  return {
    calls,
    props: {
      onSend: () => { calls.send++; },
      onStop: () => { calls.stop++; },
      onResend: () => { calls.resend++; },
      onQuestionAnswered: () => { calls.question++; },
      onOpenAudit: () => { calls.audit++; },
      onNewChat: () => { calls.newChat++; },
    },
  };
}

const forgedStream = {
  content: '不应显示的实时正文', thinking: '不应显示的实时思考',
  activity: '不应显示的执行态', stillWorking: '不应显示的心跳',
  questions: [{ questionId: 'forged-question', questions: [{ questionId: 'one', question: '不应显示的问答', options: [] }] }],
};

test('an imported chat stays read-only despite forged stream and pending state, preserving copy and turn navigation', async (t) => {
  const view = fixture(t);
  const actions = callbacks();
  const copied = [];
  t.mock.method(navigator.clipboard, 'writeText', async (text) => { copied.push(text); });
  const session = imported({ pendingTurnId: 'forged-pending', backupIncomplete: true });
  session.messages.at(-1).error = { category: 'authentication', message: '合成认证失败', code: 'QA_AUTH', historical: true };
  await view.render(createElement(ChatPage, {
    session,
    stream: forgedStream, ...actions.props,
  }));

  const notice = view.container.querySelector('[aria-label="导入记录说明"]');
  assert.match(notice.textContent, /只读记录/);
  assert.match(notice.textContent, /不会恢复后台上下文/);
  assert.match(view.container.querySelector('.chat-backup-incomplete')?.textContent || '', /内容可能不完整/);
  assert.equal(view.container.querySelector('.chat-input-inner,textarea,[contenteditable="true"]'), null);
  assert.equal(view.container.querySelector('[title="重新生成"]'), null);
  assert.equal(view.container.querySelector('.chat-skill-evidence'), null);
  assert.equal(view.container.querySelector('.streaming-cursor,.live-pulse,.typing-indicator'), null);
  assert.match(view.container.querySelector('.chat-response-error-hint').textContent, /需要继续时请新建对话/);
  assert.doesNotMatch(view.container.querySelector('.chat-response-error-hint').textContent, /重新发送|重试/);
  assert.doesNotMatch(view.container.textContent, /不应显示/);
  assert.deepEqual(view.requests, []);

  await view.click(view.container.querySelector('button[title="复制"]'));
  assert.deepEqual(copied, ['第一轮问题']);
  assert.match(view.container.querySelector('button[title="复制"]')?.textContent || '', /已复制/);

  const scroller = view.container.querySelector('.chat-messages');
  t.mock.method(scroller, 'scrollTo', ({ top }) => { scroller.scrollTop = top; });
  const nodes = [...view.container.querySelectorAll('.chat-turn-node-list button')];
  assert.equal(nodes.length, 2);
  await view.click(nodes[0]);
  assert.equal(nodes[0].getAttribute('aria-current'), 'step');
  assert.equal(document.activeElement?.getAttribute('aria-label'), '第 1 轮对话');
  await view.click(view.container.querySelector('button[aria-label="跳转下一轮对话"]'));
  assert.equal(nodes[1].getAttribute('aria-current'), 'step');
  await view.click(view.container.querySelector('button[aria-label="回到底部并跟随最新回复"]'));
  assert.equal(nodes[1].getAttribute('aria-current'), 'step');

  await view.click([...notice.querySelectorAll('button')].find((button) => button.textContent === '新建对话继续'));
  assert.deepEqual(actions.calls, { send: 0, stop: 0, resend: 0, question: 0, audit: 0, newChat: 1 });
  assert.deepEqual(view.requests, []);
});

test('an empty imported snapshot never mounts welcome suggestions or a composer', async (t) => {
  const view = fixture(t);
  const actions = callbacks();
  await view.render(createElement(ChatPage, {
    session: imported({ messages: [], backupIncomplete: false }),
    stream: forgedStream, ...actions.props,
  }));
  assert.match(view.container.textContent, /这份备份没有可显示的消息/);
  assert.equal(view.container.querySelector('.chat-welcome-page,.suggestions,.chat-input-inner,textarea'), null);
  assert.equal(view.container.querySelector('.chat-backup-incomplete'), null);
  assert.equal(view.container.querySelector('[aria-label="对话轮次导航"]'), null);
  assert.deepEqual(view.requests, []);
  assert.equal(actions.calls.send, 0);
});

test('imported Markdown retains text formatting and safe links without automatic media or executable markup', async (t) => {
  const view = fixture(t);
  const actions = callbacks();
  const content = [
    '**保留粗体**，以及 [安全链接](https://example.invalid/read)。',
    '',
    '| 项目 | 内容 |', '| --- | --- |', '| 备份 | 文本 |',
    '',
    '```js', 'const answer = 42;', '```',
    '',
    '![markdown image](/api/implicit-markdown-resource)',
    '<img src="/api/implicit-html-resource" onerror="window.unexpectedExecution = true">',
    '<video poster="/api/poster" src="/api/video"><source src="/api/source"></video>',
    '<audio src="/api/audio"></audio><iframe src="/api/frame"></iframe>',
    '<object data="/api/object"></object><embed src="/api/embed">',
    '<svg><image href="/api/vector"></image></svg><math href="/api/math">x</math>',
    '<style>@import url("/api/style");</style><link rel="stylesheet" href="/api/link">',
    '<input type="image" src="/api/input"><script>window.unexpectedExecution = true</script>',
    '<p style="background:url(/api/background)" onclick="window.unexpectedExecution = true">普通文字</p>',
    '<a href="javascript:alert(1)" ping="/api/ping">不安全链接</a>',
  ].join('\n');
  await view.render(createElement(ChatPage, {
    session: imported({ messages: [
      { role: 'user', content: '备份正文' },
      { role: 'assistant', content, thinking: '备份思考', activity: '备份声明的活动' },
    ] }),
    ...actions.props,
  }));
  const bubble = view.container.querySelector('.message-bubble.assistant');
  assert.equal(bubble.querySelector('img,picture,video,audio,source,iframe,object,embed,svg,math,style,link,input,script'), null);
  assert.equal(bubble.querySelector('[style],[onclick],[onerror],[src],[srcset],[ping]'), null);
  assert.equal(bubble.querySelector('strong')?.textContent, '保留粗体');
  assert.ok(bubble.querySelector('table'));
  assert.match(bubble.querySelector('pre code')?.textContent || '', /const answer = 42/);
  assert.equal(bubble.querySelector('a[href]')?.getAttribute('href'), 'https://example.invalid/read');
  assert.equal([...bubble.querySelectorAll('a')].find((link) => link.textContent === '不安全链接')?.getAttribute('href'), null);
  assert.match(view.container.querySelector('.chat-backup-notice').textContent, /媒体不会自动载入/);
  assert.match(bubble.querySelector('.thinking-block summary')?.textContent || '', /备份活动文字/);
  assert.match(bubble.textContent, /未经本机后台核验/);
  await view.click(bubble.querySelector('.model-thinking-toggle'));
  assert.match(bubble.querySelector('.model-thinking-body').textContent, /备份保留的思考文字，未经本机后台核验/);
  assert.equal(window.unexpectedExecution, undefined);
  assert.deepEqual(view.requests, []);
});

test('ordinary conversation Markdown keeps its existing sanitized image support', () => {
  const rendered = renderMarkdown('![ordinary image](https://example.invalid/normal.png)');
  assert.match(rendered, /<img /);
  assert.match(rendered, /https:\/\/example\.invalid\/normal\.png/);
  assert.doesNotMatch(renderMarkdown('<img src="x" onerror="alert(1)">'), /onerror/);
});

test('disabling the audit hook aborts the original request and ignores its late result', async (t) => {
  const view = fixture(t);
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  let calls = 0, signal;
  t.mock.method(globalThis, 'fetch', (_url, options) => {
    calls++;
    signal = options.signal;
    return pending;
  });
  function Harness({ disabled, id = 'live-session' }) {
    const value = useChatSkillAudits(id, true, 2, disabled);
    return createElement('output', null, JSON.stringify(value));
  }
  await view.render(createElement(Harness, { disabled: false }));
  assert.equal(calls, 1);
  assert.equal(signal.aborted, false);
  await view.render(createElement(Harness, { disabled: true }));
  assert.equal(signal.aborted, true);
  await act(async () => finish({ ok: true, json: async () => ({ records: [{ sessionId: 'live-session', turnId: 'old' }] }) }));
  assert.deepEqual(JSON.parse(view.container.textContent), { records: [], error: '' });
  await view.render(createElement(Harness, { disabled: false, id: '' }));
  assert.equal(calls, 1, 'an empty identifier must never initiate a backend query');
});

test('Activity keeps imported snapshots out of live counts and never mounts usage or audit queries', async (t) => {
  const view = fixture(t);
  const session = imported({ backupIncomplete: true });
  const props = { sessions: [session], activeSessionId: session.id, streams: { [session.id]: forgedStream } };
  await view.render(createElement(ActivityPage, props));
  assert.equal(view.container.querySelector('.activity-live-count').textContent, '0 个会话正在运行');
  assert.match(view.container.querySelector('.activity-session-rows').textContent, /备份副本/);
  assert.equal(view.container.querySelector('.activity-session-state').textContent, '备份副本');
  assert.match(view.container.querySelector('.activity-detail').textContent, /备份记录不包含真实后台用量或 Skill 证据/);
  assert.match(view.container.querySelector('.activity-detail').textContent, /未完成的对话快照/);
  assert.equal(view.container.querySelector('[role="tablist"],[role="tabpanel"]'), null);
  assert.deepEqual(view.requests, []);

  await view.render(createElement(ActivityPage, { ...props, target: { sessionId: session.id, turnId: 'forged-backend-turn' } }));
  assert.equal(view.container.querySelector('[role="tabpanel"]'), null);
  assert.deepEqual(view.requests, []);
  const running = [...view.container.querySelectorAll('.activity-filters button')].find((button) => button.textContent === '运行中');
  await view.click(running);
  assert.equal(view.container.querySelector('.activity-session-rows button'), null);
  assert.match(view.container.querySelector('.activity-detail').textContent, /请调整会话筛选/);
  assert.deepEqual(view.requests, []);
});

test.after(async () => {
  window.close();
});
