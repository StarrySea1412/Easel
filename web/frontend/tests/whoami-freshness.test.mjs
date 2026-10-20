import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { loadTsModule } from './load-ts.mjs';
globalThis.window = new Window({url:'https://easel.test/'});
globalThis.localStorage = window.localStorage;
const { accountConnection, hydrateAccountIdentities, isWhoamiFresh, getWhoamiCache, setWhoamiCache, verifyStale } = await loadTsModule('../src/lib/whoami.ts');
const { accountWhoami, startLogin } = await loadTsModule('../src/lib/api.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('invalid account cache containers and identity shapes cannot reach account rendering', () => {
  for (const raw of ['null', '[]', '1', '"legacy"', '{broken']) {
    localStorage.setItem('easel_whoami', raw);
    assert.deepEqual(getWhoamiCache(), {}, `invalid cache: ${raw}`);
  }
  const valid = { loggedIn: true, name: 'valid identity', avatar: '', ts: Date.now() };
  localStorage.setItem('easel_whoami', JSON.stringify({ zhihu: valid, douyin: null,
    kuaishou: { loggedIn: true, name: { text: 'bad identity' }, avatar: '', ts: Date.now() },
    bilibili: { loggedIn: 'true', name: '', avatar: '' } }));
  assert.deepEqual(getWhoamiCache(), { zhihu: valid });
  assert.equal(JSON.parse(localStorage.getItem('easel_whoami')).kuaishou.name.text, 'bad identity', 'reading must not erase stored data');
});

test('malformed online identity responses are rejected and never overwrite the last known identity as verified', async t => {
  localStorage.clear(); setWhoamiCache('zhihu', { loggedIn: true, name: 'retained', avatar: '', checkedAt: 0 });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ loggedIn: true, name: { nickname: 'wrong shape' }, avatar: '' }) }));
  await verifyStale(['zhihu']);
  assert.equal(getWhoamiCache().zhihu.name, 'retained');
  assert.equal(getWhoamiCache().zhihu.verified, false);
  assert.equal(isWhoamiFresh(getWhoamiCache().zhihu), false);
});
test('rewriting a cache entry cannot extend the original online verification time', () => {
  localStorage.clear();
  setWhoamiCache('zhihu', {loggedIn:true,name:'old',avatar:'',checkedAt:Date.now()-700000,verified:true});
  assert.equal(isWhoamiFresh(getWhoamiCache().zhihu), false);
  assert.equal(isWhoamiFresh({loggedIn:true,name:'',avatar:'',checkedAt:Date.now()+60000}), false);
});

test('every page uses evidence rather than local booleans to decide account state', () => {
  const now = Date.now();
  assert.equal(accountConnection({loggedIn: false, hasLocalSession: true}), 'unknown');
  assert.equal(accountConnection({loggedIn: true, hasLocalSession: true}), 'unknown');
  assert.equal(accountConnection({loggedIn: false, hasLocalSession: false}), 'not_connected');
  assert.equal(accountConnection({loggedIn: true}, {loggedIn:false,verified:true,checkedAt:now,ts:now,name:'',avatar:''}), 'unknown');
  assert.equal(accountConnection({loggedIn: false}, {loggedIn:true,verified:true,checkedAt:now,ts:now,name:'saved',avatar:''}), 'online');
  assert.equal(accountConnection({loggedIn: true}, {loggedIn:false,authState:'login_required',verified:true,checkedAt:now,ts:now,name:'',avatar:''}), 'login_required');
  assert.equal(accountConnection({loggedIn: true}, {loggedIn:false,authState:'login_required',verified:true,checkedAt:now-601000,ts:now,name:'',avatar:''}), 'unknown');
});

test('bare false from an online check preserves identity and never broadcasts a verified logout', async t => {
  localStorage.clear(); setWhoamiCache('zhihu',{loggedIn:true,name:'retained',avatar:'',checkedAt:0});
  t.mock.method(globalThis,'fetch',async()=>({ok:true,json:async()=>({loggedIn:false,verified:true,name:'',avatar:''})}));
  await verifyStale(['zhihu']);
  assert.equal(getWhoamiCache().zhihu.loggedIn,true);
  assert.equal(getWhoamiCache().zhihu.name,'retained');
  assert.equal(accountConnection({loggedIn:true},getWhoamiCache().zhihu),'unknown');
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

test('separate account callers and login startup share one serial admission queue', async t => {
  const calls = []; const pending = [];
  t.mock.method(globalThis, 'fetch', url => { calls.push(url); return new Promise(resolve => pending.push(resolve)); });
  const first = accountWhoami('zhihu');
  const second = accountWhoami('kuaishou', true);
  const login = startLogin('douyin');
  assert.deepEqual(calls, ['/api/accounts/zhihu/whoami']);
  pending.shift()({ok: true, json: async () => ({loggedIn: false})});
  await first; await tick();
  assert.deepEqual(calls, ['/api/accounts/zhihu/whoami', '/api/accounts/kuaishou/whoami?force=true']);
  pending.shift()({ok: false, status: 429, json: async () => ({detail: {message: 'busy'}})});
  await assert.rejects(second, /busy/); await tick();
  assert.equal(calls.at(-1), '/api/login/douyin');
  pending.shift()({ok: true, json: async () => ({mode: 'qr', state: 'qr_ready'})});
  assert.equal((await login).state, 'qr_ready');
});

test('busy admission stops the automatic batch and preserves identity as unverified', async t => {
  localStorage.clear(); setWhoamiCache('zhihu', {loggedIn:true, name:'retained', avatar:'', checkedAt:0});
  const calls = [];
  t.mock.method(globalThis,'fetch',async url => { calls.push(url); return {ok:false,status:429,json:async()=>({detail:{message:'browser busy'}})}; });
  verifyStale(['zhihu','douyin','kuaishou']); await tick(); await tick();
  assert.deepEqual(calls, ['/api/accounts/zhihu/whoami']);
  assert.equal(getWhoamiCache().zhihu.name,'retained');
  assert.equal(getWhoamiCache().zhihu.verified,false);
});

test('opening a login modal stops remaining background checks after the active request', async t => {
  localStorage.clear(); let finish; let alive = true; const calls = [];
  t.mock.method(globalThis,'fetch',url => { calls.push(url); return new Promise(resolve=>{finish=resolve;}); });
  verifyStale(['zhihu','douyin'], {alive:()=>alive});
  alive = false;
  finish({ok:true,json:async()=>({loggedIn:false,verified:true})});
  await tick(); await tick();
  assert.deepEqual(calls,['/api/accounts/zhihu/whoami']);
});

test('unconfirmed checks cool down for ten minutes and duplicate consumers share the active check', async t => {
  localStorage.clear(); let finish; const calls = [];
  t.mock.method(globalThis,'fetch',url => { calls.push(url); return new Promise(resolve => {finish=resolve;}); });
  const first = verifyStale(['bilibili']);
  await verifyStale(['bilibili']);
  assert.equal(calls.length, 1);
  finish({ok:true,json:async()=>({loggedIn:false,verified:false,name:'',avatar:''})});
  await first;
  await verifyStale(['bilibili']);
  assert.equal(calls.length, 1, 'switching pages must not repeat an inconclusive check');
});

test('partial refreshes preserve display details, while account switches and explicit disconnect replace them', () => {
  localStorage.clear();
  setWhoamiCache('douyin',{loggedIn:true,name:'Own',avatar:'https://self.test/me.png',identityKey:'same',accountId:'one',checkedAt:Date.now()-700000});
  setWhoamiCache('douyin',{loggedIn:true,name:'',avatar:'',identityKey:'same',verified:true,checkedAt:Date.now()});
  assert.equal(getWhoamiCache().douyin.name,'Own');
  assert.equal(getWhoamiCache().douyin.avatar,'https://self.test/me.png');
  setWhoamiCache('douyin',{loggedIn:false,name:'',avatar:'',identityKey:'same',verified:false});
  assert.equal(getWhoamiCache().douyin.name,'Own');
  assert.equal(accountConnection(undefined,getWhoamiCache().douyin),'unknown');
  setWhoamiCache('douyin',{loggedIn:true,name:'Other',avatar:'',identityKey:'same',accountId:'two',verified:true,checkedAt:Date.now()});
  assert.equal(getWhoamiCache().douyin.avatar,'');
  setWhoamiCache('douyin',{loggedIn:false,name:'',avatar:'',authState:'not_connected',verified:true,checkedAt:Date.now()});
  assert.equal(getWhoamiCache().douyin.name,'');
});

test('saved server identity restores after cache loss, stays unknown and permits the first real check', async t => {
  localStorage.clear();
  const account={platform:'douyin',identityKey:'new',identity:{loggedIn:true,name:'Saved',avatar:'https://self.test/me.png',identityKey:'new',checkedAt:Date.now()-700000}};
  hydrateAccountIdentities([account]);
  assert.equal(getWhoamiCache().douyin.name,'Saved');
  assert.equal(getWhoamiCache().douyin.ts,0);
  assert.equal(isWhoamiFresh(getWhoamiCache().douyin),false);
  const calls=[];
  t.mock.method(globalThis,'fetch',async url=>{calls.push(url);return {ok:true,json:async()=>({loggedIn:true,name:'',avatar:'',identityKey:'new',verified:true,checkedAt:Date.now()})};});
  await verifyStale(['douyin']);
  assert.equal(calls.length,1); assert.equal(getWhoamiCache().douyin.name,'Saved');
  assert.equal(accountConnection(undefined,getWhoamiCache().douyin),'online');
  hydrateAccountIdentities([{...account,identityKey:'next',identity:null}]);
  assert.equal(getWhoamiCache().douyin,undefined);
});

test('account list applies newer backend expiry across pages and rejects stale proof', () => {
  localStorage.clear();
  const old = Date.now() - 2000, now = Date.now();
  setWhoamiCache('xiaohongshu', {loggedIn:true,name:'old',avatar:'',identityKey:'before',verified:true,checkedAt:old});
  hydrateAccountIdentities([{platform:'xiaohongshu',identityKey:'after',connection:{loggedIn:false,name:'',avatar:'',identityKey:'after',authState:'login_required',verified:true,checkedAt:now}}]);
  assert.equal(accountConnection({loggedIn:true}, getWhoamiCache().xiaohongshu),'login_required');
  hydrateAccountIdentities([{platform:'xiaohongshu',identityKey:'after',connection:{loggedIn:true,name:'old',avatar:'',identityKey:'after',authState:'online',verified:true,checkedAt:old}}]);
  assert.equal(accountConnection({loggedIn:true}, getWhoamiCache().xiaohongshu),'login_required');
});
