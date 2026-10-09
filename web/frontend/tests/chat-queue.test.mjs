import test from 'node:test';
import assert from 'node:assert/strict';
import { tsModuleUrl } from './load-ts.mjs';
const moduleUrl = await tsModuleUrl(new URL('../src/lib/chatQueue.ts', import.meta.url));
let sequence = 0;
function storage() {
  const values = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key),
  } });
  return values;
}
const message = text => ({ text, attachments: [], selectedSkills: ['card-quote'], skillRequirements: { 'card-quote': '原要求' }, modelRef: 'relay/model', thinkingLevel: 'off' });
async function fresh() { return import(moduleUrl + `#queue-${++sequence}`); }

test('queue preserves snapshots, order and edits; refresh pauses without restoring stale upload paths', async () => {
  storage(); const q = await fresh();
  const first = message('第一条'); first.attachments.push({ name: 'image.png', path: 'PRIVATE_OLD_PATH', size: 20 });
  assert.ok(q.enqueueChat('a', first)); assert.ok(q.enqueueChat('a', message('第二条')));
  first.skillRequirements['card-quote'] = '调用者后改';
  const firstId = q.getChatQueue('a').items[0].id, secondId = q.getChatQueue('a').items[1].id;
  assert.ok(q.moveQueuedMessage('a', secondId, -1)); assert.ok(q.updateQueuedMessage('a', secondId, '修改后的第二条'));
  const restored = await fresh();
  assert.equal(restored.getChatQueue('a').paused, true);
  assert.equal(restored.getChatQueue('a').error, '', 'ordinary restore is represented by paused rows, not a persistent error');
  assert.deepEqual(restored.getChatQueue('a').items.map(row => row.text), ['修改后的第二条', '第一条']);
  const row = restored.getChatQueue('a').items[1];
  assert.equal(row.skillRequirements['card-quote'], '原要求'); assert.deepEqual(row.attachments, []);
  assert.deepEqual(row.missingAttachments, ['image.png']); assert.equal(restored.resumeChatQueue('a'), false);
  assert.ok(restored.attachQueuedFiles('a', firstId, [{ name: 'image.png', path: 'new-path', size: 30 }]));
  assert.ok(restored.resumeChatQueue('a')); const sent = [];
  assert.ok(restored.dispatchQueuedMessage('a', row => { sent.push(row); return true; }));
  assert.equal(sent[0].text, '修改后的第二条');
  assert.equal(restored.getChatQueue('foreign').items.length, 0);
});

test('failed persistence cannot send or lose a queued message; rejection restores its place and pauses', async () => {
  storage(); const q = await fresh(); q.enqueueChat('a', message('保留'));
  const original = localStorage.setItem;
  localStorage.setItem = () => { throw new Error('quota'); };
  let calls = 0;
  assert.equal(q.dispatchQueuedMessage('a', () => { calls++; return true; }), false);
  assert.equal(calls, 0); assert.equal(q.getChatQueue('a').items.length, 1);
  assert.equal(q.enqueueChat('a', message('未接受')), false);
  localStorage.setItem = original;
  q.resumeChatQueue('a'); assert.equal(q.dispatchQueuedMessage('a', () => false), false);
  assert.equal(q.getChatQueue('a').items[0].text, '保留'); assert.equal(q.getChatQueue('a').paused, true);
  const error = q.getChatQueue('a').error;
  assert.ok(q.enqueueChat('a', message('失败后补充')));
  assert.equal(q.getChatQueue('a').paused, true);
  assert.equal(q.getChatQueue('a').error, error);
  assert.equal(q.dispatchQueuedMessage('a', () => { calls++; return true; }), false);
  assert.equal(calls, 0);
});

test('corrupt original queue is preserved and bounded queues reject extra drafts', async () => {
  const values = storage(); values.set('easel:chat-queue:bad', '{broken'); const q = await fresh();
  assert.equal(q.enqueueChat('bad', message('新草稿')), false);
  assert.equal(values.get('easel:chat-queue:bad'), '{broken');
  for (let index = 0; index < 20; index++) assert.ok(q.enqueueChat('a', message(`消息${index}`)));
  assert.equal(q.enqueueChat('a', message('超限')), false);
});
