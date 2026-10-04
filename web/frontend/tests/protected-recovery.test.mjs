import test from 'node:test';
import assert from 'node:assert/strict';
import { tsModuleUrl } from './load-ts.mjs';

const prefix = 'data:text/javascript;base64,';
const persistenceUrl = await tsModuleUrl(new URL('../src/lib/localPersistence.ts', import.meta.url));
const recoveryUrl = await tsModuleUrl(new URL('../src/lib/protectedRecovery.ts', import.meta.url));

let sequence = 0;
function memoryStorage(initial = {}, behavior = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { if (behavior.failRead) throw new Error('blocked'); return values.get(key) ?? null; },
    setItem(key, value) { if (behavior.failWrite) { const e = new Error('full'); e.name = behavior.failWriteName || 'QuotaExceededError'; throw e; } values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

async function isolatedRecovery(storage, behavior) {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: memoryStorage(storage, behavior) });
  const uniquePersistence = `${persistenceUrl}#recovery-${++sequence}`;
  const code = Buffer.from(recoveryUrl.slice(prefix.length), 'base64').toString().replaceAll(persistenceUrl, uniquePersistence);
  const unique = `${prefix}${Buffer.from(code).toString('base64')}#recovery-${sequence}`;
  return { mod: await import(unique), persistence: await import(uniquePersistence) };
}

test('replaceProtectedValue rejects keys outside the conversation allowlist', async () => {
  const { mod } = await isolatedRecovery({});
  const result = mod.replaceProtectedValue('evil_key', '[]');
  assert.equal(result.status, 'rejected');
  assert.match(result.message, /不在会话恢复范围/);
});

test('inspectProtectedData reports present, absent and unreadable keys', async () => {
  const { mod } = await isolatedRecovery({ easel_sessions: '[{"id":"a"}]' });
  const plan = mod.inspectProtectedData();
  const sessions = plan.candidates.find(c => c.key === 'easel_sessions');
  const publish = plan.candidates.find(c => c.key === 'easel_publish_draft');
  assert.equal(sessions.present, true);
  assert.equal(sessions.size, '[{"id":"a"}]'.length);
  assert.equal(sessions.sample, '[{"id":"a"}]');
  assert.equal(publish.present, false);
  assert.equal(publish.sample, null);
});

test('successful write unprotects: value lands and status is written', async () => {
  const { mod } = await isolatedRecovery({ 'easel-sessions': 'CORRUPT{{' });
  const result = mod.replaceProtectedValue('easel-sessions', '[]');
  assert.equal(result.status, 'written');
  assert.match(result.message, /保护已解除/);
  assert.equal(globalThis.localStorage.getItem('easel-sessions'), '[]');
});

test('oversize replacement is rejected and storage is untouched', async () => {
  const original = 'KEEP-ME';
  const { mod } = await isolatedRecovery({ easel_sessions: original });
  const big = 'x'.repeat(20 * 1024 * 1024 + 1);
  const result = mod.replaceProtectedValue('easel_sessions', big);
  assert.equal(result.status, 'rejected');
  assert.equal(globalThis.localStorage.getItem('easel_sessions'), original);
});

test('failed write keeps protection and reports retryable failure', async () => {
  const original = 'CORRUPT{';
  const { mod, persistence } = await isolatedRecovery({ easel_sessions: original }, { failWrite: true });
  const before = persistence.getLocalPersistenceStatus();
  assert.equal(before.message, null);
  const result = mod.replaceProtectedValue('easel_sessions', '[]');
  assert.equal(result.status, 'failed');
  assert.match(result.message, /未变动/);
  assert.match(result.message, /重试/);
  assert.equal(globalThis.localStorage.getItem('easel_sessions'), original);
  const after = persistence.getLocalPersistenceStatus();
  assert.equal(after.unsaved, true);
  assert.match(after.message, /尚未保存/);
});

test('recovery allowlist covers exactly the documented session and publish keys', async () => {
  const { mod } = await isolatedRecovery({});
  assert.deepEqual([...mod.RECOVERY_KEYS], ['easel_sessions', 'easel-sessions', 'postcraft_sessions', 'easel_publish_draft', 'postcraft_publish_draft']);
});
