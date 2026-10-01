import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadTsModule } from './load-ts.mjs';

const { officeWorkSurface } = await loadTsModule('../src/components/agent-office/officeWorkSurface.ts', import.meta.url);
const { describeOfficeAction } = await loadTsModule('../src/lib/officeActions.ts', import.meta.url);
const { default: OfficeWorkPreview } = await loadTsModule('../src/components/agent-office/OfficeWorkPreview.tsx', import.meta.url);
const { createOfficeScreenTexture } = await loadTsModule('../src/components/agent-office/officeScreenTexture.ts', import.meta.url);
const agent = { id:'child', name:'研究员', role:'协作 Agent', task:'核对三个来源', state:'working', source:'live' };

test('work screen uses only the selected employee task and unmatched tool evidence', () => {
  const call = { id:'call', agentId:agent.id, kind:'call', source:'live', operationId:'abc', toolName:'read' };
  const current = { ...agent, action:describeOfficeAction(agent,[call]) };
  assert.equal(officeWorkSurface(current).tool,'read');
  assert.equal(officeWorkSurface(current).task,agent.task);
  assert.equal(officeWorkSurface(current).sample,false);
  assert.equal(officeWorkSurface({...agent, action:describeOfficeAction(agent,[{...call,agentId:'parent'}])}).kind,'unreported');
  const returned = {...agent, action:describeOfficeAction(agent,[call,{...call,kind:'result'}])};
  assert.equal(officeWorkSurface(returned).tool,null);
  assert.equal(officeWorkSurface(returned).kind,'unreported');
  for (const state of ['done','error','stopped']) {
    assert.equal(officeWorkSurface({...current,state}).tool,null,'terminal state clears active tool even if old action remains');
  }
});

test('demo sample copy cannot leak into live visual tasks or unknown activity', () => {
  const design = {...agent, action:{kind:'designing', label:'处理视觉内容', evidence:'observed', toolName:'imagegen'}};
  const markup = renderToStaticMarkup(React.createElement(OfficeWorkPreview,{agent:design,stale:false,onOpen(){}}));
  assert.match(markup,/核对三个来源/);
  assert.match(markup,/画板示意/);
  assert.doesNotMatch(markup,/春日|主视觉、标题区/);
  const demo = officeWorkSurface({...design,source:'demo'});
  assert.equal(demo.sample,true);
  assert.match(demo.detail,/版式草图/);
  assert.match(officeWorkSurface({...agent,task:'写作和设计',action:undefined}).detail,/未上报/);
});

test('screen expansion is plain text with explicit stale/source boundaries', () => {
  const markup = renderToStaticMarkup(React.createElement(OfficeWorkPreview,{agent:{...agent,task:'<script>no</script>'},stale:true,onOpen(){}}));
  assert.match(markup,/&lt;script&gt;no&lt;\/script&gt;/);
  assert.match(markup,/上次快照/);
  assert.match(markup,/未读取远程桌面/);
  assert.match(markup,/展开工作过程/);
});

test('interrupted observation labels the same last call as historical on both work screens', () => {
  const working = { ...agent, action: { kind: 'executing', label: '正在执行工具', evidence: 'observed', toolName: 'exec' } };
  const snapshot = { stale: true, observedAt: '2026-10-01T08:23:00Z' };
  const work = officeWorkSurface(working, snapshot);
  assert.equal(work.toolLabel, '上次记录调用：exec');
  assert.match(work.state, /^上次记录：/);
  assert.match(work.source, /上次快照/);
  assert.doesNotMatch(work.source, /时间未记录/);
  const markup = renderToStaticMarkup(React.createElement(OfficeWorkPreview, { agent: working, ...snapshot, onOpen() {} }));
  assert.match(markup, /上次记录调用：exec/);
  assert.doesNotMatch(markup, /正在调用/);
  assert.equal(officeWorkSurface(working).toolLabel, '正在调用：exec');
  assert.equal(officeWorkSurface({ ...working, source: 'demo' }, snapshot).stale, false);
  assert.match(officeWorkSurface(working, { stale: true, observedAt: 'invalid' }).source, /时间未记录/);
});

test('monitor canvas updates on content changes and releases its GPU texture', () => {
  const saved = globalThis.document;
  const texts=[];
  const ctx = { fillRect(){}, beginPath(){}, arc(){}, fill(){}, fillText(text){texts.push(text)}, measureText(text){return {width:text.length*20}} };
  globalThis.document={createElement(){return {width:0,height:0,getContext(){return ctx}}}};
  try {
    const display=createOfficeScreenTexture();
    const work=officeWorkSurface(agent);
    display.update(work);
    assert.ok(texts.includes(agent.task));
    const count=texts.length, version=display.texture.version;
    display.update(work);
    assert.equal(texts.length,count); assert.equal(display.texture.version,version);
    display.update(officeWorkSurface({...agent,state:'done'}));
    assert.ok(display.texture.version>version); assert.ok(texts.includes('本轮完成'));
    display.update(null); assert.ok(texts.includes('空闲工位'));
    let disposed=0; display.texture.addEventListener('dispose',()=>disposed++);
    display.dispose(); assert.equal(disposed,1);
  } finally { if(saved===undefined)delete globalThis.document; else globalThis.document=saved; }
});
