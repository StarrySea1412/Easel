import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// Actual panel with controlled HTTP; ClawHub replies are never executed. Favorites
// keep public metadata only and must never fake a saved state when storage fails.
globalThis.window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1:7880/' }).window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.localStorage = window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: ClawHubPanel } = await loadTsModule('../src/components/ClawHubPanel.tsx', import.meta.url);
const favoritesLib = await loadTsModule('../src/lib/skillFavorites.ts', import.meta.url);
const persistence = await loadTsModule('../src/lib/localPersistence.ts', import.meta.url);

const KEY = favoritesLib.SKILL_FAVORITES_KEY;
const external = { id: 'alice/card-quote', source: 'clawhub', slug: 'card-quote', displayName: 'Card Quote', ownerHandle: 'alice', stats: { downloads: 5609, installs: 148, stars: 7, versions: 7, comments: 3 },
  summary: '把金句排成卡片', version: '1.2.3', updatedAt: 1792000000000, canonicalUrl: 'https://clawhub.ai/alice/card-quote', installationState: 'not_checked' };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

async function mount(t) {
  t.mock.method(globalThis, 'fetch', url => {
    const href = String(url);
    if (href.includes('/api/clawhub/search')) return Promise.resolve(json({ source: 'clawhub', query: 'quote', results: [external], count: 1, limit: 12, fetchedAt: '2026-10-17T00:00:00Z', cacheHit: false }));
    if (href.includes('/api/clawhub/skills/card-quote')) return Promise.resolve(json({ source: 'clawhub', skill: { ...external, description: '作者说明', descriptionTruncated: false, topics: [], createdAt: null, stats: null }, owner: { handle: 'alice', displayName: null }, latestVersion: null, metadata: null, moderation: null, fetchedAt: '2026-10-17T00:00:00Z', cacheHit: false }));
    return Promise.resolve(json({}));
  });
  const node = document.createElement('div'); document.body.append(node);
  const root = createRoot(node);
  await act(async () => root.render(createElement(ClawHubPanel)));
  t.after(async () => { await act(async () => root.unmount()); node.remove(); });
  return {
    node,
    async search(term) {
      const input = node.querySelector('#clawhub-query');
      await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, term); input.dispatchEvent(new window.Event('input', { bubbles: true })); });
      await act(async () => node.querySelector('.clawhub-search').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
      await act(async () => { await Promise.resolve(); });
    },
    async click(element) { assert.ok(element); await act(async () => { element.focus(); element.click(); }); },
  };
}

test('search results can be favorited, listed under 我的收藏, removed, and survive a storage reload', async t => {
  window.localStorage.removeItem(KEY);
  const v = await mount(t);
  assert.equal(v.node.querySelector('.clawhub-favorites'), null, 'no favorites section before anything is saved');
  await v.search('quote');
  const card = v.node.querySelector('.clawhub-card');
  assert.ok(card, 'the result card renders');
  assert.match(card.textContent, /下载 5,609 · 评论 3/, 'public counters show on the panel card');
  assert.equal(card.querySelector('.clawhub-fav').getAttribute('aria-pressed'), 'false');
  await v.click(card.querySelector('.clawhub-fav'));
  const stored = JSON.parse(window.localStorage.getItem(KEY));
  assert.equal(stored.length, 1, 'the favorite is persisted locally');
  assert.equal(stored[0].slug, 'card-quote');
  assert.equal(stored[0].canonicalUrl, 'https://clawhub.ai/alice/card-quote');
  assert.equal(stored[0].ownerHandle, 'alice');
  const section = v.node.querySelector('.clawhub-favorites');
  assert.ok(section, 'the favorites section appears right away');
  assert.match(section.textContent, /alice\/card-quote/);
  assert.equal(card.querySelector('.clawhub-fav').getAttribute('aria-pressed'), 'true', 'the result card mirrors the saved state');
  const fresh = await loadTsModule(`../src/lib/skillFavorites.ts#fresh-${Date.now()}`, import.meta.url);
  assert.equal(fresh.skillFavorites().length, 1, 'a page reload reads the favorite back from storage');
  assert.equal(fresh.isSkillFavorite('alice/card-quote'), true);
  await v.click(section.querySelector('[aria-label^="移除收藏"]'));
  assert.equal(v.node.querySelector('.clawhub-favorites'), null);
  assert.deepEqual(JSON.parse(window.localStorage.getItem(KEY)), []);
});

test('a failed local save keeps the star honest and reports the failure', async t => {
  window.localStorage.removeItem(KEY);
  const v = await mount(t);
  await v.search('quote');
  const card = v.node.querySelector('.clawhub-card');
  // jsdom Storage is a Proxy, so swap the whole global instead of patching setItem.
  const real = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem: () => { throw new Error('storage blocked'); }, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 };
  t.after(() => { globalThis.localStorage = real; });
  await v.click(card.querySelector('.clawhub-fav'));
  assert.equal(card.querySelector('.clawhub-fav').getAttribute('aria-pressed'), 'false', 'nothing is marked saved');
  assert.equal(v.node.querySelector('.clawhub-favorites'), null);
  assert.equal(window.localStorage.getItem(KEY), null);
  assert.equal(persistence.getLocalPersistenceStatus().unsaved, true, 'the persistence notice is honest about the failure');
});
