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

test('image category includes generated and ordinary images; legacy entry normalizes and AI remains a tag', async t => {
  const tree=[{name:'images',type:'dir',path:'images',children:[{name:'generated.png',type:'file',kind:'image',path:'images/generated.png',source:'imagegen'}]},
    {name:'import.png',type:'file',kind:'image',path:'import.png'},
    {name:'readme.md',type:'file',kind:'text',path:'readme.md'}];
  t.mock.method(globalThis,'fetch',async()=>({ok:true,json:async()=>tree}));
  const node=document.createElement('div');document.body.append(node);const root=createRoot(node);
  t.after(async()=>{await act(async()=>root.unmount());node.remove();});
  await act(async()=>root.render(React.createElement(OutputsPage,{initialFilter:'imagegen'})));
  const chips=[...node.querySelectorAll('.gallery-filter-options .chip')];
  assert.equal(chips.some(chip=>chip.textContent==='AI 生图'),false);
  assert.equal(chips.find(chip=>chip.textContent==='图片').getAttribute('aria-pressed'),'true');
  assert.deepEqual([...node.querySelectorAll('.gcard-name')].map(el=>el.textContent).sort(),['generated.png','import.png']);
  assert.deepEqual([...node.querySelectorAll('.gcard-kind')].map(el=>el.textContent),['图片','图片']);
  assert.equal([...node.querySelectorAll('.gcard-sub span')].filter(el=>el.textContent==='AI 生图').length,1);
});

test('empty or invalid entry filters show all projects and files, including after changing category', async t => {
  const tree = [{name:'验收项目',type:'dir',path:'验收项目',children:[{name:'中文 文档.html',type:'file',kind:'text',path:'验收项目/中文 文档.html'}]},
    {name:'import.png',type:'file',kind:'image',path:'import.png'}];
  t.mock.method(globalThis,'fetch',async()=>({ok:true,json:async()=>tree}));
  const node=document.createElement('div');document.body.append(node);const root=createRoot(node);
  t.after(async()=>{await act(async()=>root.unmount());node.remove();});
  const names=()=>[...node.querySelectorAll('.gcard-name')].map(el=>el.textContent.trim()).sort();
  const selected=()=>[...node.querySelectorAll('.gallery-filter-options .chip')].filter(el=>el.getAttribute('aria-pressed')==='true').map(el=>el.textContent);
  await act(async()=>root.render(React.createElement(OutputsPage,{initialFilter:''})));
  assert.deepEqual(selected(),['全部']);
  assert.deepEqual(names(),['import.png','验收项目']);
  await act(async()=>[...node.querySelectorAll('.gcard-name')].find(el=>el.textContent.includes('验收项目')).click());
  assert.deepEqual(names(),['中文 文档.html']);
  await act(async()=>root.render(React.createElement(OutputsPage,{initialFilter:'image'})));
  assert.deepEqual(selected(),['图片']);
  assert.deepEqual(names(),['import.png']);
  await act(async()=>root.render(React.createElement(OutputsPage,{initialFilter:'unknown'})));
  assert.deepEqual(selected(),['全部']);
  assert.deepEqual(names(),['import.png','验收项目']);
  await act(async()=>root.render(React.createElement(OutputsPage,{initialFilter:'text'})));
  assert.deepEqual(selected(),['文档']);
  assert.deepEqual(names(),['中文 文档.html']);
  await act(async()=>root.render(React.createElement(OutputsPage,{initialFilter:''})));
  assert.deepEqual(selected(),['全部']);
  assert.deepEqual(names(),['import.png','验收项目']);
});
