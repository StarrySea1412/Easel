import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTsModule} from './load-ts.mjs';
globalThis.window = { location: { pathname: '/' } };
const {streamChat}=await loadTsModule('../src/lib/api.ts',import.meta.url);
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

test('final snapshot replaces deltas while later completion notes still append', async () => {
  let content = '', thinking = '';
  globalThis.fetch = async () => new Response(event('token', '序字错') + event('thinking', '公开摘要')
    + event('text_snapshot', { invalid: true }) + event('text_snapshot', '正确字序')
    + event('token', '\n完成说明') + event('done', {}));
  await new Promise((resolve, reject) => streamChat('test', undefined, 'isolated', chunk => content += chunk,
    resolve, reject, chunk => thinking += chunk, undefined, undefined, 'snapshot-turn', false,
    undefined, [], undefined, undefined, [], {}, undefined, undefined, undefined, text => content = text));
  assert.equal(content, '正确字序\n完成说明');
  assert.equal(thinking, '公开摘要');
});


test('only confirmed compaction lifecycles reach the caller and normal text remains separate',async()=>{
 const events=[],text=[];
 globalThis.fetch=async()=>new Response(event('compaction',{phase:'start'})+event('compaction',{phase:'guess',percentage:80})+event('token','回答')+event('compaction',{phase:'end',outcome:'failed'})+event('done',{}));
 await new Promise((resolve,reject)=>streamChat('x',undefined,'s',chunk=>text.push(chunk),resolve,reject,undefined,undefined,undefined,'compact-turn',false,undefined,[],undefined,undefined,[],{},undefined,undefined,undefined,undefined,value=>events.push(value)));
 assert.deepEqual(events,[{phase:'start'},{phase:'end',outcome:'failed'}]);assert.deepEqual(text,['回答']);
});
