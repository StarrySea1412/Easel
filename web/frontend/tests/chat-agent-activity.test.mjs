import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {act,createElement} from 'react';
import {loadTsModule} from './load-ts.mjs';

globalThis.window=new Window({url:'http://127.0.0.1/'});globalThis.document=window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const {default:Activity}=await loadTsModule('../src/components/ChatAgentActivity.tsx',import.meta.url);
const {ChatRunContext}=await loadTsModule('../src/hooks/useChatRun.ts',import.meta.url);

test('ordinary chat omits empty plan and collaboration advice for every configuration',async t=>{
 const agent={id:'root:main',name:'Main',role:'任务协调',task:'',state:'working',source:'live',action:{kind:'thinking',label:'思考中',evidence:'observed'}};
 const office={turnId:'turn-1',agents:[agent],events:[],error:null,loading:false,refresh(){}};
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 t.after(async()=>{await act(async()=>root.unmount());host.remove();});
 for(const runtime of [undefined,{subagentsConfigured:false,subagentReason:'请先选择启动模型并保存'},{subagentsConfigured:true}]){
  const value={sessionId:'session-1',turnId:'turn-1',engine:'openclaw',execution:{current:{sessionId:'session-1',turnId:'turn-1',operations:[],plan:[],runtime}},office};
  await act(async()=>root.render(createElement(ChatRunContext.Provider,{value},createElement(Activity,{sessionId:'session-1',turnId:'turn-1'}))));
  assert.match(host.textContent,/主 Agent/);
  assert.equal(host.querySelector('.chat-agent-capabilities'),null);
  assert.doesNotMatch(host.textContent,/计划|未开放|启动模型|复杂任务|未收到回执不代表|尚未收到委派/);
 }
});

test('Agent behavior retry uses Easel button styling and disables during refresh',async t=>{
 let refreshes=0;
 const agent={id:'root:main',name:'Main',role:'任务协调',task:'',state:'working',source:'live',action:{kind:'thinking',label:'思考中',evidence:'observed'}};
 const office={turnId:'turn-1',agents:[agent],events:[],observedAt:null,observedAgentCount:1,identityScanLimited:false,coverage:'',error:'读取失败',loading:false,refresh:()=>refreshes++};
 const run={sessionId:'session-1',turnId:'turn-1',engine:'openclaw',streaming:true,execution:{},office};
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 t.after(async()=>{await act(async()=>root.unmount());host.remove();});
 const render=async value=>act(async()=>root.render(createElement(ChatRunContext.Provider,{value},createElement(Activity,{sessionId:'session-1',turnId:'turn-1'}))));
 await render(run);
 let button=host.querySelector('.chat-agent-refresh');
 assert.ok(button);assert.match(button.className,/\bbtn\b.*\bbtn-sm\b.*\bbtn-ghost\b/);
 assert.equal(button.querySelector('svg')!==null,true);assert.match(button.textContent,/重新读取行为/);
 await act(async()=>button.click());assert.equal(refreshes,1);
 await render({...run,office:{...office,loading:true}});
 button=host.querySelector('.chat-agent-refresh');assert.equal(button.disabled,true);assert.match(button.textContent,/读取中/);
 await act(async()=>button.click());assert.equal(refreshes,1);
});
