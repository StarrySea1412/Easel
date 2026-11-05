import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';
globalThis.window=new Window({url:'https://easel.test/'});
globalThis.document=window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const {default:Panel}=await loadTsModule('../src/components/ConversationImageTasks.tsx');
const {uniqueImageArtifacts}=await loadTsModule('../src/lib/chatArtifacts.ts');
const image=(id='a',extra={})=>({id:id.repeat(32),sessionId:'chat',turnId:'t',path:'topic/'+id+'.png',name:id+'.png',mimeType:'image/png',version:'v1',contentSha256:'c'.repeat(64),size:1024,status:'ready',revision:1,...extra});
async function setup(t,extra={}) {
  const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
  let adds=0,publishes=0,reads=0;
  const props={sessionId:'chat',items:[image()],jobs:[],targetId:'chat',onUpdated:()=>{},onRefresh:()=>reads++,onAddToChat:async()=>{adds++;},onPublish:()=>{publishes++;},...extra};
  const render=async(value={})=>act(async()=>root.render(createElement(Panel,{...props,...value})));
  await render();t.after(async()=>{await act(async()=>root.unmount());container.remove();});
  const button=label=>[...container.querySelectorAll('button')].find(b=>b.textContent.trim()===label);
  return {container,render,button,adds:()=>adds,publishes:()=>publishes,reads:()=>reads};
}
test('only byte-identical copies in the same session and turn are grouped',()=>{
  assert.equal(uniqueImageArtifacts([image(),image('b')]).length,1);
  assert.equal(uniqueImageArtifacts([image(),image('b',{contentSha256:'d'.repeat(64)})]).length,2);
  assert.equal(uniqueImageArtifacts([image(),image('b',{turnId:'other'})]).length,2);
  assert.equal(uniqueImageArtifacts([image(),image('b',{sessionId:'other'})]).length,2);
  assert.equal(uniqueImageArtifacts([image('a',{contentSha256:undefined}),image('b',{contentSha256:undefined})]).length,2);
});
test('gallery groups copies and exposes separate accessible draft actions',async t=>{
  const view=await setup(t,{items:[image(),image('b'),image('c',{sessionId:'foreign'})]});
  assert.equal(view.container.querySelectorAll('article').length,1);
  assert.match(view.container.textContent,/合并 2 份相同文件/);
  assert.equal(view.container.querySelector('a').getAttribute('aria-label'),'查看原图：a.png');
  await act(async()=>view.button('添加到对话').click());assert.equal(view.adds(),1);
  assert.match(view.container.textContent,/已加入目标对话草稿/);
  await act(async()=>view.button('用于发布').click());assert.equal(view.publishes(),1);
});
test('pending addition blocks duplicate click and reports real failure',async t=>{
  let reject;let calls=0;const wait=new Promise((_,no)=>{reject=no;});
  const view=await setup(t,{onAddToChat:()=>{calls++;return wait;}});
  await act(async()=>{view.button('添加到对话').click();view.button('添加到对话').click();});
  assert.equal(calls,1);assert.ok(view.button('正在添加').disabled);
  await act(async()=>reject(new Error('目标对话已删除')));
  assert.match(view.container.textContent,/目标对话已删除/);assert.ok(!view.button('添加到对话').disabled);
});
test('missing targets and unavailable files disable their actions',async t=>{
  const view=await setup(t,{targetId:null});assert.ok(view.button('添加到对话').disabled);
  assert.ok(!view.button('用于发布').disabled);
  await view.render({items:[image('a',{status:'missing'})]});
  assert.ok(view.button('用于发布').disabled);assert.match(view.container.textContent,/文件已移动或删除/);
});
test('legacy image refresh reads existing file once and validates ownership',async t=>{
  let reads=0,updated=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{reads++;assert.match(String(url),/\/refresh\?/);assert.equal(options.method,'POST');return new Response(JSON.stringify(image()));});
  const view=await setup(t,{items:[image('a',{contentSha256:undefined})],onUpdated:()=>updated++});
  assert.equal(reads,1);assert.equal(updated,1);
  await view.render();assert.equal(reads,1);
});
test('task state and complete prompt remain distinct from saved file count',async t=>{
  const view=await setup(t,{items:[],jobs:[{jobId:'b'.repeat(32),sessionId:'chat',turnId:'t',prompt:'完整提示词'.repeat(40),phase:'running',stage:'downloading'}]});
  assert.match(view.container.textContent,/正在保存/);assert.match(view.container.textContent,/1 个进行中/);
  assert.equal(view.container.querySelector('details p').textContent,'完整提示词'.repeat(40));
  assert.equal(view.container.querySelectorAll('article').length,0);
});


test('three-image status separates saved files from assistant visual review',async t=>{
  const cardSet={cardSetId:'f'.repeat(32),sessionId:'chat',turnId:'t',expected:3,ready:2,complete:false,qualityState:'pending',
    cards:[{cardIndex:1,cardRole:'cover',ready:true,phase:'done'},{cardIndex:2,cardRole:'content',ready:true,phase:'done'},{cardIndex:3,cardRole:'ending',ready:false,phase:'error',error:'测试缺图'}]};
  const job={jobId:'b'.repeat(32),sessionId:'chat',turnId:'t',prompt:'三图分镜',phase:'done',cardSet};
  const view=await setup(t,{jobs:[job,{...job,jobId:'c'.repeat(32)}]});
  assert.equal(view.container.querySelectorAll('[aria-label="小红书三图卡组状态"]').length,1);
  assert.match(view.container.textContent,/已保存 2\/3/);assert.match(view.container.textContent,/待质量验收/);
  assert.match(view.container.textContent,/封面/);assert.match(view.container.textContent,/核心卖点/);assert.match(view.container.textContent,/场景与收尾/);
  await view.render({jobs:[{...job,cardSet:{...cardSet,ready:3}}]});
  assert.match(view.container.textContent,/已保存 3\/3/);assert.doesNotMatch(view.container.textContent,/助手审图通过/);
  await view.render({jobs:[{...job,cardSet:{...cardSet,ready:3,complete:true,qualityState:'assistant_reviewed'}}]});
  assert.match(view.container.textContent,/助手审图通过/);
});
