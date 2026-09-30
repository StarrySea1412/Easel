import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

globalThis.window = { location: { pathname: '/' } };
const source = fs.readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { streamChat } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const event = (name, value) => `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
async function consume(chunks) {
  const thinking = [], content = [], activity = [];
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    controller.close();
  }}));
  await new Promise((resolve, reject) => streamChat('test', undefined, 'isolated', chunk => content.push(chunk), resolve, reject, chunk => thinking.push(chunk), step => activity.push(step)));
  return { thinking, content, activity };
}

test('real thinking deltas remain separate from answer and tool status across split SSE frames', async () => {
  const raw = event('thinking', '先读取材料。') + event('activity', '读取文件') + event('thinking', '再核对来源。') + event('token', '这是答案。') + event('done', {});
  const result = await consume([raw.slice(0, 21), raw.slice(21, 76), raw.slice(76)]);
  assert.deepEqual(result, { thinking: ['先读取材料。', '再核对来源。'], content: ['这是答案。'], activity: ['读取文件'] });
});
test('status-only streams do not fabricate thinking; non-text payloads are ignored', async () => {
  const result = await consume([event('activity', '正在思考') + event('thinking', { text: 'not the delta contract' }) + event('thinking', null) + event('token', '答案') + event('done', {})]);
  assert.deepEqual(result.thinking, []);
  assert.deepEqual(result.activity, ['正在思考']);
});
test('thinking text beyond 4000 characters survives stream consumption', async () => {
  const text = '真实返回'.repeat(1400);
  const result = await consume([event('thinking', text) + event('done', {})]);
  assert.equal(result.thinking.join(''), text);
});
