import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new JSDOM('<!doctype html><body></body>', { url: 'https://easel.test/' }).window;
globalThis.document = window.document;
globalThis.CustomEvent = window.CustomEvent;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });
const { createRoot } = await import('react-dom/client');
const { recommendSkills } = await loadTsModule('../src/lib/skillRecommendations.ts', import.meta.url);
const { default: Suggestions, missingSkillSetup, openSkillConfiguration } = await loadTsModule('../src/components/ComposerSkillSuggestions.tsx', import.meta.url);
const skill = (name, patch = {}) => ({ name, description: name, layer: 'content', needsApi: false, apiConfigured: true, ...patch });
const key = (configured, label = '生图 Key') => ({ label, required: true, configured });
const detail = (configured, patch = {}) => ({ ...skill('ai-image-gen'), body: 'ai_image.py', needsApi: true, apiConfigured: configured,
  apiSpec: { providers: [{ keys: [key(configured)] }] }, ...patch });

test('recommendations use installed skills, exclude picks, rank explicit names and cap at three', () => {
  const catalog = ['copywriting','poster-hero','ai-image-gen','skill-content-calendar'].map(name => skill(name));
  assert.deepEqual(recommendSkills('hello', catalog), []);
  assert.deepEqual(recommendSkills('请生成一张图片', catalog).map(s => s.name), ['ai-image-gen']);
  assert.deepEqual(recommendSkills('请生成一张图片', catalog, ['ai-image-gen']), []);
  assert.deepEqual(recommendSkills('请生成一张图片', [skill('copywriting')]), []);
  const rows = recommendSkills('copywriting 海报 生成图片 内容排期', catalog);
  assert.equal(rows.length, 3); assert.equal(rows[0].name, 'copywriting');
});

test('missing setup uses confirmed required state, ignores optional keys and never infers absence from unknown data', () => {
  assert.equal(missingSkillSetup(detail(true)), null);
  assert.equal(missingSkillSetup(undefined), null);
  assert.equal(missingSkillSetup(detail(false, { apiConfigured: undefined })), null);
  assert.equal(missingSkillSetup(detail(false)), '生图 Key');
  assert.equal(missingSkillSetup(detail(false, { apiSpec: { providers: [{ keys: [key(false, '模型名称'), { ...key(false, '可选 Key'), required: false }] }] } })), '模型名称');
});

async function fixture(t, response, selectedSkills = []) {
  const calls = [], picked = [], toasts = [];
  const toast = event => toasts.push(event.detail);
  window.addEventListener('easel:toast', toast);
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push([url, init]); if (response instanceof Error) throw response;
    return { ok: true, json: async () => response };
  });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container), catalog = [skill('ai-image-gen')];
  let props = { text: '请生成一张图片', skills: { skillList: catalog, selectedSkills, selectSkill: name => picked.push(name) } };
  const render = async patch => { props = { ...props, ...patch }; await act(async () => root.render(createElement(Suggestions, props))); };
  await render(); await act(async () => { await new Promise(resolve => setTimeout(resolve, 700)); });
  t.after(async () => { window.removeEventListener('easel:toast', toast); await act(async () => root.unmount()); container.remove(); });
  return { container, calls, picked, toasts, render };
}

test('missing Key is announced once with a direct channel action; suggestion click selects without sending', async t => {
  const view = await fixture(t, detail(false)), routes = [];
  const route = event => routes.push(event.detail);
  window.addEventListener('easel:open-skill-settings', route); t.after(() => window.removeEventListener('easel:open-skill-settings', route));
  assert.equal(view.toasts.length, 1); assert.equal(view.toasts[0].action.label, '去设置');
  await act(async () => view.toasts[0].action.run()); assert.deepEqual(routes, ['image']);
  await act(async () => view.container.querySelector('[aria-label^="加入"]').click());
  assert.deepEqual(view.picked, ['ai-image-gen']);
  await view.render({ text: '请生成一张图片海报' });
  assert.equal(view.toasts.length, 1);
  assert.ok(view.calls.every(([, init]) => !init?.body), 'recommendations only read skill metadata');
});

test('configured Key and unknown detail failures keep recommendations without a false setup warning', async t => {
  for (const response of [detail(true), new Error('offline')]) {
    const view = await fixture(t, response);
    assert.ok(view.container.querySelector('[aria-label^="加入"]'));
    assert.equal(view.container.querySelector('.skill-setup-prompts'), null);
    assert.equal(view.toasts.length, 0);
  }
});

test('selected skills refresh setup status after a catalog update and unknown channels use the existing skill drawer', async t => {
  const view = await fixture(t, detail(false), ['ai-image-gen']);
  assert.equal(view.toasts.length, 1);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => detail(true) }));
  await view.render({ skills: { skillList: [skill('ai-image-gen', { apiConfigured: true })], selectedSkills: ['ai-image-gen'], selectSkill() {} } });
  assert.equal(view.container.querySelector('.skill-setup-prompts'), null);
  const routes = [], route = event => routes.push(event.detail);
  window.addEventListener('easel:open-skill-configuration', route); t.after(() => window.removeEventListener('easel:open-skill-configuration', route));
  openSkillConfiguration({ ...skill('search'), body: 'TAVILY_API_KEY', needsApi: true });
  assert.deepEqual(routes, ['search']);
});
