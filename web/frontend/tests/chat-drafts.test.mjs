import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { tsModuleUrl } from './load-ts.mjs';

// Real ChatPage/Composer/draft persistence in jsdom. Uploads and browser storage
// are controlled substitutes; this is not a real browser or backend upload test.
globalThis.window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://easel.test/' }).window;
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.FormData = window.FormData;
window.matchMedia = () => ({ matches: false });
window.HTMLElement.prototype.scrollTo = function ({ top }) { this.scrollTop = top; };
const { createRoot } = await import('react-dom/client');
const base = new URL('../src/', import.meta.url);
const prefix = 'data:text/javascript;base64,';
const bases = Object.fromEntries(await Promise.all([
  ['persistence', 'lib/localPersistence.ts'], ['draft', 'lib/chatDrafts.ts'],
  ['composer', 'components/ChatComposer.tsx'], ['page', 'components/ChatPage.tsx'], ['store', 'lib/store.ts'],
].map(async ([key, path]) => [key, await tsModuleUrl(new URL(path, base))])));
let sequence = 0;
const rewrite = (url, pairs, suffix) => {
  let code = Buffer.from(url.slice(prefix.length), 'base64').toString();
  for (const [before, after] of pairs) code = code.replaceAll(before, after);
  return prefix + Buffer.from(code).toString('base64') + suffix;
};
async function freshModules() {
  const suffix = `#chat-draft-${++sequence}`;
  const persistence = bases.persistence + suffix;
  const draft = rewrite(bases.draft, [[bases.persistence, persistence]], suffix);
  const composer = rewrite(bases.composer, [[bases.draft, draft]], suffix);
  const page = rewrite(bases.page, [[bases.composer, composer]], suffix);
  const store = rewrite(bases.store, [[bases.persistence, persistence], [bases.draft, draft]], suffix);
  return { persistence: await import(persistence), draft: await import(draft),
    Page: (await import(page)).default, store: await import(store) };
}
const draftKey = id => `easel:chat-draft:${id}`;
const file = { id: 'upload-1', name: 'reference.png', path: 'outputs/uploads/owner/reference.png' };
const storedDraft = (text, attachmentNames = []) => JSON.stringify({ version: 1, text, attachmentNames });
const session = (id, patch = {}) => ({ id, title: id, created: 1, messages: [], ...patch });

async function fixture(t, initial = {}) {
  const values = new Map(Object.entries(initial));
  const storage = { values, reads: [], writes: [], blocked: false, quota: false,
    getItem(key) { this.reads.push(key); if (this.blocked) throw new Error('denied'); return values.get(key) ?? null; },
    setItem(key, value) { this.writes.push(key); if (this.quota) throw Object.assign(new Error('full'), { name: 'QuotaExceededError' }); values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  const h = { accepted: true, sent: [], requests: [], upload: async () => ({ ok: true, files: [file] }) };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    h.requests.push([url, options]);
    const result = url === '/api/upload' || url === '/api/upload/local' ? await h.upload(url, options)
      : url === '/api/skills' ? [] : url === '/api/upload/limits' ? { max_mb: 50 } : { records: [] };
    return { ok: true, json: async () => result };
  });
  let modules = await freshModules();
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  let current = session('one');
  const render = async (id = current.id, patch = {}) => {
    current = session(id, patch);
    await act(async () => root.render(createElement(modules.Page, {
      session: current, onSend: (...args) => { h.sent.push(args); return h.accepted; },
      onStop() {}, onResend() {},
    })));
  };
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  return {
    h, container, storage, render, modules: () => modules,
    away: async () => act(async () => root.render(createElement('section', null, 'Other page'))),
    async reload() { await act(async () => root.render(null)); modules = await freshModules(); await render(current.id, current); },
    async type(value) {
      const input = container.querySelector('textarea');
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    },
    async upload() {
      const input = container.querySelector('input[type=file]');
      Object.defineProperty(input, 'files', { configurable: true, value: [new window.File(['image'], file.name, { type: 'image/png' })] });
      await act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })));
    },
    click: async element => act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))),
  };
}

test('navigation restores each session draft and uploaded references independently', async t => {
  const view = await fixture(t);
  await view.render('one'); await view.type('  草稿一\n保留换行  '); await view.upload();
  await view.away(); await view.render('two'); await view.type('草稿二');
  await view.render('one');
  assert.equal(view.container.querySelector('textarea').value, '  草稿一\n保留换行  ');
  assert.equal(view.container.querySelectorAll('.attach-chip').length, 1);
  assert.match(view.container.textContent, /刷新页面后需要重新添加/);
  await view.click(view.container.querySelector('[aria-label="移除 reference.png"]'));
  await view.render('two'); assert.equal(view.container.querySelector('textarea').value, '草稿二');
  assert.equal(view.container.querySelector('.attach-chip'), null);
  assert.deepEqual(view.h.sent, []);
});

test('only an accepted send clears its own draft and failed acceptance retains text and attachments', async t => {
  const view = await fixture(t);
  await view.render('two'); await view.type('另一会话待发送');
  await view.render('one'); await view.type('  本轮文本  '); await view.upload();
  view.h.accepted = false;
  await view.click(view.container.querySelector('[aria-label="发送消息"]'));
  assert.equal(view.container.querySelector('textarea').value, '  本轮文本  ');
  assert.ok(view.container.querySelector('.attach-chip'));
  assert.match(view.container.querySelector('[role=alert]').textContent, /草稿已保留/);
  view.h.accepted = true;
  await view.click(view.container.querySelector('[aria-label="发送消息"]'));
  assert.deepEqual(view.h.sent.at(-1), ['本轮文本', [file], [], {}, 'medium']);
  assert.equal(view.container.querySelector('textarea').value, '');
  assert.equal(view.container.querySelector('.attach-chip'), null);
  assert.equal(JSON.parse(view.storage.values.get(draftKey('one'))).text, '');
  await view.render('two'); assert.equal(view.container.querySelector('textarea').value, '另一会话待发送');
});

test('uploads completing after navigation attach to the original session and survive its remount', async t => {
  const view = await fixture(t);
  let finish;
  view.h.upload = () => new Promise(resolve => { finish = resolve; });
  await view.render('one'); await view.type('素材所属会话'); await view.upload();
  assert.equal(view.modules().draft.getChatDraft('one').uploading, true);
  await view.render('two'); await view.type('不可收到会话一素材');
  await act(async () => finish({ ok: true, files: [file] }));
  assert.equal(view.container.querySelector('.attach-chip'), null);
  const upload = view.h.requests.find(([url]) => url === '/api/upload');
  assert.equal(upload[1].body.get('sessionId'), 'one');
  await view.render('one'); assert.equal(view.container.querySelectorAll('.attach-chip').length, 1);
  assert.equal(view.modules().draft.getChatDraft('one').uploading, false);
});

test('refresh restores text but requires reattachment or an explicit dismissal before sending', async t => {
  const view = await fixture(t);
  await view.render('one'); await view.type('刷新后仍在'); await view.upload();
  const raw = view.storage.values.get(draftKey('one'));
  assert.equal(raw.includes(file.path), false); assert.equal(raw.includes(file.id), false);
  await view.reload();
  assert.equal(view.container.querySelector('textarea').value, '刷新后仍在');
  assert.equal(view.container.querySelector('.attach-chip'), null);
  assert.match(view.container.textContent, /刷新前的素材需要重新添加：reference.png/);
  assert.equal(view.container.querySelector('[aria-label="发送消息"]').disabled, true);
  await view.upload();
  assert.equal(view.container.querySelector('[aria-label="发送消息"]').disabled, false);
  assert.equal(view.modules().draft.getChatDraft('one').missingAttachments.length, 0);
  await view.reload();
  await view.click([...view.container.querySelectorAll('button')].find(button => button.textContent === '忽略这些素材'));
  await view.click(view.container.querySelector('[aria-label="发送消息"]'));
  assert.deepEqual(view.h.sent.at(-1), ['刷新后仍在', [], [], {}, 'medium']);
});

test('malformed draft storage is preserved even after edits, clearing and persistence retry', async t => {
  const raw = '{damaged draft';
  const view = await fixture(t, { [draftKey('one')]: raw });
  await view.render('one'); await view.type('仅页内的新内容');
  await view.away(); await view.render('one');
  assert.equal(view.container.querySelector('textarea').value, '仅页内的新内容');
  assert.equal(view.storage.values.get(draftKey('one')), raw);
  assert.equal(view.modules().persistence.retryPendingLocalWrites(), false);
  await view.click(view.container.querySelector('[aria-label="发送消息"]'));
  assert.equal(view.container.querySelector('textarea').value, '');
  assert.equal(view.storage.values.get(draftKey('one')), raw);
  assert.equal(view.storage.writes.includes(draftKey('one')), false);
});

test('a denied initial draft read cannot later overwrite the unread original', async t => {
  const raw = storedDraft('受保护原稿');
  const view = await fixture(t, { [draftKey('one')]: raw });
  view.storage.blocked = true;
  await view.render('one');
  view.storage.blocked = false;
  await view.type('页内临时稿');
  assert.equal(view.storage.values.get(draftKey('one')), raw);
  assert.equal(view.modules().persistence.retryPendingLocalWrites(), false);
  assert.equal(view.modules().draft.getChatDraft('one').text, '页内临时稿');
});

test('quota failure retains the latest in-memory draft and retries only that value', async t => {
  const view = await fixture(t, { [draftKey('one')]: storedDraft('已保存版本') });
  await view.render('one'); view.storage.quota = true;
  await view.type('第一次改动'); await view.type('最新改动');
  await view.away(); await view.render('one');
  assert.equal(view.container.querySelector('textarea').value, '最新改动');
  assert.equal(JSON.parse(view.storage.values.get(draftKey('one'))).text, '已保存版本');
  view.storage.quota = false;
  assert.equal(view.modules().persistence.retryPendingLocalWrites(), true);
  assert.equal(JSON.parse(view.storage.values.get(draftKey('one'))).text, '最新改动');
});

test('draft-only sessions survive placeholder pruning and page refresh', async t => {
  const view = await fixture(t);
  await view.render('older'); await view.type('未发出的创作');
  const sessions = [session('newer'), session('older')];
  assert.equal(view.modules().store.saveSessions(sessions), true);
  assert.deepEqual(JSON.parse(view.storage.values.get('easel_sessions')).map(item => item.id), ['newer', 'older']);
  await view.reload();
  assert.equal(view.container.querySelector('textarea').value, '未发出的创作');
  assert.equal(view.modules().store.loadSessions().some(item => item.id === 'older'), true);
});

test('clearing a deleted draft invalidates late uploads without affecting another draft', async t => {
  const view = await fixture(t);
  const drafts = view.modules().draft;
  drafts.setChatDraftText('one', '即将删除'); drafts.setChatDraftText('two', '保留');
  const token = drafts.beginChatDraftUpload('one');
  drafts.clearChatDraft('one');
  drafts.appendChatDraftUploads('one', token, [file]); drafts.finishChatDraftUpload('one', token, 'late failure');
  assert.equal(drafts.hasChatDraft('one'), false);
  assert.equal(drafts.getChatDraft('two').text, '保留');
});

test('read-only backups never mount or read a draft, even when a forged draft key exists', async t => {
  const view = await fixture(t, { [draftKey('backup')]: '{must remain untouched' });
  await view.render('backup', { importedFromBackup: true });
  assert.equal(view.container.querySelector('textarea'), null);
  assert.deepEqual(view.h.requests, []);
  assert.equal(view.modules().store.saveSessions([session('backup', { importedFromBackup: true })]), true);
  assert.equal(view.storage.reads.includes(draftKey('backup')), false);
  assert.equal(view.storage.writes.includes(draftKey('backup')), false);
});

test.after(() => window.close());
