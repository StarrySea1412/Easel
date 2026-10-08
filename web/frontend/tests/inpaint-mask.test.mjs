import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { loadTsModule } from './load-ts.mjs';
const {createBinaryMask,maskPoint,paintMaskSegment,fillMaskPreview,encodeMaskPng,maskReferenceUrl}=await loadTsModule('../src/lib/inpaintMask.ts',import.meta.url);

test('pointer geometry uses actual canvas display scale and clamps edges',()=>{
 assert.deepEqual(maskPoint(110,70,{left:10,top:20,width:200,height:100},1600,800),{x:800,y:400});
 assert.deepEqual(maskPoint(-50,500,{left:10,top:20,width:200,height:100},1600,800),{x:0,y:800});
 assert.throws(()=>createBinaryMask(1.5,20),/尺寸/);assert.throws(()=>createBinaryMask(40001,1000),/尺寸/);
});
test('round strokes are continuous, overlap does not duplicate area, and erasing returns to an empty mask',async()=>{
 const mask=createBinaryMask(30,20);paintMaskSegment(mask,{x:3,y:10},{x:27,y:10},2);
 const count=mask.count;assert.ok(count>40);for(let x=3;x<27;x++)assert.equal(mask.pixels[10*30+x],1);
 paintMaskSegment(mask,{x:3,y:10},{x:27,y:10},2);assert.equal(mask.count,count);
 paintMaskSegment(mask,{x:3,y:10},{x:27,y:10},2,true);assert.equal(mask.count,0);assert.equal(mask.pixels.some(Boolean),false);
 await assert.rejects(encodeMaskPng(mask),/先涂抹/);
});
test('PNG has original dimensions and only fully transparent selected pixels or fully opaque protected pixels',async()=>{
 const mask=createBinaryMask(19,11);paintMaskSegment(mask,{x:3,y:3},{x:15,y:8},1.7);
 const preview=new Uint8ClampedArray(19*11*4);fillMaskPreview(mask,preview,19,11);assert.ok(preview.some((n,i)=>i%4===3&&n===125));
 const file=await encodeMaskPng(mask),png=Buffer.from(await file.arrayBuffer());assert.equal(file.type,'image/png');assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10]);
 const idat=[];let width,height;
 for(let offset=8;offset<png.length;){const size=png.readUInt32BE(offset),type=png.toString('ascii',offset+4,offset+8),data=png.subarray(offset+8,offset+8+size);if(type==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);assert.equal(data[8],8);assert.equal(data[9],6);}if(type==='IDAT')idat.push(data);offset+=size+12;}
 assert.equal(width,19);assert.equal(height,11);const decoded=inflateSync(Buffer.concat(idat));
 let transparent=0;for(let y=0;y<height;y++){assert.equal(decoded[y*(width*4+1)],0);for(let x=0;x<width;x++){const alpha=decoded[y*(width*4+1)+1+x*4+3];assert.equal(alpha,mask.pixels[y*width+x]?0:255);if(!alpha)transparent++;}}
 assert.equal(transparent,mask.count);
});
test('only the matching local uploaded reference URL can be loaded',()=>{
 assert.equal(maskReferenceUrl({id:'ref-one',url:'/api/imagegen/references/ref-one'},'https://easel.test'),'https://easel.test/api/imagegen/references/ref-one');
 for(const url of ['https://other.test/api/imagegen/references/ref-one','/api/imagegen/references/other','/api/imagegen/references/ref-one?download=1','javascript:alert(1)'])assert.throws(()=>maskReferenceUrl({id:'ref-one',url},'https://easel.test'));
});
