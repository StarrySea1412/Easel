import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolRecoveryStream, REPAIR_INSTRUCTION, registerToolRecovery, streamIdleTimeout, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from '../openclaw/easel-agent-safety/recovery.mjs';

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

test('an idle repair stops locally and never dispatches a late response', async () => {
  const h = harness([rejected(), async (_m, _c, o) => {
    await new Promise(resolve => o.signal.addEventListener('abort', resolve, { once: true }));
    return { async *[Symbol.asyncIterator]() {}, result: async () => message() };
  }], { streamIdleTimeoutMs: 5 });
  const { result, events } = await consume(h.wrapped(model, context));
  assert.equal(result.stopReason, 'error'); assert.equal(result.errorCode, 'model_stream_idle_timeout'); assert.equal(h.calls.length, 2);
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

test('idle detection settles even when a provider ignores AbortSignal', async () => {
  const h = harness([rejected(), () => new Promise(() => {})], { streamIdleTimeoutMs: 5 });
  const { result } = await consume(h.wrapped(model, context));
  assert.equal(result.stopReason, 'error'); assert.equal(result.errorCode, 'model_stream_idle_timeout');
});

test('provider registration applies only to the affected model and text-only requests remain valid', async () => {
  let provider; registerToolRecovery({ registerProvider(value) { provider = value; } });
  assert.equal(provider.id, 'happycoding'); assert.equal(provider.wrapStreamFn({ modelId: 'other', streamFn() {} }), undefined);
  const h = harness([message('stop', [{ type: 'text', text: 'normal' }])]);
  const { result } = await consume(h.wrapped(model, { messages: [], tools: [] }));
  assert.equal(result.stopReason, 'stop'); assert.equal(h.calls.length, 1);
});

const timeout = () => ({ ...message('error', []), errorMessage: '524 status code (no body)' });
const timeoutStream = (value = timeout(), events = []) => async () => ({
  async *[Symbol.asyncIterator]() { yield* events; yield { type: 'error', error: value }; },
  result: async () => value,
});

test('524 recovers the exact request once, including text-only callers, without a repair instruction', async () => {
  for (const c of [context, { ...context, tools: [] }]) {
    const h = harness([timeoutStream(), message('stop', [{ type: 'text', text: 'recovered' }])]);
    const { result } = await consume(h.wrapped(model, c, { apiKey: 'PRIVATE_KEY' }));
    assert.equal(result.stopReason, 'stop'); assert.equal(h.calls.length, 2);
    assert.equal(h.calls[0].context, h.calls[1].context);
    assert.equal(h.calls[1].options.apiKey, 'PRIVATE_KEY');
    assert.equal(result.usage.output, 40);
    assert.deepEqual(h.records.map(r => r.outcome), ['provider_request_retry', 'validated']);
    assert(!JSON.stringify(h.records).includes('PRIVATE'));
  }
});

test('persistent 524 stops after two attempts; request retry budget is shared across steps', async () => {
  const h = harness([timeoutStream(), timeoutStream(), timeoutStream()]);
  const { result, events } = await consume(h.wrapped(model, context));
  assert.equal(h.calls.length, 2); assert.equal(result.stopReason, 'error');
  assert.equal(result.errorMessage, 'Easel provider request recovery stopped');
  assert(result.content.length > 0); assert(!events.some(e => e.type === 'toolcall_end'));
  await consume(h.wrapped(model, context)); assert.equal(h.calls.length, 3);
  assert.deepEqual(h.records.map(r => r.outcome), ['provider_request_retry', 'provider_request_exhausted', 'provider_request_exhausted']);
});

test('idle detection bounds a silent initial response and retry without claiming a provider error or user abort', async () => {
  for (const values of [[() => new Promise(() => {})], [timeoutStream(), () => new Promise(() => {})]]) {
    const h = harness(values, { streamIdleTimeoutMs: 10 });
    const { result, events } = await consume(h.wrapped(model, context));
    assert.equal(result.stopReason, 'error'); assert.equal(result.errorCode, 'model_stream_idle_timeout');
    assert.equal(h.records.at(-1).outcome, 'model_stream_idle_timeout');
    assert.equal(h.records.at(-1).timeoutSource, 'easel_stream_idle');
    assert.equal(h.records.at(-1).idleTimeoutMs, 10);
    assert(!events.some(e => e.type === 'toolcall_end'));
  }
});

test('idle policy is explicit, configurable and can defer all waiting to the caller', () => {
  assert.equal(DEFAULT_STREAM_IDLE_TIMEOUT_MS, 600000);
  assert.equal(streamIdleTimeout({}), 600000);
  assert.equal(streamIdleTimeout({ EASEL_MODEL_STREAM_IDLE_TIMEOUT_MS: '0' }), 0);
  assert.equal(streamIdleTimeout({ EASEL_MODEL_STREAM_IDLE_TIMEOUT_MS: '1800000' }), 1800000);
  for (const value of ['', '-1', 'NaN', 'Infinity', '1e6', '7200001'])
    assert.equal(streamIdleTimeout({ EASEL_MODEL_STREAM_IDLE_TIMEOUT_MS: value }), 600000);
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test('first model response can remain silent beyond the former 90-second total cutoff', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let ready;
  const h = harness([() => new Promise(resolve => { ready = resolve; })]);
  const pending = consume(h.wrapped(model, context));
  t.mock.timers.tick(95000);
  assert.equal(h.calls[0].options.signal.aborted, false);
  const value = message('stop', [{ type: 'text', text: 'long reasoning completed' }]);
  ready({ async *[Symbol.asyncIterator]() { yield { type: 'done', message: value }; }, result: async () => value });
  assert.equal((await pending).result.stopReason, 'stop');
  assert.equal(h.calls.length, 1);
});
function activeStream(kind, final = message('stop', [{ type: 'text', text: 'done' }])) {
  return async () => ({ async *[Symbol.asyncIterator]() {
    yield { type: 'start', partial: message('stop', []) };
    for (let index = 0; index < 12; index++) {
      await delay(10);
      yield kind === 'toolcall_delta' ? { type: kind, partial: message() } : { type: kind, delta: 'progress' };
    }
    yield { type: 'done', message: final };
  }, result: async () => final });
}
test('reasoning, text and tool streams outlive idle windows while calls remain private until validation', async () => {
  for (const kind of ['thinking_delta', 'text_delta', 'toolcall_delta']) {
    const h = harness([activeStream(kind)], { streamIdleTimeoutMs: 60 });
    const { result, events } = await consume(h.wrapped(model, context));
    assert.equal(result.stopReason, 'stop'); assert.equal(h.calls.length, 1);
    assert(!events.some(event => event.type === 'toolcall_end'));
    assert.equal(h.records.at(-1).outcome, 'validated');
  }
  const repair = harness([rejected(), activeStream('thinking_delta', message())], { streamIdleTimeoutMs: 60 });
  assert.equal((await consume(repair.wrapped(model, context))).result.stopReason, 'toolUse');
  assert.equal(repair.calls.length, 2);
});
test('a stream that stalls after provisional tool data stops without dispatch or retry', async () => {
  const h = harness([async () => ({ async *[Symbol.asyncIterator]() {
    yield { type: 'toolcall_end', toolCall: call(), partial: message() };
    await new Promise(() => {});
  }, result: () => new Promise(() => {}) })], { streamIdleTimeoutMs: 10 });
  const { result, events } = await consume(h.wrapped(model, context));
  assert.equal(result.errorCode, 'model_stream_idle_timeout'); assert.equal(h.calls.length, 1);
  assert.equal(h.records.at(-1).observedTool, true);
  assert(!events.some(event => event.type === 'toolcall_end'));
});
test('synthetic start does not extend silent wait and disabled idle still obeys user cancellation', async () => {
  const h = harness([async () => ({ async *[Symbol.asyncIterator]() {
    for (let i = 0; i < 8; i++) { await delay(2); yield { type: 'start' }; }
    await new Promise(() => {});
  }, result: () => new Promise(() => {}) })], { streamIdleTimeoutMs: 10 });
  assert.equal((await consume(h.wrapped(model, context))).result.errorCode, 'model_stream_idle_timeout');
  const controller = new AbortController();
  const cancelled = harness([async () => { setTimeout(() => controller.abort(), 15); return new Promise(() => {}); }], { streamIdleTimeoutMs: 0 });
  const { result } = await consume(cancelled.wrapped(model, context, { signal: controller.signal }));
  assert.equal(result.stopReason, 'aborted'); assert.equal(cancelled.calls.length, 1);
});

test('cancellation during the recovery remains cancelled and dispatches no late response', async () => {
  const controller = new AbortController();
  const h = harness([timeoutStream(), async () => { controller.abort(); return new Promise(() => {}); }]);
  const { result } = await consume(h.wrapped(model, context, { signal: controller.signal }));
  assert.equal(result.stopReason, 'aborted'); assert.equal(h.calls.length, 2);
});

test('HTTP recovery is forbidden after provisional text, reasoning or tool output', async () => {
  for (const event of [{ type: 'text_delta', delta: 'partial' }, { type: 'thinking_delta', delta: 'partial' },
    { type: 'toolcall_start', partial: message() }]) {
    const h = harness([timeoutStream(timeout(), [event])]);
    const { result, events } = await consume(h.wrapped(model, context));
    assert.equal(h.calls.length, 1); assert.equal(result.stopReason, 'error');
    assert(!events.some(e => e.type === 'toolcall_end'));
  }
});

test('transport retry preserves receipts, permits a new image but blocks an already completed identical call', async () => {
  const prior = { ...call('image-prior'), name: 'easel_generate_image' };
  const c = { ...context, messages: [...context.messages, { role: 'assistant', content: [prior] },
    { role: 'toolResult', toolCallId: prior.id, isError: false, content: [] }] };
  const h = harness([timeoutStream(), message('toolUse', [{ ...prior, id: 'new-id' }])], { validateToolCall() {} });
  const { result, events } = await consume(h.wrapped(model, c));
  assert.equal(result.stopReason, 'error'); assert.equal(h.records.at(-1).outcome, 'completed_tool_replay_blocked');
  assert.equal(h.calls[1].context, c); assert(!events.some(e => e.type === 'toolcall_end'));
  const fresh = harness([timeoutStream(), message('toolUse', [{ ...prior, arguments: { content: 'new image' } }])], { validateToolCall() {} });
  assert.equal((await consume(fresh.wrapped(model, c))).result.stopReason, 'toolUse');
});

test('request recovery and parameter repair have independent limits with cumulative usage', async () => {
  const h = harness([timeoutStream(), rejected(), message()]);
  const { result } = await consume(h.wrapped(model, context));
  assert.equal(result.stopReason, 'toolUse'); assert.equal(h.calls.length, 3);
  assert.equal(h.calls[1].context, context);
  assert.equal(h.calls[2].context.messages.at(-1).content, REPAIR_INSTRUCTION);
  assert.equal(result.usage.totalTokens, 90);
});
