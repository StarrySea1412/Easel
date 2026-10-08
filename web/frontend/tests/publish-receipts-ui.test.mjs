import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// Real hook, publish editor and receipt components; all HTTP, mail and platform
// operations below are controlled substitutes. This is not live publication QA.
globalThis.window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://easel.test/' }).window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: window.localStorage });
const { createRoot } = await import('react-dom/client');
const { usePublishReceipts } = await loadTsModule('../src/hooks/usePublishReceipts.ts');
const { default: PublishReceiptCenter, PublishReceiptCard } = await loadTsModule('../src/components/PublishReceiptCenter.tsx');
const { default: PublishPage } = await loadTsModule('../src/components/PublishPage.tsx');
const { default: CalendarPage } = await loadTsModule('../src/components/CalendarPage.tsx');
const { savePublishDraft } = await loadTsModule('../src/lib/store.ts');

const makeReceipt = (changes = {}) => ({
  receiptId: 'a'.repeat(32), platform: 'zhihu', title: '隔离验收样例',
  state: 'starting', outcome: null, message: '正在等待平台回执。',
  createdAt: '2026-10-08T01:00:00.000Z', updatedAt: '2026-10-08T01:00:00.000Z',
  notification: { state: 'unconfigured', message: '自动通知未开启' }, url: '', ...changes,
});
const completed = (changes = {}) => makeReceipt({
  state: 'finished', outcome: 'published', ok: true, message: '平台已确认公开发布。',
  url: 'https://zhuanlan.zhihu.com/p/12345', updatedAt: '2026-10-08T01:01:00.000Z', ...changes,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

async function fixture(t, initial = [], page = 'other') {
  localStorage.clear();
  savePublishDraft({ title: '本次要发布的标题', body: '本次内容正文。', platforms: ['zhihu'], overrides: {}, tags: '' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = {
    model: null, items: structuredClone(initial), requests: [], configured: 0, publishPageOpened: 0,
    list: null, detail: null, publish: null, sms: null, precheck: null,
    accounts: [{ platform: 'zhihu', loggedIn: true }], schedule: [], confirm: true, confirmations: [],
  };
  t.mock.method(window, 'confirm', text => { h.confirmations.push(text); return h.confirm; });
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const path = String(url);
    const request = { path, options, body: options.body ? JSON.parse(options.body) : undefined };
    h.requests.push(request);
    let result;
    if (path === '/api/publish/receipts') result = h.list ? await h.list(request) : h.items;
    else if (path.startsWith('/api/publish/receipts/')) {
      const id = path.split('/').at(-1);
      result = h.detail ? await h.detail(id, request) : h.items.find(item => item.receiptId === id);
    } else if (/^\/api\/publish\/[^/]+\/sms$/.test(path)) {
      if (!h.sms) throw new Error('No simulated SMS handler configured');
      result = await h.sms(path.split('/')[3], request.body, request);
    } else if (/^\/api\/publish\/[^/]+$/.test(path) && options.method === 'POST') {
      if (!h.publish) throw new Error('No simulated publisher configured');
      result = await h.publish(path.split('/')[3], request.body, request);
    } else if (path === '/api/accounts') result = h.accounts;
    else if (path === '/api/outputs') result = [];
    else if (path === '/api/schedule') result = h.schedule;
    else if (path.startsWith('/api/schedule/context?')) result = {};
    else if (path === '/api/chat') result = h.precheck ? await h.precheck(request) : { response: '模拟预检结果' };
    else throw new Error(`Unexpected request: ${path}`);
    return { ok: true, json: async () => structuredClone(result) };
  });
  function Shell({ page }) {
    const model = usePublishReceipts();
    h.model = model;
    return createElement('main', null,
      createElement(PublishReceiptCenter, { model, onConfigure: () => { h.configured++; }, onOpenPublish: () => { h.publishPageOpened++; } }),
      page === 'publish' ? createElement(PublishPage, { persona: '', publishReceipts: model })
        : page === 'calendar' ? createElement(CalendarPage) : createElement('section', { 'data-testid': 'other-page' }, '其他页面'),
    );
  }
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  let unmounted = false;
  const render = async nextPage => { await act(async () => root.render(createElement(Shell, { page: nextPage }))); };
  const dispose = async () => { if (!unmounted) { unmounted = true; await act(async () => root.unmount()); container.remove(); } };
  t.after(dispose);
  await render(page);
  const click = async element => { assert.ok(element, 'interaction target exists'); await act(async () => element.click()); };
  const refresh = async () => { await act(async () => { await h.model.refresh(); }); };
  const tick = async ms => { await act(async () => { t.mock.timers.tick(ms); }); };
  return {
    h, container, root, render, dispose, click, refresh, tick,
    model: () => h.model,
    button: label => [...container.querySelectorAll('button')].find(element => element.textContent.trim() === label),
    async type(element, value) {
      assert.ok(element);
      await act(async () => {
        const prototype = element instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
        element.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    },
    posts: () => h.requests.filter(request => request.options.method === 'POST' && /^\/api\/publish\/[^/]+$/.test(request.path)),
  };
}

test('initial history restores silently, and its dialog supports keyboard navigation and safe links', async t => {
  const view = await fixture(t, [completed(), completed({ receiptId: 'b'.repeat(32), platform: 'wechat-oa', outcome: 'draft', url: 'https://mp.weixin.qq.com/cgi-bin/appmsg' })]);
  assert.equal(view.model().receipts.length, 2);
  assert.equal(view.model().notices.length, 0);
  assert.equal(view.posts().length, 0);
  const entry = view.container.querySelector('.publish-receipts-entry');
  await act(async () => entry.focus()); await view.click(entry);
  const modal = view.container.querySelector('[role="dialog"]');
  assert.ok(modal.contains(document.activeElement));
  assert.match(modal.textContent, /已存草稿/);
  assert.match(modal.textContent, /邮件未配置/);
  const links = [...modal.querySelectorAll('a')];
  assert.equal(links.length, 1);
  assert.equal(links[0].href, 'https://zhuanlan.zhihu.com/p/12345');
  assert.equal(links[0].rel, 'noopener noreferrer');
  const buttons = [...modal.querySelectorAll('button')];
  await act(async () => {
    buttons.at(-1).focus();
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  });
  assert.equal(document.activeElement, buttons[0]);
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  assert.equal(view.container.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, entry);
});

test('a new final result is announced once across page changes; mail failure updates independently', async t => {
  const view = await fixture(t, [makeReceipt()], 'publish');
  await view.render('other');
  view.h.items = [completed({ notification: { state: 'queued' } })];
  await view.tick(2500);
  assert.equal(view.h.requests.filter(request => request.path === `/api/publish/receipts/${'a'.repeat(32)}`).length, 1);
  assert.equal(view.model().notices.length, 1);
  assert.match(view.container.querySelector('[aria-live="polite"]').textContent, /知乎 · 已发布/);
  assert.ok(view.container.querySelector('.publish-receipts-summary a'));
  await view.click(view.container.querySelector('[aria-label="收起本次发布结果提醒"]'));
  view.h.items = [completed({ updatedAt: '2026-10-08T01:02:00.000Z', notification: { state: 'failed', message: '模拟 SMTP 连接失败' } })];
  await view.refresh();
  assert.equal(view.model().notices.length, 0);
  assert.equal(view.model().receipts[0].outcome, 'published');
  await view.render('publish');
  assert.match(view.container.querySelector('.publish-previews .publish-receipt').textContent, /邮件发送失败/);
  assert.equal(view.posts().length, 0, 'navigation and polling never re-submit content');
});

test('refreshing the application recovers server results without replaying POST or old alerts', async t => {
  const view = await fixture(t, [makeReceipt()]);
  view.h.items = [completed()]; await view.tick(2500);
  assert.equal(view.model().notices.length, 1);
  await act(async () => view.root.render(null));
  await view.render('publish');
  assert.equal(view.model().receipts[0].outcome, 'published');
  assert.equal(view.model().notices.length, 0);
  assert.equal(view.posts().length, 0);
});

test('active polling is serial, a pending read is aborted on unmount, and no timer revives it', async t => {
  const view = await fixture(t, [makeReceipt()]);
  const wait = deferred(); let signal;
  view.h.detail = (_id, request) => { signal = request.options.signal; return wait.promise; };
  await view.tick(2500);
  assert.equal(signal.aborted, false);
  await view.tick(6000);
  assert.equal(view.h.requests.filter(request => request.path.includes('/receipts/')).length, 1);
  void view.model().refresh(); void view.model().refresh();
  assert.equal(view.h.requests.filter(request => request.path === '/api/publish/receipts').length, 1);
  await view.dispose();
  assert.equal(signal.aborted, true);
  const before = view.h.requests.length;
  await act(async () => { wait.resolve(completed()); });
  await view.tick(30000);
  assert.equal(view.h.requests.length, before);
});

test('failed or malformed refresh preserves the last result until recovery', async t => {
  const view = await fixture(t, [makeReceipt()]);
  view.h.list = () => { throw new Error('模拟连接断开'); };
  await view.refresh();
  assert.match(view.model().error, /连接断开/);
  assert.equal(view.model().receipts.length, 1);
  view.h.list = () => [{ ok: true, state: 'success' }];
  await view.refresh();
  assert.match(view.model().error, /格式不受支持/);
  assert.equal(view.model().notices.length, 0);
  view.h.list = null; view.h.items = [completed()]; await view.refresh();
  assert.equal(view.model().error, '');
  assert.equal(view.model().notices.length, 1);
  assert.equal(view.posts().length, 0);
});

test('a timed out read gives a recoverable error and never marks a task failed', async t => {
  const view = await fixture(t, [makeReceipt()]);
  view.h.detail = (_id, { options }) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
  await view.tick(2500); await view.tick(12000);
  assert.match(view.model().error, /超时/);
  assert.equal(view.model().receipts[0].outcome, null);
  assert.equal(view.model().notices.length, 0);
});

test('confirmed batches survive editor unmount, keep immutable payloads and reject double submission', async t => {
  const view = await fixture(t, [], 'publish');
  const wait = deferred();
  view.h.publish = async (platform, payload) => {
    if (platform === 'douyin') return wait.promise;
    const result = completed({ receiptId: 'b'.repeat(32), platform, title: payload.title, outcome: 'submitted', url: '' });
    view.h.items.push(result); return result;
  };
  const requests = [
    { platform: 'douyin', payload: { title: '确认过的标题', body: '确认过的正文', media: ['video.mp4'], tags: '' } },
    { platform: 'zhihu', payload: { title: '第二个平台', body: '不同平台版本', media: [], tags: '' } },
  ];
  let pending;
  await act(async () => { pending = view.model().submit(requests); void view.model().submit(requests); });
  requests[1].payload.title = '后来编辑的标题'; requests[0].payload.media.push('later.mp4');
  await view.render('other');
  const active = makeReceipt({ platform: 'douyin', title: '确认过的标题' });
  view.h.items.push(active);
  await act(async () => {
    wait.resolve({ async: true, pending: true, receiptId: active.receiptId, state: 'starting', outcome: null, message: '处理中' });
    await pending;
  });
  assert.equal(view.posts().length, 2);
  assert.equal(view.posts()[1].body.title, '第二个平台');
  assert.deepEqual(view.posts()[0].body.media, ['video.mp4']);
  assert.equal(view.model().active[0].receiptId, active.receiptId);
  assert.equal(view.model().notices[0].outcome, 'submitted');
  assert.match(view.container.textContent, /已提交/);
  assert.equal(view.container.querySelector('.publish-receipts-summary a'), null);
});

test('a legacy ok response without receipt cannot be presented as success or automatically retried', async t => {
  const view = await fixture(t);
  view.h.publish = () => ({ ok: true, message: 'success' });
  await act(async () => view.model().submit([{ platform: 'zhihu', payload: { title: '需要核对', body: '正文', media: [] } }]));
  assert.equal(view.model().notices.length, 0);
  assert.match(view.model().submissionIssues[0].message, /未返回可恢复的发布回执/);
  assert.equal(view.posts().length, 1);
  await view.refresh(); await view.render('publish');
  assert.equal(view.posts().length, 1);
});

test('restored SMS verification is bound to its receipt and cannot fall through to another task', async t => {
  const active = makeReceipt({ platform: 'douyin', state: 'sms_required', message: '请输入本次发布的验证码' });
  const old = completed({ receiptId: 'b'.repeat(32), platform: 'douyin', title: '之前完成的任务', url: 'https://www.douyin.com/video/12345' });
  const view = await fixture(t, [active, old]);
  await view.click(view.button('处理验证'));
  view.h.sms = (platform, body) => {
    assert.equal(platform, 'douyin'); assert.equal(body.receiptId, active.receiptId); assert.equal(body.code, '123456');
    view.h.items = [{ ...active, state: 'verifying', updatedAt: '2026-10-08T01:02:00.000Z' }, old];
    return { ok: true };
  };
  await view.type(view.container.querySelector('.publish-receipt-sms input'), '123456');
  await view.click(view.button('提交验证码'));
  assert.equal(view.h.requests.filter(request => request.path.endsWith('/sms')).length, 1);
  assert.equal(view.container.querySelector('.publish-receipt-sms'), null);
  assert.match(view.container.querySelector(`[data-receipt-id="${active.receiptId}"]`).textContent, /正在验证/);
  await assert.rejects(() => view.model().submitSms(old.receiptId, '654321'), /验证任务已变化/);
  assert.equal(view.h.requests.filter(request => request.path.endsWith('/sms')).length, 1);
});

test('editor confirmation is required, cancellation and leaving during precheck do not send content', async t => {
  const view = await fixture(t, [], 'publish');
  view.h.confirm = false;
  await view.click(view.button('发布到 1 个平台'));
  assert.equal(view.h.confirmations.length, 1);
  assert.match(view.h.confirmations[0], /草稿箱/);
  assert.equal(view.posts().length, 0);
  const wait = deferred(); view.h.precheck = () => wait.promise;
  await view.click(view.button('发布到 1 个平台'));
  await view.render('other');
  await act(async () => wait.resolve({ response: '模拟晚到预检' }));
  assert.equal(view.h.confirmations.length, 1);
  assert.equal(view.posts().length, 0);
});

test('editor uses the durable outcome, preserves receipts when clearing its draft, and opens notification settings', async t => {
  const view = await fixture(t, [], 'publish');
  view.h.publish = (_platform, payload) => {
    const receipt = completed({ title: payload.title, outcome: 'unverified', message: '需要人工核实', url: '' });
    view.h.items = [receipt]; return receipt;
  };
  await view.click(view.button('发布到 1 个平台'));
  assert.equal(view.posts().length, 1);
  assert.equal(view.model().receipts[0].outcome, 'unverified');
  assert.match(view.container.querySelector('[role="dialog"]').textContent, /结果待核实/);
  await view.click(view.container.querySelector('[aria-label="关闭发布回执"]'));
  await view.click(view.button('清空内容'));
  assert.equal(view.container.querySelector('#publish-title').value, '');
  assert.equal(view.model().receipts.length, 1);
  await view.click(view.button('查看全部发布回执'));
  await view.click(view.button('通知设置'));
  assert.equal(view.h.configured, 1);
  assert.equal(view.container.querySelector('[role="dialog"]'), null);
});

test('a card exposes storage failures without inventing a link or hiding the known platform result', async t => {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(createElement(PublishReceiptCard, { receipt: completed({
    url: 'https://evil.test/result', storageWarning: '模拟保存失败，请先核对平台结果。', notification: { state: 'sent' },
  }) })));
  assert.match(container.textContent, /已发布/);
  assert.match(container.textContent, /未返回可验证的公开作品地址/);
  assert.match(container.querySelector('[role="alert"]').textContent, /模拟保存失败/);
  assert.equal(container.querySelector('a'), null);
});

for (const valid of [true, false]) test(`calendar exposes ${valid ? 'the saved public work address' : 'no link for an unsafe work address'}`, async t => {
  const view = await fixture(t);
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  view.h.schedule = [{ id: 'simulated-record', title: '日历作品记录', platform: '知乎', date, time: '', status: 'published', note: '',
    url: valid ? 'https://zhuanlan.zhihu.com/p/12345' : 'https://zhuanlan.zhihu.com.evil.test/p/12345' }];
  await view.render('calendar');
  await view.click([...view.container.querySelectorAll('.cal-event')].find(button => button.textContent.includes('日历作品记录')));
  const link = [...view.container.querySelectorAll('a')].find(anchor => anchor.textContent.includes('查看作品地址'));
  if (valid) { assert.equal(link?.href, view.h.schedule[0].url); assert.equal(link?.rel, 'noopener noreferrer'); }
  else assert.equal(link, undefined);
  assert.equal(view.h.requests.filter(request => request.options.method === 'POST').length, 0);
});

test.after(() => window.close());
