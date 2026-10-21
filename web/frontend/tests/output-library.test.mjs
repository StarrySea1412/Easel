import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act,createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://127.0.0.1:7880/'}).window;
globalThis.document=window.document;globalThis.HTMLElement=window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
Object.defineProperty(globalThis,'localStorage',{configurable:true,get:()=>window.localStorage});
const {createRoot}=await import('react-dom/client');
const {default:OutputsPage}=await loadTsModule('../src/components/OutputsPage.tsx',import.meta.url);
const references=await loadTsModule('../src/lib/outputReferences.ts',import.meta.url);
const file={name:'notes.md',path:'project/notes.md',type:'file',kind:'text'};
const other={name:'other.md',path:'project/other.md',type:'file',kind:'text'};
const session={id:'origin-chat',title:'原始创作',created:1,messages:[{role:'assistant',content:'[作品](outputs/project/notes.md)'}]};

async function fixture(t,props={}){
  window.localStorage.clear();
  const state={folders:[],files:{}},calls=[];
  let fail=false, origins=[{sessionId:session.id,turnId:'turn-1',evidence:'delivery'}];
  t.mock.method(globalThis,'fetch',async(url,init={})=>{
    url=String(url);const method=init.method||'GET',body=init.body?JSON.parse(init.body):{};calls.push({url,method,body});
    let result={};
    if(url==='/api/outputs')result=[{name:'project',path:'project',type:'dir',children:[file,other]}];
    else if(url==='/api/output-library')result=structuredClone(state);
    else if(url.startsWith('/api/output-library/origins'))result={origins};
    else if(url==='/api/output-library/folders'&&method==='POST'){
      if(fail)return {ok:false,status:409,json:async()=>({detail:'该位置已有同名文件夹'})};
      result={id:'folder-'+(state.folders.length+1),name:body.name,parent:body.parent};state.folders.push(result);
    }else if(url.includes('/api/output-library/folders/')&&method==='PATCH'){
      state.folders.find(f=>f.id===url.split('/').at(-1)).name=body.name;
    }else if(url.includes('/api/output-library/folders/')&&method==='DELETE'){
      const id=url.split('/').at(-1);state.folders=state.folders.filter(f=>f.id!==id);for(const [path,folder]of Object.entries(state.files))if(folder===id)delete state.files[path];
    }else if(url==='/api/output-library/file'){if(body.folder)state.files[body.path]=body.folder;else delete state.files[body.path];}
    else if(url.startsWith('/api/output/'))result={kind:'text',content:'real output',isBinary:false,path:file.path};
    return {ok:true,json:async()=>result};
  });
  const node=document.createElement('div');document.body.append(node);const root=createRoot(node);
  t.after(async()=>{await act(async()=>root.unmount());node.remove();});
  const options={sessions:[session],onOpenConversation:async()=>true,...props};
  const render=()=>act(async()=>root.render(createElement(OutputsPage,options)));
  await render();
  return {node,state,calls,options,render,fail:value=>{fail=value;},origins:value=>{origins=value;},
    click:element=>act(async()=>{assert.ok(element);element.click();}),
    input:async(element,value)=>act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(element,value);element.dispatchEvent(new window.Event('input',{bubbles:true}));}),
  };
}

test('custom folders create, nest, classify, rename and delete without relocating file paths',async t=>{
  const v=await fixture(t);
  await v.click(v.node.querySelector('[aria-label="新建文件夹"]'));
  await v.input(document.querySelector('[aria-label="文件夹名称"]'),'品牌策划');
  await v.click([...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='保存'));
  assert.equal(v.state.folders[0].name,'品牌策划');
  assert.match(v.node.querySelector('h1').textContent,/品牌策划/);
  await v.click(v.node.querySelector('[aria-label="在品牌策划中新建文件夹"]'));
  await v.input(document.querySelector('[aria-label="文件夹名称"]'),'素材');
  await v.click([...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='保存'));
  assert.equal(v.state.folders[1].parent,'folder-1');
  await v.click([...v.node.querySelectorAll('.library-folder-select')].find(b=>b.textContent.includes('全部文件')));
  await v.click(v.node.querySelector('.gcard-name'));
  await v.click(v.node.querySelector('[aria-label="整理notes.md"]'));
  await v.click(document.querySelector('[aria-label="目标文件夹"]'));
  await v.click([...document.querySelectorAll('[role=option]')].find(b=>b.textContent==='品牌策划 / 素材'));
  await v.click([...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='保存'));
  assert.equal(v.state.files[file.path],'folder-2');
  await v.click([...v.node.querySelectorAll('.library-folder-select')].find(b=>b.title==='品牌策划'));
  assert.deepEqual([...v.node.querySelectorAll('.gcard-name')].map(b=>b.textContent),['notes.md']);
  await v.click(v.node.querySelector('[aria-label="重命名文件夹素材"]'));
  await v.input(document.querySelector('[aria-label="文件夹名称"]'),'参考');
  await v.click([...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='保存'));
  assert.equal(v.state.folders[1].name,'参考');
  await v.click(v.node.querySelector('[aria-label="删除文件夹参考"]'));
  assert.match(document.querySelector('[role=dialog]').textContent,/文件会保留/);
  await v.click([...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='删除文件夹'));
  assert.equal(v.state.files[file.path],undefined);
  await v.click([...v.node.querySelectorAll('.library-folder-select')].find(b=>b.textContent.includes('未归类')));
  assert.equal(v.node.querySelectorAll('.gcard').length,2);
  assert.ok(!v.calls.some(c=>c.url.includes('/rename')||c.url.startsWith('/api/output/')&&c.method==='DELETE'));
});

test('save errors retain folder text and Escape returns focus to the opening button',async t=>{
  const v=await fixture(t),opener=v.node.querySelector('[aria-label="新建文件夹"]');
  opener.focus();await v.click(opener);
  const input=document.querySelector('[aria-label="文件夹名称"]');assert.equal(document.activeElement,input);
  await v.input(input,'保留我的输入');v.fail(true);
  await v.click([...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='保存'));
  assert.equal(input.value,'保留我的输入');assert.match(document.querySelector('[role=alert]').textContent,/同名/);
  await act(async()=>document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  assert.equal(document.querySelector('[role=dialog]'),null);assert.equal(document.activeElement,opener);
});

test('delivery origins open the exact session; deleted and unknown origins never navigate',async t=>{
  const opened=[],v=await fixture(t,{onOpenConversation:async(id,f)=>{opened.push([id,f.path]);return true;}});
  await v.click(v.node.querySelector('.gcard-name'));
  await v.click(v.node.querySelector('[aria-label="返回notes.md的对话"]'));
  assert.match(document.querySelector('[role=dialog]').textContent,/来源对话/);
  await v.click(document.querySelector('.library-origin'));
  assert.deepEqual(opened,[[session.id,file.path]]);
  assert.equal(document.querySelector('[role=dialog]'),null);
  references.markOutputSessionDeleted(session.id);
  await v.click(v.node.querySelector('[aria-label="返回notes.md的对话"]'));
  assert.match(document.querySelector('[role=dialog]').textContent,/原对话已删除/);
  assert.equal(document.querySelector('.library-origin').disabled,true);
  await v.click([...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='关闭'));
  v.origins([{sessionId:'missing',evidence:'delivery'}]);
  await v.click(v.node.querySelector('[aria-label="返回notes.md的对话"]'));
  assert.match(document.querySelector('[role=dialog]').textContent,/未找到原对话/);
  assert.equal(opened.length,1);
});

test('legacy references retain deleted identity and distinguish links from names and user attachments',()=>{
  window.localStorage.clear();
  references.rememberOutputReferences([session,{...session,id:'user-only',messages:[{role:'user',content:'[文件](outputs/project/notes.md)'}]}]);
  assert.equal(references.outputReferences(file.path).length,1);
  assert.equal(references.outputReferences(file.path)[0].evidence,'reference');
  references.markOutputSessionDeleted(session.id);
  references.rememberOutputReferences([]);
  assert.equal(references.outputReferences(file.path)[0].deleted,true);
  references.renameOutputReferences('project','archive');
  assert.equal(references.outputReferences(file.path).length,0);
  assert.equal(references.outputReferences('archive/notes.md')[0].sessionId,session.id);
  assert.deepEqual(references.referencedOutputs('notes.md [wrong](https://remote.test/api/media/project/notes.md) `python x.py --out outputs/no.md`'),[]);
  assert.deepEqual(references.referencedOutputs('[yes](/api/media/project/%E8%B5%84%E6%96%99.md) [hidden](/api/media/_sessions/x) [escape](/api/media/../x)'),['project/资料.md']);
  references.rememberOutputReferences([{...session,id:'percent',messages:[{role:'assistant',content:'[成果](/api/media/project/50%25.md)'}]}]);
  assert.equal(references.outputReferences('project/50%.md')[0].sessionId,'percent');
});
