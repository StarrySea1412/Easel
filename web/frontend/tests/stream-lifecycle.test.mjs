import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const compile=async(path)=>{const js=ts.transpileModule(fs.readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);};
const {drainStreamRun}=await compile('../src/lib/streamLifecycle.ts');
const {fetchSkillRecords}=await compile('../src/lib/skillEvidence.ts');
test('a stopped run never finalizes when its queued drain timer fires',()=>{
 const original={turnId:'first'};let current=original,buffered=true,finished=0;const timers=[];
 drainStreamRun(()=>current===original,()=>buffered,()=>finished++,fn=>timers.push(fn));
 current=undefined;buffered=false;timers.shift()();assert.equal(finished,0);
});
test('an old finalizer neither consumes nor clears a replacement run',()=>{
 const original={turnId:'old'};let current=original;const timers=[];
 drainStreamRun(()=>current===original,()=>true,()=>{current=undefined;},fn=>timers.push(fn));
 const replacement={turnId:'new',thinking:'new evidence'};current=replacement;timers.shift()();assert.equal(current,replacement);assert.equal(timers.length,0);
});
test('the owning run finalizes once after buffered answer drains',()=>{
 let buffered=true,finished=0;const timers=[];
 drainStreamRun(()=>true,()=>buffered,()=>finished++,fn=>timers.push(fn));
 assert.equal(finished,0);buffered=false;timers.shift()();assert.equal(finished,1);
});
test('targeted old-turn loading includes turnId and discards foreign session/turn data',async()=>{
 globalThis.window={location:{pathname:'/'}};let target='';
 globalThis.fetch=async(url)=>{target=url;return new Response(JSON.stringify({records:[{sessionId:'a',turnId:'old',status:'completed',invocation:[]},{sessionId:'b',turnId:'old'},{sessionId:'a',turnId:'new'}]}));};
 const rows=await fetchSkillRecords('a','old');assert.equal(new URL(target,'http://local').searchParams.get('turnId'),'old');assert.deepEqual(rows.map(r=>r.turnId),['old']);
});
test('failed old-turn fetch remains an error rather than no execution evidence',async()=>{
 globalThis.fetch=async()=>new Response('{}',{status:503});await assert.rejects(fetchSkillRecords('a','old'),/暂不可读/);
});
