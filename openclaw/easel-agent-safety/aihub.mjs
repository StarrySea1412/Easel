import { appendFileSync, mkdirSync, existsSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const AIHUB_CONNECTION_ERROR = 'Easel AI Hub connection interrupted';
export const AIHUB_SERVICE_ERROR = 'Easel AI Hub upstream rejected request';
const NOTICE = 'AI Hub 请求未完成，已停止自动重发；已完成的工具结果保留，请核对后继续。';

export function aihubFailure(raw) {
  const text = typeof raw === 'string' ? raw : '';
  if (/^(?:Error:[ \t]*)?(?:Connection error\.?|fetch failed|socket hang up|LLM request failed: network connection was interrupted\.?|Easel AI Hub connection interrupted)$/.test(text))
    return { code: 'model_provider_connection_failed', message: AIHUB_CONNECTION_ERROR };
  if (/^(?:Error:[ \t]*)?(?:50[234]|524)(?: status code|\b)/.test(text) || text === AIHUB_SERVICE_ERROR)
    return { code: 'model_service_unavailable', message: AIHUB_SERVICE_ERROR };
  return null;
}

function audit(row) {
  try {
    const directory = join(process.env.EASEL_DATA_DIR || '/data', 'logs');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'aihub-transport.jsonl');
    if (existsSync(path) && statSync(path).size > 512 * 1024) renameSync(path, path + '.1');
    appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n', { mode: 0o600 });
  } catch { /* Diagnostics must never change request semantics. */ }
}

/** Preserve live events and the guarded SDK transport; never replay a request. */
async function abortable(value, signal) {
  if (!signal) return await value;
  if (signal.aborted) throw new Error('aborted');
  let listener;
  const aborted = new Promise((_, reject) => {
    listener = () => reject(new Error('aborted'));
    signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([value, aborted]); }
  finally { signal.removeEventListener('abort', listener); }
}

export function createAihubStream(baseStream, { createStream, validateToolCall, record = audit }) {
  return (model, context, options = {}) => {
    const output = createStream(), requestId = randomUUID(), started = performance.now();
    void (async () => {
      let message, terminal, firstEventMs = null, events = 0;
      const facts = { requestId, provider: 'aihub', model: /^[A-Za-z0-9_.:/+-]{1,300}$/.test(model.id) ? model.id : 'unknown' };
      const write = row => { try { record({ ...facts, ...row }); } catch {} };
      try {
        if (options.signal?.aborted) throw new Error('aborted');
        const source = await abortable(Promise.resolve(baseStream(model, context, { ...options,
          async onPayload(payload, selected) {
            const replacement = await options.onPayload?.(payload, selected);
            const actual = replacement === undefined ? payload : replacement;
            write({ outcome: 'request_prepared', payloadBytes: Buffer.byteLength(JSON.stringify(actual)),
              tools: Array.isArray(actual?.tools) ? actual.tools.length : 0,
              toolReceipts: Array.isArray(actual?.messages) ? actual.messages.filter(m => m.role === 'tool').length : 0 });
            return replacement;
          },
        })), options.signal);
        const iterator = source[Symbol.asyncIterator]();
        while (true) {
          const next = await abortable(iterator.next(), options.signal);
          if (next.done) break;
          const event = next.value;
          if (event.type === 'done' || event.type === 'error') { terminal = event; continue; }
          if (event.type !== 'start') {
            firstEventMs ??= Math.round(performance.now() - started);
            events++;
          }
          if (!event.type.startsWith('toolcall_')) output.push(event);
        }
        message = await abortable(source.result(), options.signal);
        const calls = (message.content || []).filter(b => b.type === 'toolCall');
        if (message.stopReason === 'toolUse' || calls.length && message.stopReason !== 'error' && message.stopReason !== 'aborted') {
          try {
            if (message.stopReason !== 'toolUse' || !calls.length) throw new Error('terminal');
            const ids = new Set();
            for (const call of calls) {
              if (!call.id || ids.has(call.id)) throw new Error('identity');
              ids.add(call.id);
              validateToolCall(context.tools, call);
            }
          } catch { message = { ...message, stopReason: 'error', easelErrorCode: 'model_tool_call_invalid',
            errorMessage: 'Provider returned an incomplete or malformed tool call' }; }
        }
      } catch (error) {
        const classified = aihubFailure(error instanceof Error ? error.message : '');
        message = { role: 'assistant', provider: model.provider, model: model.id, api: model.api,
          timestamp: Date.now(), content: [], stopReason: options.signal?.aborted ? 'aborted' : 'error',
          errorMessage: classified?.message || 'Easel AI Hub request failed' };
      }
      const cancelled = options.signal?.aborted || message.stopReason === 'aborted';
      if (cancelled) message = { ...message, stopReason: 'aborted' };
      if (message.stopReason === 'error') {
        const classified = aihubFailure(message.errorMessage);
        // A failed POST does not prove the upstream did no work. Use the host's
        // structured terminal marker to stop session AND model-fallback retries.
        // Keep the precise Easel diagnosis separate from the host protocol code.
        message = { ...message, errorCode: 'PROVIDER_POST_DISPATCH_AMBIGUITY',
          ...(classified ? { easelErrorCode: classified.code, errorMessage: classified.message } : {}),
          content: [...(message.content || []).filter(b => b.type === 'text' || b.type === 'thinking'), { type: 'text', text: NOTICE }] };
      }
      write({ outcome: cancelled ? 'aborted' : message.stopReason === 'error' ? 'request_failed_no_replay' : 'completed',
        ...(['model_provider_connection_failed', 'model_service_unavailable', 'model_tool_call_invalid'].includes(message.easelErrorCode)
          ? { code: message.easelErrorCode } : {}), firstEventMs, events,
        elapsedMs: Math.round(performance.now() - started), automaticRetries: 0 });
      if (message.stopReason === 'toolUse') message.content.forEach((call, contentIndex) => {
        if (call.type !== 'toolCall') return;
        output.push({ type: 'toolcall_start', contentIndex, partial: message });
        output.push({ type: 'toolcall_end', contentIndex, toolCall: call, partial: message });
      });
      output.push(message.stopReason === 'error' || message.stopReason === 'aborted'
        ? { type: 'error', reason: message.stopReason, error: message }
        : { ...(terminal || {}), type: 'done', reason: message.stopReason, message });
      output.end(message);
    })();
    return output;
  };
}

export function registerAihub(api) {
  api.registerProvider({ id: 'aihub', label: 'AI Hub', auth: [],
    wrapStreamFn(ctx) {
      if (typeof ctx.streamFn !== 'function') return;
      let wrapped;
      return async (model, context, options) => {
        if (model.api !== 'openai-completions') return ctx.streamFn(model, context, options);
        wrapped ||= import('openclaw/plugin-sdk/llm').then(sdk => createAihubStream(ctx.streamFn,
          { createStream: sdk.createAssistantMessageEventStream, validateToolCall: sdk.validateToolCall }));
        return (await wrapped)(model, context, options);
      };
    },
  });
}
