import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// React events and storage/download stubs only; no browser or disk download.
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: ConversationBackupCard } = await loadTsModule('../src/components/settings/ConversationBackupCard.tsx', import.meta.url);
const { MAX_BACKUP_BYTES } = await loadTsModule('../src/lib/conversationBackup.ts', import.meta.url);
const persistence = await loadTsModule('../src/lib/localPersistence.ts', import.meta.url);

function backup(title = '备份会话') {
  return {
    format: 'easel-conversation-backup', version: 1, exportedAt: '2026-09-30T00:00:00.000Z',
    sessions: [{ title, created: 123, messages: [{ role: 'user', content: '本地消息' }, { role: 'assistant', content: '回答' }] }],
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function file(name, body, size = undefined) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { name, size: size ?? new TextEncoder().encode(text).length, text: async () => text };
}

async function fixture(t, callbacks = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let mounted = true;
  const imports = [], opens = [];
  const props = {
    onExport: () => backup(),
    onExportRaw: () => ({ format: 'easel-raw-conversation-storage', version: 1, exportedAt: '2026-09-30T00:00:00.000Z', entries: [] }),
    onImport: value => { imports.push(value); return { count: value.sessions.length, firstSessionId: 'imported-first' }; },
    onOpenSession: id => opens.push(id),
    ...callbacks,
  };
  const unmount = async () => {
    if (mounted) {
      await act(async () => root.unmount());
      mounted = false;
    }
  };
  t.after(async () => { await unmount(); container.remove(); });
  await act(async () => root.render(createElement(ConversationBackupCard, props)));
  return {
    container, imports, opens, unmount,
    button: label => [...container.querySelectorAll('button')].find(button => button.textContent === label),
    click: async button => act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))),
    async select(value) {
      const input = container.querySelector('input[type="file"]');
      Object.defineProperty(input, 'files', { configurable: true, value: [value] });
      await act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })));
      assert.equal(input.value, '', 'reset selection so the same file can be chosen again');
    },
  };
}

test('the card previews local counts and titles before explicitly adding read-only copies', async t => {
  const view = await fixture(t);
  const data = backup('第一份标题');
  data.sessions[0].incomplete = true;
  data.sessions.push({ title: '已归档标题', created: 321, archived: true, messages: [{ role: 'assistant', content: '旧回答' }] });
  await view.select(file('my-backup.json', data));
  assert.equal(view.imports.length, 0);
  assert.match(view.container.textContent, /本机导出、解析和导入/);
  assert.match(view.container.textContent, /不包含附件文件，不读取模型配置或平台凭据/);
  assert.match(view.container.textContent, /文件含对话内容，请妥善保存/);
  assert.match(view.container.textContent, /不会恢复原后台上下文/);
  assert.match(view.container.textContent, /再次选择同一文件并确认导入，会新增另一批副本/);
  assert.deepEqual([...view.container.querySelectorAll('dl dd')].map(item => item.textContent), ['2', '3', '1', '1']);
  assert.deepEqual([...view.container.querySelectorAll('.conversation-backup-titles li')].map(item => item.textContent), ['第一份标题', '已归档标题']);
  await view.click(view.button('确认导入只读副本'));
  assert.equal(view.imports.length, 1);
  assert.deepEqual(view.imports[0], data);
  assert.equal(view.container.querySelector('[aria-label="备份导入预览"]'), null);
  assert.match(view.container.textContent, /已新增 2 个只读会话副本/);
  await view.click(view.button('打开首个导入记录'));
  assert.deepEqual(view.opens, ['imported-first']);
});

test('two confirmation clicks in the same event batch import only once', async t => {
  const view = await fixture(t);
  await view.select(file('one.json', backup()));
  const confirm = view.button('确认导入只读副本');
  await act(async () => {
    confirm.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    confirm.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(view.imports.length, 1);
  assert.equal(view.button('确认导入只读副本'), undefined);
});

test('oversized and empty files are rejected before reading their contents', async t => {
  const view = await fixture(t);
  let reads = 0;
  for (const size of [MAX_BACKUP_BYTES + 1, 0]) {
    await view.select({ name: 'too-large.json', size, text() { reads++; throw new Error('should not read'); } });
    assert.ok(view.container.querySelector('[role="alert"]'));
    assert.equal(view.button('确认导入只读副本'), undefined);
  }
  assert.equal(reads, 0);
  assert.equal(view.imports.length, 0);
});

test('corrupt JSON, unknown versions and raw storage are rejected; the same input can recover', async t => {
  const view = await fixture(t);
  for (const data of ['{broken', { ...backup(), version: 2 }, { format: 'easel-raw-conversation-storage', version: 1, entries: [] }]) {
    await view.select(file('same.json', data));
    assert.ok(view.container.querySelector('[role="alert"]'));
    assert.equal(view.button('确认导入只读副本'), undefined);
  }
  await view.select(file('same.json', backup('重新选择成功')));
  assert.equal(view.container.querySelector('[role="alert"]'), null);
  assert.match(view.container.textContent, /重新选择成功/);
  assert.equal(view.imports.length, 0);
});

test('a newer file wins over an earlier asynchronous read', async t => {
  const pending = deferred();
  const view = await fixture(t);
  await view.select({ name: 'old.json', size: 100, text: () => pending.promise });
  assert.equal(view.container.querySelector('[aria-busy="true"]')?.textContent.includes('正在本机读取'), true);
  await view.select(file('new.json', backup('新文件内容')));
  await act(async () => pending.resolve(JSON.stringify(backup('旧文件内容'))));
  assert.match(view.container.textContent, /新文件内容/);
  assert.doesNotMatch(view.container.textContent, /旧文件内容/);
  assert.equal(view.container.querySelector('[aria-busy="true"]'), null);
});

test('cancelling an asynchronous read discards its late rejection and never imports', async t => {
  const pending = deferred();
  const view = await fixture(t);
  await view.select({ name: 'cancel.json', size: 100, text: () => pending.promise });
  await view.click(view.button('取消读取'));
  await act(async () => pending.reject(new Error('stale read failure')));
  assert.equal(view.container.querySelector('[role="alert"]'), null);
  assert.equal(view.container.querySelector('[aria-label="备份导入预览"]'), null);
  assert.equal(view.container.querySelector('[aria-busy="true"]'), null);
  assert.equal(view.imports.length, 0);
});

test('cancelling a parsed preview adds no records', async t => {
  const view = await fixture(t);
  await view.select(file('cancel-preview.json', backup()));
  await view.click(view.button('取消导入'));
  assert.equal(view.container.querySelector('[aria-label="备份导入预览"]'), null);
  assert.equal(view.imports.length, 0);
});

test('unmounting prevents a pending read from publishing a preview or importing', async t => {
  const pending = deferred();
  const view = await fixture(t);
  await view.select({ name: 'unmount.json', size: 100, text: () => pending.promise });
  await view.unmount();
  await act(async () => pending.resolve(JSON.stringify(backup())));
  assert.equal(view.container.textContent, '');
  assert.equal(view.imports.length, 0);
});

test('file read failures are shown and an import exception cannot be confirmed repeatedly', async t => {
  let imports = 0;
  const view = await fixture(t, { onImport: () => { imports++; throw new Error('模拟导入失败'); } });
  await view.select({ name: 'unreadable.json', size: 100, text: async () => { throw new Error('模拟读取失败'); } });
  assert.match(view.container.querySelector('[role="alert"]').textContent, /模拟读取失败/);
  await view.select(file('valid.json', backup()));
  const confirm = view.button('确认导入只读副本');
  await act(async () => {
    confirm.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    confirm.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(imports, 1);
  assert.equal(confirm.disabled, true);
  assert.match(view.container.querySelector('[role="alert"]').textContent, /模拟导入失败/);
});

test('portable export uses compact JSON, initiates a download and delays URL cleanup through unmount', async t => {
  const values = [], clicks = [], revoked = [], timers = [];
  const data = backup('未保存的内存会话');
  data.sessions[0].incomplete = true;
  t.mock.method(URL, 'createObjectURL', value => { values.push(value); return 'blob:simulated-download'; });
  t.mock.method(URL, 'revokeObjectURL', value => revoked.push(value));
  t.mock.method(window.HTMLAnchorElement.prototype, 'click', function () { clicks.push({ href: this.href, name: this.download, connected: this.isConnected }); });
  t.mock.method(window, 'setTimeout', (callback, delay) => { timers.push({ callback, delay }); return 1; });
  const view = await fixture(t, { onExport: () => data });
  await view.click(view.button('导出会话备份'));
  assert.equal(values.length, 1);
  assert.equal(await values[0].text(), JSON.stringify(data));
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].connected, true);
  assert.match(clicks[0].name, /^easel-conversations-.*\.json$/);
  assert.match(view.container.textContent, /已发起 1 个会话的备份下载/);
  assert.doesNotMatch(view.container.textContent, /已保存到|下载成功/);
  assert.equal(document.querySelector('a[download]'), null);
  assert.deepEqual(revoked, []);
  await view.unmount();
  assert.deepEqual(revoked, []);
  assert.equal(timers[0].delay, 60_000);
  timers[0].callback();
  assert.deepEqual(revoked, ['blob:simulated-download']);
});

test('raw export has a distinct filename and reports unreadable entries without claiming importability', async t => {
  const data = { format: 'easel-raw-conversation-storage', version: 1, exportedAt: '2026-09-30T00:00:00.000Z', entries: [{ key: 'easel_sessions', value: null, readable: false }, { key: 'postcraft_sessions', value: null, readable: true }] };
  let blob, filename;
  t.mock.method(URL, 'createObjectURL', value => { blob = value; return 'blob:raw'; });
  t.mock.method(window.HTMLAnchorElement.prototype, 'click', function () { filename = this.download; });
  t.mock.method(window, 'setTimeout', () => 1);
  const view = await fixture(t, { onExportRaw: () => data });
  await view.click(view.button('导出原始存储'));
  assert.equal(await blob.text(), JSON.stringify(data));
  assert.match(filename, /^easel-raw-conversation-storage-/);
  assert.match(view.container.textContent, /此排障文件不能通过会话导入入口直接导入/);
  assert.match(view.container.textContent, /不会清除原始值/);
  assert.match(view.container.textContent, /原始备份有 1 项读取失败/);
});

test('callback and browser download failures report failure without a success notice', async t => {
  const view = await fixture(t, { onExport: () => { throw new Error('没有可导出的会话'); } });
  await view.click(view.button('导出会话备份'));
  assert.match(view.container.querySelector('[role="alert"]').textContent, /导出失败：没有可导出的会话/);
  assert.doesNotMatch(view.container.textContent, /已发起/);
  t.mock.method(URL, 'createObjectURL', () => { throw new Error('模拟下载不可用'); });
  await view.click(view.button('导出原始存储'));
  assert.match(view.container.querySelector('[role="alert"]').textContent, /模拟下载不可用/);
  assert.doesNotMatch(view.container.textContent, /已发起/);
});

test('unsaved imports remain visible and retry persistence without importing them again', async t => {
  let fail = true, imports = 0, writes = 0;
  const key = 'conversation-backup-card-test';
  globalThis.localStorage = {
    setItem() { writes++; if (fail) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' }); },
  };
  t.after(async () => {
    fail = false;
    await act(async () => persistence.writeLocalValue(key, 'cleanup'));
    delete globalThis.localStorage;
  });
  const view = await fixture(t, {
    onImport: () => { imports++; persistence.writeLocalValue(key, 'new imported records'); return { count: 1, firstSessionId: 'unsaved-import' }; },
  });
  await view.select(file('unsaved.json', backup()));
  await view.click(view.button('确认导入只读副本'));
  assert.equal(imports, 1);
  assert.match(view.container.textContent, /仅确认保留在当前页面/);
  assert.match(view.container.textContent, /请勿重复导入/);
  assert.equal(view.button('确认导入只读副本'), undefined);
  await view.click(view.button('重试保存导入记录'));
  assert.match(view.container.textContent, /重试仍未成功/);
  assert.equal(imports, 1);
  fail = false;
  // A later normal write can succeed without using this card's retry button.
  await act(async () => persistence.writeLocalValue(key, 'saved by a later update'));
  assert.equal(view.button('重试保存导入记录'), undefined);
  fail = true;
  await act(async () => persistence.writeLocalValue(key, 'new unsaved update'));
  assert.match(view.container.textContent, /仅确认保留在当前页面/);
  assert.doesNotMatch(view.container.textContent, /重试仍未成功/);
  fail = false;
  await view.click(view.button('重试保存导入记录'));
  assert.equal(imports, 1);
  assert.equal(writes, 5);
  assert.equal(view.button('重试保存导入记录'), undefined);
  assert.doesNotMatch(view.container.textContent, /仅确认保留在当前页面/);
  await view.click(view.button('打开首个导入记录'));
  assert.deepEqual(view.opens, ['unsaved-import']);
});

test.after(async () => {
  await window.happyDOM.abort();
  window.close();
});
