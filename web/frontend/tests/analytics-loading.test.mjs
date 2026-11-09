import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new JSDOM('', {url:'https://easel.test/'}).window;
globalThis.localStorage = window.localStorage;
globalThis.sessionStorage = window.sessionStorage;
const cache = await loadTsModule('../src/lib/analyticsCache.ts');
const api = await loadTsModule('../src/lib/api.ts');
const tick = async () => { for (let i=0;i<12;i++) await Promise.resolve(); };
function identity(name) {
  localStorage.setItem('easel_whoami', JSON.stringify({zhihu:{identityKey:name,accountId:name}}));
}
const sample = (count=10) => ({platform:'zhihu',loggedIn:true,fetched_at:1,followers:count,notes:[],metrics:[]});

test('stalled collection clears shared loading, preserves saved results, rejects late data and permits retry', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  identity('timeout-owner');
  cache.restoreAnalyticsSnapshot('zhihu',sample(),cache.analyticsScope('zhihu'));
  let finish,signal,calls=0;
  const capture = s => { calls++;signal=s;return new Promise(resolve=>{finish=resolve;}); };
  const first = cache.collectAnalytics('zhihu',capture,true);
  const second = cache.collectAnalytics('zhihu',capture,true);
  const failures = [assert.rejects(first,/读取超时/),assert.rejects(second,/读取超时/)];
  await tick();
  assert.equal(calls,1);assert.equal(cache.analyticsPending('zhihu'),true);
  t.mock.timers.tick(105000);await Promise.all(failures);
  assert.equal(signal.aborted,true);assert.equal(cache.analyticsPending('zhihu'),false);
  assert.equal(cache.readAnalyticsCache('zhihu').followers,10);
  assert.match(cache.analyticsError('zhihu'),/读取超时/);
  const retried = await cache.collectAnalytics('zhihu',async()=>sample(20),true);
  assert.equal(retried.followers,20);assert.equal(cache.analyticsError('zhihu'),'');
  finish(sample(999));await tick();
  assert.equal(cache.readAnalyticsCache('zhihu').followers,20);
  assert.equal(cache.analyticsPending('zhihu'),false);
});

test('account switch discards a late collection without affecting the new account',async()=>{
  identity('old-owner');let finish;
  const task=cache.collectAnalytics('zhihu',()=>new Promise(resolve=>{finish=resolve;}),true);
  await tick();identity('new-owner');
  const rejected=assert.rejects(task,/账号已切换/);
  finish(sample(99));await rejected;
  assert.equal(cache.analyticsPending('zhihu'),false);
  assert.equal(cache.readAnalyticsCache('zhihu'),null);
  assert.equal(cache.analyticsError('zhihu'),'');
});

test('stalled snapshot body ends without starting a collection or overwriting saved data',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});identity('snapshot-owner');
  cache.restoreAnalyticsSnapshot('zhihu',sample(30),cache.analyticsScope('zhihu'));
  let signal,finish;const calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls.push(url);signal=options.signal;
    return {ok:true,json:()=>new Promise(resolve=>{finish=resolve;})};
  });
  const task=api.restoreAccountAnalytics('zhihu');const rejected=assert.rejects(task,/暂未读取成功/);
  await tick();t.mock.timers.tick(10000);await rejected;
  assert.equal(signal.aborted,true);
  finish({data:sample(999),running:true});await tick();
  assert.deepEqual(calls,['/api/analytics/zhihu/snapshot']);
  assert.equal(cache.readAnalyticsCache('zhihu').followers,30);
});
