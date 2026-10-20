import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { loadTsModule } from './load-ts.mjs';

const dom = new JSDOM('', {url:'https://easel.test/'});
globalThis.window = dom.window;
globalThis.localStorage = window.localStorage;
globalThis.sessionStorage = window.sessionStorage;
const { sanitizeAccountMetrics, verifiedDouyinMetrics } = await loadTsModule('../src/lib/accountMetricEvidence.ts');
const cache = await loadTsModule('../src/lib/analyticsCache.ts');
const source = {schema:'douyin-account-overview-v2',section:'账号总览',url:'https://creator.douyin.com/creator-micro/home',period:'last_7_days',from:'2026-10-14',to:'2026-10-20'};

test('obsolete browser cache removes course metrics while preserving account and works', () => {
  const data = {platform:'douyin',loggedIn:true,nickname:'Owner',followers:105,notes:[{title:'Own work'}],metrics:[{label:'播放量',value:'211.88万',vs:''}],analysis:{metrics:[{label:'播放量',value:'211.88万'}]}};
  const before = structuredClone(data);
  const cleaned = sanitizeAccountMetrics(data);
  assert.deepEqual(cleaned.metrics, []);
  assert.equal(cleaned.analysis, undefined);
  assert.equal(cleaned.metricsNeedsRefresh, true);
  assert.equal(cleaned.followers,105);
  assert.deepEqual(cleaned.notes,data.notes);
  assert.deepEqual(data,before);
  localStorage.setItem('easel_whoami',JSON.stringify({douyin:{identityKey:'owner-key',accountId:'owner'}}));
  sessionStorage.setItem('easel:analytics-cache:v1',JSON.stringify({douyin:{scope:JSON.stringify(['owner-key','owner']),at:Date.now(),data}}));
  assert.deepEqual(cache.readAnalyticsCache('douyin').metrics,[]);
});

test('verified values and real zero remain; invalid dates or period cannot authorize metrics', () => {
  const data={platform:'douyin',metrics_source:source,metrics:[{label:'播放量',value:'0',vs:''}]};
  assert.equal(sanitizeAccountMetrics(data),data);
  assert.equal(verifiedDouyinMetrics(source),true);
  for (const override of [{from:'2026-02-30'}, {to:'2026-10-21'},{section:'热门课程'},{schema:'old'},{period:'unknown'}])
    assert.equal(verifiedDouyinMetrics({...source,...override}),false);
  const other={platform:'zhihu',metrics:[{label:'阅读总量',value:10}]};
  assert.equal(sanitizeAccountMetrics(other),other);
});
