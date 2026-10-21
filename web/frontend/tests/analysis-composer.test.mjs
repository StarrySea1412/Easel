import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './load-ts.mjs';
const {analysisChatMessage,analysisDraftText,defaultAnalysisRequest}=await loadTsModule('../src/lib/analysisComposer.ts',import.meta.url);
const context={kind:'content-analysis',markdown:'# 作品分析\n\n## 真实材料\n```json\n[{"id":"original","body":"完整正文"}]\n```'};
test('analysis keeps material out of the display text while sending the full frozen snapshot',()=>{
 const message=analysisChatMessage(context,'只分析叙事节奏',true);
 assert.equal(message.content,'只分析叙事节奏');
 assert.ok(message.agentContent.includes(context.markdown));assert.match(message.agentContent,/用户本轮要求\n\n只分析叙事节奏/);
 assert.equal(analysisChatMessage(context,'后续追问',false).agentContent,'后续追问');
});
test('exact old analysis drafts receive a readable default, edited drafts and regular chats remain intact',()=>{
 assert.equal(analysisDraftText(context.markdown,context),defaultAnalysisRequest(context));
 const edited=context.markdown+'\n请按新要求执行';
 assert.equal(analysisDraftText(edited,context),edited);
 assert.equal(analysisDraftText(context.markdown),context.markdown);
 assert.deepEqual(analysisChatMessage(undefined,'  一般问题  ',true),{content:'一般问题',agentContent:'一般问题'});
 assert.equal(analysisChatMessage(context,context.markdown,true).agentContent.split(context.markdown).length,2,'legacy JSON is included once');
});
