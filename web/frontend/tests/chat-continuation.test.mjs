import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Window} from 'happy-dom';
import {act,createElement} from 'react';
import {loadTsModule} from './load-ts.mjs';
import {runtimeToolParams} from '../../../openclaw/easel-agent-safety/runtime.mjs';
import {createHash} from 'node:crypto';

globalThis.window=new Window({url:'https://easel.test/'});globalThis.document=window.document;globalThis.localStorage=window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const {default:Controls}=await loadTsModule('../src/components/ChatContinuationControls.tsx',import.meta.url);
const {default:Settings}=await loadTsModule('../src/components/settings/ChatContinuationSettings.tsx',import.meta.url);
const {readChatAutoContinue,saveChatAutoContinue}=await loadTsModule('../src/lib/chatContinuation.ts',import.meta.url);
const {retryPendingLocalWrites}=await loadTsModule('../src/lib/localPersistence.ts',import.meta.url);

test('settings preserve existing per-conversation choices and block edits while running',async()=>{
  localStorage.clear();localStorage.setItem('easel_chat_auto_continue:one','off');
  const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
  const render=(id,busy=false,unavailableReason)=>act(async()=>root.render(createElement(Settings,{key:id,session:id?{id,title:`对话 ${id}`,busy,unavailableReason}:undefined})));
  try {
    const toggle=()=>container.querySelector('[role=switch]');
    await render('one');assert.equal(toggle().getAttribute('aria-checked'),'false');
    assert.match(container.textContent,/对话 one · 仅对当前对话生效/);
    assert.match(container.textContent,/最多自动继续 2 次/);
    assert.equal(document.getElementById(toggle().getAttribute('aria-labelledby')).textContent,'自动继续');
    await act(async()=>toggle().click());assert.equal(readChatAutoContinue('one'),true);
    await render('two',true);assert.ok(toggle().disabled);
    await act(async()=>toggle().click());assert.equal(readChatAutoContinue('two'),true);
    await render('two');await act(async()=>toggle().click());assert.equal(readChatAutoContinue('two'),false);
    await render('one');assert.equal(toggle().getAttribute('aria-checked'),'true');
    await render('two');assert.equal(toggle().getAttribute('aria-checked'),'false');
    await render('two',false,'只读记录');assert.ok(toggle().disabled);assert.match(container.textContent,/只读记录/);
    await render(undefined);assert.equal(toggle(),null);assert.match(container.textContent,/先打开一个对话/);
  } finally {await act(async()=>root.unmount());container.remove();}
});

test('failed settings writes stay visible and never apply later as a queued preference',async t=>{
  localStorage.clear();
  const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
  try {
    await act(async()=>root.render(createElement(Settings,{session:{id:'failure',title:'保存失败测试',busy:false}})));
    const toggle=container.querySelector('[role=switch]');
    const write=t.mock.method(localStorage,'setItem',()=>{throw new Error('storage blocked');});
    await act(async()=>toggle.click());
    assert.equal(toggle.getAttribute('aria-checked'),'true');
    assert.match(container.querySelector('[role=alert]').textContent,/未能保存/);
    write.mock.restore();retryPendingLocalWrites();assert.equal(localStorage.getItem('easel_chat_auto_continue:failure'),null);assert.equal(readChatAutoContinue('failure'),true);
    await act(async()=>toggle.click());assert.equal(readChatAutoContinue('failure'),false);
    assert.equal(container.querySelector('[role=alert]'),null);
  } finally {await act(async()=>root.unmount());container.remove();}
});

test('high-volume interleaved preference writes stay isolated across 64 conversations',async()=>{
  localStorage.clear();
  const sessions=64,iterations=500;
  try {
    await Promise.all(Array.from({length:sessions},async(_,session)=>{
      for(let iteration=0;iteration<iterations;iteration++){
        const expected=(session+iteration)%2===0;
        assert.equal(saveChatAutoContinue(`stress-${session}`,expected),true);
        assert.equal(readChatAutoContinue(`stress-${session}`),expected);
        if(iteration%25===0)await new Promise(resolve=>setImmediate(resolve));
      }
    }));
    for(let session=0;session<sessions;session++)
      assert.equal(readChatAutoContinue(`stress-${session}`),(session+iterations-1)%2===0);
    assert.equal(Array.from({length:localStorage.length},(_,index)=>localStorage.key(index))
      .filter(key=>key?.startsWith('easel_chat_auto_continue:stress-')).length,sessions);
  } finally { localStorage.clear(); }
});

test('composer retains only manual continuation, blocks it while running and leaves no empty row',async()=>{
  const container=document.createElement('div');document.body.append(container);const root=createRoot(container);let count=0;
  const render=(busy=false,canContinue=true)=>act(async()=>root.render(createElement(Controls,{busy,canContinue,onContinue:()=>count++})));
  try {
    const manual=()=>container.querySelector('[aria-label="继续未完成任务"]');
    await render();assert.equal(container.querySelector('[role=switch]'),null);
    assert.equal(manual().classList.contains('btn'),false);
    assert.equal(manual().textContent,'');
    assert.equal(manual().title,'继续未完成任务');
    assert.ok(manual().querySelector('svg'));
    await act(async()=>manual().click());assert.equal(count,1);
    await render(true);assert.ok(manual().disabled);
    await act(async()=>manual().click());assert.equal(count,1);
    await render(false,false);assert.equal(container.innerHTML,'');
  } finally {await act(async()=>root.unmount());container.remove();}
});

test('Linux pipefail script is passed as one Bash argument, quoting stays literal',async()=>{
  const command="set -euo pipefail\nprintf '%s' 'a b'";
  const changed=await runtimeToolParams({toolName:'exec',params:{command,cwd:'/work'}},{},{},{},'linux');
  assert.equal(changed.params.cwd,'/work');assert.match(changed.params.command,/^bash -lc /);
  if(process.platform!=='win32')assert.equal(execFileSync('/bin/sh',['-c',changed.params.command],{encoding:'utf8'}),'a b');
  assert.equal(await runtimeToolParams({toolName:'exec',params:{command}},{},{},{},'win32'),undefined);
});

test('old inbox references migrate only within the current session and use configured vision',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'easel-media-'));
  try {
    const scope=createHash('sha256').update('own').digest('hex').slice(0,20);
    const inbox=path.join(root,'outputs','_inbox',scope,'batch');await fs.mkdir(inbox,{recursive:true});
    const file=path.join(inbox,'01.png');await fs.writeFile(file,Buffer.from('fixture bytes'));
    const config={agents:{defaults:{imageModel:{primary:'vision/model'}}},models:{providers:{vision:{models:[{id:'model',input:['text','image']}]}}}};
    const env={EASEL_DATA_DIR:root,OPENCLAW_STATE_DIR:path.join(root,'state')};
    const result=await runtimeToolParams({toolName:'view_image',params:{path:file,model:'chat/text'}},{sessionKey:'agent:main:own'},config,env);
    assert.equal(result.params.model,'vision/model');assert.ok(result.params.path.startsWith(path.join(root,'state','media')));
    assert.equal((await fs.readFile(result.params.path)).toString(),'fixture bytes');
    const denied=await runtimeToolParams({toolName:'view_image',params:{path:file}},{sessionKey:'agent:main:other'},config,env);
    assert.equal(denied.block,true);
    assert.equal((await runtimeToolParams({toolName:'view_image',params:{}},{},{},env)).block,true);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
