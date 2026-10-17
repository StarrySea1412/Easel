import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTsModule} from './load-ts.mjs';

// 辅助对话（侧边面板子会话）的纯逻辑：归属、序号、上一轮引用与 /side 语法。
const {sideChatOf,sideChatTitle,lastExchangeQuote}=await loadTsModule('../src/lib/sideChat.ts',import.meta.url);
const {suggestsCommand}=await loadTsModule('../src/lib/goalCommand.ts',import.meta.url);

const parent={id:'p',title:'主对话',created:1,messages:[{role:'user',content:'帮我写文案'},{role:'assistant',content:'好的'}]};
const child={id:'c1',title:'辅助对话',created:2,messages:[],parentSessionId:'p'};

test('a side chat belongs to its parent session and never to another one',()=>{
  assert.equal(sideChatOf(parent,[parent,child])?.id,'c1');
  assert.equal(sideChatOf(parent,[parent]),undefined);
  assert.equal(sideChatOf(child,[parent,child]),undefined,'a side chat cannot own a side chat');
  assert.equal(sideChatTitle(parent,[parent]),'辅助对话');
  assert.equal(sideChatTitle(parent,[parent,child]),'辅助对话 2');
});

test('the parent quote keeps the last exchange and stays bounded',()=>{
  const quote=lastExchangeQuote(parent);
  assert.match(quote,/我：帮我写文案/);
  assert.match(quote,/助手：好的/);
  const long={...parent,messages:[{role:'assistant',content:'x'.repeat(900)}]};
  const bounded=lastExchangeQuote(long);
  assert.ok(bounded.length<=601,bounded.length);
  assert.equal(lastExchangeQuote({...parent,messages:[]}),'');
});

test('slash grammar recognizes the side chat commands',()=>{
  assert.equal(suggestsCommand('/side'),true);
  assert.equal(suggestsCommand('/btw'),true);
  assert.equal(suggestsCommand('/s'),true);
  assert.equal(suggestsCommand('/su'),false);
});
