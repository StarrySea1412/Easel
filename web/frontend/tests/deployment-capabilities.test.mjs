import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: EnvBoard } = await loadTsModule('../src/components/EnvBoard.tsx', import.meta.url);
const { default: StorageCard } = await loadTsModule('../src/components/settings/StorageSettingsCard.tsx', import.meta.url);
const { default: CodexSettings } = await loadTsModule('../src/components/CodexSettings.tsx', import.meta.url);
const { decodeDeploymentCapabilities, fetchDeploymentCapabilities } = await loadTsModule('../src/lib/deploymentCapabilities.ts', import.meta.url);
const server = { web: true, deployment: { mode: 'server', readOnlyRoot: true, environmentInstall: false, storageMigration: false } };
const storage = { currentPath: '/data/easel/outputs', logicalPath: '/app/outputs', status: 'ready', fileCount: 3, byteCount: 1024, requiresRestart: false, pendingPath: null, backupPath: null, error: null };
const tool = { id: 'ffmpeg', name: 'FFmpeg', state: 'missing', group: 'common', desc: '视频处理', requirement: '按需安装' };
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

async function fixture(t, Component, { readiness = server, status = 200, storageValue = storage, runtime = { available: false, error: '此服务器未启用 Codex，请使用 OpenClaw。', options: [] }, deferReadiness } = {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    calls.push({ url, ...init });
    if (url.endsWith('/server/readiness')) return deferReadiness ? await deferReadiness : response(readiness, status);
    if (url.endsWith('/env/jobs')) return response({ jobs: [] });
    if (url.endsWith('/env/install')) return response({ jobs: [] });
    if (url.endsWith('/storage/location')) return response(init.body ? { ...storageValue, status: 'pending_restart', pendingPath: JSON.parse(init.body).path, requiresRestart: true } : storageValue);
    if (url.endsWith('/codex/runtime')) return response(runtime);
    assert.fail(`Unexpected request: ${url}`);
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Component, Component === EnvBoard ? { tools: [tool], python: '/usr/bin/python', loading: false, error: '', onRefresh() {} } : {})));
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  return { container, calls, button: label => [...container.querySelectorAll('button')].find(item => item.textContent === label), click: async element => act(async () => element.click()) };
}

test('server capability flags never authorize desktop migration or root installation without writable-root confirmation', () => {
  const locked = decodeDeploymentCapabilities({ deployment: { mode: 'server', readOnlyRoot: true, environmentInstall: true, storageMigration: true } });
  assert.deepEqual(locked, { mode: 'server', environmentInstall: false, storageMigration: false });
  assert.deepEqual(decodeDeploymentCapabilities({ web: true, resources: { agent: {} } }), locked);
  assert.deepEqual(decodeDeploymentCapabilities({ web: true }), { mode: 'unknown', environmentInstall: false, storageMigration: false });
});

test('capability lookup preserves mounted base path, bypasses cache and distinguishes absent local route from failed server reads', async t => {
  window.location.href = 'https://easel.test/easel/index.html';
  t.after(() => { window.location.href = 'https://easel.test/'; });
  const calls = [];
  let status = 404;
  t.mock.method(globalThis, 'fetch', async (url, init) => { calls.push({ url, init }); return response({}, status); });
  assert.equal((await fetchDeploymentCapabilities()).mode, 'local');
  assert.equal(calls[0].url, '/easel/api/server/readiness');
  assert.equal(calls[0].init.cache, 'no-store');
  for (status of [401, 502, 200]) {
    const value = await fetchDeploymentCapabilities();
    assert.equal(value.mode, 'unknown');
    assert.equal(value.environmentInstall || value.storageMigration, false);
  }
});

for (const [name, readiness] of [['declared', server], ['legacy', { web: true, resources: { agent: { capacity: 1, active: 0 } } }]]) {
  test(`${name} server keeps environment inspection available and disables every installation action`, async t => {
    const view = await fixture(t, EnvBoard, { readiness });
    assert.equal(view.button('重新检测').disabled, false);
    for (const label of ['安装缺少项', '补装本组', '安装']) {
      assert.equal(view.button(label).disabled, true);
      await view.click(view.button(label));
    }
    assert.equal(view.container.querySelector('.env-runtime'), null);
    assert.match(view.container.textContent, /服务器环境由管理员维护/);
    assert.ok(view.calls.every(call => !call.method || call.method === 'GET'));
  });
}

test('server storage shows the persistent directory and saved files without desktop migration or restart controls', async t => {
  const view = await fixture(t, StorageCard, { storageValue: { ...storage, status: 'pending_restart', requiresRestart: true, pendingPath: '/private/legacy-target', backupPath: '/private/legacy-backup' } });
  assert.ok(view.container.textContent.includes('持久目录/data/easel/outputs'));
  assert.match(view.container.textContent, /3 个文件 · 1.0 KB/);
  assert.match(view.container.textContent, /服务器持久目录由管理员维护/);
  assert.match(view.container.textContent, /等待管理员处理/);
  assert.equal(view.container.querySelector('form'), null);
  assert.equal(view.button('取消待迁移计划'), undefined);
  for (const hidden of ['D:', '/private/', '/app/outputs', '下次启动', '关闭并重新启动']) assert.equal(view.container.textContent.includes(hidden), false);
  await view.click(view.button('刷新状态'));
  assert.ok(view.calls.every(call => !call.method || call.method === 'GET'));
});

test('pending or unrecognized server capability never briefly mounts a migration form', async t => {
  let resolve;
  const deferReadiness = new Promise(done => { resolve = done; });
  const view = await fixture(t, StorageCard, { deferReadiness });
  assert.match(view.container.textContent, /正在确认运行环境/);
  assert.equal(view.container.querySelector('form'), null);
  await act(async () => resolve(response({ unexpected: 'response' })));
  assert.equal(view.container.querySelector('form'), null);
  assert.match(view.container.textContent, /目录修改暂不可用/);
  assert.ok(view.calls.every(call => !call.method));
});

test('local environment retains installation and storage migration after recognizing the absent server route', async t => {
  const environment = await fixture(t, EnvBoard, { status: 404 });
  assert.equal(environment.button('安装').disabled, false);
  await environment.click(environment.button('安装'));
  const install = environment.calls.find(call => call.url.endsWith('/env/install'));
  assert.equal(install.method, 'POST');
  assert.deepEqual(JSON.parse(install.body), { ids: ['ffmpeg'] });
  const view = await fixture(t, StorageCard, { status: 404, storageValue: { ...storage, requiresRestart: true } });
  assert.ok(view.container.querySelector('form'));
  assert.ok(view.button('取消待迁移计划'));
  const input = view.container.querySelector('input');
  await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'D:/Easel-content'); input.dispatchEvent(new window.Event('input', { bubbles: true })); });
  await act(async () => view.container.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  const schedule = view.calls.find(call => call.method === 'POST');
  assert.deepEqual(JSON.parse(schedule.body), { path: 'D:/Easel-content' });
  assert.match(view.container.textContent, /迁移计划已保存/);
});

test('disabled server Codex exposes the returned reason and cannot start authentication or promise availability', async t => {
  const view = await fixture(t, CodexSettings);
  assert.match(view.container.textContent, /此服务器未启用 Codex，请使用 OpenClaw/);
  assert.doesNotMatch(view.container.textContent, /新建对话后可选择|本机/);
  assert.equal(view.button('登录 ChatGPT 账号').disabled, true);
  await view.click(view.button('登录 ChatGPT 账号'));
  assert.ok(view.calls.every(call => !call.method));
});
