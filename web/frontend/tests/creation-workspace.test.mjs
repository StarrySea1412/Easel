import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new Window({url:'https://easel.test/work/'});
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
globalThis.CustomEvent = window.CustomEvent;
const workspace = await loadTsModule('../src/lib/creationWorkspace.ts',import.meta.url);
const drafts = await loadTsModule('../src/lib/chatDrafts.ts',import.meta.url);
const visuals = await loadTsModule('../src/lib/analysisVisuals.ts',import.meta.url);

test('workspace slots detach only their own view and persist the source selection',()=>{
  const image=workspace.ensureCreation('image','source-a');
  const first=document.createElement('div'), second=document.createElement('div');
  const removeFirst=workspace.registerCreationSlot('image','source-a',first);
  const removeSecond=workspace.registerCreationSlot('image','source-a',second);
  removeFirst(); assert.equal(workspace.creationSlot(image.id),second);
  removeSecond(); assert.equal(workspace.creationSlot(image.id),undefined);
  assert.equal(workspace.currentCreation('image').sessionId,'source-a');
  const index=JSON.parse(localStorage.getItem('easel:creation-workspaces:v1'));
  assert.equal(index.focus.image,image.id);
});

test('publish drafts and returned quotes are isolated and never replace existing chat text',()=>{
  const a=workspace.ensureCreation('publish','a'),b=workspace.ensureCreation('publish','b');
  workspace.saveCreationDraft(a,{title:'标题',body:'正文',platforms:['zhihu'],tags:'',overrides:{},media:[]});
  assert.equal(workspace.readCreationDraft(a).body,'正文');
  assert.equal(workspace.readCreationDraft(b).body,'');
  drafts.setChatDraftText('a','保留原输入');
  workspace.returnCreationQuote('a','发布草稿');workspace.returnCreationQuote('a','发布草稿');
  assert.equal(drafts.getChatDraft('a').text,'保留原输入');
  assert.deepEqual(drafts.getChatDraft('a').quotes,['发布草稿']);
  assert.equal(drafts.getChatDraft('b').quotes,undefined);
});

test('deleted source cannot be selected or resurrected by a late return',async()=>{
  const source='removed'; workspace.ensureCreation('image',source);
  drafts.setChatDraftText(source,'将被删除');
  workspace.creationSessionDeleted(source);
  assert.equal(workspace.canReturnToSession(source),false);
  assert.throws(()=>workspace.selectCreation('image',source));
  assert.throws(()=>workspace.returnCreationQuote(source,'late'));
  await assert.rejects(workspace.returnImageToChat(source,'/work/api/media/a.png'));
  assert.equal(drafts.getChatDraft(source).text,'');
  assert.ok(!workspace.creationWorkspaces().some(item=>item.sessionId===source));
});

test('image to publishing preserves draft, deduplicates images and rejects foreign media',()=>{
  const a=workspace.ensureCreation('publish','a');
  workspace.addImageToPublish('a','/work/api/media/gallery/one.png');
  workspace.addImageToPublish('a','/work/api/media/gallery/one.png');
  assert.deepEqual(workspace.readCreationDraft(a).media,['gallery/one.png']);
  assert.equal(workspace.readCreationDraft(a).body,'正文');
  assert.throws(()=>workspace.addImageToPublish('a','https://other.test/api/media/a.png'));
  assert.throws(()=>workspace.addImageToPublish('a','/work/api/media/a.html'));
});

test('receipt uses durable origin before a legacy optional local index',()=>{
  workspace.bindCreationReceipt('receipt','legacy');
  assert.equal(workspace.creationReceiptSession({receiptId:'receipt',sourceSessionId:'durable'}),'durable');
});

test('notification opens the tool after navigation and a target survives workspace restoration',()=>{
  workspace.requestCreationPanel('publish','origin','选中的正文');
  assert.equal(workspace.takeCreationPanel('another'),null);
  assert.equal(workspace.takeCreationPanel('origin'),'publish');
  assert.equal(workspace.takeCreationPanel('origin'),null);
  const own=workspace.ensureCreation('publish','origin');
  assert.equal(workspace.creationMaterial(own),'选中的正文');
  assert.equal(workspace.creationMaterial(workspace.ensureCreation('publish','another')),'');
  workspace.saveCreationTarget(own,'target');
  assert.equal(workspace.creationTarget(own),'target');
  workspace.creationSessionDeleted('target');
  assert.equal(workspace.creationTarget(own),'origin');
});

test('malformed frozen fields cannot crash cards or adopt unrelated JSON',()=>{
  const fence=String.fromCharCode(96).repeat(3);
  const rows=[{id:'own',title:'作品',body:{bad:true},transcript:42,metrics:{views:0,likes:'bad',comments:null}}];
  const json=fence+'json\n'+JSON.stringify(rows)+'\n'+fence;
  assert.deepEqual(visuals.frozenEvidence(json,['own']),[]);
  const [item]=visuals.frozenEvidence('## 真实材料\n'+json,['own']);
  assert.equal(item.body,undefined);assert.equal(item.transcript,undefined);
  assert.deepEqual(item.metrics,{views:0,comments:null});
});

test('metric parsing keeps zero and missing values distinct',()=>{
  assert.equal(visuals.numericMetric('1.2万'),12000);assert.equal(visuals.numericMetric('0'),0);
  assert.equal(visuals.numericMetric('—'),null);assert.equal(visuals.numericMetric('未知'),null);
  assert.equal(visuals.numericMetric(Infinity),null);
  assert.deepEqual(visuals.metricData([{label:'零',value:0},{label:'缺',value:null}]),[{label:'零',value:0,display:'0'}]);
});

test('frozen material never adopts another account current contents',()=>{
  const md='## 真实材料\n'+String.fromCharCode(96).repeat(3)+'json\n'+JSON.stringify([{id:'own',title:'本轮'},{id:'other',title:'其他'}])+'\n'+String.fromCharCode(96).repeat(3);
  assert.deepEqual(visuals.frozenEvidence(md,['own']).map(item=>item.id),['own']);
  assert.deepEqual(visuals.frozenEvidence('bad json',['own']),[]);
});

test('image return uploads into the fixed target, deduplicates clicks and preserves input',async t=>{
  const calls=[];
  drafts.setChatDraftText('image-target','保留这段正文');
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls.push({url:String(url),options});
    if(String(url).includes('/api/media/')) return new Response(new Blob(['image'],{type:'image/png'}));
    assert.equal(options.body.get('sessionId'),'image-target');
    return new Response(JSON.stringify({ok:true,files:[{name:'cover.png',path:'inbox/image-target/cover.png',size:5,type:'image/png'}]}),{headers:{'Content-Type':'application/json'}});
  });
  const one=workspace.returnImageToChat('image-target','/work/api/media/cover.png');
  const two=workspace.returnImageToChat('image-target','/work/api/media/cover.png');
  assert.equal(one,two);await one;
  await workspace.returnImageToChat('image-target','/work/api/media/cover.png');
  assert.equal(calls.length,2);
  assert.equal(drafts.getChatDraft('image-target').text,'保留这段正文');
  assert.equal(drafts.getChatDraft('image-target').attachments.length,1);
  assert.equal(drafts.getChatDraft('other-target').attachments.length,0);
  assert.equal(drafts.getChatDraft('image-target').uploading,false);
});

test('deleting the target during image retrieval prevents late uploads and draft resurrection',async t=>{
  let complete;
  t.mock.method(globalThis,'fetch',()=>new Promise(resolve=>{complete=resolve;}));
  const transfer=workspace.returnImageToChat('late-image-target','/work/api/media/late.png');
  workspace.creationSessionDeleted('late-image-target');
  complete(new Response(new Blob(['image'],{type:'image/png'})));
  await assert.rejects(transfer);
  assert.equal(drafts.getChatDraft('late-image-target').attachments.length,0);
  assert.equal(drafts.getChatDraft('late-image-target').uploading,false);
});

test('generated documents use the fixed target upload channel and retain the existing draft',async t=>{
  const calls=[];
  drafts.setChatDraftText('document-target','已有正文');
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls.push(String(url));
    if(!options) return new Response(new Blob(['# report'],{type:'text/markdown'}));
    assert.equal(options.body.get('sessionId'),'document-target');
    assert.equal(options.body.getAll('files')[0].name,'report.md');
    return new Response(JSON.stringify({ok:true,files:[{name:'report.md',path:'inbox/document-target/report.md',size:8,type:'text/markdown'}]}));
  });
  await workspace.returnGeneratedFileToChat('document-target','project/report.md');
  await workspace.returnGeneratedFileToChat('document-target','project/report.md');
  assert.equal(calls.length,2);
  assert.equal(drafts.getChatDraft('document-target').text,'已有正文');
  assert.equal(drafts.getChatDraft('document-target').attachments.length,1);
  await assert.rejects(workspace.returnGeneratedFileToChat('document-target','../private'));
  await assert.rejects(workspace.returnGeneratedFileToChat('document-target','https://other.test/file'));
});

test('prepared publishing drafts reject malformed fields before they reach the editor',async()=>{
  const {decodeCreationDrafts}=await loadTsModule('../src/lib/chatArtifacts.ts',import.meta.url);
  const row={id:'a'.repeat(32),sessionId:'draft-owner',turnId:'turn',createdAt:1,state:'prepared',draft:{title:'标题',body:'正文',tags:'',platforms:['zhihu'],media:[],overrides:{}}};
  assert.equal(decodeCreationDrafts([row],'draft-owner').length,1);
  assert.deepEqual(decodeCreationDrafts([row],'another-owner'),[]);
  for(const changes of [{tags:{}},{platforms:[{}]},{media:[42]},{overrides:[]},{overrides:{zhihu:{}}}])assert.deepEqual(decodeCreationDrafts([{...row,draft:{...row.draft,...changes}}],'draft-owner'),[]);
});
