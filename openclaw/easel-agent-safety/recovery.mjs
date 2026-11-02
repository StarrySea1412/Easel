import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_TOOL_ARGUMENT_BYTES = 12000;
export const REPAIR_INSTRUCTION = '上一次模型响应在工具派发前被拒绝，没有执行其中任何调用。仅重新生成尚未执行的下一步，保留此前工具结果，不重复已成功的工具或已受理的生图、发布、支付任务。工具参数必须是符合所给schema的完整JSON对象，每个参数对象不超过12000 UTF-8字节。长文本使用easel_write_artifact的begin/append/status/commit，每块最多3000字符，固定requestId、序号从0递增；完成后easel_present交付。此次修复仅可使用已提供的read/read_file/web_search/web_fetch/view_image/easel_write_artifact/easel_present/easel_plan_update/easel_goal_update/easel_task_guard工具，禁止exec、浏览器操作、启动Agent或提交生图/发布/支付；必要时用文字说明需核对后继续。生图不能改为HTML。不要重复原来的超长响应。';
const REPAIR_SAFE_TOOLS = new Set(['read', 'read_file', 'web_search', 'web_fetch', 'view_image',
  'easel_write_artifact', 'easel_present', 'easel_plan_update', 'easel_goal_update', 'easel_task_guard']);
const REJECTIONS = new Set([
  'Provider returned an incomplete or malformed tool call',
  'Provider completed tool call with malformed JSON arguments',
  'Provider completed stream with an incomplete tool call',
]);

function audit(record) {
  const directory = join(process.env.EASEL_DATA_DIR || '/data', 'logs');
  const path = join(directory, 'model-tool-recovery.jsonl');
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (existsSync(path) && statSync(path).size > 512 * 1024) renameSync(path, path + '.1');
    appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n', { mode: 0o600 });
  } catch { /* Diagnostics cannot turn a completed model response into a retry. */ }
}

function failed(model, reason, aborted = false) {
  return { role: 'assistant', provider: model.provider, model: model.id, api: model.api,
    content: [], timestamp: Date.now(), stopReason: aborted ? 'aborted' : 'error', errorMessage: reason,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

function combinedUsage(previous, current) {
  const result = { ...current };
  for (const [key, value] of Object.entries(previous || {})) {
    if (typeof value === 'number' && Number.isFinite(value)) result[key] = value + (Number(current?.[key]) || 0);
    else if (key === 'cost' && value && typeof value === 'object') result.cost = combinedUsage(value, current?.cost);
  }
  return result;
}

function fingerprint(call) {
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return JSON.stringify([call.name, canonical(call.arguments)]);
}

function completedCalls(context) {
  const calls = new Map(), completed = new Set();
  for (const message of context.messages || []) {
    if (message.role === 'assistant') for (const block of message.content || []) {
      if (block.type === 'toolCall') calls.set(block.id, block);
    }
    if (message.role === 'toolResult' && !message.isError && calls.has(message.toolCallId)) completed.add(fingerprint(calls.get(message.toolCallId)));
  }
  return completed;
}

async function abortable(promise, signal) {
  if (!signal) return await promise;
  if (signal.aborted) throw new Error('aborted');
  let listener;
  const aborted = new Promise((_, reject) => {
    listener = () => reject(new Error('aborted'));
    signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener('abort', listener); }
}

function emitValidated(stream, message) {
  stream.push({ type: 'start', partial: message });
  if (message.stopReason !== 'error' && message.stopReason !== 'aborted') {
    message.content.forEach((block, contentIndex) => {
      if (block.type === 'toolCall') {
        stream.push({ type: 'toolcall_start', contentIndex, partial: message });
        stream.push({ type: 'toolcall_end', contentIndex, toolCall: block, partial: message });
      } else if (block.type === 'text' || block.type === 'thinking') {
        const content = block.type === 'text' ? block.text : block.thinking;
        stream.push({ type: block.type + '_start', contentIndex, partial: message });
        stream.push({ type: block.type + '_delta', contentIndex, delta: content || '', partial: message });
        stream.push({ type: block.type + '_end', contentIndex, content: content || '', partial: message });
      }
    });
    stream.push({ type: 'done', reason: message.stopReason, message });
  } else stream.push({ type: 'error', reason: message.stopReason, error: message });
  stream.end(message);
}

/** Request-level recovery. The rejected response never reaches a tool dispatcher. */
export function createToolRecoveryStream(baseStream, { createStream, validateToolCall, record = audit, repairTimeoutMs = 120000 }) {
  // One repair shared by every model step owned by this prepared runtime.
  let repairs = 0;
  return (model, context, options = {}) => {
    if (!Array.isArray(context.tools) || !context.tools.length) return baseStream(model, context, options);
    const output = createStream(), requestId = randomUUID();
    void (async () => {
      let firstUsage, message, activeSignal = options.signal;
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          if (options.signal?.aborted) { message = failed(model, 'aborted', true); break; }
          const repair = attempt > 0;
          const controller = repair ? new AbortController() : null;
          const timer = repair ? setTimeout(() => controller.abort(), repairTimeoutMs) : null;
          const signal = repair ? options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal : options.signal;
          activeSignal = signal;
          let observedTool = false, argumentBytes = 0;
          try {
            const nextContext = repair ? { ...context, messages: [...(context.messages || []),
              { role: 'user', content: REPAIR_INSTRUCTION, timestamp: Date.now() }] } : context;
            const source = await abortable(Promise.resolve(baseStream(model, nextContext, { ...options, signal })), signal);
            const iterator = source[Symbol.asyncIterator]();
            while (true) {
              const next = await abortable(iterator.next(), signal);
              if (next.done) break;
              const event = next.value;
              if (event.type.startsWith('toolcall_')) observedTool = true;
              if (event.partial?.content) for (const block of event.partial.content) {
                if (block.type === 'toolCall') argumentBytes = Math.max(argumentBytes,
                  Buffer.byteLength(typeof block.partialArgs === 'string' ? block.partialArgs : JSON.stringify(block.arguments || {})));
              }
              // Consume privately. Never publish a provisional toolcall_end.
            }
            message = await abortable(source.result(), signal);
          } finally { if (timer) clearTimeout(timer); }
          if (signal?.aborted) { message = failed(model, 'aborted', true); break; }
          let reason = null;
          if (message.stopReason === 'error' && REJECTIONS.has(message.errorMessage)) reason = 'malformed_tool_call';
          if (message.stopReason === 'error' && observedTool && message.errorMessage === 'Stream ended without finish_reason') reason = 'tool_stream_incomplete';
          if (['length', 'max_tokens'].includes(message.stopReason) && observedTool) reason = 'tool_output_limit';
          const calls = (message.content || []).filter(block => block.type === 'toolCall');
          if (calls.length && !['toolUse', 'error', 'aborted'].includes(message.stopReason)) reason = 'unconfirmed_tool_call';
          if (message.stopReason === 'toolUse') {
            try {
              if (!calls.length) throw Error('missing');
              const ids = new Set();
              for (const call of calls) {
                if (typeof call.id !== 'string' || !call.id || ids.has(call.id)) throw Error('identity');
                ids.add(call.id);
                const size = Buffer.byteLength(JSON.stringify(call.arguments));
                argumentBytes = Math.max(argumentBytes, size);
                if (size > MAX_TOOL_ARGUMENT_BYTES) { reason = 'tool_arguments_too_large'; break; }
                validateToolCall(context.tools, call);
              }
            } catch { reason = 'tool_schema_invalid'; }
          }
          if (repair && calls.some(call => completedCalls(context).has(fingerprint(call)))) reason = 'completed_tool_replay_blocked';
          if (repair && calls.some(call => !REPAIR_SAFE_TOOLS.has(call.name))) reason = 'unsafe_repaired_tool_blocked';
          record({ requestId, attempt, provider: model.provider, model: model.id,
            maxTokens: options.maxTokens ?? model.maxTokens ?? null, stopReason: message.stopReason,
            outputTokens: message.usage?.output ?? null, argumentBytes,
            outcome: reason || (message.stopReason === 'error' ? 'error' : 'validated') });
          if (!reason) break;
          if (reason === 'completed_tool_replay_blocked' || reason === 'unsafe_repaired_tool_blocked' || repairs >= 1 || repair) {
            const usage = message.usage;
            message = { ...failed(model, 'Easel tool call recovery exhausted'), usage,
              errorCode: 'easel_tool_recovery_exhausted',
              // A nonempty diagnostic prevents OpenClaw's separate silent-turn retry.
              content: [{ type: 'text', text: '工具参数恢复未通过安全校验，请核对原任务记录后继续。' }] };
            break;
          }
          repairs++;
          firstUsage = message.usage;
          // Same model, auth, tool schemas and prior receipts. No tool is rerun.
        }
      } catch {
        message = failed(model, activeSignal?.aborted ? 'aborted' : 'Easel model response recovery failed', activeSignal?.aborted);
      }
      if (firstUsage) message = { ...message, usage: combinedUsage(firstUsage, message.usage) };
      emitValidated(output, message);
    })();
    return output;
  };
}

export function registerToolRecovery(api) {
  api.registerProvider({ id: 'happycoding', label: 'Happycoding', auth: [],
    wrapStreamFn(ctx) {
      if (ctx.modelId !== 'deepseek-v4.1-flash' || typeof ctx.streamFn !== 'function') return;
      let wrapped;
      return async (model, context, options) => {
        wrapped ||= import('openclaw/plugin-sdk/llm').then(sdk => createToolRecoveryStream(ctx.streamFn,
          { createStream: sdk.createAssistantMessageEventStream, validateToolCall: sdk.validateToolCall }));
        return (await wrapped)(model, context, options);
      };
    },
  });
}
