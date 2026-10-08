import { useEffect, useId, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { ImagegenReference } from '../lib/api';
import { createBinaryMask, encodeMaskPng, fillMaskPreview, maskPoint, maskReferenceUrl, paintMaskSegment, type BinaryMask, type MaskPoint } from '../lib/inpaintMask';
import Select from './ui/Select';
import RadioGroup from './ui/RadioGroup';
import '../styles/inpaint-mask-editor.css';

export default function InpaintMaskEditor({reference,onApply,onClose,disabled=false,uploadError=''}:{
  reference:ImagegenReference;onApply:(file:File)=>Promise<boolean>;onClose:()=>void;disabled?:boolean;uploadError?:string;
}) {
  const [tool,setTool]=useState<'brush'|'eraser'>('brush');
  const [size,setSize]=useState('medium');
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [count,setCount]=useState(0);
  const [saving,setSaving]=useState(false);
  const [previewSize,setPreviewSize]=useState({width:1,height:1});
  const [viewportHeight,setViewportHeight]=useState(window.innerHeight);
  const base=useRef<HTMLCanvasElement>(null),overlay=useRef<HTMLCanvasElement>(null),panel=useRef<HTMLElement>(null),closeButton=useRef<HTMLButtonElement>(null);
  const mask=useRef<BinaryMask|null>(null),preview=useRef<ImageData|null>(null),stroke=useRef<{id:number;last:MaskPoint}|null>(null),frame=useRef<number|undefined>(undefined),generation=useRef(0),savingRef=useRef(false);
  const callbacks=useRef({onClose,onApply});callbacks.current={onClose,onApply};
  const titleId=useId(),descriptionId=useId();
  const referenceId=reference.id,referenceUrl=reference.url,referenceWidth=reference.width,referenceHeight=reference.height;
  const blocked=disabled||saving||loading||!mask.current;
  const renderOverlay=()=>{
    const data=preview.current,current=mask.current,context=overlay.current?.getContext('2d');
    if(!data||!current||!context)return;
    fillMaskPreview(current,data.data,data.width,data.height);context.putImageData(data,0,0);
  };
  const schedulePreview=()=>{if(frame.current!==undefined)return;frame.current=window.requestAnimationFrame(()=>{frame.current=undefined;renderOverlay();});};
  useEffect(()=>{
    const current=++generation.current;
    const pendingFrame=frame;
    setLoading(true);setError('');setCount(0);setSaving(false);savingRef.current=false;mask.current=null;preview.current=null;stroke.current=null;
    let image:HTMLImageElement|undefined;
    const releaseImage=()=>{if(image){image.onload=null;image.onerror=null;image.src='';image=undefined;}};
    try {
      const source=maskReferenceUrl({id:referenceId,url:referenceUrl},window.location.origin);
      const initial=createBinaryMask(referenceWidth,referenceHeight);
      image=new window.Image();image.decoding='async';
      image.onload=()=>{
        if(current!==generation.current||!image)return;
        try {
          if(image.naturalWidth!==referenceWidth||image.naturalHeight!==referenceHeight)throw new Error('参考图尺寸已变化，请重新选择参考图。');
          const ratio=Math.min(1,1200/referenceWidth,900/referenceHeight),width=Math.max(1,Math.round(referenceWidth*ratio)),height=Math.max(1,Math.round(referenceHeight*ratio));
          if(!base.current||!overlay.current)return;
          base.current.width=width;base.current.height=height;overlay.current.width=width;overlay.current.height=height;
          const background=base.current.getContext('2d'),selection=overlay.current.getContext('2d');
          if(!background||!selection)throw new Error('当前浏览器无法使用画布，请改为上传 PNG 蒙版。');
          background.drawImage(image!,0,0,width,height);selection.clearRect(0,0,width,height);
          mask.current=initial;preview.current=selection.createImageData(width,height);setPreviewSize({width,height});setLoading(false);
        }catch(cause){setError(cause instanceof Error?cause.message:'参考图读取失败。');setLoading(false);}
        finally{releaseImage();}
      };
      image.onerror=()=>{if(current===generation.current){setError('参考图加载失败，请关闭后重试或重新上传参考图。');setLoading(false);}releaseImage();};
      image.src=source;
    }catch(cause){setError(cause instanceof Error?cause.message:'参考图读取失败。');setLoading(false);}
    return()=>{generation.current=current+1;releaseImage();mask.current=null;preview.current=null;stroke.current=null;if(pendingFrame.current!==undefined)window.cancelAnimationFrame(pendingFrame.current);pendingFrame.current=undefined;};
  },[referenceId,referenceUrl,referenceWidth,referenceHeight]);
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;closeButton.current?.focus({preventScroll:true});
    const resize=()=>setViewportHeight(window.innerHeight);
    const keydown=(event:KeyboardEvent)=>{
      const target=event.target as HTMLElement|null;
      if(event.key==='Escape'&&target?.getAttribute('role')==='combobox'&&target.getAttribute('aria-expanded')==='true')return;
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(!savingRef.current)callbacks.current.onClose();return;}
      if(event.key!=='Tab')return;
      const elements=Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"]), [tabindex="0"]')||[]),first=elements[0],last=elements.at(-1);
      if(!first){event.preventDefault();panel.current?.focus();return;}
      if(event.shiftKey&&(document.activeElement===first||!panel.current?.contains(document.activeElement))){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&(document.activeElement===last||!panel.current?.contains(document.activeElement))){event.preventDefault();first.focus();}
    };
    document.addEventListener('keydown',keydown,true);window.addEventListener('resize',resize);
    return()=>{document.removeEventListener('keydown',keydown,true);window.removeEventListener('resize',resize);if(previous?.isConnected)previous.focus({preventScroll:true});};
  },[]);
  const endStroke=()=>{const active=stroke.current;stroke.current=null;if(active&&overlay.current?.hasPointerCapture?.(active.id))overlay.current.releasePointerCapture(active.id);};
  const paint=(event:PointerEvent<HTMLCanvasElement>,start=false)=>{
    const current=mask.current;
    if(blocked||savingRef.current||!current)return;
    if(start&&(event.button!==0||stroke.current))return;
    if(!start&&stroke.current?.id!==event.pointerId)return;
    const rect=event.currentTarget.getBoundingClientRect();
    if(rect.width<=0||rect.height<=0)return;
    if(!start&&(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)){endStroke();return;}
    event.preventDefault();
    const point=maskPoint(event.clientX,event.clientY,rect,current.width,current.height);
    if(start){event.currentTarget.setPointerCapture?.(event.pointerId);stroke.current={id:event.pointerId,last:point};}
    const diameter=Math.max(2,Math.min(current.width,current.height)*({small:.02,medium:.05,large:.1}[size]||.05));
    paintMaskSegment(current,stroke.current!.last,point,diameter/2,tool==='eraser');stroke.current!.last=point;setCount(current.count);schedulePreview();
  };
  const clear=()=>{if(blocked||!mask.current)return;endStroke();mask.current.pixels.fill(0);mask.current.count=0;setCount(0);schedulePreview();setError('');};
  const apply=async()=>{
    if(blocked||savingRef.current||!mask.current?.count)return;
    endStroke();savingRef.current=true;setSaving(true);setError('');const current=generation.current;
    try {
      const png=await encodeMaskPng(mask.current);
      if(current!==generation.current)return;
      const ok=await callbacks.current.onApply(new File([png],`${reference.id}-mask.png`,{type:'image/png'}));
      if(current!==generation.current)return;
      if(ok)callbacks.current.onClose();else setError('蒙版未保存，请检查上传提示后重试。');
    }catch(cause){if(current===generation.current)setError(cause instanceof Error?cause.message:'蒙版保存失败，请重试。');}
    finally{if(current===generation.current){savingRef.current=false;setSaving(false);}}
  };
  const displayWidth=Math.min(previewSize.width,viewportHeight*.52*previewSize.width/previewSize.height);
  return createPortal(<div className="inpaint-mask-overlay"><section className="inpaint-mask-editor" ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}>
    <header><div><p>局部修改</p><h2 id={titleId}>涂出你想修改的地方</h2></div><button type="button" ref={closeButton} className="icon-btn" aria-label="取消绘制并关闭" disabled={saving} onClick={onClose}>×</button></header>
    <p className="inpaint-mask-intro" id={descriptionId}>粉色区域用于指定修改位置。应用后，填写修改描述并生成；服务需支持局部编辑。</p>
    <div className="inpaint-mask-tools"><RadioGroup aria-label="绘制工具" value={tool} onChange={value=>{endStroke();setTool(value);}} disabled={blocked} options={[{value:'brush',label:'画笔'},{value:'eraser',label:'橡皮'}]}/><label>笔刷大小<Select aria-label="笔刷大小" value={size} onChange={value=>{endStroke();setSize(value);}} disabled={blocked} options={[{value:'small',label:'细'},{value:'medium',label:'标准'},{value:'large',label:'宽'}]}/></label><button type="button" className="btn btn-sm" disabled={blocked||!count} onClick={clear}>清空</button></div>
    <div className="inpaint-mask-stage" aria-busy={loading}><div className="inpaint-mask-canvas-stack" style={{width:displayWidth,visibility:loading||!mask.current?'hidden':'visible'}}><canvas ref={base} aria-hidden="true"/><canvas ref={overlay} className={`inpaint-mask-drawing ${tool==='eraser'?'is-eraser':''}`} aria-label="涂抹需要修改的区域" onPointerDown={event=>paint(event,true)} onPointerMove={event=>paint(event)} onPointerUp={endStroke} onPointerCancel={endStroke} onLostPointerCapture={endStroke} onPointerLeave={endStroke}/></div>{loading&&<p role="status">正在读取参考图…</p>}</div>
    <div className="inpaint-mask-meta"><span>{reference.name} · {reference.width} × {reference.height}</span><span role="status">{count?'已选择修改区域':'尚未涂抹'}</span></div>
    {(error||uploadError)&&<p className="inpaint-mask-error" role="alert">{uploadError||error}</p>}
    <footer><p>应用会替换已有蒙版；取消保留原草稿。</p><div><button type="button" className="btn" disabled={saving} onClick={onClose}>取消</button><button type="button" className="btn btn-primary" disabled={blocked||!count} onClick={()=>void apply()}>{saving?'正在保存…':'应用修改区域'}</button></div></footer>
  </section></div>,document.body);
}
