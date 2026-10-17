import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {loadTsModule} from './load-ts.mjs';

// The breakdown flow merges into the selected conversation (no new list row);
// store persistence falls back to an in-memory shim when storage is absent.
globalThis.window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://easel.test/' }).window;
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;

const {createBreakdownSession}=await loadTsModule('../src/lib/breakdownChat.ts',import.meta.url);

test('breakdown merges into the selected conversation, keeping its identity, and still starts fresh without one',()=>{
  const base={id:'keep-1',title:'今天的对话',created:5,engine:'codex',messages:[{role:'user',content:'历史'},{role:'assistant',content:'回答'}]};
  const merged=createBreakdownSession('https://example.com/post','persona','model/x',undefined,base);
  assert.equal(merged.id,'keep-1');
  assert.equal(merged.title,'今天的对话','a merged breakdown keeps the conversation title');
  assert.equal(merged.engine,'codex','a merged breakdown keeps the conversation engine');
  assert.equal(merged.messages.length,3);
  assert.equal(merged.messages.at(-1).kind,'breakdown');
  assert.equal(merged.messages.at(-1).requestedModelRef,'model/x');
  assert.ok(merged.pendingTurnId?.startsWith('keep-1-breakdown-'));
  const fresh=createBreakdownSession('https://example.com/post');
  assert.match(fresh.title,/^拆解 · /);
  assert.equal(fresh.messages.length,1);
  assert.equal(fresh.engine,'openclaw');
});
