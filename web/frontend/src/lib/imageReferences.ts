import type { ImagegenReference } from './api';
export const REFERENCE_MAX_BYTES = 10 * 1024 * 1024;
export function validateReferenceFile(file: Pick<File, 'type'|'size'>, mask = false): void {
  if (!file.size || file.size > REFERENCE_MAX_BYTES) throw new Error('图片必须非空且不超过 10 MB。');
  if (!(mask ? ['image/png'] : ['image/png','image/jpeg','image/webp']).includes(file.type)) throw new Error(mask ? '蒙版必须为含透明区域的 PNG 图片。' : '参考图仅支持 PNG、JPEG 或 WebP。');
}
export function restoreReference(value: unknown): ImagegenReference | null {
  if(!value || typeof value !== 'object') return null;
  const item = value as Partial<ImagegenReference>;
  return typeof item.id === 'string' && item.id.length > 0 && typeof item.url === 'string'
    && item.url.startsWith('/api/imagegen/references/') && typeof item.name === 'string'
    && typeof item.width === 'number' && item.width > 0 && typeof item.height === 'number' && item.height > 0 ? item as ImagegenReference : null;
}
export async function validateMaskFile(file: File, reference: ImagegenReference): Promise<void> {
  validateReferenceFile(file, true);
  const bitmap = await createImageBitmap(file);
  let canvas: HTMLCanvasElement | null = null;
  try {
    if(bitmap.width !== reference.width || bitmap.height !== reference.height) throw new Error(`蒙版必须与参考图同尺寸：${reference.width} × ${reference.height}。`);
    canvas = document.createElement('canvas');canvas.width=Math.min(1024,bitmap.width);canvas.height=Math.min(1024,bitmap.height);
    const context=canvas.getContext('2d', {willReadFrequently:true});if(!context)throw new Error('无法校验蒙版，请换用支持 Canvas 的浏览器。');
    // Keep readback buffers bounded instead of allocating full-size RGBA copies.
    for(let y=0;y<bitmap.height;y+=1024)for(let x=0;x<bitmap.width;x+=1024){
      const width=Math.min(1024,bitmap.width-x),height=Math.min(1024,bitmap.height-y);
      context.clearRect(0,0,canvas.width,canvas.height);
      context.drawImage(bitmap,x,y,width,height,0,0,width,height);
      const pixels=context.getImageData(0,0,width,height).data;
      for(let i=3;i<pixels.length;i+=4)if(pixels[i]===0)return;
    }
    throw new Error('蒙版没有完全透明区域。请将需要编辑的区域设为透明。');
  } finally {bitmap.close();if(canvas){canvas.width=0;canvas.height=0;}}
}
