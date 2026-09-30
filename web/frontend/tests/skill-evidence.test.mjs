import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const code=ts.transpileModule(fs.readFileSync(new URL('../src/lib/skillEvidence.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {skillState}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
test('loading or attempting a skill never appears successful',()=>{
 for(const status of ['loaded','attempted','not_observed','unknown'])assert.notEqual(skillState({status,evidence:[]}).tone,'success');
 assert.equal(skillState({status:'loaded',evidence:[]}).label,'已读取说明');
});
test('explicit failed tool evidence overrides attempted state',()=>{
 assert.equal(skillState({status:'attempted',evidence:[{kind:'executed',success:false}]}).tone,'error');
 assert.equal(skillState({status:'attempted',evidence:[{kind:'executed',success:null}]}).tone,'pending');
});
test('only successful recorded execution has success presentation',()=>{
 assert.equal(skillState({status:'executed',evidence:[{kind:'executed',success:true}]}).tone,'success');
 assert.equal(skillState({status:'not_observed',evidence:[]}).tone,'unknown');
});
