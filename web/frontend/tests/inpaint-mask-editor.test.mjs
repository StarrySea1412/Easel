import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';
globalThis.window=new Window({url:'https://easel.test/'});globalThis.document=window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const {default:Editor}=await loadTsModule('../src/components/InpaintMaskEditor.tsx',import.meta.url);
const reference={id:'ref-one',url:'/api/imagegen/references/ref-one',name:'参考图.png',width:32,height:20};
async function fixture(t,applyResult=true){
 const images=[],uploads=[];let closed=0;
 t.mock.method(window,'Image',function(){const image={naturalWidth:32,naturalHeight:20,onload:null,onerror:null,src:'',decoding:''};images.push(image);return image;});
 t.mock.method(window.HTMLCanvasElement.prototype,'getContext',function(){return {drawImage(){},clearRect(){},createImageData:(width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4)}),putImageData(){}};});
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
 let resolveUpload;const uploaded=new Promise(resolve=>{resolveUpload=resolve;});
 const props={reference,onClose:()=>closed++,onApply:async file=>{uploads.push(file);resolveUpload();return applyResult;}};
 const render=async patch=>{Object.assign(props,patch);await act(async()=>root.render(createElement(Editor,props)));};await render();
 t.after(async()=>{await act(async()=>root.unmount());container.remove();});
 const button=label=>[...document.querySelectorAll('[role=dialog] button')].find(item=>item.textContent===label);
 const canvas=()=>document.querySelector('.inpaint-mask-drawing');
 const paint=async()=>{canvas().getBoundingClientRect=()=>({left:10,top:20,right:74,bottom:60,width:64,height:40});await act(async()=>{canvas().dispatchEvent(new window.PointerEvent('pointerdown',{clientX:42,clientY:40,pointerId:1,button:0,bubbles:true,cancelable:true}));canvas().dispatchEvent(new window.PointerEvent('pointerup',{pointerId:1,bubbles:true}));});};
 return {images,uploads,uploaded,closed:()=>closed,button,render,paint,load:async()=>act(async()=>images.at(-1).onload()),click:async label=>act(async()=>button(label).click())};
}
test('load, paint, clear and cancel only change the editor draft; empty or failed images cannot be applied',async t=>{
 const v=await fixture(t);assert.equal(v.button('应用修改区域').disabled,true);await v.load();assert.equal(v.button('应用修改区域').disabled,true);
 assert.equal(v.images.at(-1).src,'');assert.equal(v.images.at(-1).onload,null);assert.equal(v.images.at(-1).onerror,null);
 await v.paint();assert.equal(v.button('应用修改区域').disabled,false);await v.click('清空');assert.equal(v.button('应用修改区域').disabled,true);
 await v.paint();await v.click('取消');assert.equal(v.closed(),1);assert.deepEqual(v.uploads,[]);
 await v.render({reference:{...reference,id:'ref-two',url:'/api/imagegen/references/ref-two'}});assert.equal(v.button('应用修改区域').disabled,true);
 await act(async()=>v.images.at(-1).onerror());assert.match(document.querySelector('[role=alert]').textContent,/加载失败/);assert.equal(v.button('应用修改区域').disabled,true);
});
test('apply emits an actual PNG only after explicit action, and closes only on a successful save',async t=>{
 const v=await fixture(t);await v.load();await v.paint();assert.equal(v.uploads.length,0);
 await act(async()=>{v.button('应用修改区域').click();await v.uploaded;});
 assert.equal(v.uploads.length,1);assert.equal(v.uploads[0].type,'image/png');assert.ok(v.uploads[0].size>0);assert.equal(v.closed(),1);
 const bytes=new Uint8Array(await v.uploads[0].arrayBuffer());assert.deepEqual([...bytes.slice(0,8)],[137,80,78,71,13,10,26,10]);
});
test('upload rejection retains the selection for retry and a changed reference clears it',async t=>{
 const v=await fixture(t,false);await v.load();await v.paint();await act(async()=>{v.button('应用修改区域').click();await v.uploaded;});
 assert.equal(v.closed(),0);assert.equal(v.button('应用修改区域').disabled,false);assert.match(document.querySelector('[role=alert]').textContent,/未保存/);
 await v.render({reference:{...reference,id:'ref-two',url:'/api/imagegen/references/ref-two'}});await v.load();assert.equal(v.button('应用修改区域').disabled,true);assert.match(document.querySelector('.inpaint-mask-meta').textContent,/尚未涂抹/);
});
test('unsafe reference sources never load an image and remain unappliable',async t=>{
 const v=await fixture(t);const loads=v.images.length;await v.render({reference:{...reference,url:'https://untrusted.test/picture.png'}});
 assert.equal(v.images.length,loads);assert.equal(v.button('应用修改区域').disabled,true);assert.match(document.querySelector('[role=alert]').textContent,/地址无效/);
});
