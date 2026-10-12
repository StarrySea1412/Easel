import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = { location: { pathname: '/' } };
const { decodeChatTiming, finishChatTiming, formatChatElapsed } = await loadTsModule('../src/lib/chatTiming.ts', import.meta.url);
const { streamChat } = await loadTsModule('../src/lib/api.ts', import.meta.url);
const { createConversationBackup, parseConversationBackup, createImportedSessions } = await loadTsModule('../src/lib/conversationBackup.ts', import.meta.url);

test('timing freezes before display drain and restored completion does not grow with offline time', () => {
  const done = finishChatTiming({ startedAt: 100000 }, 165500);
  assert.equal(done.elapsedMs, 65500);
  assert.equal(finishChatTiming(done, 999999).elapsedMs, 65500);
  assert.equal(formatChatElapsed(done.elapsedMs), '1分5秒');
  assert.equal(formatChatElapsed(3661000), '1小时1分1秒');
  assert.deepEqual(decodeChatTiming({ startedAt: 'old', elapsedMs: -1 }), {});
  assert.deepEqual(finishChatTiming({}), {});
});

test('replayed terminal timing is delivered before failure and completed snapshots remain stable', async t => {
  const order = [], encoder = new TextEncoder();
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode('id: 1\nevent: timing\ndata: {"startedAt":100000}\n\n'
      + 'id: 2\nevent: timing\ndata: {"startedAt":100000,"elapsedMs":7000}\n\n'
      + 'id: 3\nevent: error\ndata: {"code":"fixture_failure","message":"Fixture error"}\n\n'));
    controller.close();
  }})));
  await new Promise(resolve => streamChat('', undefined, 'timing-fixture', () => {}, () => {},
    () => { order.push('error'); resolve(); }, undefined, undefined, undefined, 'timing-turn', true,
    undefined, [], undefined, undefined, [], {}, undefined, undefined, undefined, undefined, undefined,
    value => order.push(value)));
  assert.deepEqual(order, [{ startedAt: 100000 }, { startedAt: 100000, elapsedMs: 7000 }, 'error']);
});

test('completed elapsed duration survives export/import while live start identifiers are not exported', () => {
  const session = { id: 'fixture', title: 'Fixture', created: 1, messages: [
    { role: 'assistant', content: 'done', startedAt: 123456, elapsedMs: 4321 }] };
  const backup = createConversationBackup([session]);
  assert.equal(backup.sessions[0].messages[0].elapsedMs, 4321);
  assert.equal('startedAt' in backup.sessions[0].messages[0], false);
  const parsed = parseConversationBackup(JSON.stringify(backup));
  assert.equal(parsed.sessions[0].messages[0].elapsedMs, 4321);
  assert.equal(createImportedSessions(parsed, [])[0].messages[0].elapsedMs, 4321);
  assert.throws(() => parseConversationBackup(JSON.stringify({ ...backup, sessions: [{ ...backup.sessions[0],
    messages: [{ role: 'assistant', content: '', elapsedMs: -3 }] }] })), /耗时/);
});
