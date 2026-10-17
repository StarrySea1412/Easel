import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// 技能库分区侧边栏：按流水线层列出锚点（带计数），点击跳转并更新高亮。
globalThis.window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://easel.test/' }).window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = callback => { callback(); return 1; };
const { createRoot } = await import('react-dom/client');
const { default: SkillPage } = await loadTsModule('../src/components/SkillPage.tsx', import.meta.url);

test('the section sidebar lists each layer with counts and jumps on click', async t => {
  const jumped = [];
  window.HTMLElement.prototype.scrollIntoView = function () { jumped.push(this); };
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ([
    { name: 'skill-trending-topics', description: '热榜选题', layer: 'discover' },
    { name: 'skill-event-calendar', description: '节日节点', layer: 'plan' },
  ]) }));
  const node = document.createElement('div'); document.body.append(node);
  const root = createRoot(node);
  await act(async () => root.render(createElement(SkillPage, { onOpenChat() {} })));
  t.after(async () => { await act(async () => root.unmount()); node.remove(); });
  await act(async () => new Promise(resolve => setTimeout(resolve, 30)));

  // jsdom 没有布局：显式注入分区几何，让滚动高亮逻辑可被确定性断言。
  const sections = [...node.querySelectorAll('.skills-body section')];
  assert.equal(sections.length, 2);
  Object.defineProperty(sections[0], 'offsetTop', { value: 0, configurable: true });
  Object.defineProperty(sections[1], 'offsetTop', { value: 600, configurable: true });
  await act(async () => { node.querySelector('.skills-page').dispatchEvent(new window.Event('scroll')); });

  const nav = node.querySelector('.skills-section-nav');
  assert.ok(nav, 'the section sidebar renders beside the content');
  const items = [...nav.querySelectorAll('.skills-nav-item')];
  assert.equal(items.length, 2, 'one entry per non-empty layer');
  assert.match(items[0].textContent, /发现/);
  assert.match(items[0].textContent, /1/);
  assert.equal(items[0].getAttribute('aria-current'), 'true', 'the first section starts active');
  assert.equal(items[1].getAttribute('aria-current'), null);

  await act(async () => items[1].click());
  assert.equal(jumped.length, 1, 'clicking jumps straight to the section');
  assert.equal(items[1].getAttribute('aria-current'), 'true', 'the active highlight follows the jump');
  assert.equal(items[0].getAttribute('aria-current'), null);
  assert.ok(nav.querySelector('.skills-nav-top'), 'a back-to-top entry exists');
});
