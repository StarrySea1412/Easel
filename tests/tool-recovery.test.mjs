import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolRecoveryStream, REPAIR_INSTRUCTION, registerToolRecovery } from '../openclaw/easel-agent-safety/recovery.mjs';

class Stream {
  queue = []; waiters = []; done = false;
  constructor() { this.final = new Promise(resolve => { this.resolve = resolve; }); }
  push(event) { const waiter = this.waiters.shift(); if (waiter) waiter({ value: event, done: false }); else this.queue.push(event); }
  end(value) { this.done = true; this.resolve(value); for (const waiter of this.waiters.splice(0)) waiter({ done: true }); }
  result() { return this.final; }
  [Symbol.asyncIterator]() { return this; }
  async next() { if (this.queue.length) return { value: this.queue.shift(), done: false }; if (this.done) return { done: true }; return new Promise(resolve => this.waiters.push(resolve)); }
}
const model = { id: 'deepseek-v4.1-flash', provider: 'happycoding', api: 'openai-completions', maxTokens: 16384 };
const tool = { name: 'easel_write_artifact', parameters: { type: 'object', required: ['content'], properties: { content: { type: 'string' } } } };
const context = { messages: [{ role: 'user', content: 'PRIVATE_TASK', timestamp: 1 }], tools: [tool] };
const call = (id = 'new', text = 'small') => ({ type: 'toolCall', id, name: 'easel_write_artifact', arguments: { content: text } });
const message = (stopReason = 'toolUse', content = [call()], usage = { input: 10, output: 20, totalTokens: 30, cost: { total: 0.01 } }) => ({ role: 'assistant', content, stopReason, usage, provider: model.provider, model: model.id, timestamp: 2 });
const rejected = () => ({ ...message('error', []), errorMessage: 'Provider returned an incomplete or malformed tool call' });
function harness(values, extra = {}) {
  const calls = [], records = [];
  const base = async (m, c, o) => {
    calls.push({ model: m, context: c, options: o });
    const value = values.shift();
    if (typeof value === 'function') return value(m, c, o);
    if (value instanceof Error) throw value;
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'start', partial: value };
        yield { type: 'toolcall_start', contentIndex: 0, partial: value };
        yield { type: 'toolcall_end', contentIndex: 0, toolCall: call('unvalidated'), partial: value };
        yield value.stopReason === 'error' ? { type: 'error', reason: 'error', error: value } : { type: 'done', reason: value.stopReason, message: value };
      },
      result: async () => value,
    };
  };
  const wrapped = createToolRecoveryStream(base, { createStream: () => new Stream(),
    validateToolCall(tools, c) { assert(tools.some(t => t.name === c.name)); assert.equal(typeof c.arguments?.content, 'string'); },
    record: row => records.push(row), ...extra });
  return { wrapped, calls, records };
}
async function consume(stream) { stream = await stream; const events = []; for await (const event of stream) events.push(event); return { events, result: await stream.result() }; }

test('valid response publishes only schema-checked calls, without changing the original request', async () => {
  const h = harness([message()]), original = structuredClone(context);
  const { events, result } = await consume(h.wrapped(model, context, { maxTokens: 16384 }));
  assert.equal(result.stopReason, 'toolUse');
  assert.deepEqual(events.filter(e => e.type === 'toolcall_end').map(e => e.toolCall.id), ['new']);
  assert.deepEqual(context, original); assert.equal(h.calls.length, 1);
});

test('malformed response regenerates one compact request while preserving prior receipts and total usage', async () => {
  const c = { ...context, messages: [...context.messages,
    { role: 'assistant', content: [call('done', 'already saved')] },
    { role: 'toolResult', toolCallId: 'done', content: [{ type: 'text', text: 'saved' }], isError: false }] };
  const h = harness([rejected(), message()]);
  const { events, result } = await consume(h.wrapped(model, c, { apiKey: 'PRIVATE_KEY', maxTokens: 16384 }));
  assert.equal(h.calls.length, 2); assert.equal(result.stopReason, 'toolUse');
  assert.equal(h.calls[1].model, model); assert.equal(h.calls[1].options.apiKey, 'PRIVATE_KEY');
  assert.deepEqual(h.calls[1].context.messages.slice(0, -1), c.messages);
  assert.equal(h.calls[1].context.messages.at(-1).content, REPAIR_INSTRUCTION);
  assert.deepEqual(events.filter(e => e.type === 'toolcall_end').map(e => e.toolCall.id), ['new']);
  assert.equal(result.usage.output, 40); assert.equal(result.usage.totalTokens, 60); assert.equal(result.usage.cost.total, 0.02);
  assert(!JSON.stringify(h.records).includes('PRIVATE'));
});

test('output-limited tool arguments and oversized valid JSON must shrink before dispatch', async () => {
  for (const bad of [message('length', []), message('toolUse', [call('large', '长'.repeat(5000))])]) {
    const h = harness([bad, message()]); const { result, events } = await consume(h.wrapped(model, context));
    assert.equal(h.calls.length, 2); assert.equal(result.stopReason, 'toolUse');
    assert.deepEqual(events.filter(e => e.type === 'toolcall_end').map(e => e.toolCall.id), ['new']);
  }
});

test('schema-invalid and missing tool calls are never dispatched', async () => {
  for (const bad of [message('toolUse', [ { ...call(), arguments: { content: 2 } } ]), message('toolUse', [])]) {
    const h = harness([bad, message()]); const { result } = await consume(h.wrapped(model, context));
    assert.equal(result.stopReason, 'toolUse'); assert.equal(h.calls.length, 2);
  }
});

test('repair budget is shared across model steps and stops after one repair', async () => {
  const h = harness([rejected(), rejected(), rejected()]);
  const first = await consume(h.wrapped(model, context));
  assert.equal(first.result.stopReason, 'error'); assert.equal(h.calls.length, 2);
  const second = await consume(h.wrapped(model, context));
  assert.equal(second.result.stopReason, 'error'); assert.equal(h.calls.length, 3);
  assert(!first.events.some(e => e.type === 'toolcall_end'));
});

test('a repaired call identical to an already completed call is blocked', async () => {
  const c = { ...context, messages: [{ role: 'assistant', content: [call('prior')] },
    { role: 'toolResult', toolCallId: 'prior', content: [], isError: false }] };
  const h = harness([rejected(), message()]); const { result, events } = await consume(h.wrapped(model, c));
  assert.equal(result.stopReason, 'error'); assert.equal(h.records.at(-1).outcome, 'completed_tool_replay_blocked');
  assert(!events.some(e => e.type === 'toolcall_end')); assert.equal(h.calls.length, 2);
});

test('abort before start performs no model request', async () => {
  const h = harness([]), controller = new AbortController(); controller.abort();
  const { result } = await consume(h.wrapped(model, context, { signal: controller.signal }));
  assert.equal(result.stopReason, 'aborted'); assert.equal(h.calls.length, 0);
});

test('repair has a cancellation deadline and never dispatches a late response', async () => {
  const h = harness([rejected(), async (_m, _c, o) => {
    await new Promise(resolve => o.signal.addEventListener('abort', resolve, { once: true }));
    return { async *[Symbol.asyncIterator]() {}, result: async () => message() };
  }], { repairTimeoutMs: 5 });
  const { result, events } = await consume(h.wrapped(model, context));
  assert.equal(result.stopReason, 'aborted'); assert.equal(h.calls.length, 2);
  assert(!events.some(e => e.type === 'toolcall_end'));
});

test('unknown transport failures are not retried', async () => {
  const h = harness([new Error('PRIVATE transport error')]); const { result } = await consume(h.wrapped(model, context));
  assert.equal(result.stopReason, 'error'); assert.equal(h.calls.length, 1);
  assert(!JSON.stringify(result).includes('PRIVATE'));
});

test('repair cannot resubmit a paid image under a new request identity or run arbitrary commands', async () => {
  for (const name of ['easel_generate_image', 'exec', 'browser', 'sessions_spawn']) {
    const h = harness([rejected(), message('toolUse', [{ ...call(), name }])], { validateToolCall() {} });
    const { result, events } = await consume(h.wrapped(model, context));
    assert.equal(result.errorCode, 'easel_tool_recovery_exhausted');
    assert.equal(h.records.at(-1).outcome, 'unsafe_repaired_tool_blocked');
    assert(!events.some(e => e.type === 'toolcall_end'));
  }
});

test('repair deadline settles even when a provider ignores AbortSignal', async () => {
  const h = harness([rejected(), () => new Promise(() => {})], { repairTimeoutMs: 5 });
  const { result } = await consume(h.wrapped(model, context));
  assert.equal(result.stopReason, 'aborted');
});

test('provider registration applies only to the affected model and normal text callers bypass buffering', async () => {
  let provider; registerToolRecovery({ registerProvider(value) { provider = value; } });
  assert.equal(provider.id, 'happycoding'); assert.equal(provider.wrapStreamFn({ modelId: 'other', streamFn() {} }), undefined);
  const h = harness([message('stop', [{ type: 'text', text: 'normal' }])]);
  const { result } = await consume(h.wrapped(model, { messages: [], tools: [] }));
  assert.equal(result.stopReason, 'stop'); assert.equal(h.calls.length, 1);
});
