import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// 技能分类与标签：覆盖层展示、分类筛选、自动分类预览与合并应用（全部走模拟接口）。
globalThis.window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://easel.test/' }).window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = callback => { callback(); return 1; };
const { createRoot } = await import('react-dom/client');
const { default: SkillPage } = await loadTsModule('../src/components/SkillPage.tsx', import.meta.url);

const skills = [
  { name: 'card-quote', description: '金句卡片', layer: 'produce' },
  { name: 'video-reframe', description: '视频改幅', layer: 'produce' },
  { name: 'mystery', description: '暂无分类的技能', layer: 'general' },
];
const meta = {
  skills: {
    'card-quote': { tags: ['设计'], categoryId: 'preset-visual' },
    mystery: { categoryId: 'user-1' },
  },
  categories: [{ id: 'preset-visual', label: '视觉设计', preset: true }, { id: 'user-1', label: '我的专栏', preset: false }],
};

test('tags render, the category filter narrows the grid, and auto-classify merges suggestions', async t => {
  const puts = [];
  let metaFetches = 0;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const href = String(url);
    if (href.includes('/api/skills/meta')) { metaFetches += 1; return { ok: true, json: async () => meta }; }
    if (href.includes('/api/skills/classify')) {
      return { ok: true, json: async () => ({ mode: 'rules', suggestions: {
        'video-reframe': { tags: ['视频'], categoryId: 'preset-video' },
        mystery: { tags: [], categoryId: null },
      } }) };
    }
    if (href.includes('/api/skill/') && href.endsWith('/meta') && options.method === 'PUT') {
      puts.push({ url: href, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({}) };
    }
    if (href.includes('/api/skills')) return { ok: true, json: async () => skills };
    return { ok: true, json: async () => ({}) };
  });
  const node = document.createElement('div'); document.body.append(node);
  const root = createRoot(node);
  await act(async () => root.render(createElement(SkillPage, { onOpenChat() {} })));
  t.after(async () => { await act(async () => root.unmount()); node.remove(); });
  await act(async () => new Promise(resolve => setTimeout(resolve, 40)));

  const cards = () => [...node.querySelectorAll('.skill-card')];
  assert.equal(cards().length, 3);
  const quote = cards().find(card => card.textContent.includes('card-quote'));
  assert.match(quote.textContent, /设计/, 'tags from the metadata layer render on the card');

  // 分类筛选：选“我的专栏”只剩 mystery
  const filterButtons = [...node.querySelectorAll('.skill-category-filter button, .skill-category-filter [role="radio"]')];
  const mine = filterButtons.find(b => b.textContent.trim() === '我的专栏');
  assert.ok(mine, 'custom category appears in the filter');
  await act(async () => mine.click());
  assert.deepEqual(cards().map(card => card.textContent.includes('mystery')), [true]);
  await act(async () => filterButtons.find(b => b.textContent.trim() === '全部分类').click());
  assert.equal(cards().length, 3);

  // 自动分类：离线规则 → 预览 → 应用（合并写回）
  await act(async () => [...node.querySelectorAll('button')].find(b => b.textContent.trim() === '自动分类').click());
  const panel = node.querySelector('.skill-classify');
  assert.ok(panel, 'the classify panel opens');
  await act(async () => [...panel.querySelectorAll('button')].find(b => b.textContent.trim() === '离线规则分类').click());
  await act(async () => new Promise(resolve => setTimeout(resolve, 30)));
  assert.match(panel.textContent, /画幅转换/, 'suggestions use the display name');
  assert.match(panel.textContent, /视频/);
  const applies = metaFetches;
  await act(async () => [...panel.querySelectorAll('button')].find(b => b.textContent.trim() === '应用').click());
  await act(async () => new Promise(resolve => setTimeout(resolve, 30)));
  assert.equal(puts.length, 2, 'each suggestion is saved through the metadata API');
  const videoPut = puts.find(call => call.url.includes('video-reframe'));
  assert.deepEqual(videoPut.body.tags, ['视频']);
  assert.equal(videoPut.body.categoryId, 'preset-video');
  const mysteryPut = puts.find(call => call.url.includes('mystery'));
  assert.equal(mysteryPut.body.categoryId, 'user-1', 'existing custom category is never overwritten');
  assert.ok(metaFetches > applies, 'metadata reloads after applying');
});
