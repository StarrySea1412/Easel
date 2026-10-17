import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { loadTsModule } from './load-ts.mjs';

// 分享载荷、回传合并（去重与来源标注）以及两个接口的错误透出。
globalThis.window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://easel.test/' }).window;
globalThis.document = window.document;
const { sharePayloadFor, mergeShareAppends, createConversationShare, fetchShareAppends } = await loadTsModule('../src/lib/conversationShare.ts', import.meta.url);

const session = {
  id: 's1', title: '拆解对话', created: 1, engine: 'openclaw',
  messages: [
    { role: 'user', content: '帮我拆解', requestedModelRef: 'relay/glm-5.3' },
    { role: 'assistant', content: '', agentContent: '内部提示词' },
    { role: 'assistant', content: '初版报告' },
  ],
};
const append = { appendId: 'ap-1', at: 101, source: { model: 'glm-5.3', harness: 'ZCode' }, note: '', messages: [{ role: 'assistant', content: '接管产出' }, { role: 'assistant', content: '   ' }] };

test('the share payload is the complete readable transcript without internal fields', () => {
  const payload = sharePayloadFor(session);
  assert.deepEqual(payload.messages, [
    { role: 'user', content: '帮我拆解' },
    { role: 'assistant', content: '初版报告' },
  ], 'empty assistant placeholders are skipped, no agentContent leaks');
  assert.equal(payload.meta.modelRef, 'relay/glm-5.3');
  assert.equal(payload.sessionId, 's1');
});

test('loading appends merges once, labels the source and keeps history intact', () => {
  const first = mergeShareAppends(session, [append]);
  assert.equal(first.added, 1);
  assert.equal(first.session.messages.length, 4);
  const merged = first.session.messages.at(-1);
  assert.equal(merged.content, '接管产出');
  assert.equal(merged.shareAppend.appendId, 'ap-1');
  assert.equal(merged.shareAppend.source.harness, 'ZCode');
  const again = mergeShareAppends(first.session, [append]);
  assert.equal(again.added, 0, 'the same appendId never duplicates messages');
  assert.equal(again.session, first.session);
});

test('share endpoints surface backend failures with honest messages', async t => {
  const replies = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    replies.push({ url: String(url), method: options.method || 'GET' });
    if (String(url).includes('/api/conversation-shares') && (options.method || 'GET') === 'POST') {
      return { ok: true, json: async () => ({ token: 'Tok_' + 'A'.repeat(24), title: '拆解对话', createdAt: 5, messageCount: 2 }) };
    }
    if (String(url).includes('/missing')) return { ok: false, status: 404, json: async () => ({ detail: '分享不存在或已删除' }) };
    return { ok: true, json: async () => ({ token: 'Tok_' + 'A'.repeat(24), title: '拆解对话', messageCount: 2, appends: [append], appendCount: 1 }) };
  });
  const created = await createConversationShare(session);
  assert.equal(created.messageCount, 2);
  const loaded = await fetchShareAppends(created.token);
  assert.equal(loaded.appends[0].appendId, 'ap-1');
  await assert.rejects(() => fetchShareAppends('missing'), /分享不存在/);
  await assert.rejects(() => createConversationShare({ ...session, messages: [] }), /还没有可分享的内容/);
});
