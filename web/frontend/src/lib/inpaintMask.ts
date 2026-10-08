export interface MaskPoint { x:number; y:number }
export interface BinaryMask { width:number; height:number; pixels:Uint8Array; count:number }

export function createBinaryMask(width:number,height:number):BinaryMask {
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width*height>40_000_000)throw new Error('参考图尺寸无效或超过 4000 万像素。');
  return {width,height,pixels:new Uint8Array(width*height),count:0};
}
export function maskPoint(clientX:number,clientY:number,rect:{left:number;top:number;width:number;height:number},width:number,height:number):MaskPoint {
  if(rect.width<=0||rect.height<=0)throw new Error('画布尚未显示。');
  return {x:Math.max(0,Math.min(width,(clientX-rect.left)*width/rect.width)),y:Math.max(0,Math.min(height,(clientY-rect.top)*height/rect.height))};
}
/** Rasterize a round capsule into a one-byte binary selection; no antialiased alpha. */
export function paintMaskSegment(mask:BinaryMask,from:MaskPoint,to:MaskPoint,radius:number,erase=false):void {
  if(![from.x,from.y,to.x,to.y,radius].every(Number.isFinite)||radius<=0)return;
  const dx=to.x-from.x,dy=to.y-from.y,length2=dx*dx+dy*dy,r2=radius*radius;
  const minY=Math.max(0,Math.floor(Math.min(from.y,to.y)-radius)),maxY=Math.min(mask.height-1,Math.ceil(Math.max(from.y,to.y)+radius));
  for(let y=minY;y<=maxY;y++) {
    const cy=y+.5;
    // Restrict each row to the stroke band rather than scanning a diagonal's entire box.
    let low=0,high=1;
    if(dy){const a=(cy-radius-from.y)/dy,b=(cy+radius-from.y)/dy;low=Math.max(0,Math.min(a,b));high=Math.min(1,Math.max(a,b));if(low>high)continue;}
    const minX=Math.max(0,Math.floor(Math.min(from.x+dx*low,from.x+dx*high)-radius)),maxX=Math.min(mask.width-1,Math.ceil(Math.max(from.x+dx*low,from.x+dx*high)+radius));
    for(let x=minX;x<=maxX;x++) {
      const cx=x+.5,t=length2?Math.max(0,Math.min(1,((cx-from.x)*dx+(cy-from.y)*dy)/length2)):0;
      if((cx-from.x-dx*t)**2+(cy-from.y-dy*t)**2>r2)continue;
      const index=y*mask.width+x,next=erase?0:1;
      if(mask.pixels[index]!==next){mask.count+=next?1:-1;mask.pixels[index]=next;}
    }
  }
}
export function fillMaskPreview(mask:BinaryMask,target:Uint8ClampedArray,width:number,height:number):void {
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const index=(y*width+x)*4;
    const source=Math.min(mask.height-1,Math.floor((y+.5)*mask.height/height))*mask.width+Math.min(mask.width-1,Math.floor((x+.5)*mask.width/width));
    target[index]=238;target[index+1]=82;target[index+2]=123;target[index+3]=mask.pixels[source]?125:0;
  }
}
export function maskReferenceUrl(reference:{id:string;url:string},origin:string):string {
  const url=new URL(reference.url,origin);
  if(!/^[A-Za-z0-9_-]{1,160}$/.test(reference.id)||url.origin!==origin||url.pathname!==`/api/imagegen/references/${reference.id}`||url.search||url.hash||url.username||url.password)throw new Error('参考图地址无效，请重新选择已上传的参考图。');
  return url.href;
}

const CRC_TABLE=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function pngChunk(type:string,bytes:Uint8Array):Uint8Array<ArrayBuffer> {
  const chunk=new Uint8Array(bytes.length+12),view=new DataView(chunk.buffer);view.setUint32(0,bytes.length);
  for(let i=0;i<4;i++)chunk[4+i]=type.charCodeAt(i);chunk.set(bytes,8);
  let crc=0xffffffff;for(let i=4;i<chunk.length-4;i++)crc=CRC_TABLE[(crc^chunk[i])&255]^(crc>>>8);
  view.setUint32(chunk.length-4,(crc^0xffffffff)>>>0);return chunk;
}
/** Stream scanlines to PNG: selected pixels are alpha 0, all other pixels alpha 255. */
export async function encodeMaskPng(mask:BinaryMask):Promise<Blob> {
  if(!mask.count)throw new Error('请先涂抹需要修改的区域。');
  if(typeof CompressionStream!=='function')throw new Error('当前浏览器不支持保存蒙版，请更新浏览器后重试。');
  const compressor=new CompressionStream('deflate'),writer=compressor.writable.getWriter();
  const compressed=new Response(compressor.readable).arrayBuffer();
  try {
    for(let y=0;y<mask.height;y++) {
      const row=new Uint8Array(mask.width*4+1);row.fill(255);row[0]=0;
      for(let x=0;x<mask.width;x++)row[1+x*4+3]=mask.pixels[y*mask.width+x]?0:255;
      await writer.write(row);
    }
    await writer.close();
  } catch(error){await writer.abort(error).catch(()=>{});await compressed.catch(()=>{});throw error;}
  const header=new Uint8Array(13),view=new DataView(header.buffer);view.setUint32(0,mask.width);view.setUint32(4,mask.height);header[8]=8;header[9]=6;
  return new Blob([new Uint8Array([137,80,78,71,13,10,26,10]),pngChunk('IHDR',header),pngChunk('IDAT',new Uint8Array(await compressed)),pngChunk('IEND',new Uint8Array())],{type:'image/png'});
}
