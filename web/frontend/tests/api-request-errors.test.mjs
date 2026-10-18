import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = { location: { pathname: '/' } };
const { runAgent } = await loadTsModule('../src/lib/api.ts', import.meta.url);

function stubFetch(payload, status = 413) {
  globalThis.fetch = async () => ({ ok: false, status, statusText: 'error', json: async () => payload });
}

test('structured error details keep the backend explanation', async () => {
  stubFetch({
    detail: {
      code: 'chat_context_budget', category: 'context_budget', retryable: true,
      message: '本轮上下文已接近运行时安全预算，未提交模型请求；请先让当前会话总结/压缩，或新建对话后分批继续。',
    },
  });
  await assert.rejects(runAgent('hi'), /本轮上下文已接近运行时安全预算/);
});

test('plain text and FastAPI validation details keep their existing rendering', async () => {
  stubFetch({ detail: '直出的文本文案' });
  await assert.rejects(runAgent('hi'), /直出的文本文案/);
  stubFetch({ detail: [{ msg: '字段缺失' }, { msg: '字段超长' }] });
  await assert.rejects(runAgent('hi'), /字段缺失；字段超长/);
});

test('unknown shapes still fall back to the generic message', async () => {
  stubFetch({ detail: { code: 'no_message' } });
  await assert.rejects(runAgent('hi'), /请求失败（413/);
});
