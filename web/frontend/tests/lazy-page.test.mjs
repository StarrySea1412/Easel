import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement, useEffect, useState } from 'react';
import { loadTsModule } from './load-ts.mjs';

// Happy DOM exercises React rendering and events without a real browser.
// It cannot verify page layout, CSS, downloads or actual chunk requests.
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { createLazyPage } = await loadTsModule('../src/lib/lazyPage.ts', import.meta.url);

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(t) {
  const container = document.createElement('div');
  document.body.append(container);
  const caught = [];
  const root = createRoot(container, { onCaughtError: (error) => caught.push(error) });
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return {
    container,
    caught,
    render: async (element) => act(async () => root.render(element)),
    click: async (button) => act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))),
  };
}

test('a deferred page starts loading on mount and renders the latest props after resolution', { timeout: 10000 }, async (t) => {
  const pending = deferred();
  let loads = 0;
  const Page = createLazyPage('内容分析', () => { loads++; return pending.promise; });
  const view = fixture(t);
  assert.equal(loads, 0);

  await view.render(createElement(Page, { title: '旧筛选' }));
  const loading = view.container.querySelector('[role="status"]');
  assert.equal(loading?.getAttribute('aria-busy'), 'true');
  assert.match(loading.textContent, /正在打开内容分析/);
  assert.equal(loads, 1);

  await view.render(createElement(Page, { title: '最新筛选' }));
  await act(async () => pending.resolve({
    default: ({ title }) => createElement('output', { 'data-testid': 'page-result' }, title),
  }));
  assert.equal(view.container.querySelector('[data-testid="page-result"]')?.textContent, '最新筛选');
  assert.equal(view.container.querySelector('[aria-busy="true"]'), null);
  assert.equal(loads, 1);
  assert.deepEqual(view.caught, []);
});

test('retry reloads a rejected lazy module while preserving outer controller state and current props', { timeout: 10000 }, async (t) => {
  const attempts = [deferred(), deferred(), deferred()];
  let loads = 0, mounts = 0, unmounts = 0, reloads = 0;
  const Page = createLazyPage('运行记录', () => attempts[loads++].promise);
  const view = fixture(t);
  t.mock.method(window.location, 'reload', () => { reloads++; });

  function PersistentController({ selectedSession }) {
    const [receivedTokens, setReceivedTokens] = useState(0);
    useEffect(() => {
      mounts++;
      return () => { unmounts++; };
    }, []);
    return createElement('div', null,
      createElement('button', {
        'data-testid': 'controller',
        onClick: () => setReceivedTokens((value) => value + 1),
      }, `已接收 ${receivedTokens}`),
      createElement(Page, { selectedSession }),
    );
  }

  await view.render(createElement(PersistentController, { selectedSession: 'session-a' }));
  const controllerButton = view.container.querySelector('[data-testid="controller"]');
  await view.click(controllerButton);

  for (let attempt = 0; attempt < 2; attempt++) {
    const failure = new Error(`simulated chunk failure ${attempt + 1}`);
    await act(async () => attempts[attempt].reject(failure));
    const errorPanel = view.container.querySelector('[role="alert"]');
    assert.match(errorPanel?.textContent || '', /运行记录暂时无法打开/);
    assert.equal(view.caught.at(-1), failure);
    assert.equal(view.container.querySelector('[aria-busy="true"]'), null);

    await view.render(createElement(PersistentController, { selectedSession: `session-retry-${attempt}` }));
    const retry = errorPanel.querySelector('button');
    assert.equal(retry.textContent, '重新尝试');
    await view.click(retry);
    assert.equal(loads, attempt + 2, 'each click must invoke a new loader, not reuse the rejected promise');
    assert.equal(view.container.querySelector('[role="alert"]'), null);
    assert.equal(view.container.querySelector('[role="status"]')?.getAttribute('aria-busy'), 'true');
  }

  await view.render(createElement(PersistentController, { selectedSession: 'session-latest' }));
  await view.click(controllerButton);
  await act(async () => attempts[2].resolve({
    default: ({ selectedSession }) => createElement('output', { 'data-testid': 'loaded-session' }, selectedSession),
  }));

  assert.equal(view.container.querySelector('[data-testid="loaded-session"]')?.textContent, 'session-latest');
  assert.equal(view.container.querySelector('[data-testid="controller"]'), controllerButton);
  assert.equal(controllerButton.textContent, '已接收 2');
  assert.equal(mounts, 1);
  assert.equal(unmounts, 0);
  assert.equal(reloads, 0);
  assert.equal(loads, 3);
  assert.equal(view.container.querySelector('[role="alert"]'), null);
});

test.after(async () => {
  await window.happyDOM.abort();
  window.close();
});
