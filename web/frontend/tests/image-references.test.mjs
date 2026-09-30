import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTsModule} from './load-ts.mjs';
const compile=(path)=>loadTsModule(path,import.meta.url);
const {validateReferenceFile,restoreReference,validateMaskFile}=await compile('../src/lib/imageReferences.ts');
globalThis.window={location:{pathname:'/'}};
const {startImagegen,uploadImagegenReference}=await compile('../src/lib/api.ts');
test('reference validation rejects unsupported, oversized and empty uploads',()=>{
  assert.doesNotThrow(()=>validateReferenceFile({type:'image/webp',size:100}));
  for(const file of [{type:'image/svg+xml',size:100},{type:'image/png',size:0},{type:'image/jpeg',size:10*1024*1024+1}]) assert.throws(()=>validateReferenceFile(file));
  assert.throws(()=>validateReferenceFile({type:'image/jpeg',size:100},true));
});
test('draft restores only a local backend reference with known dimensions',()=>{
  const ref={id:'abc',url:'/api/imagegen/references/abc',name:'source.png',width:32,height:32};
  assert.deepEqual(restoreReference(ref),ref);
  assert.equal(restoreReference({...ref,url:'https://external.invalid/image.png'}),null);
  assert.equal(restoreReference({...ref,width:0}),null);
});
test('mask validation enforces matching dimensions and actual transparent pixels',async()=>{
  let alpha=255,closed=0;
  globalThis.createImageBitmap=async()=>({width:1,height:1,close(){closed++;}});
  globalThis.document={createElement:()=>({getContext:()=>({drawImage(){},getImageData:()=>({data:new Uint8ClampedArray([0,0,0,alpha])})})})};
  const file={type:'image/png',size:10},ref={width:1,height:1};
  await assert.rejects(validateMaskFile(file,{width:2,height:1}),/同尺寸/);
  await assert.rejects(validateMaskFile(file,ref),/透明区域/);
  alpha=0;await validateMaskFile(file,ref);assert.equal(closed,3);
});
test('image editing sends reference IDs and auto size while upload stays multipart',async()=>{
  const calls=[];globalThis.fetch=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({jobId:'job'}),{headers:{'Content-Type':'application/json'}});};
  await startImagegen('修改背景','auto',1,{mode:'img2img',referenceId:'reference',maskId:'mask'});
  assert.deepEqual(JSON.parse(calls[0].options.body),{prompt:'修改背景',size:'auto',n:1,mode:'img2img',referenceId:'reference',maskId:'mask'});
  await uploadImagegenReference(new File(['sample'],'image.png',{type:'image/png'}));
  assert.ok(calls[1].options.body instanceof FormData);assert.equal(calls[1].options.body.get('file').name,'image.png');
});
