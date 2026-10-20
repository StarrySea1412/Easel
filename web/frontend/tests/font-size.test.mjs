import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import postcss from 'postcss';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new Window({ url: 'http://127.0.0.1:7880/' });
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const font = await loadTsModule('../src/lib/fontSize.ts', import.meta.url);
const { default: typography } = await loadTsModule('../scripts/scalable-typography.ts', import.meta.url);
const { default: Appearance } = await loadTsModule('../src/components/settings/AppearanceSettings.tsx', import.meta.url);
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const bootstrap = html.split('<script id="easel-font-size-init">')[1].split('</script>')[0];

test('pre-paint and runtime agree on saved sizes, invalid values and restricted storage', () => {
  for (const [stored, expected] of [[null, 14], ['', 14], ['bad', 14], ['NaN', 14], ['Infinity', 14], ['11', 14], ['21', 14], ['12', 12], ['16.37', 16.4], ['20', 20]]) {
    const properties = new Map();
    vm.runInNewContext(bootstrap, { document: { documentElement: { style: { setProperty: (key, value) => properties.set(key, value) } } }, localStorage: { getItem: () => stored } });
    assert.equal(properties.get('--easel-font-size'), `${expected}px`);
    window.localStorage.clear();
    if (stored !== null) window.localStorage.setItem(font.FONT_SIZE_STORAGE_KEY, stored);
    font.initializeFontSize()();
    assert.equal(font.readFontSize().size, expected);
    assert.equal(document.documentElement.style.getPropertyValue('--easel-font-size'), `${expected}px`);
  }
  assert.doesNotThrow(() => vm.runInNewContext(bootstrap, { document, localStorage: { getItem: () => { throw Error('denied'); } } }));
});

test('continuous sizes persist, clamp safely, sync other tabs and reset after storage clear', () => {
  window.localStorage.clear();
  const stop = font.initializeFontSize();
  assert.equal(font.initializeFontSize(), stop);
  const changes = [];
  const unsubscribe = font.subscribeFontSize(() => changes.push(font.readFontSize().size));
  font.setFontSize(16.3);
  assert.equal(window.localStorage.getItem(font.FONT_SIZE_STORAGE_KEY), '16.3');
  const stable = font.readFontSize(); font.setFontSize(16.3); assert.equal(font.readFontSize(), stable);
  font.setFontSize(NaN); assert.equal(font.readFontSize().size, 16.3);
  font.setFontSize(999); assert.equal(font.readFontSize().size, 20);
  font.setFontSize(-100); assert.equal(font.readFontSize().size, 12);
  font.setFontSize(16.3); stop(); font.initializeFontSize()();
  assert.equal(font.readFontSize().size, 16.3, 'reload restores preference');
  const stopAgain = font.initializeFontSize();
  window.dispatchEvent(new window.StorageEvent('storage', { key: font.FONT_SIZE_STORAGE_KEY, newValue: '18.7' }));
  assert.equal(font.readFontSize().size, 18.7);
  window.dispatchEvent(new window.StorageEvent('storage', { key: 'unrelated', newValue: '12' }));
  assert.equal(font.readFontSize().size, 18.7);
  window.dispatchEvent(new window.StorageEvent('storage', { key: null, newValue: null }));
  assert.equal(font.readFontSize().size, 14);
  unsubscribe(); stopAgain();
  window.dispatchEvent(new window.StorageEvent('storage', { key: font.FONT_SIZE_STORAGE_KEY, newValue: '19' }));
  assert.equal(font.readFontSize().size, 14, 'cleanup removes storage listener');
  assert.ok(changes.includes(16.3) && changes.includes(18.7));
});

test('blocked storage still applies sizes and exposes a persistence notice', async t => {
  t.mock.method(window.localStorage, 'getItem', () => { throw Error('denied'); });
  t.mock.method(window.localStorage, 'setItem', () => { throw Error('denied'); });
  const stop = font.initializeFontSize(); t.after(stop);
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  t.after(async () => { await act(async () => root.unmount()); node.remove(); });
  await act(async () => root.render(createElement(Appearance)));
  const slider = node.querySelector('input[type=range]');
  assert.equal(slider.labels[0].textContent, '字号大小');
  assert.equal(slider.step, '0.1'); assert.equal(slider.min, '12'); assert.equal(slider.max, '20');
  await act(async () => font.setFontSize(16.3));
  assert.equal(slider.value, '16.3'); assert.equal(slider.getAttribute('aria-valuetext'), '16.3 像素');
  assert.equal(node.querySelector('output').textContent, '16.3px');
  assert.match(node.textContent, /字号已应用.*无法保存/);
  const reset = [...node.querySelectorAll('button')].find(button => button.textContent === '恢复默认');
  await act(async () => reset.click());
  assert.equal(font.readFontSize().size, 14); assert.equal(reset.disabled, true);
});

test('CSS scales absolute typography including shorthand and responsive text without scaling geometry', async () => {
  const source = '.x { font-size:14px; width:14px; padding:12px; line-height:20px; } .y{font:600 12.5px/18px "42px Studio"; font-size:clamp(20px, 3vw, 40px)} .z{font-size:1.2em;line-height:1.6}';
  const result = await postcss([typography()]).process(source, { from: undefined });
  const values = new Map(); result.root.walkRules(rule => { const declarations = {}; rule.walkDecls(d => declarations[d.prop] = d.value); values.set(rule.selector, declarations); });
  assert.match(values.get('.x')['font-size'], /--easel-font-scale/);
  assert.equal(values.get('.x').width, '14px'); assert.equal(values.get('.x').padding, '12px');
  assert.match(values.get('.x')['line-height'], /--easel-font-scale/);
  assert.match(values.get('.y').font, /calc\(12.5px.*calc\(18px/);
  assert.ok(values.get('.y').font.endsWith('"42px Studio"'));
  assert.match(values.get('.y')['font-size'], /calc\(\(clamp\(20px, 3vw, 40px\)\) \*/);
  assert.equal(values.get('.z')['font-size'], '1.2em'); assert.equal(values.get('.z')['line-height'], '1.6');
  assert.equal((await postcss([typography()]).process(result.css, { from: undefined })).css, result.css, 'processing twice cannot double-scale');
});
