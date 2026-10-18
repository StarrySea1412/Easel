import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTsModule} from './load-ts.mjs';

// 辅助对话（侧边面板子会话）的纯逻辑：归属、序号、多实例顺序、标签顺序与 /side 语法。
const {sideChatOf,sideChatsOf,sideChatTitle,computeSideOrder,lastExchangeQuote}=await loadTsModule('../src/lib/sideChat.ts',import.meta.url);
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

test('a parent can own multiple side chats, oldest first for tabs and newest as the default',()=>{
  const second={id:'c2',title:'辅助对话 2',created:3,parentSessionId:'p'};
  assert.deepEqual(sideChatsOf(parent,[parent,second,child]).map(s=>s.id),['c1','c2']);
  assert.equal(sideChatOf(parent,[parent,second,child])?.id,'c2','the default tab is the most recently created side chat');
  assert.deepEqual(sideChatsOf(parent,[parent]),[]);
  assert.deepEqual(sideChatsOf(child,[parent,child,second]),[],'children only belong to the parent session');
  assert.deepEqual(sideChatsOf(parent,[{id:'other',parentSessionId:'x',created:1,messages:[]}]),[]);
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

test('tab order honors sideOrder and computeSideOrder inserts before or after the target',()=>{
  const second={id:'c2',title:'辅助对话 2',created:3,parentSessionId:'p'};
  const forced=[{...child,sideOrder:1},{...second,sideOrder:0}];
  assert.deepEqual(sideChatsOf(parent,[forced[0],forced[1]]).map(s=>s.id),['c2','c1'],'sideOrder wins over creation time');
  const ids=['s1','s2','s3'];
  assert.deepEqual(computeSideOrder(ids,'s3','s1',false),['s3','s1','s2'],'insert before the target');
  assert.deepEqual(computeSideOrder(ids,'s1','s3',true),['s2','s3','s1'],'insert after the target');
  assert.deepEqual(computeSideOrder(ids,'s2','s2',true),ids,'the same id keeps the order');
  assert.deepEqual(computeSideOrder(ids,'missing','s1',true),ids,'unknown ids keep the order');
});
