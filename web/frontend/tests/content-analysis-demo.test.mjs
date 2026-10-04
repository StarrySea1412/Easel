import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule, tsModuleUrl } from './load-ts.mjs';

// Real demo UI in a simulated DOM; no account credentials or backend writes.
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: Demo } = await loadTsModule('../src/components/ContentAnalysisDemo.tsx', import.meta.url);
const { demoContents, demoTotal, demoThemes, demoTrend, filterDemoContents } = await loadTsModule('../src/lib/contentAnalysisDemo.ts', import.meta.url);

async function fixture(t, section = 'review', Component = Demo) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const calls = { source: 0, sections: [], fetches: [] };
  let props = { section, onSection: value => { calls.sections.push(value); props.section = value; }, onUseMyData: () => { calls.source++; }, onNavigateAccounts() {}, onNavigateIdeas() {} };
  t.mock.method(globalThis, 'fetch', async (...args) => { calls.fetches.push(args); throw new Error('Demo must not fetch'); });
  const render = async values => { props = { ...props, ...values }; await act(async () => root.render(createElement(Component, props))); };
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await render();
  return { container, calls, render,
    button: label => [...container.querySelectorAll('button')].find(item => item.textContent.replace(/[←→↗↑↓↕]/g, '').trim() === label),
    async click(element) { assert.ok(element, 'click target exists'); await act(async () => element.click()); await render(); },
    async input(element, value) {
      assert.ok(element, 'input exists');
      const prototype = element.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
      await act(async () => element.dispatchEvent(new window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })));
      await render();
    },
  };
}
const workRows = container => [...container.querySelectorAll('.ca-demo-table tbody tr')];

test('fictional examples have coherent totals, equal theme coverage and age-aligned trend values', () => {
  assert.equal(demoContents.length, 9);
  assert.ok(demoContents.every(item => item.id.startsWith('demo-') && item.period === '7d' && !item.url));
  assert.ok(demoContents.every(item => Date.parse(item.snapshotAt) - Date.parse(item.publishedAt) === 7 * 24 * 60 * 60 * 1000));
  assert.equal(demoTotal('collects'), demoContents.reduce((total, item) => total + item.metrics.collects, 0));
  assert.deepEqual(demoThemes('collects').map(item => [item.tag, item.count, item.average]), [['实用教程', 3, 850], ['清单推荐', 3, 620], ['日常记录', 3, 76]]);
  assert.equal(demoTrend.length, 7);
  assert.equal(demoTrend.at(-1).views, Math.round(demoTotal('views') / 9));
  assert.ok(demoTrend.every((item, index) => !index || item.views > demoTrend[index - 1].views));
  assert.equal(filterDemoContents('不存在', '', 'views', false).length, 0);
});

test('overview leads with plain-language conclusion and fully labelled fictional evidence without network activity', async t => {
  const view = await fixture(t);
  assert.match(view.container.querySelector('[role="status"]').textContent, /账号、作品、指标和分析均为虚构/);
  assert.match(view.container.querySelector('#ca-verdict-title').textContent, /能照着做/);
  assert.match(view.container.textContent, /表现怎么样.*可能的原因.*下一步做什么/s);
  assert.equal(workRows(view.container).length, 9);
  assert.equal(view.container.querySelector('.ca-demo-table').querySelectorAll('caption').length, 1);
  assert.match(view.container.textContent, /按发布后的天数对齐/);
  assert.deepEqual(view.calls.fetches, []);
});

test('search and theme filters combine, preserve a truthful count and recover from no matches', async t => {
  const view = await fixture(t, 'works');
  const search = view.container.querySelector('input[type="search"]');
  const theme = view.container.querySelector('.ca-demo-table-tools select');
  await view.input(search, '咖啡');
  assert.equal(workRows(view.container).length, 2);
  await view.input(theme, '实用教程');
  assert.equal(workRows(view.container).length, 1);
  assert.match(workRows(view.container)[0].textContent, /拍咖啡别只会俯拍/);
  await view.input(search, '没有这篇文章');
  assert.equal(workRows(view.container).length, 0);
  assert.match(view.container.textContent, /没有找到匹配的作品/);
  await view.click(view.button('显示全部作品'));
  assert.equal(workRows(view.container).length, 9);
  assert.equal(search.value, '');
  assert.equal(theme.value, '');
});

test('metric columns sort numerically in both directions and expose their active sort', async t => {
  const view = await fixture(t, 'works');
  assert.match(workRows(view.container)[0].textContent, /夜景总是拍糊/);
  await view.click(view.button('收藏'));
  assert.match(workRows(view.container)[0].textContent, /下雨的下午/);
  assert.equal(view.button('收藏').closest('th').getAttribute('aria-sort'), 'ascending');
  await view.click(view.button('阅读 / 播放'));
  assert.match(workRows(view.container)[0].textContent, /夜景总是拍糊/);
  assert.equal(view.button('阅读 / 播放').closest('th').getAttribute('aria-sort'), 'descending');
  await view.click(view.button('发布日'));
  assert.match(workRows(view.container)[0].textContent, /没有计划的周末/);
});

test('each work opens a recommendation first and its supporting quotation separately', async t => {
  const view = await fixture(t, 'works');
  const row = workRows(view.container)[0];
  const details = row.querySelector('details');
  const evidence = details.querySelector('details');
  assert.equal(details.open, false);
  assert.equal(evidence.open, false);
  await view.click(details.querySelector('summary'));
  assert.equal(details.open, true);
  assert.match(details.textContent, /下一篇继续回答一个具体问题/);
  assert.equal(evidence.open, false);
  await view.click(evidence.querySelector('summary'));
  assert.equal(evidence.open, true);
  assert.match(evidence.querySelector('blockquote').textContent, /第一步：靠稳手机/);
  assert.match(evidence.textContent, /不能证明/);
});

test('theme comparison changes metric and drills into exactly the selected theme', async t => {
  const view = await fixture(t, 'themes');
  await view.input(view.container.querySelector('.ca-demo-metric-label select'), 'views');
  assert.match(view.container.querySelector('.ca-comparison-bars').textContent, /16,867/);
  await view.click(view.container.querySelector('.ca-comparison-bars button'));
  assert.deepEqual(view.calls.sections, ['works']);
  assert.equal(workRows(view.container).length, 3);
  assert.ok(workRows(view.container).every(row => row.textContent.includes('实用教程')));
});

test('sample action checklist changes only in-memory experience and offers a real-data route', async t => {
  const view = await fixture(t, 'experiments');
  for (const checkbox of view.container.querySelectorAll('input[type="checkbox"]')) await view.click(checkbox);
  assert.match(view.container.textContent, /体验进度 3 \/ 3/);
  assert.match(view.container.textContent, /不保存实验/);
  assert.equal(view.container.querySelector('form'), null);
  await view.click(view.button('用我的作品制定计划'));
  assert.equal(view.calls.source, 1);
  assert.deepEqual(view.calls.fetches, []);
});

const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
async function loadPage() {
  let code = ts.transpileModule(fs.readFileSync(new URL('../src/components/ContentAnalysisPage.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const parsed = ts.createSourceFile('Page.js', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const replacements = [];
  for (const statement of parsed.statements.filter(ts.isImportDeclaration)) {
    const specifier = statement.moduleSpecifier.text;
    if (specifier.endsWith('.css')) { replacements.push({ start: statement.getStart(parsed), end: statement.end, text: '' }); continue; }
    const target = specifier === '../lib/api' ? moduleUrl('export async function fetchAccounts(){globalThis.__demoAccountReads++;return [];}')
      : specifier === './ContentAnalysisDemo' ? await tsModuleUrl(new URL('../src/components/ContentAnalysisDemo.tsx', import.meta.url))
      : specifier === './icons' ? await tsModuleUrl(new URL('../src/components/icons.tsx', import.meta.url))
      : specifier.startsWith('.') ? moduleUrl(`export default function Panel(){return ${JSON.stringify(specifier === './ContentAnalysisWorkbench' ? '真实作品工作台替身' : '')};}`)
      : import.meta.resolve(specifier);
    replacements.push({ start: statement.moduleSpecifier.getStart(parsed), end: statement.moduleSpecifier.end, text: JSON.stringify(target) });
  }
  for (const item of replacements.reverse()) code = code.slice(0, item.start) + item.text + code.slice(item.end);
  return (await import(moduleUrl(code))).default;
}

test('page defaults to isolated demo and mounts real account tools only after selecting my data', async t => {
  globalThis.__demoAccountReads = 0;
  const Page = await loadPage();
  const view = await fixture(t, 'review', Page);
  assert.equal(globalThis.__demoAccountReads, 0);
  assert.ok(view.container.querySelector('[aria-label="内容分析演示"]'));
  assert.doesNotMatch(view.container.textContent, /真实作品工作台替身/);
  await view.click(view.button('我的数据'));
  assert.equal(globalThis.__demoAccountReads, 1);
  assert.equal(view.container.querySelector('[aria-label="内容分析演示"]'), null);
  assert.match(view.container.textContent, /真实作品工作台替身/);
  assert.equal(view.container.querySelector('.ca-collection-tools').open, false);
  await view.click(view.button('看演示数据'));
  assert.equal(globalThis.__demoAccountReads, 1);
  assert.ok(view.container.querySelector('[aria-label="内容分析演示"]'));
  assert.doesNotMatch(view.container.textContent, /真实作品工作台替身/);
});

test.after(async () => { await window.happyDOM.abort(); window.close(); });
