import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { loadTsModule } from './load-ts.mjs';

globalThis.window=new JSDOM('',{url:'https://easel.test/'}).window;
globalThis.localStorage=window.localStorage;globalThis.sessionStorage=window.sessionStorage;
const api=await loadTsModule('../src/lib/api.ts');
const tick=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
for(const [name,invoke,deadline] of [
  ['sources',()=>api.fetchImportSources(),15000],
  ['preview',()=>api.previewImport('cc-switch','auto'),20000],
  ['catalog',()=>api.discoverImportModels({source:'cc-switch',path:'test.db',id:'test',slot:'openai',previewToken:'test-token'}),35000],
])test(`stalled import ${name} settles once, aborts its transport and permits explicit retry`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let calls=0,signal,finish;
  t.mock.method(globalThis,'fetch',async(_url,init)=>{calls++;signal=init.signal;return new Promise(resolve=>{finish=resolve;});});
  const request=invoke();const rejected=assert.rejects(request,/超时.*尚未写入/);await tick();
  t.mock.timers.tick(deadline);await rejected;assert.equal(calls,1);assert.equal(signal.aborted,true);
  finish(new Response(JSON.stringify({late:true})));await tick();assert.equal(calls,1);
  globalThis.fetch=async()=>new Response(JSON.stringify({retried:true}));assert.deepEqual(await invoke(),{retried:true});
});
test.after(()=>window.close());
