import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new Window({ url: 'http://127.0.0.1:7880/' });
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.sessionStorage = window.sessionStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const events = await loadTsModule('../src/lib/eventNotifications.ts', import.meta.url);
const { showToast, TOAST_EVENT } = await loadTsModule('../src/lib/toast.ts', import.meta.url);
const format = await loadTsModule('../src/lib/noticeFormat.ts', import.meta.url);
const { default: Center } = await loadTsModule('../src/components/EventNotificationCenter.tsx', import.meta.url);

const flush = () => new Promise(resolve => setTimeout(resolve));
const buttonText = text => [...document.querySelectorAll('.global-events-panel button')].find(button => button.textContent === text);
async function mount(t, props = {}) {
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  await act(async () => root.render(createElement(Center, { onOpen: () => {}, ...props })));
  t.after(async () => { await act(async () => root.unmount()); node.remove(); });
  return node;
}

test('toast governance keeps confirmations transient and durable events in the inbox', async () => {
  events.clearEvents();
  const toasts = []; const listener = event => toasts.push(event.detail.message);
  window.addEventListener(TOAST_EVENT, listener);
  try {
    showToast('已选择思考强度：高，下一轮生效', 'success');
    await flush();
    assert.deepEqual(toasts, ['已选择思考强度：高，下一轮生效']);
    assert.equal(events.readEvents().length, 0, 'a confirmation toast must not enter the notification inbox');
    showToast('对话 · 已完成', 'success', undefined, 'chat:s1:t1:已完成', { page: 'chat', sessionId: 's1' });
    await flush();
    assert.equal(events.readEvents().length, 1);
    assert.equal(events.readEvents()[0].id, 'chat:s1:t1:已完成');
    showToast('对话 · 已完成', 'success', undefined, 'chat:s1:t1:已完成', { page: 'chat', sessionId: 's1' });
    await flush();
    assert.equal(toasts.length, 2, 'a duplicate durable id is suppressed instead of re-toasting');
  } finally { window.removeEventListener(TOAST_EVENT, listener); }
});

test('notification subjects bound long titles and keep URLs readable', () => {
  assert.equal(format.noticeSubject('拆解 · https://www.zhihu.com/question/123 · 已完成', '对话'), '拆解 · zhihu.com · 已完成');
  assert.equal(format.noticeSubject('  多   空格   标题  ', '对话'), '多 空格 标题');
  assert.equal(format.noticeSubject('', '对话'), '对话');
  assert.equal(format.noticeSubject(undefined, '对话'), '对话');
  const short = '这是一个特别特别长的会话标题需要被截断处理一下';
  assert.equal(format.noticeSubject(short, '对话'), short, 'subjects within the bound stay unchanged');
  const long = short + '再加一段让长度超过限制的补充文字';
  assert.equal(format.noticeSubject(long, '对话'), long.slice(0, 24) + '…');
});

test('legacy confirmation records are classified for one-tap cleanup', () => {
  assert.equal(format.isLegacyTransientNotice('已选择思考强度：Ultra，下一轮生效'), true);
  assert.equal(format.isLegacyTransientNotice('已引用到输入框，可继续编辑；尚未发送。'), true);
  assert.equal(format.isLegacyTransientNotice('已保存对话标题'), true);
  assert.equal(format.isLegacyTransientNotice('对话 · 已完成'), false);
  assert.equal(format.isLegacyTransientNotice('小红书 · 发布状态待核验'), false);
  assert.equal(format.isLegacyTransientNotice('抓取失败：网络错误'), false);
});

test('cleanup removes only confirmed noise, verifies via its own route and never revives records', async t => {
  events.clearEvents();
  const server = new Map(); const serverSeen = new Set(); const requests = [];
  let removeRoute = true;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    const isRemove = String(url).endsWith('/api/notifications/remove');
    requests.push({ url, method: init.method || 'GET', body });
    if (isRemove) {
      if (!removeRoute) return new Response(JSON.stringify({ detail: 'Not Found' }), { status: 404 });
      for (const id of body.ids) { server.delete(id); serverSeen.add(id); }
      return new Response(JSON.stringify({ ok: true }));
    }
    if (init.method === 'POST' && !String(url).endsWith('/read')) {
      for (const row of body.notices) if (!serverSeen.has(row.id)) { serverSeen.add(row.id); server.set(row.id, { ...row, read: false }); }
    } else if (init.method === 'DELETE') {
      server.clear();
    }
    return new Response(JSON.stringify({ notices: [...server.values()], seen: [...serverSeen] }));
  });
  // Rows an older build persisted for its confirmation toasts.
  events.recordEvent('已选择思考强度：自适应最高，下一轮生效', 'success', undefined, 'legacy-noise');
  events.recordEvent('拆解 · zhihu.com · 已完成', 'success', undefined, 'real-done', { page: 'chat', sessionId: 's1' });
  await events.syncEvents();
  assert.equal(server.size, 2);
  const afterSeed = requests.length; // the opening clearEvents() legitimately used DELETE
  const node = await mount(t);
  await act(async () => node.querySelector('button').click());
  assert.equal(document.querySelectorAll('.event-card').length, 2);
  const clean = buttonText('清理 1 条提示记录');
  assert.ok(clean, 'the cleanup action is offered only when confirmed noise exists');
  const toasts = []; const listener = event => toasts.push(event.detail.message);
  window.addEventListener(TOAST_EVENT, listener);
  try {
    // A stale backend without the dedicated route must fail closed and keep records.
    removeRoute = false;
    await act(async () => { clean.click(); await flush(); });
    assert.equal(events.readEvents().length, 2, 'a failed cleanup must not hide records locally');
    assert.match(toasts.at(-1), /清理未生效/);
    assert.ok(buttonText('清理 1 条提示记录'), 'the action stays available for a retry');
    removeRoute = true;
    await act(async () => { buttonText('清理 1 条提示记录').click(); await flush(); });
    assert.equal(events.readEvents().map(row => row.id).join(','), 'real-done');
    assert.match(toasts.at(-1), /已清理 1 条提示记录/);
  } finally { window.removeEventListener(TOAST_EVENT, listener); }
  assert.equal(document.querySelectorAll('.event-card').length, 1);
  assert.equal(buttonText('清理 1 条提示记录'), undefined, 'the action disappears once no noise remains');
  assert.deepEqual(requests.filter(request => request.url.endsWith('/remove')).at(-1).body, { ids: ['legacy-noise'] });
  assert.equal(server.has('legacy-noise'), false);
  // The clear-all DELETE is never used for targeted cleanup.
  assert.equal(requests.slice(afterSeed).some(request => request.method === 'DELETE'), false);
  // Another stale tab pushing the removed record again must not revive it.
  await fetch('/api/notifications', { method: 'POST', body: JSON.stringify({ notices: [{ id: 'legacy-noise', message: '已选择思考强度：高，下一轮生效', tone: 'success', at: Date.now(), read: false }] }) });
  const listed = await (await fetch('/api/notifications')).json();
  assert.deepEqual(listed.notices.map(row => row.id), ['real-done']);
});

test('storage explanation is an info trigger instead of a collapsed block', async t => {
  const node = await mount(t);
  await act(async () => node.querySelector('button').click());
  const trigger = document.querySelector('[aria-label="通知存储说明"]');
  assert.ok(trigger, 'the explanation moved to an info trigger');
  assert.equal(document.querySelector('.event-history-note details'), null);
  await act(async () => trigger.focus());
  const tip = document.querySelector('.inline-info-tooltip');
  assert.ok(tip, 'hover/focus opens the tooltip');
  assert.match(tip.textContent, /最近1000条/);
  await act(async () => trigger.blur());
  assert.equal(document.querySelector('.inline-info-tooltip'), null);
});
