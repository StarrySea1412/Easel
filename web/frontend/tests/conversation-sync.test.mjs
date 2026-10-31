import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {loadTsModule,tsModuleUrl} from './load-ts.mjs';

globalThis.window=new Window({url:'https://workbench.test/'});
const sync=await loadTsModule('../src/lib/conversationSync.ts',import.meta.url);
const session=id=>({id,title:'原对话',created:10,engine:'openclaw',messages:[{role:'user',content:'原问题'},{role:'assistant',content:'原答案',turnId:'turn-one'}]});

test('sync migrates normal visible history, skips imported/worker contexts, and sends the acknowledged revision for regeneration',async t=>{
  const calls=[];let revision=0;
  t.mock.method(globalThis,'fetch',async(path,init)=>{const body=JSON.parse(init.body);calls.push({path,body});return {ok:true,json:async()=>({id:body.conversation.id,saved:true,revision:++revision})};});
  const original=session('sync-normal');
  await sync.syncConversations([original,{...session('readonly'),importedFromBackup:true},{...session('worker'),taskWorker:true}]);
  assert.equal(calls.length,1);assert.equal(calls[0].body.conversation.messages[0].content,'原问题');assert.equal(calls[0].body.baseRevision,undefined);
  await sync.syncConversations([original]);assert.equal(calls.length,1);
  const regenerated={...original,messages:[original.messages[0],{role:'assistant',content:'新答案',turnId:'turn-two'}]};
  await sync.syncConversations([regenerated]);assert.equal(calls[1].body.baseRevision,1);
  assert.ok(calls.every(call=>call.path.endsWith('/api/tasks/conversations')));
});

test('offline migration preserves local messages and retries without marking them synced',async t=>{
  const original=session('sync-offline');const frozen=JSON.stringify(original);let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('offline');});
  await sync.syncConversations([original]);await sync.syncConversations([original]);
  assert.equal(calls,2);assert.equal(JSON.stringify(original),frozen);
});

test('a fresh browser reads the original id and hydrates a stale prefix while preserving divergent local work',async t=>{
  const remote=session('sync-read');
  t.mock.method(globalThis,'fetch',async(path)=>{assert.ok(path.endsWith('/conversations/sync-read'));return {ok:true,json:async()=>({conversation:remote,revision:3})};});
  const loaded=await sync.readServerConversation(remote.id);assert.equal(loaded.id,remote.id);assert.deepEqual(loaded.messages,remote.messages);
  assert.equal(sync.mergeServerConversation([],loaded)[0].id,remote.id);
  const short={...remote,messages:[remote.messages[0]]};assert.equal(sync.mergeServerConversation([short],loaded)[0].messages.length,2);
  const other={...remote,messages:[{role:'user',content:'保留本地修改'}]};const local=[other];assert.equal(sync.mergeServerConversation(local,loaded),local);
});

test('a mismatched server identity never opens another conversation',async t=>{
  t.mock.method(globalThis,'fetch',async()=>({ok:true,json:async()=>({conversation:session('wrong'),revision:1})}));
  await assert.rejects(sync.readServerConversation('wanted'),/原对话记录无效/);
});

test('reading a divergent remote copy never acknowledges it as a writable local revision',async t=>{
  const remote=session('sync-divergent-read');const calls=[];
  t.mock.method(globalThis,'fetch',async(path,init)=>{
    if(init.method==='GET')return {ok:true,json:async()=>({conversation:remote,revision:99})};
    const body=JSON.parse(init.body);calls.push(body);
    return {ok:false,status:409,json:async()=>({detail:'对话存在不同版本'})};
  });
  const loaded=await sync.readServerConversation(remote.id);
  const local={...remote,messages:[{role:'user',content:'本地独有问题'}]};
  const kept=sync.mergeServerConversation([local],loaded);
  await sync.syncConversations(kept);
  assert.equal(calls.length,1);assert.equal(calls[0].baseRevision,undefined);
  assert.equal(kept[0].messages[0].content,'本地独有问题');
});

test('another computer discovers paged original conversations without a notification and skips acknowledged unchanged copies',async t=>{
  const a=session('index-a'),b=session('index-b');const calls=[];
  t.mock.method(globalThis,'fetch',async(path,init)=>{
    calls.push(path);
    const data=path.endsWith('/conversations')?{conversations:[{id:a.id,revision:1}],next:a.id}:
      path.includes('?after=')?{conversations:[{id:b.id,revision:1}],next:null}:
      {conversation:path.endsWith(a.id)?a:b,revision:1};
    return {ok:true,json:async()=>data};
  });
  const loaded=await sync.readServerConversations([]);
  assert.deepEqual(loaded.map(s=>s.id).sort(),[a.id,b.id]);
  assert.ok(calls.some(path=>path.includes('?after=index-a')));
});

test('an adopted unchanged copy receives an equal-length updated answer without another write',async t=>{
  let remote=session('same-length-update'),revision=1;const writes=[];
  t.mock.method(globalThis,'fetch',async(path,init)=>{
    if(init.method==='POST'){writes.push(JSON.parse(init.body));return {ok:true,json:async()=>({id:remote.id,saved:true,revision})};}
    return {ok:true,json:async()=>path.endsWith('/conversations')?{conversations:[{id:remote.id,revision}],next:null}:{conversation:remote,revision}};
  });
  let local=sync.mergeServerConversation([],await sync.readServerConversation(remote.id));
  remote={...remote,messages:[remote.messages[0],{...remote.messages[1],content:'同轮更新的完整答案'}]};revision++;
  local=sync.mergeServerConversation(local,(await sync.readServerConversations(local))[0]);
  assert.equal(local[0].messages[1].content,'同轮更新的完整答案');
  await sync.syncConversations(local);
  assert.equal(writes.length,0,'adopting a server snapshot must not echo it back');
});

test('equal-length refresh preserves a locally edited branch and edits made while the read was in flight',async t=>{
  let remote=session('same-length-conflict'),revision=1;
  t.mock.method(globalThis,'fetch',async(path)=>({ok:true,json:async()=>path.endsWith('/conversations')?{conversations:[{id:remote.id,revision}],next:null}:{conversation:remote,revision}}));
  const local=sync.mergeServerConversation([],await sync.readServerConversation(remote.id));
  remote={...remote,messages:[remote.messages[0],{...remote.messages[1],content:'远端新答案'}]};revision++;
  const pending=(await sync.readServerConversations(local))[0];
  const edited=structuredClone(local);edited[0].messages[1].content='本地编辑不能丢';
  assert.equal(sync.mergeServerConversation(edited,pending),edited);
  const later=(await sync.readServerConversations(edited))[0];
  assert.equal(sync.mergeServerConversation(edited,later),edited);
});

test('accepted revision and content baseline survive a browser module restart',async t=>{
  let remote=session('same-length-after-reload'),revision=4;
  t.mock.method(globalThis,'fetch',async(path)=>({ok:true,json:async()=>path.endsWith('/conversations')?{conversations:[{id:remote.id,revision}],next:null}:{conversation:remote,revision}}));
  const local=sync.mergeServerConversation([],await sync.readServerConversation(remote.id));
  const restored=await import((await tsModuleUrl(new URL('../src/lib/conversationSync.ts',import.meta.url)))+'#isolated-reload');
  remote={...remote,messages:[remote.messages[0],{...remote.messages[1],content:'刷新后仍能取回同轮完整答案'}]};revision++;
  const next=restored.mergeServerConversation(local,(await restored.readServerConversations(local))[0]);
  assert.equal(next[0].messages[1].content,'刷新后仍能取回同轮完整答案');
});

test('adopting server history cancels a queued old mirror without granting it the new revision',async t=>{
  const blocker=session('sync-blocker'),old=session('sync-queued-old');let release;
  const gate=new Promise(resolve=>{release=resolve;});const writes=[];
  const remote={...old,messages:[...old.messages,{role:'user',content:'服务器新增的一轮'}]};
  t.mock.method(globalThis,'fetch',async(path,init)=>{
    if(init.method==='GET')return {ok:true,json:async()=>({conversation:remote,revision:10})};
    const body=JSON.parse(init.body);writes.push(body);
    if(body.conversation.id===blocker.id)await gate;
    return {ok:true,json:async()=>({id:body.conversation.id,saved:true,revision:1})};
  });
  const first=sync.syncConversations([blocker]);
  const queued=sync.syncConversations([old]);
  const adopted=sync.mergeServerConversation([old],await sync.readServerConversation(old.id));
  release();await Promise.all([first,queued]);
  assert.equal(adopted[0].messages.length,3);
  assert.deepEqual(writes.map(body=>body.conversation.id),[blocker.id]);
});
