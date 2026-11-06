import test from 'node:test';
import assert from 'node:assert/strict';
import { createAihubStream, registerAihub, aihubFailure } from '../openclaw/easel-agent-safety/aihub.mjs';

class Stream {
  queue = []; waiters = []; done = false;
  constructor() { this.final = new Promise(resolve => { this.resolve = resolve; }); }
  push(event) { const waiter = this.waiters.shift(); if (waiter) waiter({ value: event, done: false }); else this.queue.push(event); }
  end(value) { this.done = true; this.resolve(value); for (const waiter of this.waiters.splice(0)) waiter({ done: true }); }
  result() { return this.final; }
  [Symbol.asyncIterator]() { return this; }
  async next() { if (this.queue.length) return { value: this.queue.shift(), done: false }; if (this.done) return { done: true }; return new Promise(resolve => this.waiters.push(resolve)); }
}
const model = { id: 'kimi-k3.1-pro', provider: 'aihub', api: 'openai-completions' };
const context = { messages: [{ role: 'user', content: 'PRIVATE_TASK' }], tools: [{ name: 'fixture' }] };
const call = { type: 'toolCall', id: 'call', name: 'fixture', arguments: { value: 1 } };
function harness(message, extra = {}) {
  const requests = [], records = [];
  const base = async (m, c, o) => {
    requests.push({ model: m, context: c, options: o });
    await o.onPayload({ model: m.id, messages: c.messages, tools: c.tools }, m);
    if (message instanceof Error) throw message;
    return { async *[Symbol.asyncIterator]() {
      yield { type: 'start', partial: message };
      yield { type: 'text_delta', delta: 'live', partial: message };
      yield { type: 'toolcall_end', toolCall: call, partial: message };
      yield { type: message.stopReason === 'error' ? 'error' : 'done', message };
    }, result: async () => message };
  };
  return { requests, records, wrapped: createAihubStream(base, { createStream: () => new Stream(),
    validateToolCall(_tools, c) { assert.equal(c.name, 'fixture'); assert.equal(typeof c.arguments.value, 'number'); },
    record: row => records.push(row), ...extra }) };
}
async function consume(stream) { const events = []; for await (const event of stream) events.push(event); return { events, result: await stream.result() }; }
for (const diagnostic of ['Connection error.', '502 status code (no body)', '524 status code (no body)']) {
  test('AI Hub terminal failure does not repeat or dispatch tools: ' + diagnostic, async () => {
    const h = harness({ ...model, stopReason: 'error', errorMessage: diagnostic, content: [call] });
    const { result, events } = await consume(h.wrapped(model, context));
    assert.equal(h.requests.length, 1); assert.equal(result.stopReason, 'error');
    assert.equal(result.errorCode, 'PROVIDER_POST_DISPATCH_AMBIGUITY');
    assert(result.content.some(b => b.type === 'text')); assert(!result.content.some(b => b.type === 'toolCall'));
    assert(!events.some(e => e.type === 'toolcall_end'));
    assert(!JSON.stringify(h.records).includes('PRIVATE'));
    assert.equal(h.records.at(-1).automaticRetries, 0);
  });
}

test('AI Hub group model rejection survives terminal and thrown errors without replay or private diagnostics', async () => {
  const raw = '404 Model "gpt-6.1-sol" is not available for this group';
  for (const value of [{stopReason:'error',errorMessage:raw,content:[call]},new Error(raw)]) {
    const h=harness(value);
    const {result,events}=await consume(h.wrapped({...model,id:'gpt-6.1-sol'},context));
    assert.equal(h.requests.length,1);
    assert.equal(result.easelErrorCode,'model_group_unavailable');
    assert.equal(result.errorMessage,'Easel AI Hub model unavailable for group');
    assert.equal(result.errorCode,'PROVIDER_POST_DISPATCH_AMBIGUITY');
    assert(!events.some(e=>e.type==='toolcall_end'));
    const receipt=h.records.at(-1);
    assert.equal(receipt.code,'model_group_unavailable');
    assert.equal(receipt.upstreamStatus,404);
    assert.equal(receipt.upstreamReason,'model_not_available_for_group');
    assert.equal(receipt.automaticRetries,0);
    assert(!JSON.stringify(h.records).includes('PRIVATE'));
  }
  assert.equal(aihubFailure('User quoted '+raw),null);
  assert.equal(aihubFailure('404 missing page'),null);
  assert.equal(aihubFailure(raw+'\n'),null);
  assert.equal(aihubFailure(raw+'\nPRIVATE'),null);
});
test('AI Hub keeps the original context, settings and live text, then releases valid tools once', async () => {
  const h = harness({ ...model, stopReason: 'toolUse', content: [call] });
  const options = { apiKey: 'PRIVATE_KEY', reasoning: 'high', maxTokens: 8192, onPayload: p => ({ ...p, metadata: 'PRIVATE_METADATA' }) };
  const { result, events } = await consume(h.wrapped(model, context, options));
  assert.equal(result.stopReason, 'toolUse'); assert.equal(h.requests[0].context, context);
  assert.equal(h.requests[0].options.maxTokens, 8192); assert.equal(h.requests[0].options.reasoning, 'high');
  assert.equal(events.filter(e => e.type === 'text_delta').length, 1);
  assert.equal(events.filter(e => e.type === 'toolcall_end').length, 1);
  assert(!JSON.stringify(h.records).includes('PRIVATE'));
});
test('AI Hub rejects malformed calls without recovery or replay', async () => {
  const h = harness({ stopReason: 'toolUse', content: [{ ...call, arguments: {} }] });
  const { result, events } = await consume(h.wrapped(model, context));
  assert.equal(result.easelErrorCode, 'model_tool_call_invalid'); assert.equal(h.requests.length, 1);
  assert(!events.some(e => e.type === 'toolcall_end'));
});
test('AI Hub pre-aborted requests never reach the provider', async () => {
  const h = harness({ stopReason: 'stop', content: [] }), controller = new AbortController(); controller.abort();
  const { result } = await consume(h.wrapped(model, context, { signal: controller.signal }));
  assert.equal(result.stopReason, 'aborted'); assert.equal(h.requests.length, 0);
});
test('AI Hub cancellation settles even if the provider ignores abort', async () => {
  const controller = new AbortController();
  const wrapped = createAihubStream(() => new Promise(() => {}), { createStream: () => new Stream(), record() {} });
  const pending = consume(wrapped(model, context, { signal: controller.signal })); controller.abort();
  assert.equal((await pending).result.stopReason, 'aborted');
});
test('AI Hub registration leaves other protocols alone and diagnostics require an exact marker', async () => {
  let provider; registerAihub({ registerProvider(value) { provider = value; } });
  assert.equal(provider.id, 'aihub'); assert.equal(provider.wrapStreamFn({}), undefined);
  let count = 0; const wrapped = provider.wrapStreamFn({ streamFn() { count++; return 'unchanged'; } });
  assert.equal(await wrapped({ ...model, api: 'anthropic-messages' }, context), 'unchanged');
  assert.equal(count, 1); assert.equal(aihubFailure('用户引用 Connection error.'), null);
});
