import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new JSDOM('<!doctype html><body></body>', { url: 'https://easel.test/', pretendToBeVisual: true }).window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: window.localStorage });
const { createRoot } = await import('react-dom/client');
const { default: PublishPage } = await loadTsModule('../src/components/PublishPage.tsx');
const { default: Steps } = await loadTsModule('../src/components/ui/Steps.tsx');
const { savePublishDraft } = await loadTsModule('../src/lib/store.ts');
const account = { accountId: 'a'.repeat(32), platform: 'zhihu', label: '品牌号', name: '模拟身份', status: 'ready', checkedAt: new Date().toISOString(), busy: false };

async function fixture(t, component = PublishPage, props = {}) {
  localStorage.clear();
  savePublishDraft({ title: '准备好的标题', body: '通用正文', tags: '', media: [], platforms: [], overrides: {} });
  const posts = [];
  t.mock.method(window, 'confirm', () => true);
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    let value = [];
    if (url === '/api/social-accounts') value = [account];
    if (url === '/api/social-accounts/batches' && options.method === 'POST') {
      posts.push(JSON.parse(options.body)); value = { batchId: 'b'.repeat(32), state: 'running', createdAt: '2026-11-09T00:00:00Z', jobs: [] };
    }
    return { ok: true, json: async () => value };
  });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const receipts = { active: [], receipts: [], submitting: false, submittingPlatforms: [], verificationBusyIds: [], open() {} };
  await act(async () => root.render(createElement(component, { persona: '', publishReceipts: receipts, ...props })));
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const visible = el => !el.closest('[hidden]');
  const button = text => [...container.querySelectorAll('button')].find(el => visible(el) && el.textContent.trim() === text);
  return { container, posts, visible, button, click: async el => { assert.ok(el); await act(async () => el.click()); }, type: async (el, text) => act(async () => {
    Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype, 'value').set.call(el, text);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  }) };
}

test('steps use ordinary numbers and keyboard navigation skips disabled steps without fabricating completion', async t => {
  const calls = [];
  const h = await fixture(t, Steps, { label: '发布流程', current: 'a', items: [{key:'a',label:'内容'},{key:'b',label:'账号',disabled:true},{key:'c',label:'结果'}], onChange: value => calls.push(value) });
  assert.deepEqual([...h.container.querySelectorAll('.workflow-step-icon')].map(el => el.textContent), ['1','2','3']);
  const first = h.container.querySelector('button'); first.focus();
  await act(async () => first.dispatchEvent(new window.KeyboardEvent('keydown', {key:'ArrowRight',bubbles:true})));
  assert.equal(document.activeElement.textContent, '3结果');
  assert.deepEqual(calls, []);
  await h.click(document.activeElement); assert.deepEqual(calls, ['c']);
  assert.equal(h.container.querySelectorAll('.is-complete').length, 0);
});

test('publishing shows one stage, preserves account edits on return and opens results after one submission', async t => {
  const h = await fixture(t);
  assert.equal(h.visible(h.container.querySelector('.publish-editor')), true);
  assert.equal(h.visible(h.container.querySelector('.distribution-platforms')), false);
  assert.equal(h.visible(h.container.querySelector('.publish-side')), false);
  await h.click(h.button('下一步：选择账号 →'));
  await h.click(h.container.querySelector('[data-platform="zhihu"]'));
  await h.click(h.container.querySelector('[data-account-id]'));
  await h.click(h.button('下一步：确认发布 →'));
  const editor = h.container.querySelector('.distribution-editor input.field');
  await h.type(editor, '账号单独标题');
  await h.click(h.button('返回选择账号'));
  assert.equal(h.container.querySelector('[data-account-id]').checked, true);
  await h.click(h.button('下一步：确认发布 →'));
  assert.equal(editor.value, '账号单独标题');
  await h.click(h.button('确认发布到 1 个账号'));
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].requests[0].payload.title, '账号单独标题');
  assert.equal(h.container.querySelector('[aria-current="step"] .workflow-step-title').textContent, '查看结果');
  assert.equal(h.visible(h.container.querySelector('.distribution-history')), true);
  assert.equal(h.button('确认发布到 1 个账号'), undefined);
});

test('visiting results directly does not show uncompleted steps as completed', async t => {
  const h = await fixture(t);
  await h.click([...h.container.querySelectorAll('.workflow-steps button')].at(-1));
  assert.equal(h.container.querySelectorAll('.workflow-steps .is-complete').length, 1);
  assert.equal(h.container.querySelector('.workflow-step-title').textContent, '准备内容');
  assert.equal(h.posts.length, 0);
});
