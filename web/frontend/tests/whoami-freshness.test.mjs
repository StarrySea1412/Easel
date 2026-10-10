import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { loadTsModule } from './load-ts.mjs';
globalThis.window = new Window({url:'https://easel.test/'});
globalThis.localStorage = window.localStorage;
const { isWhoamiFresh, getWhoamiCache, setWhoamiCache, verifyStale } = await loadTsModule('../src/lib/whoami.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));
test('rewriting a cache entry cannot extend the original online verification time', () => {
  localStorage.clear();
  setWhoamiCache('zhihu', {loggedIn:true,name:'old',avatar:'',checkedAt:Date.now()-700000,verified:true});
  assert.equal(isWhoamiFresh(getWhoamiCache().zhihu), false);
  assert.equal(isWhoamiFresh({loggedIn:true,name:'',avatar:'',checkedAt:Date.now()+60000}), false);
});
test('failed automatic check retains identity but marks its status unknown and broadcasts the result', async t => {
  localStorage.clear(); setWhoamiCache('zhihu',{loggedIn:true,name:'retained identity',avatar:'',checkedAt:Date.now()-700000});
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('synthetic offline');});
  const errors=[]; verifyStale(['zhihu'],{onError:(_p,message)=>errors.push(message)}); await tick(); await tick();
  const entry=getWhoamiCache().zhihu;
  assert.equal(entry.name,'retained identity'); assert.equal(entry.verified,false);
  assert.equal(isWhoamiFresh(entry),false); assert.deepEqual(errors,['synthetic offline']);
});
test('a late automatic result cannot overwrite another tab changing the account cache', async t => {
  localStorage.clear(); let finish;
  t.mock.method(globalThis,'fetch',()=>new Promise(resolve=>{finish=resolve;}));
  verifyStale(['zhihu']);
  const current={loggedIn:true,name:'new identity',avatar:'',checkedAt:Date.now(),ts:Date.now()};
  localStorage.setItem('easel_whoami',JSON.stringify({zhihu:current}));
  finish({ok:true,json:async()=>({loggedIn:false,name:'stale',avatar:'',verified:true})});
  await tick(); await tick(); assert.equal(getWhoamiCache().zhihu.name,'new identity');
});
