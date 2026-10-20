import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {loadTsModule} from './load-ts.mjs';

globalThis.window=new JSDOM('<!doctype html><body/>',{url:'https://easel.test/'}).window;
globalThis.document=window.document;
globalThis.localStorage=window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const Panel=(await loadTsModule('../src/components/PanelMaterialQuote.tsx')).default;
const drafts=await loadTsModule('../src/lib/chatDrafts.ts');
const {saveAnalysisChatResult}=await loadTsModule('../src/lib/analysisConversations.ts');

test('quotes only selection inside the current panel, allows editing, and preserves the chat draft without network',async t=>{
  let requests=0; globalThis.fetch=async()=>{requests++;throw Error('no requests expected');};
  const box=document.createElement('div');document.body.append(box);const root=createRoot(box);
  t.after(async()=>{await act(async()=>root.unmount());box.remove();});
  drafts.setChatDraftText('panel-quote-owner','已有草稿');
  await act(async()=>root.render(createElement(Panel,{sessionId:'panel-quote-owner',tool:'files',hidden:false},createElement('p',null,'原始文件片段'))));
  const button=()=>[...box.querySelectorAll('button')].find(b=>b.textContent==='提取选中内容');
  const outside=document.createElement('p');outside.textContent='其他面板';document.body.append(outside);t.after(()=>outside.remove());
  const select=node=>{const range=document.createRange();range.selectNodeContents(node);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);};
  select(outside);await act(async()=>button().click());assert.equal(box.querySelector('textarea'),null);
  select(box.querySelector('.chat-panel-material-body p'));await act(async()=>button().click());
  const field=box.querySelector('textarea');assert.match(field.value,/文件材料引用/);assert.match(field.value,/原始文件片段/);
  const onChange=Object.keys(field).find(k=>k.startsWith('__reactProps$'));
  await act(async()=>field[onChange].onChange({target:{value:'编辑后的引用'}}));
  await act(async()=>[...box.querySelectorAll('button')].find(b=>b.textContent==='引用到当前对话').click());
  assert.equal(drafts.getChatDraft('panel-quote-owner').text,'已有草稿');
  assert.deepEqual(drafts.getChatDraft('panel-quote-owner').quotes,['编辑后的引用']);
  assert.equal(requests,0);assert.equal(box.querySelector('textarea'),null);
});

test('analysis writeback excludes stops, errors and imported contexts, and preserves session and turn identity',async()=>{
  const calls=[];globalThis.fetch=async(url,options)=>{calls.push([url,options]);return {ok:true,json:async()=>({id:'binding'})};};
  const session={id:'analysis-owner',analysisContext:{id:'binding',platform:'douyin',accountId:'owner'}};
  const message={role:'assistant',turnId:'turn-owner',content:'本次分析依据已保存的作品材料，提供具体行动。'};
  for(const skipped of [{...message,error:{message:'failed'}},{...message,stopped:true},{...message,turnId:''}])assert.equal(await saveAnalysisChatResult(session,skipped),null);
  assert.equal(await saveAnalysisChatResult({...session,importedFromBackup:true},message),null);assert.equal(calls.length,0);
  await saveAnalysisChatResult(session,message);assert.equal(calls.length,1);
  assert.deepEqual(JSON.parse(calls[0][1].body),{platform:'douyin',accountId:'owner',sessionId:'analysis-owner',turnId:'turn-owner',markdown:message.content});
});
