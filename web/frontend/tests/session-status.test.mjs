import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTsModule} from './load-ts.mjs';
const {sessionStatuses}=await loadTsModule('../src/lib/sessionStatus.ts',import.meta.url);
const user={role:'user',content:'继续处理'};
const answer={role:'assistant',content:'文件已交付',turnId:'turn-1',elapsedMs:500};
const chat=(id,messages=[],extra={})=>({id,title:id,created:1,messages,...extra});
const snapshot=(goals=[],runs=[])=>({goals,runs,plans:[],serverTime:1});
const state=(session,tasks)=>sessionStatuses([session],[],[],tasks).get(session.id)?.kind;

test('running counts deduplicate regular/goal streams and keep stopping until confirmed, including archived chats',()=>{
  const chats=[chat('a'),chat('b',[],{archived:true}),chat('backup',[],{importedFromBackup:true})];
  const tasks=snapshot([{id:'g',sessionId:'a',status:'active'}],[{sessionId:'a',state:'running'}]);
  const statuses=sessionStatuses(chats,['a','a','backup','deleted'],['b'],tasks);
  assert.equal(statuses.size,2);assert.equal(statuses.get('a').kind,'running');assert.equal(statuses.get('b').kind,'stopping');
  assert.equal(sessionStatuses(chats,[],[],snapshot()).size,0);
});
test('badges follow latest turn receipts and persistable errors, never old prose, pending replies or stopped results',()=>{
  assert.equal(state(chat('done',[user,answer])),'completed');
  assert.equal(state(chat('error',[user,{...answer,content:'部分输出',error:{message:'连接因重启中断'}}])),'failed');
  assert.equal(state(chat('stop',[user,{...answer,stopped:true}])),'stopped');
  assert.equal(state(chat('next',[user,answer,user])),undefined);
  assert.equal(state(chat('pending',[user,answer],{pendingTurnId:'new'})),'unconfirmed');
  assert.equal(state(chat('legacy',[{role:'assistant',content:'已完成！'}])),undefined);
  assert.equal(state(chat('injected',[{...answer,externalSource:'gateway-injected'}])),undefined);
  assert.equal(state(chat('backup',[user,answer],{importedFromBackup:true})),undefined);
});
test('goal iteration completion is separate from review, input, pause, failure and final approval',()=>{
  const message={...answer,taskRunId:'run'},g={id:'g',sessionId:'a',status:'blocked',phase:'review'},r={id:'run',goalId:'g',sessionId:'a',state:'completed'};
  const session=chat('a',[message]);
  assert.equal(state(session,snapshot([g],[r])),'review');
  assert.equal(state(session,snapshot([{...g,status:'completed'}],[r])),'completed');
  assert.equal(state(session,snapshot([{...g,phase:'waiting_input'}],[r])),'waiting');
  assert.equal(state(session,snapshot([{...g,phase:'work'}],[r])),'blocked');
  assert.equal(state(session,snapshot([{...g,status:'paused',phase:'work'}],[r])),'paused');
  assert.equal(state(session,snapshot([g],[{...r,state:'failed',reason:'工具执行失败'}])),'failed');
  assert.equal(state(session,snapshot([g],[{...r,state:'stopped'}])),'stopped');
  assert.equal(state(session,snapshot([g],[{...r,state:'unconfirmed'}])),'unconfirmed');
  assert.equal(state(chat('a',[]),snapshot([],[{...r,state:'queued'}])),'queued');
  assert.equal(state(session,snapshot()),undefined,'missing goal snapshot cannot turn iteration into goal success');
  assert.equal(state(chat('a',[{...answer,taskGoalId:'g'}]),snapshot([{...g,status:'draft',phase:'idle'}])),undefined);
});
test('old terminal goal runs cannot override the latest ordinary chat or a newer unanswered user message',()=>{
  const tasks=snapshot([{id:'g',sessionId:'a',status:'completed'}],[{id:'old',goalId:'g',sessionId:'a',state:'failed'}]);
  assert.equal(state(chat('a',[user,answer]),tasks),'completed');
  assert.equal(state(chat('a',[answer,user]),tasks),undefined);
});
