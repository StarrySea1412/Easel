import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// Actual preference, hook and settings card in a simulated DOM. No backend.
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { DEMO_DATA_PREFERENCE_KEY: key, readDemoDataPreference } = await loadTsModule('../src/lib/demoPreferences.ts', import.meta.url);
const { useDemoDataPreference } = await loadTsModule('../src/hooks/useDemoDataPreference.ts', import.meta.url);
const { default: Card } = await loadTsModule('../src/components/settings/DemoDataSettingsCard.tsx', import.meta.url);
const { retryPendingLocalWrites } = await loadTsModule('../src/lib/localPersistence.ts', import.meta.url);
const encoded = enabled => JSON.stringify({ version: 1, enabled });

async function fixture(t, initial = {}) {
  const values = new Map(Object.entries(initial));
  const storage = {
    failRead: false, failWrite: false,
    getItem(name) { if (this.failRead) throw new Error('Storage denied'); return values.get(name) ?? null; },
    setItem(name, value) { if (this.failWrite) throw new Error('Storage full'); values.set(name, value); },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  const container = document.createElement('div');
  document.body.append(container);
  let root = createRoot(container);
  let current;
  function Settings() {
    current = useDemoDataPreference();
    return createElement(Card, current);
  }
  const render = () => act(async () => root.render(createElement(Settings)));
  await render();
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  return {
    values, storage, container, state: () => current,
    toggle: () => act(async () => container.querySelector('[role="switch"]').click()),
    external: async (raw, changedKey = key) => {
      if (raw === null) values.delete(changedKey); else values.set(changedKey, raw);
      await act(async () => window.dispatchEvent(new window.StorageEvent('storage', { key: changedKey, newValue: raw })));
    },
    remount: async () => { await act(async () => root.unmount()); root = createRoot(container); await render(); },
  };
}

test('a named settings switch saves false and restores it on remount without changing records', async t => {
  const preserved = { easel_sessions: '[{"id":"keep"}]', easel_office_appearance: 'keep appearance' };
  const view = await fixture(t, preserved);
  assert.equal(view.state().enabled, true);
  assert.equal(view.values.has(key), false, 'opening settings does not write a default');
  const control = view.container.querySelector('[role="switch"]');
  assert.equal(control.tagName, 'BUTTON');
  assert.equal(control.type, 'button');
  assert.equal(view.container.querySelector(`[id="${control.getAttribute('aria-labelledby')}"]`).textContent, '显示演示数据');
  assert.ok(view.container.querySelector(`[id="${control.getAttribute('aria-describedby')}"]`));
  await view.toggle();
  assert.equal(view.state().enabled, false);
  assert.equal(control.getAttribute('aria-checked'), 'false');
  assert.equal(view.values.get(key), encoded(false));
  assert.match(view.container.querySelector('[role="status"]').textContent, /已保存到当前浏览器/);
  await view.remount();
  assert.equal(view.container.querySelector('[role="switch"]').getAttribute('aria-checked'), 'false');
  for (const [name, value] of Object.entries(preserved)) assert.equal(view.values.get(name), value);
  await view.toggle();
  assert.equal(view.values.get(key), encoded(true));
});

test('malformed or unavailable preferences close fictional data and preserve unread records', async t => {
  const view = await fixture(t);
  for (const raw of ['false', '{broken', '{"version":2,"enabled":true}', '{"version":1,"enabled":"false"}']) {
    await view.external(raw);
    assert.equal(view.state().enabled, false);
    assert.match(view.container.querySelector('[role="alert"]').textContent, /暂时关闭演示/);
    assert.equal(view.values.get(key), raw);
  }
  view.storage.failRead = true;
  assert.equal(readDemoDataPreference().enabled, false);
  assert.match(readDemoDataPreference().error, /无法读取/);
  view.storage.failRead = false;
  await view.external(encoded(false));
  assert.equal(view.state().error, '');
  assert.equal(view.state().enabled, false);
});

test('failed writes keep the active choice and are never silently replayed later', async t => {
  const view = await fixture(t, { [key]: encoded(true) });
  view.storage.failWrite = true;
  await view.toggle();
  assert.equal(view.state().enabled, true);
  assert.equal(view.values.get(key), encoded(true));
  assert.match(view.container.querySelector('[role="alert"]').textContent, /无法保存.*开关未更改/);
  assert.equal(view.container.querySelector('[role="status"]'), null);
  view.storage.failWrite = false;
  await act(async () => retryPendingLocalWrites());
  assert.equal(view.values.get(key), encoded(true));
  await view.toggle();
  assert.equal(view.state().enabled, false);
  assert.equal(view.container.querySelector('[role="alert"]'), null);
  view.storage.failWrite = true;
  await view.toggle();
  assert.equal(view.state().enabled, false, 'a failed re-enable also retains the saved choice');
  assert.equal(view.values.get(key), encoded(false));
});

test('open tabs follow only this preference and preserve unrelated saved data', async t => {
  const view = await fixture(t);
  await view.external(encoded(false));
  assert.equal(view.state().enabled, false);
  await view.external('some work', 'unrelated');
  assert.equal(view.state().enabled, false);
  await view.external(encoded(true));
  assert.equal(view.state().enabled, true);
  assert.equal(view.values.get('unrelated'), 'some work');
  view.values.delete(key);
  await act(async () => window.dispatchEvent(new window.StorageEvent('storage', { key: null })));
  assert.equal(view.state().enabled, true);
  assert.equal(view.state().saved, false);
});

test.after(async () => { await window.happyDOM.abort(); window.close(); });
