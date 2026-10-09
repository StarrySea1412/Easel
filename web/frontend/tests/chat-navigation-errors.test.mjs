import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTsModule} from './load-ts.mjs';
const {chatTurnNodes,activeTurnFromOffsets,isChatAtBottom,shouldFollowChatScroll}=await loadTsModule('../src/lib/chatNavigation.ts',import.meta.url);
const {chatErrorDetail,makeChatError,chatErrorTitle,historicalGatewayAuthError}=await loadTsModule('../src/lib/chatErrors.ts',import.meta.url);
test('turn nodes count user requests only and preserve anchors through assistant updates',()=>{
 const messages=[{role:'user',content:'第一轮\n问题'},{role:'assistant',content:'answer'},{role:'user',content:'',attachments:[{}]},{role:'assistant',content:'partial'}];
 assert.deepEqual(chatTurnNodes(messages),[{messageIndex:0,number:1,label:'第一轮 问题'},{messageIndex:2,number:2,label:'附件创作（1 个附件）'}]);
 messages[3].content='more tokens';assert.equal(chatTurnNodes(messages)[1].messageIndex,2);
});
test('current node follows document offsets and latest node only at bottom',()=>{
 assert.equal(activeTurnFromOffsets([0,300,900],100,false),0);
 assert.equal(activeTurnFromOffsets([0,300,900],300,false),1);
 assert.equal(activeTurnFromOffsets([0,300,900],500,true),2);
 assert.equal(activeTurnFromOffsets([],0,true),-1);
});
test('reading history stays outside the bottom follow threshold',()=>{
 assert.equal(isChatAtBottom(800,1000,200),true);assert.equal(isChatAtBottom(450,1000,200),false);
});
test('authentication errors retain exact reason instead of becoming timeouts',()=>{
 const detail={message:'gateway token missing',code:'gateway_auth_missing',category:'authentication',retryable:false};
 assert.deepEqual(chatErrorDetail(makeChatError(detail)),detail);assert.equal(chatErrorTitle(detail),'认证未通过');
 assert.equal(chatErrorDetail('Unauthorized',401).category,'authentication');
});
test('plain unknown failures are not classified from guesses in their text',()=>{
 assert.equal(chatErrorDetail('Something failed').category,undefined);
 assert.equal(chatErrorDetail('timeout may have occurred').category,undefined);
 assert.equal(chatErrorTitle(chatErrorDetail('Unavailable')),'请求未完成');
});

test('unsupported effort has a specific title and retains the runtime explanation',()=>{
 const detail={message:'当前模型不支持ultra；允许运行档位off',code:'thinking_level_unsupported',category:'configuration',retryable:false};
 assert.deepEqual(chatErrorDetail(makeChatError(detail)),detail);
 assert.equal(chatErrorTitle(detail),'思考档位不支持');
});
globalThis.window={location:{pathname:'/'}};
const {streamChat}=await loadTsModule('../src/lib/api.ts',import.meta.url);
test('SSE structured authentication failure is terminal with preserved fields',async()=>{
 const detail={message:'需要重新配对',code:'gateway_pairing_required',category:'authentication',retryable:false};let fetches=0;
 globalThis.fetch=async()=>{fetches++;return new Response(`event: error\ndata: ${JSON.stringify(detail)}\n\n`);};
 const error=await new Promise(resolve=>streamChat('hi',undefined,'s',()=>{},()=>assert.fail('must not complete'),resolve));
 assert.deepEqual(error.detail,detail);assert.equal(fetches,1);
});
test('401 during recovery is not retried into a timeout',async()=>{
 let fetches=0;globalThis.fetch=async()=>{fetches++;return new Response(JSON.stringify({detail:{message:'凭据已失效',category:'authentication',code:'gateway_auth_rejected'}}),{status:401});};
 const error=await new Promise(resolve=>streamChat('',undefined,'s',()=>{},()=>assert.fail('must not complete'),resolve,undefined,undefined,undefined,'old-turn',true));
 assert.equal(error.detail.category,'authentication');assert.equal(error.message,'凭据已失效');assert.equal(fetches,1);
});
test('explicit authentication category remains terminal even under a gateway 503 wrapper',async()=>{
 let fetches=0;globalThis.fetch=async()=>{fetches++;return new Response(JSON.stringify({detail:{message:'本机网关没有凭据',category:'authentication',code:'gateway_auth_missing',retryable:false}}),{status:503});};
 const error=await new Promise(resolve=>streamChat('',undefined,'s',()=>{},()=>assert.fail('must not complete'),resolve,undefined,undefined,undefined,'old-turn',true));
 assert.equal(error.detail.code,'gateway_auth_missing');assert.equal(fetches,1);
});

test('a small upward scroll pauses following even while still near the bottom',()=>{
 assert.equal(shouldFollowChatScroll(true,800,788,1000,200),false);
 assert.equal(shouldFollowChatScroll(false,788,788,1000,200),false);
});
test('scrolling down to the latest edge resumes following',()=>{
 assert.equal(shouldFollowChatScroll(false,500,800,1000,200),true);
 assert.equal(shouldFollowChatScroll(false,500,600,1000,200),false);
});

test('a node jump near the bottom stays paused until the user scrolls again',()=>{
 assert.equal(shouldFollowChatScroll(false,500,780,1000,200,true),false);
 assert.equal(shouldFollowChatScroll(false,780,800,1000,200,true),false);
 assert.equal(shouldFollowChatScroll(false,780,800,1000,200,false),true);
});

for(const event of ['done','error'])test(`terminal ${event} releases a response that the server keeps open`,{timeout:2000},async()=>{
 let response,terminalCalls=0,cancelled;
 const released=new Promise(resolve=>{cancelled=resolve;});
 const detail={message:'网关连接提前结束',category:'connection',code:'gateway_stream_interrupted',retryable:true};
 globalThis.fetch=async()=>{
  response=new Response(new ReadableStream({
   start(controller){controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(event==='done'?{}:detail)}\n\n`));},
   cancel(){cancelled();},
  }));
  return response;
 };
 await new Promise(resolve=>streamChat('hi',undefined,'s',()=>assert.fail('no tokens expected'),()=>{terminalCalls++;assert.equal(event,'done');resolve();},error=>{terminalCalls++;assert.equal(event,'error');assert.deepEqual(error.detail,detail);resolve();}));
 await released;
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(terminalCalls,1);
 assert.equal(response.body.locked,false);
});

test('only the exact leading legacy gateway diagnostic is shown as a historical auth error',()=>{
 const diagnostic='gateway agent requires credentials before opening a websocket';
 for(const text of [diagnostic,diagnostic+'\nFix credentials', 'Error: '+diagnostic+'\r\nFix credentials']){
  const error=historicalGatewayAuthError(text);assert.equal(error.category,'authentication');assert.equal(error.historical,true);
 }
});
test('quoted diagnostics, explanatory prose and generic errors remain unchanged',()=>{
 const diagnostic='gateway agent requires credentials before opening a websocket';
 for(const text of ['例如：'+diagnostic,'> '+diagnostic,'```\n'+diagnostic+'\n```','    '+diagnostic,diagnostic+' is a message quoted here','Error: unknown failure'])assert.equal(historicalGatewayAuthError(text),undefined);
});
test('legacy display replacement never includes old diagnostic credentials or timeout guesses',()=>{
 const original='Error: gateway agent requires credentials before opening a websocket\nFix with token AUTH_SECRET_SHOULD_NOT_DISPLAY\n可能超时';
 const result=historicalGatewayAuthError(original);assert.ok(result);assert.ok(!JSON.stringify(result).includes('AUTH_SECRET_SHOULD_NOT_DISPLAY'));assert.ok(!JSON.stringify(result).includes('超时'));assert.ok(original.includes('AUTH_SECRET_SHOULD_NOT_DISPLAY'));
});
