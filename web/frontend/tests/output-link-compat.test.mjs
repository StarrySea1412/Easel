import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { loadTsModule } from './load-ts.mjs';
globalThis.window = new Window({url:'http://127.0.0.1:7880/'});
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const {linkifyOutputs} = await loadTsModule('../src/lib/linkifyOutputs.ts', import.meta.url);
const {default: OutputsPage} = await loadTsModule('../src/components/OutputsPage.tsx', import.meta.url);

test('Markdown local document links enter the library while external URLs and code stay intact', () => {
  assert.equal(linkifyOutputs('[文档](outputs/project/readme.md)'), '[文档](#/outputs/project/readme.md)');
  assert.equal(linkifyOutputs('[文档](C:\\Easel\\outputs\\project\\readme.md)'), '[文档](#/outputs/project/readme.md)');
  for (const source of ['[外部](https://example.com/outputs/readme.md)', '[越界](outputs/../secret.md)', '```\n[文档](outputs/a.md)\n```']) assert.equal(linkifyOutputs(source), source);
  assert.match(linkifyOutputs('![图片](outputs/project/a.png)'), /^!\[图片\]\(\/api\/media\/project\/a.png\)$/);
});

test('real OutputsPage waits for the tree then opens the linked file preview', async t => {
  const calls = [];
  let finishTree;
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(String(url));
    if (String(url).endsWith('/api/outputs')) return new Promise(resolve => { finishTree = () => resolve({ok:true,json:async()=>[{name:'project',type:'dir',path:'project',children:[{name:'readme.md',type:'file',kind:'text',path:'project/readme.md'}]}]}); });
    return {ok:true,json:async()=>({content:'# 真实文档预览',isBinary:false})};
  });
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node); let handled = 0;
  await act(async()=>root.render(React.createElement(OutputsPage,{jumpPath:'project/readme.md',onJumpHandled:()=>handled++})));
  assert.equal(handled,0);
  await act(async()=>finishTree());
  assert.equal(handled,1); assert.match(node.textContent,/真实文档预览/);
  assert.equal(calls.some(url=>url.includes('project/readme.md')),true);
  await act(async()=>root.unmount());node.remove();
});
