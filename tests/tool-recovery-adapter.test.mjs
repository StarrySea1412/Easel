// Run in the fixed OpenClaw container with EASEL_LLM_SDK pointing at plugin-sdk/llm.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createToolRecoveryStream } from '../openclaw/easel-agent-safety/recovery.mjs';

test('real OpenClaw transport: malformed/length/schema/closed stream recovery never dispatches rejected calls',
  { skip: !process.env.EASEL_LLM_SDK }, async () => {
    const sdk = await import(process.env.EASEL_LLM_SDK);
    for (const fault of ['malformed', 'length', 'schema', 'closed', 'twice', '524-once', '524-persistent']) {
      let requests = 0; const payloads = [], audit = [];
      const server = createServer(async (req, res) => {
        let body = ''; for await (const b of req) body += b;
        payloads.push(JSON.parse(body)); requests++;
        if (fault.startsWith('524') && (requests === 1 || fault === '524-persistent')) {
          res.writeHead(524, { 'Content-Length': '0' }); res.end(); return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({
          id: 'fixture', object: 'chat.completion.chunk', model: 'fixture',
          choices: [{ index: 0, delta, finish_reason }],
        }) + '\n\n');
        const bad = requests === 1 || fault === 'twice';
        const args = bad && ['malformed', 'length', 'closed', 'twice'].includes(fault)
          ? '{"operation":"begin"' : bad && fault === 'schema' ? '{"operation":2}'
          : '{"operation":"begin"}';
        send({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-' + requests, type: 'function',
          function: { name: 'easel_write_artifact', arguments: args } }] });
        if (bad && fault === 'closed') { res.end(); return; }
        send({}, bad && fault === 'length' ? 'length' : 'tool_calls');
        res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }) + '\n\n');
        res.end('data: [DONE]\n\n');
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const model = { id: 'fixture', provider: 'happycoding', api: 'openai-completions',
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`, reasoning: false, input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 16384 };
        const tool = { name: 'easel_write_artifact', description: 'fixture only', parameters: {
          type: 'object', required: ['operation'], additionalProperties: false, properties: { operation: { type: 'string', enum: ['begin'] } } } };
        const context = { messages: [{ role: 'user', content: 'SYNTHETIC', timestamp: Date.now() }], tools: [tool] };
        const wrapped = createToolRecoveryStream(sdk.streamSimple, { createStream: sdk.createAssistantMessageEventStream,
          validateToolCall: sdk.validateToolCall, record: row => audit.push(row) });
        const stream = await wrapped(model, context, { apiKey: 'synthetic-not-a-secret', maxTokens: 16384 });
        const events = []; for await (const event of stream) events.push(event);
        const result = await stream.result();
        assert.equal(requests, 2, fault + ': ' + result.errorMessage);
        const exhausted = fault === 'twice' || fault === '524-persistent';
        assert.equal(events.filter(e => e.type === 'toolcall_end').length, exhausted ? 0 : 1, fault);
        assert.equal(result.stopReason, exhausted ? 'error' : 'toolUse', fault);
        assert.equal(result.usage.output, fault === '524-persistent' ? 0 : fault === 'closed' || fault === '524-once' ? 20 : 40);
        if (fault.startsWith('524')) assert.deepEqual(payloads[1].messages, payloads[0].messages, fault);
        assert.equal(payloads[1].messages.at(-1).role, 'user');
        assert(audit[0].outcome !== 'validated', fault);
      } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    }
  });
