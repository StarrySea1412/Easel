import test from 'node:test';
import assert from 'node:assert/strict';
import { tsModuleUrl } from './load-ts.mjs';

const prefix = 'data:text/javascript;base64,';
const storeUrl = await tsModuleUrl(new URL('../src/lib/store.ts', import.meta.url));
const persistenceUrl = await tsModuleUrl(new URL('../src/lib/localPersistence.ts', import.meta.url));
const draftsUrl = await tsModuleUrl(new URL('../src/lib/chatDrafts.ts', import.meta.url));
let sequence = 0;

async function isolatedStore(storage) {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  const uniquePersistence = `${persistenceUrl}#fixture-${++sequence}`;
  const draftCode = Buffer.from(draftsUrl.slice(prefix.length), 'base64').toString().replaceAll(persistenceUrl, uniquePersistence);
  const uniqueDrafts = `${prefix}${Buffer.from(draftCode).toString('base64')}#fixture-${sequence}`;
  const code = Buffer.from(storeUrl.slice(prefix.length), 'base64').toString()
    .replaceAll(persistenceUrl, uniquePersistence).replaceAll(draftsUrl, uniqueDrafts);
  return {
    store: await import(`${prefix}${Buffer.from(code).toString('base64')}#fixture-${sequence}`),
    persistence: await import(uniquePersistence),
  };
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values, calls: [], failRead: false, failedKeys: new Map(),
    getItem(key) {
      this.calls.push(['get', key]);
      if (this.failRead) throw Object.assign(new Error('blocked'), { name: 'SecurityError' });
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      this.calls.push(['set', key, value]);
      if (this.failedKeys.has(key)) throw Object.assign(new Error('not saved'), { name: this.failedKeys.get(key) });
      values.set(key, value);
    },
    removeItem(key) { this.calls.push(['remove', key]); values.delete(key); },
  };
}

function session(id = 'existing', content = '请保留我的消息') {
  return { id, title: 'Existing conversation', created: 123, messages: [{ role: 'user', content }] };
}

test('importing the store neither resets history nor accesses browser storage', async () => {
  const storage = memoryStorage({ easel_sessions: JSON.stringify([session()]), easel_active_session: 'existing' });
  let tabReads = 0;
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { tabReads++; throw new Error('must not touch tab data'); } });
  const { store } = await isolatedStore(storage);
  assert.deepEqual(storage.calls, []);
  assert.equal(tabReads, 0);
  assert.deepEqual(store.loadSessions(), [session()]);
  assert.equal(store.loadActiveId(), 'existing');
  assert.equal(storage.values.has('easel_chat_reset_20260902'), false);
  assert.equal(storage.calls.some(([operation]) => operation === 'remove'), false);
});

test('one malformed record cannot hide healthy sessions or crash message rendering', async () => {
  const saved = [session(), null, {
    id: 'damaged', title: { bad: true }, created: 'yesterday', archived: 'yes',
    messages: [null, 42, { role: 'tool', content: 'internal' }, { role: 'assistant', content: 99, thinking: 12 },
      { role: 'user', content: '正常问题【附件素材】private/path', attachments: [null, { id: 'a', name: 'photo.png', path: 'outputs/photo.png' }], selectedSkills: ['writer', null] },
      { role: 'assistant', content: '有效回答', error: { message: '连接失败', category: 'connection', retryable: true } }],
  }];
  const { store } = await isolatedStore(memoryStorage({ easel_sessions: JSON.stringify(saved) }));
  const loaded = store.loadSessions();
  assert.deepEqual(loaded[0], session());
  assert.equal(loaded[1].title, 'New Chat');
  assert.equal(loaded[1].created, 0);
  assert.equal(loaded[1].messages.length, 3);
  assert.equal(loaded[1].messages[0].content, '');
  assert.equal(loaded[1].messages[1].content, '正常问题');
  assert.equal(loaded[1].messages[1].agentContent, '正常问题【附件素材】private/path');
  assert.deepEqual(loaded[1].messages[1].selectedSkills, ['writer']);
  assert.equal(loaded[1].messages[1].attachments.length, 1);
  assert.equal(loaded[1].messages[2].error.category, 'connection');
});

test('missing or duplicate session identifiers retain all valid messages with distinct keys', async () => {
  const saved = [session('same', 'first'), session('same', 'second'), { messages: [{ role: 'assistant', content: 'recovered' }] }];
  const { store } = await isolatedStore(memoryStorage({ easel_sessions: JSON.stringify(saved) }));
  const loaded = store.loadSessions();
  assert.equal(new Set(loaded.map(item => item.id)).size, 3);
  assert.deepEqual(loaded.map(item => item.messages[0].content), ['first', 'second', 'recovered']);
});

for (const legacyKey of ['postcraft_sessions', 'easel-sessions']) {
  test(`${legacyKey} migrates only after the current-key write succeeds`, async () => {
    const raw = JSON.stringify([session()]);
    const storage = memoryStorage({ [legacyKey]: raw });
    const { store } = await isolatedStore(storage);
    assert.deepEqual(store.loadSessions(), [session()]);
    assert.equal(storage.values.get('easel_sessions'), raw);
    assert.equal(storage.values.has(legacyKey), false);
    const write = storage.calls.findIndex(call => call[0] === 'set');
    const remove = storage.calls.findIndex(call => call[0] === 'remove');
    assert.ok(write >= 0 && remove > write);
  });
}

test('a migration write failure retains the source and still loads its conversations', async () => {
  const raw = JSON.stringify([session()]);
  const storage = memoryStorage({ postcraft_sessions: raw });
  storage.failedKeys.set('easel_sessions', 'QuotaExceededError');
  const { store, persistence } = await isolatedStore(storage);
  assert.deepEqual(store.loadSessions(), [session()]);
  assert.equal(storage.values.get('postcraft_sessions'), raw);
  assert.equal(storage.values.has('easel_sessions'), false);
  assert.equal(persistence.getLocalPersistenceStatus().unsaved, true);
  storage.failedKeys.clear();
  assert.equal(persistence.retryPendingLocalWrites(), true);
  assert.equal(storage.values.get('easel_sessions'), raw);
});

test('an unreadable history is not replaced by a newly created empty session', async () => {
  for (const raw of ['{broken json', '{"notSessions":true}']) {
    const storage = memoryStorage({ easel_sessions: raw });
    const { store, persistence } = await isolatedStore(storage);
    assert.deepEqual(store.loadSessions(), []);
    const empty = store.createSession();
    assert.equal(store.saveSessions([empty]), false);
    assert.equal(storage.values.get('easel_sessions'), raw);
    assert.equal(persistence.retryPendingLocalWrites(), false);
    assert.equal(persistence.getLocalPersistenceStatus().unsaved, true);
    assert.deepEqual(store.loadSessions(), [empty]);
  }
});

test('denied initial reads remain protected even when storage becomes writable', async () => {
  const raw = JSON.stringify([session()]);
  const storage = memoryStorage({ easel_sessions: raw });
  storage.failRead = true;
  const { store, persistence } = await isolatedStore(storage);
  assert.deepEqual(store.loadSessions(), []);
  assert.equal(persistence.getLocalPersistenceStatus().unavailable, true);
  storage.failRead = false;
  assert.equal(store.saveSessions([store.createSession()]), false);
  assert.equal(storage.values.get('easel_sessions'), raw);
});

test('a valid legacy fallback never overwrites unreadable current history or deletes either source', async () => {
  const broken = '{broken current history';
  const legacy = JSON.stringify([session('legacy-recovered')]);
  const storage = memoryStorage({ easel_sessions: broken, postcraft_sessions: legacy });
  const { store, persistence } = await isolatedStore(storage);
  assert.deepEqual(store.loadSessions(), [session('legacy-recovered')]);
  assert.equal(storage.values.get('easel_sessions'), broken);
  assert.equal(storage.values.get('postcraft_sessions'), legacy);
  assert.equal(storage.calls.some(([operation]) => operation === 'set' || operation === 'remove'), false);
  assert.equal(store.saveSessions([session('new-in-memory'), session('legacy-recovered')]), false);
  assert.equal(persistence.retryPendingLocalWrites(), false);
  assert.equal(storage.values.get('easel_sessions'), broken);
  assert.equal(storage.values.get('postcraft_sessions'), legacy);
  assert.equal(persistence.getLocalPersistenceStatus().unsaved, true);
  assert.ok(persistence.getLocalPersistenceStatus().message);
  assert.equal(store.loadSessions()[0].id, 'new-in-memory');
});

test('quota failures retain the newest in-memory changes and retry only their latest snapshot', async () => {
  const storage = memoryStorage({ easel_sessions: JSON.stringify([session()]) });
  const { store, persistence } = await isolatedStore(storage);
  store.loadSessions();
  storage.failedKeys.set('easel_sessions', 'QuotaExceededError');
  assert.equal(store.saveSessions([session('first-change')]), false);
  const latest = [session('latest-change')];
  assert.equal(store.saveSessions(latest), false);
  assert.deepEqual(store.loadSessions(), latest);
  assert.equal(store.saveActiveId('latest-change'), true);
  assert.equal(persistence.getLocalPersistenceStatus().unsaved, true);
  assert.equal(JSON.parse(storage.values.get('easel_sessions'))[0].id, 'existing');
  storage.failedKeys.clear();
  const before = storage.calls.length;
  assert.equal(persistence.retryPendingLocalWrites(), true);
  assert.deepEqual(storage.calls.slice(before).map(call => [call[0], call[1]]), [['set', 'easel_sessions']]);
  assert.equal(JSON.parse(storage.values.get('easel_sessions'))[0].id, 'latest-change');
  assert.equal(persistence.getLocalPersistenceStatus().message, null);
});

test('save failures from security policy and serialization never escape to callers', async () => {
  const storage = memoryStorage();
  const { store, persistence } = await isolatedStore(storage);
  storage.failedKeys.set('easel_sessions', 'SecurityError');
  assert.equal(store.saveSessions([session()]), false);
  assert.equal(persistence.getLocalPersistenceStatus().unavailable, true);
  storage.failedKeys.clear();
  assert.equal(persistence.retryPendingLocalWrites(), true);
  const circular = session();
  circular.messages[0].attachments = [circular];
  assert.equal(store.saveSessions([circular]), false);
  assert.equal(persistence.getLocalPersistenceStatus().unsaved, true);
});

test('saving does not silently truncate real history at 100 sessions', async () => {
  const storage = memoryStorage();
  const { store } = await isolatedStore(storage);
  const sessions = Array.from({ length: 105 }, (_, index) => session(`history-${index}`));
  sessions.push({ ...store.createSession(), pendingTurnId: 'running' }, store.createSession(), store.createSession());
  assert.equal(store.saveSessions(sessions), true);
  const saved = JSON.parse(storage.values.get('easel_sessions'));
  assert.equal(saved.length, 107);
  assert.equal(saved.filter(item => item.messages.length).length, 105);
  assert.equal(saved.some(item => item.pendingTurnId === 'running'), true);
});

test('a newer unserializable value prevents retrying an older stale pending snapshot', async () => {
  const storage = memoryStorage({ easel_sessions: JSON.stringify([session()]) });
  const { store, persistence } = await isolatedStore(storage);
  storage.failedKeys.set('easel_sessions', 'QuotaExceededError');
  store.saveSessions([session('stale-pending')]);
  const circular = session('newest');
  circular.messages[0].attachments = [circular];
  assert.equal(store.saveSessions([circular]), false);
  storage.failedKeys.clear();
  assert.equal(persistence.retryPendingLocalWrites(), false);
  assert.equal(JSON.parse(storage.values.get('easel_sessions'))[0].id, 'existing');
  assert.equal(persistence.getLocalPersistenceStatus().unsaved, true);
});

test('publish drafts normalize broken fields and preserve unreadable originals', async () => {
  const storage = memoryStorage({ easel_publish_draft: JSON.stringify({ title: null, body: '保留正文', platforms: ['douyin', 2], overrides: { douyin: '保留覆盖', xhs: null }, tags: [] }) });
  const { store } = await isolatedStore(storage);
  assert.deepEqual(store.loadPublishDraft(), { title: '', body: '保留正文', platforms: ['douyin'], overrides: { douyin: '保留覆盖' }, tags: '' });
  const broken = memoryStorage({ easel_publish_draft: '{broken' });
  const isolated = await isolatedStore(broken);
  const draft = isolated.store.loadPublishDraft();
  assert.equal(isolated.store.savePublishDraft({ ...draft, body: '页内新稿' }), false);
  assert.equal(broken.values.get('easel_publish_draft'), '{broken');
  assert.equal(isolated.store.loadPublishDraft().body, '页内新稿');
});

test('clearing the active ID cannot resurrect an obsolete legacy ID', async () => {
  const storage = memoryStorage({ postcraft_active_session: 'obsolete' });
  const { store } = await isolatedStore(storage);
  assert.equal(store.saveActiveId(null), true);
  const reloaded = await isolatedStore(storage);
  assert.equal(reloaded.store.loadActiveId(), null);
});

test('imported read-only records preserve literal attachment markers and remain inert after save and reload', async () => {
  const original = { ...session('backup-copy', '解释【附件素材】标记后的原文也必须保留'), importedFromBackup: true, backupIncomplete: true,
    sessionKey: 'old-backend-session', pendingTurnId: 'old-job', persona: 'old-profile' };
  original.messages[0] = { ...original.messages[0], turnId: 'old-turn', agentContent: 'hidden command',
    attachments: [{ id: 'old-file', name: 'file', path: 'outputs/file' }], selectedSkills: ['old-skill'] };
  const storage = memoryStorage({ easel_sessions: JSON.stringify([original]) });
  const { store } = await isolatedStore(storage);
  const loaded = store.loadSessions();
  assert.deepEqual(loaded, [{ ...session('backup-copy', '解释【附件素材】标记后的原文也必须保留'), importedFromBackup: true, backupIncomplete: true }]);
  assert.equal(store.saveSessions(loaded), true);
  const reloaded = await isolatedStore(storage);
  assert.deepEqual(reloaded.store.loadSessions(), loaded);
});

test('subscriptions expose stable snapshots and notify after save callers finish', async () => {
  const storage = memoryStorage();
  const { persistence } = await isolatedStore(storage);
  const before = persistence.getLocalPersistenceStatus();
  assert.equal(before, persistence.getLocalPersistenceStatus());
  let calls = 0;
  const unsubscribe = persistence.subscribeLocalPersistence(() => { calls++; });
  storage.failedKeys.set('example', 'QuotaExceededError');
  assert.equal(persistence.writeLocalValue('example', 'new value'), false);
  assert.equal(calls, 0);
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(calls, 1);
  assert.notEqual(before, persistence.getLocalPersistenceStatus());
  unsubscribe();
  storage.failedKeys.clear();
  persistence.retryPendingLocalWrites();
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(calls, 1);
});
