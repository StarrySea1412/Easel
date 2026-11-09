import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://easel.test/', pretendToBeVisual: true }).window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: window.localStorage });
const { createRoot } = await import('react-dom/client');
const { default: Accounts } = await loadTsModule('../src/components/SocialAccountsPanel.tsx');
const { DistributionEditor } = await loadTsModule('../src/components/SocialDistributionPanel.tsx');
const { PublishReceiptCard } = await loadTsModule('../src/components/PublishReceiptCenter.tsx');

const a = { accountId: 'a'.repeat(32), platform: 'xiaohongshu', label: '品牌号', name: '甲', externalAccountId: 'a'.repeat(24), status: 'ready', busy: false, attemptId: 'e'.repeat(32), updatedAt: '2026-11-09T00:00:00Z' };
const b = { ...a, accountId: 'b'.repeat(32), platform: 'douyin', label: '视频号乙', externalAccountId: '12345' };
const seed = { title: '通用稿', body: '原正文', media: ['cover.png'], tags: '测试' };
const job = (account, outcome, changes = {}) => ({ jobId: account.accountId, platform: account.platform, accountId: account.accountId, accountLabel: account.label,
  externalAccountId: account.externalAccountId, payload: { ...seed, title: '原确认稿', media: ['video.mp4'] }, state: 'finished', outcome, message: '模拟结果', receiptId: 'f'.repeat(32), ...changes });

async function fixture(t, component = DistributionEditor, props = {}) {
  localStorage.clear();
  const h = { accounts: [structuredClone(a), structuredClone(b)], batches: [], posts: [], events: [], submit: null, creates: [] };
  t.mock.method(window, 'confirm', () => true);
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const path = String(url), body = options.body ? JSON.parse(options.body) : undefined;
    let result;
    if (path === '/api/social-accounts' && options.method === 'POST') {
      h.creates.push(body); result = { ...a, ...body, accountId: 'c'.repeat(32), status: 'logged_out' }; h.accounts.push(result);
    } else if (path === '/api/social-accounts') result = h.accounts;
    else if (path === '/api/social-accounts/batches' && options.method === 'POST') {
      h.posts.push(body);
      result = h.submit ? await h.submit(body) : { batchId: 'd'.repeat(32), state: 'running', createdAt: a.updatedAt, jobs: [] };
    } else if (path === '/api/social-accounts/batches') result = h.batches;
    else if (path.endsWith('/history') || path.endsWith('/default-history')) result = h.events;
    else throw new Error(`Unexpected simulated endpoint: ${path}`);
    return { ok: true, json: async () => structuredClone(result) };
  });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  h.render = async (extra = {}) => act(async () => { root.render(createElement(component, { seed, files: [], ...props, ...extra })); });
  h.text = () => container.textContent;
  h.find = label => [...container.querySelectorAll('button')].find(button => button.textContent.trim() === label);
  h.click = async label => {
    const button = typeof label === 'string' ? h.find(label) : label;
    assert.ok(button, `Missing button ${label}`);
    await act(async () => { button.click(); });
  };
  h.input = async (element, value) => act(async () => {
    const proto = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  h.container = container;
  h.choose = async account => {
    const platform = container.querySelector(`[data-platform="${account.platform}"]`);
    if(platform.getAttribute('aria-pressed') !== 'true') await h.click(platform);
    await h.click(container.querySelector(`[data-account-id="${account.accountId}"]`));
  };
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await h.render();
  return h;
}

test('account page offers all seven platforms with a shared keyboard selector', async t => {
  const h = await fixture(t, Accounts);
  await h.click('新增独立账号');
  await h.click(h.container.querySelector('[aria-label="新增账号的平台"]'));
  const options = [...document.querySelectorAll('[role="option"]')];
  assert.equal(options.length, 7);
  await h.click(options.find(option => option.textContent.includes('B站')));
  await h.input(h.container.querySelector('input[placeholder="例如：品牌号 / 主理人号"]'), '第二个B站账号');
  await act(async () => h.container.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  assert.deepEqual(h.creates, [{ label: '第二个B站账号', platform: 'bilibili' }]);
  assert.equal(h.container.querySelectorAll('select').length, 0);
});

test('login history displays persistent timestamps and attempt identifiers separately from credentials', async t => {
  const h = await fixture(t, Accounts);
  h.events = [{ id: 1, attemptId: 'e'.repeat(32), action: 'logout', state: 'logged_out', message: '该账号已退出，历史保留', at: a.updatedAt }];
  await h.click(h.container.querySelector('[aria-label="管理 小红书 / 品牌号"]'));
  assert.ok(h.text().includes('该账号已退出，历史保留'));
  assert.equal(h.container.querySelector('time').getAttribute('dateTime'), a.updatedAt);
  assert.ok(h.text().includes('e'.repeat(32)));
  await h.click('默认账号登录记录');
  assert.ok(h.text().includes('默认账号 · 登录记录'));
});

test('account inventory filters platform, status and search without losing other accounts', async t => {
  const h = await fixture(t, Accounts);
  assert.equal(h.container.querySelectorAll('[role="listitem"]').length, 2);
  const rail = h.container.querySelector('[aria-label="按平台筛选账号"]');
  await h.click([...rail.querySelectorAll('button')].find(el => el.textContent.startsWith('抖音')));
  assert.equal(h.container.querySelectorAll('[role="listitem"]').length, 1);
  await h.input(h.container.querySelector('[aria-label="搜索独立账号"]'), '不存在');
  assert.equal(h.container.querySelectorAll('[role="listitem"]').length, 0);
  await h.click('清除筛选');
  assert.equal(h.container.querySelectorAll('[role="listitem"]').length, 2);
});

test('privacy hides names and platform identity in list and inspector while preserving account labels', async t => {
  const h = await fixture(t, Accounts, {hideIdentity:true});
  await h.click(h.container.querySelector('[aria-label="管理 小红书 / 品牌号"]'));
  assert.ok(h.text().includes('品牌号'));
  assert.ok(h.text().includes('账号身份已隐藏'));
  assert.equal(h.container.querySelectorAll('.account-identity-details dd')[1].textContent, '身份已隐藏');
  assert.ok(!h.text().includes('小红书 · 甲'));
});

test('confirmed targets retain separate edited payloads across different platforms', async t => {
  const h = await fixture(t);
  await h.choose(a); await h.choose(b);
  const editors = [...h.container.querySelectorAll('fieldset')];
  await h.input(editors[0].querySelector('input.field'), '品牌专用标题');
  await h.input(editors[1].querySelector('input.field'), '视频专用标题');
  await h.render({ seed: { ...seed, title: '已变化的通用稿' } });
  await h.click('确认发布到 2 个账号');
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.posts[0].requests.map(row => [row.accountId, row.payload.title]), [[a.accountId, '品牌专用标题'], [b.accountId, '视频专用标题']]);
  assert.equal(h.posts[0].confirmed, true);
});

test('lost admission response freezes the payload and reuses the request key', async t => {
  const h = await fixture(t);
  await h.choose(a);
  h.submit = async () => { throw new Error('simulated network loss'); };
  await h.click('确认发布到 1 个账号');
  assert.ok(h.text().includes('上次提交的结果还未确认'));
  assert.equal(h.container.querySelector('fieldset').disabled, true);
  const frozen = structuredClone(h.posts[0]);
  h.submit = async () => ({ batchId: 'd'.repeat(32), createdAt: a.updatedAt, state: 'finished', jobs: [] });
  await h.click('查询本次受理结果');
  assert.deepEqual(h.posts[1], frozen);
  assert.equal(localStorage.getItem('easel_social_distribution_pending_v1'), null);
});

test('publishing reveals only selected platform accounts and keeps one editor visible', async t => {
  const h = await fixture(t);
  assert.equal(h.container.querySelectorAll('[data-account-id]').length, 0);
  await h.choose(a);
  assert.equal(h.container.querySelectorAll('[data-account-id]').length, 1);
  assert.equal(h.container.querySelector('[data-account-id]').getAttribute('data-account-id'), a.accountId);
  await h.choose(b);
  assert.equal(h.container.querySelectorAll('[role="tabpanel"]:not([hidden])').length, 1);
  assert.ok(h.text().includes('已选择 2 个平台 · 2 个账号'));
  const active = h.container.querySelector('[role="tab"][aria-selected="true"]');
  await act(async () => active.dispatchEvent(new window.KeyboardEvent('keydown', {key:'ArrowLeft',bubbles:true})));
  assert.equal(h.container.querySelector('[role="tab"][aria-selected="true"]').id, `distribution-tab-${a.accountId}`);
  await h.click(h.container.querySelector('[data-platform="douyin"]'));
  assert.equal(h.container.querySelectorAll('[data-account-id]').length, 1);
  await h.click('确认发布到 1 个账号');
  assert.deepEqual(h.posts[0].requests.map(row => row.accountId), [a.accountId]);
});

test('deselecting a platform preserves edited content for explicit later reselection', async t => {
  const h = await fixture(t);
  await h.choose(a);
  await h.input(h.container.querySelector('fieldset input.field'), '为品牌号准备的内容');
  await h.click(h.container.querySelector('[data-platform="xiaohongshu"]'));
  assert.equal(h.container.querySelectorAll('[role="tabpanel"]').length, 0);
  await h.choose(a);
  assert.equal(h.container.querySelector('fieldset input.field').value, '为品牌号准备的内容');
});

test('retry submits only the failed account original payload and unknown results have no retry', async t => {
  const h = await fixture(t);
  h.batches = [{ batchId: 'c'.repeat(32), state: 'finished', createdAt: a.updatedAt, jobs: [job(a, 'unverified'), job(b, 'failed')] }];
  await h.click('刷新账号与批次');
  assert.equal([...h.container.querySelectorAll('button')].filter(el => el.textContent.startsWith('仅重试')).length, 1);
  await h.click('仅重试 视频号乙 的原确认稿');
  assert.deepEqual(h.posts[0].requests, [{ accountId: b.accountId, payload: h.batches[0].jobs[1].payload }]);
});

test('account scoped receipts display identity and offer manual verification without automatic default-profile checks', async t => {
  const receipt = { receiptId: 'f'.repeat(32), platform: 'douyin', accountId: b.accountId, accountLabel: b.label,
    externalAccountId: b.externalAccountId, title: '原确认稿', createdAt: a.updatedAt, updatedAt: a.updatedAt,
    state: 'finished', outcome: 'unverified', message: '待核实', verification: { state: 'paused', automatic: false, attempts: 0 } };
  const h = await fixture(t, PublishReceiptCard, { receipt, onCheck: async () => {} });
  assert.ok(h.text().includes('目标账号：视频号乙 · 12345'));
  assert.ok(h.find('核实发布结果'));
  assert.equal(h.find('开启自动核实'), undefined);
});
