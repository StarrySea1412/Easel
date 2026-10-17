import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// Real ComfyUI panel with a stubbed HTTP layer: the demo path must keep the
// workspace usable without ComfyUI and must label its placeholder honestly.
globalThis.window = new Window({ url: 'http://127.0.0.1:7880/' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: Panel } = await loadTsModule('../src/components/ComfyVideoWorkflowPanel.tsx', import.meta.url);

const unconfigured = {
  configured: false, baseUrl: '', workflowPath: '', workflowNodeCount: 0, promptNodes: [], promptNode: '',
  error: '未配置 COMFYUI_BASE_URL / COMFYUI_WORKFLOW_PATH', note: 'note', demoAvailable: true,
};

test('demo run keeps the panel usable without ComfyUI and labels the placeholder', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const path = String(url);
    if (path.endsWith('/api/comfyui/video/config')) return new Response(JSON.stringify(unconfigured));
    if (path.endsWith('/api/comfyui/video') && init.method === 'POST') {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ jobId: 'demo-1', state: 'running' }));
    }
    if (path.includes('/api/comfyui/video/demo-1')) {
      return new Response(JSON.stringify({ jobId: 'demo-1', state: 'done', mode: 'demo', prompt: '海边日落', url: '/api/media/demo.mp4', error: null, started: 1 }));
    }
    return new Response('{}');
  });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(createElement(Panel, { prompt: '海边日落', locked: false, sessionId: 's1' })));
  const button = text => [...host.querySelectorAll('button')].find(item => item.textContent === text);
  assert.equal(button('提交到 ComfyUI').disabled, true, 'live submission stays closed without configuration');
  assert.equal(button('模拟运行').disabled, false, 'the demo path is available');
  assert.ok(host.querySelector('[aria-label="ComfyUI 工作流说明"]'), 'the explanation is an info trigger instead of a fold');
  await act(async () => button('模拟运行').click());
  assert.deepEqual(requests, [{ prompt: '海边日落', cinematic: {}, sessionId: 's1', demo: true }]);
  assert.match(host.textContent, /模拟/);
  assert.equal(host.querySelector('video')?.getAttribute('aria-label'), '模拟占位视频');
  assert.match(host.textContent, /不是 ComfyUI 或任何模型服务的产物/);
  assert.ok(host.querySelector('a[download]'));
  await act(async () => root.unmount()); host.remove();
});

test('info trigger shows the configuration explanation on hover/focus and keeps live mode fail-closed', async t => {
  const configured = { ...unconfigured, configured: true, baseUrl: 'http://127.0.0.1:8188', workflowNodeCount: 3, promptNode: '1', error: null, demoAvailable: false };
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).endsWith('/api/comfyui/video/config')) return new Response(JSON.stringify(configured));
    return new Response('{}');
  });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(createElement(Panel, { prompt: 'x', locked: false })));
  const trigger = host.querySelector('[aria-label="ComfyUI 工作流说明"]');
  assert.ok(trigger);
  await act(async () => trigger.focus());
  const tip = document.querySelector('.inline-info-tooltip');
  assert.ok(tip, 'hover/focus opens the tooltip instead of a collapsed block');
  assert.match(tip.textContent, /COMFYUI_BASE_URL/);
  assert.match(tip.textContent, /未配置时不会调用其他付费视频通道/);
  await act(async () => trigger.blur());
  assert.equal(document.querySelector('.inline-info-tooltip'), null);
  const button = text => [...host.querySelectorAll('button')].find(item => item.textContent === text);
  assert.equal(button('提交到 ComfyUI').disabled, false, 'a configured workflow enables the live button');
  assert.equal(button('模拟运行').disabled, true, 'demo stays off when ffmpeg is unavailable');
  await act(async () => root.unmount()); host.remove();
});
