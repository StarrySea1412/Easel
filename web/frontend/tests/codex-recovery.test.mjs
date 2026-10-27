import test from 'node:test';
import assert from 'node:assert/strict';
import { tsModuleUrl } from './load-ts.mjs';
const {applyCodexResult}=await import(await tsModuleUrl(new URL('../src/lib/codexRecovery.ts',import.meta.url)));
const session=()=>({id:'s',engine:'codex',pendingTurnId:'newer',messages:[
  {role:'user',content:'original prompt'},
  {role:'assistant',turnId:'old',content:'partial',error:{message:'lost'},activity:'preserved'},
  {role:'user',content:'new prompt'},
]});
const result=()=>({sessionId:'s',turn_id:'old',status:'done',outcome:'completed',text:'original result',thinking:'summary',thinkingStatus:'available',elapsedMs:1250});
test('native result replaces only its own assistant; preserves newer pending and user inputs',()=>{
  const before=session();const after=applyCodexResult(before,'old',result());
  assert.equal(after.messages.length,3);assert.equal(after.messages[0],before.messages[0]);
  assert.equal(after.messages[2],before.messages[2]);assert.equal(after.pendingTurnId,'newer');
  assert.equal(after.messages[1].content,'original result');assert.equal(after.messages[1].error,undefined);
  assert.equal(after.messages[1].activity,'preserved');assert.equal(after.messages[1].thinkingStatus,'available');
  assert.deepEqual(applyCodexResult(after,'old',result()),after);
});
test('foreign, in-progress, unknown and unbound historical records never overwrite a message',()=>{
  const before=session();
  for(const change of [{sessionId:'foreign'},{turn_id:'foreign'},{status:'running'},{outcome:'unconfirmed'}]){
    assert.equal(applyCodexResult(before,'old',{...result(),...change}),before);
  }
  assert.equal(applyCodexResult({...before,engine:'openclaw'},'old',result()).messages,before.messages);
  assert.equal(applyCodexResult(before,'absent',{...result(),turn_id:'absent'}),before);
});
test('missing pending reply appended once; interruptions stay stopped and failures retain errors',()=>{
  const before={...session(),pendingTurnId:'pending'};
  const snapshot={...result(),turn_id:'pending',outcome:'interrupted'};
  const after=applyCodexResult(before,'pending',snapshot);
  assert.equal(after.messages.length,4);assert.equal(after.messages[3].stopped,true);
  assert.equal(after.pendingTurnId,undefined);
  assert.equal(applyCodexResult(after,'pending',snapshot).messages.length,4);
  const failed=applyCodexResult(session(),'old',{...result(),outcome:'failed',error:{message:'original error'}});
  assert.equal(failed.messages[1].error.message,'original error');
});
