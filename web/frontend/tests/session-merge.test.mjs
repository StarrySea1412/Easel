import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTsModule} from './load-ts.mjs';
const {pickMergeTarget}=await loadTsModule('../src/lib/sessionMerge.ts',import.meta.url);
const chat=(id,extra={})=>({id,title:id,created:1,messages:[],...extra});

test('only a safe, selected conversation accepts merged starts; everything else falls back to a new row',()=>{
  const none=()=>false;
  assert.equal(pickMergeTarget([chat('a')],null,none),undefined,'no selection means a fresh conversation');
  assert.equal(pickMergeTarget([chat('a')],'missing',none),undefined);
  assert.equal(pickMergeTarget([chat('a')],'a',none)?.id,'a','the selected conversation wins over list order');
  assert.equal(pickMergeTarget([chat('a',{importedFromBackup:true})],'a',none),undefined,'backup imports never accept merged starts');
  assert.equal(pickMergeTarget([chat('a',{pendingTurnId:'turn-x'})],'a',none),undefined,'a pending reply blocks merging');
  assert.equal(pickMergeTarget([chat('busy')],'busy',id=>id==='busy'),undefined,'a streaming session blocks merging');
  assert.equal(pickMergeTarget([chat('b'),chat('a')],'a',none)?.id,'a');
});
