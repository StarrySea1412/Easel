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
const {readChatAutoContinue}=await loadTsModule('../src/lib/chatContinuation.ts',import.meta.url);

test('toggle is scoped, blocks edits while running, manual continuation never resends original',async()=>{
  const container=document.createElement('div');document.body.append(container);const root=createRoot(container);let count=0;
  const render=(sessionId,busy=false)=>act(async()=>root.render(createElement(Controls,{key:sessionId,sessionId,busy,canContinue:true,onContinue:()=>count++})));
  try {
    const toggle=()=>container.querySelector('[role=switch]');
    const manual=()=>container.querySelector('[aria-label="继续未完成任务"]');
    await render('one');assert.equal(toggle().getAttribute('aria-checked'),'true');
    assert.equal(container.querySelector('input[type=checkbox]'),null);
    assert.equal(manual().classList.contains('btn'),false);
    assert.equal(document.getElementById(toggle().getAttribute('aria-labelledby')).textContent,'自动继续');
    assert.equal(document.getElementById(toggle().getAttribute('aria-describedby')).textContent,'最多 2 次');
    await act(async()=>toggle().click());assert.equal(readChatAutoContinue('one'),false);
    await act(async()=>manual().click());assert.equal(count,1);
    await render('two',true);assert.equal(toggle().getAttribute('aria-checked'),'true');assert.ok(toggle().disabled);assert.ok(manual().disabled);
    await act(async()=>{toggle().click();manual().click();});assert.equal(count,1);assert.equal(readChatAutoContinue('two'),true);
    await render('one');assert.equal(toggle().getAttribute('aria-checked'),'false');
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
