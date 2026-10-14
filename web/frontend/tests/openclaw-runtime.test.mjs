import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new Window({url:'https://easel.test/'});
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: Card } = await loadTsModule('../src/components/OpenClawRuntimeCard.tsx');
const version = {installedVersion:'2026.9.6', installedState:'ok', installedPath:'/opt/openclaw/openclaw.mjs',
  latestVersion:'2026.10.3', latestState:'ok', updateAvailable:true,
  releaseUrl:'https://github.com/openclaw/openclaw/releases/tag/v2026.10.3', releases:[]};

test('actual runtime card refreshes versions and sends bounded official evidence to the Agent', async t => {
  const calls = [], prompts = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    return new Response(JSON.stringify(String(url).endsWith('/releases') ? {...version, notesState:'partial',
      releases:[{version:'2026.10.3',sourceUrl:'https://raw.githubusercontent.com/openclaw/openclaw/v2026.10.3/CHANGELOG/2026.10.3.md',text:'note'.repeat(9000),truncated:false}]} : version), {status:200});
  });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {await act(() => root.unmount()); container.remove();});
  await act(async () => root.render(createElement(Card, {onAssess:prompt => {prompts.push(prompt); return true;}})));
  assert.match(container.textContent, /2026.9.6/);
  assert.match(container.textContent, /2026.10.3.*有新版本/);
  assert.equal(container.querySelector('a').href, version.releaseUrl);
  const button = text => [...container.querySelectorAll('button')].find(item => item.textContent === text);
  await act(async () => button('重新检测版本').click());
  assert.ok(calls.some(url => String(url).endsWith('?refresh=1')));
  await act(async () => button('让 Agent 评估更新').click());
  assert.equal(prompts.length,1);
  assert.match(prompts[0], /不升级、不安装、不修改配置、不重启/);
  const evidence = JSON.parse(prompts[0].split('\n\n').at(-1));
  assert.equal(evidence.notesState,'partial');
  assert.equal(evidence.releases[0].text.length,24000);
  assert.equal(evidence.releases[0].truncated,true);
});

test('unavailable official version disables assessment and reports the gap', async t => {
  t.mock.method(globalThis,'fetch',async () => new Response(JSON.stringify({...version, latestVersion:null,
    latestState:'unavailable',updateAvailable:false,releaseUrl:null,latestError:'官方查询不可用'}),{status:200}));
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {await act(() => root.unmount()); container.remove();});
  await act(async () => root.render(createElement(Card,{onAssess:() => {throw new Error('Must not send');}})));
  assert.match(container.textContent,/官方查询不可用/);
  assert.equal(container.querySelectorAll('button')[1].disabled,true);
  assert.equal(container.querySelector('a'),null);
});
