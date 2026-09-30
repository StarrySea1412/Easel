import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './load-ts.mjs';

const { exportRawConversationStorage } = await loadTsModule('../src/lib/conversationStorageBackup.ts', import.meta.url);

test('raw backup preserves corrupt and legacy bytes and reads only conversation keys', () => {
  const values = { easel_sessions: '{corrupt\r\n原文', 'easel-sessions': '["legacy"]', postcraft_sessions: ' null ' };
  const reads = [];
  globalThis.localStorage = {
    getItem(key) { reads.push(key); return values[key]; },
    setItem() { assert.fail('must not save'); },
    removeItem() { assert.fail('must not remove'); },
    key() { assert.fail('must not enumerate other application data'); },
  };
  const result = exportRawConversationStorage();
  assert.equal(result.format, 'easel-raw-conversation-storage');
  assert.equal(result.version, 1);
  assert.deepEqual(reads, Object.keys(values));
  assert.deepEqual(result.entries, Object.entries(values).map(([key, value]) => ({ key, value, readable: true })));
});

test('partial read failures are distinguished from genuinely absent values', () => {
  globalThis.localStorage = { getItem(key) {
    if (key === 'easel_sessions') throw new Error('blocked');
    return key === 'easel-sessions' ? 'legacy raw' : null;
  } };
  const result = exportRawConversationStorage();
  assert.deepEqual(result.entries, [
    { key: 'easel_sessions', readable: false, value: null },
    { key: 'easel-sessions', readable: true, value: 'legacy raw' },
    { key: 'postcraft_sessions', readable: true, value: null },
  ]);
});

test('blocked storage getter reports inability to export rather than an empty successful backup', () => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('denied'); } });
  assert.throws(exportRawConversationStorage, /阻止.*读取/);
  delete globalThis.localStorage;
});
