import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './load-ts.mjs';
const values=new Map();
globalThis.localStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
const q=await loadTsModule('../src/lib/chatQueue.ts',import.meta.url);
const {steerQueuedMessage}=await loadTsModule('../src/lib/chatSteering.ts',import.meta.url);
const message=text=>({text,attachments:[],selectedSkills:['s'],skillRequirements:{s:'exact'},modelRef:'relay/model',thinkingLevel:'off'});

test('steering waits for confirmed stop, sends exact selected snapshot and pauses neighbours',async()=>{
 const session='steer-order';q.enqueueChat(session,message('first'));q.enqueueChat(session,message('selected'));q.enqueueChat(session,message('last'));
 const item=q.getChatQueue(session).items[1];let confirm;const sent=[];
 const result=steerQueuedMessage(session,item.id,()=>new Promise(r=>confirm=r),row=>{sent.push(row);return true;});
 assert.equal(sent.length,0);assert.equal(q.getChatQueue(session).paused,true);
 assert.equal(await steerQueuedMessage(session,item.id,async()=>true,()=>{throw Error('duplicate');}),false);
 confirm(true);assert.equal(await result,true);assert.deepEqual(sent,[item]);
 assert.deepEqual(q.getChatQueue(session).items.map(row=>row.text),['first','last']);assert.equal(q.getChatQueue(session).paused,true);
});
test('stop failure, rejected send and edits while stopping preserve queued messages',async()=>{
 const session='steer-failed';q.enqueueChat(session,message('one'));q.enqueueChat(session,message('two'));const id=q.getChatQueue(session).items[1].id;
 assert.equal(await steerQueuedMessage(session,id,async()=>false,()=>{throw Error('must not send');}),false);
 assert.equal(await steerQueuedMessage(session,id,async()=>true,()=>false),false);
 assert.deepEqual(q.getChatQueue(session).items.map(row=>row.text),['one','two']);
 let confirm;const result=steerQueuedMessage(session,id,()=>new Promise(r=>confirm=r),()=>{throw Error('changed');});
 q.updateQueuedMessage(session,id,'edited');confirm(true);assert.equal(await result,false);
 assert.deepEqual(q.getChatQueue(session).items.map(row=>row.text),['one','edited']);
});
