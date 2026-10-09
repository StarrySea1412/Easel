import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { showToast } from '../lib/toast';
import { getChatQueue, subscribeChatQueue, removeQueuedMessage, moveQueuedMessage, resumeChatQueue, pauseChatQueue, attachQueuedFiles } from '../lib/chatQueue';
import { uploadFiles } from '../lib/api';
import { IconEdit, IconTrash } from './icons';

function QueueGripIcon() {
  return <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor" aria-hidden="true">{[3,7,11].map(y=><g key={y}><circle cx="4" cy={y} r="1"/><circle cx="8" cy={y} r="1"/></g>)}</svg>;
}

export default function ChatQueueTray({ sessionId, editingId, onEdit, onSteer, stopping = false }: { sessionId: string; editingId?: string; onEdit: (id: string, text: string) => void; onSteer?: (id: string) => Promise<boolean>; stopping?: boolean }) {
  const queue = useSyncExternalStore(subscribeChatQueue, () => getChatQueue(sessionId));
  const [error,setError]=useState(''),[uploading,setUploading]=useState<string|null>(null);
  const dragged = useRef<string | null>(null);
  const tray = useRef<HTMLElement>(null);
  const touchTarget = useRef<string | null>(null);
  const [steering, setSteering] = useState<string | null>(null);
  const steeringLock = useRef(false);
  const [dragTarget, setDragTarget] = useState<string | null>(null);
  const [dragVisual, setDragVisual] = useState<{ id: string; left: number; top: number; width: number; startX: number; startY: number; offsetX: number; offset: number } | null>(null);
  const rowPositions = useRef(new Map<string, number>());
  const rowOrder = useRef<string[]>([]);
  useLayoutEffect(() => {
    const next = new Map<string, number>();
    const sameRows = queue.items.length === rowPositions.current.size && queue.items.every(item => rowPositions.current.has(item.id));
    const reordered = sameRows && queue.items.some((item, index) => rowOrder.current[index] !== item.id);
    tray.current?.querySelectorAll<HTMLElement>('[data-queue-id]').forEach(row => {
      const id = row.dataset.queueId!, top = row.getBoundingClientRect().top, before = rowPositions.current.get(id);
      next.set(id, top);
      if (reordered && before !== undefined && Math.abs(before - top) > 1 && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
        row.animate?.([{ transform: `translateY(${before - top}px)` }, { transform: 'translateY(0)' }], { duration: 180, easing: 'ease-out' });
    });
    rowPositions.current = next;
    rowOrder.current = queue.items.map(item => item.id);
  }, [queue.items]);
  const [hint, setHint] = useState<{ anchor: HTMLButtonElement; itemId: string } | null>(null);
  const [hintPosition, setHintPosition] = useState({ left: 12, top: 12 });
  const hintPanel = useRef<HTMLDivElement>(null), hintId = useId();
  useLayoutEffect(() => {
    if (!hint) return;
    const place = () => {
      const rect = hint.anchor.getBoundingClientRect(), width = hintPanel.current?.offsetWidth || 240, height = hintPanel.current?.offsetHeight || 46;
      setHintPosition({ left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)), top: Math.max(12, rect.top - height - 8) });
    };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
    if (hintPanel.current) observer?.observe(hintPanel.current);
    observer?.observe(hint.anchor);
    return () => { observer?.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [hint]);
  const reorder = (target: string) => {
    const current = getChatQueue(sessionId).items;
    const from = current.findIndex(item => item.id === dragged.current), to = current.findIndex(item => item.id === target);
    if (from >= 0 && to >= 0 && from !== to) {
      const saved = moveQueuedMessage(sessionId, current[from].id, to - from);
      commit(saved); showToast(saved ? '已调整消息顺序' : '消息顺序未能保存，请保留当前页面。', saved ? 'success' : 'error');
    }
    dragged.current = null; setDragTarget(null);
    setDragVisual(null);
  };
  const commit=(accepted:boolean)=>{setError(accepted?'':'更改未保存，请检查浏览器存储或输入内容。');return accepted;};
  const edit=(id:string,value:string)=>{pauseChatQueue(sessionId);onEdit(id,value);};
  const toggle=()=>queue.paused?commit(resumeChatQueue(sessionId)):pauseChatQueue(sessionId);
  const dragItem = queue.items.find(item => item.id === dragVisual?.id);
  if(!queue.items.length&&!queue.error)return null;
  return <section ref={tray} className="chat-queue is-compact" aria-label="待发送消息">
    {dragVisual && dragItem && createPortal(<div className="chat-queue-row chat-queue-drag-preview" aria-hidden="true" style={{ left: dragVisual.left + dragVisual.offsetX, top: dragVisual.top, width: dragVisual.width, transform: `translateY(${dragVisual.offset}px)` }}>
      <span className="chat-queue-grip"><QueueGripIcon/></span><span className="chat-queue-text">{dragItem.text || '素材消息'}{(dragItem.attachments.length || dragItem.missingAttachments.length) > 0 && <small> · {dragItem.attachments.length + dragItem.missingAttachments.length} 份素材{dragItem.missingAttachments.length ? '需重新添加' : ''}</small>}</span>{queue.paused && queue.items[0].id === dragItem.id && <span className="chat-queue-paused">已暂停</span>}<span className="chat-queue-actions"><span className="chat-queue-steer">↪ 引导</span><span className="chat-queue-remove"><IconTrash size={13}/></span><span>•••</span></span>
    </div>, document.body)}
    {hint && queue.items.some(item => item.id === hint.itemId) && createPortal(<div ref={hintPanel} id={hintId} role="tooltip" className="chat-queue-steer-hint" style={hintPosition}>停止当前生成，按此消息继续<br/><small>保留已生成内容，其他队列保持暂停</small></div>, document.body)}
    <ol>{queue.items.map((item,index)=><li data-queue-id={item.id} className={`chat-queue-row ${editingId===item.id?'is-editing':''} ${dragTarget===item.id?'is-drop-target':''} ${dragVisual?.id===item.id?'is-drag-placeholder':''}`} key={item.id}
      onDragOver={event => { if (!dragged.current) return; event.preventDefault(); setDragTarget(item.id); }} onDrop={event => { if (!dragged.current) return; event.preventDefault(); reorder(item.id); }}>
      <button type="button" className="chat-queue-grip" draggable={false} aria-label={`拖动第 ${index+1} 条消息调整顺序`} title="拖动排序，或用上下方向键移动"
        onDragStart={event => { dragged.current = item.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/easel-queue', item.id); }} onDragEnd={() => { dragged.current = null; setDragTarget(null); }}
        onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); const offset = event.key === 'ArrowUp' ? -1 : 1; if (index + offset >= 0 && index + offset < queue.items.length) { const saved = moveQueuedMessage(sessionId, item.id, offset); commit(saved); showToast(saved ? '已调整消息顺序' : '消息顺序未能保存。', saved ? 'success' : 'error'); } } }}
        onPointerDown={event => { if (event.button === 0) { dragged.current = item.id; touchTarget.current = item.id; setHint(null); const rect=event.currentTarget.closest('li')!.getBoundingClientRect(); setDragVisual({ id:item.id,left:rect.left,top:rect.top,width:rect.width,startX:event.clientX,startY:event.clientY,offsetX:0,offset:0 }); event.currentTarget.setPointerCapture(event.pointerId); } }}
        onPointerMove={event => { if (dragged.current) { setDragVisual(current=>current?{...current,offsetX:event.clientX-current.startX,offset:event.clientY-current.startY}:null); const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-queue-id]'); touchTarget.current = row && tray.current?.contains(row) ? row.dataset.queueId || null : null; setDragTarget(touchTarget.current); } }}
        onPointerUp={() => { if (dragged.current) reorder(touchTarget.current || item.id); }} onPointerCancel={() => { dragged.current = null; touchTarget.current = null; setDragTarget(null); setDragVisual(null); }}>
        <QueueGripIcon/>
      </button>
      <button type="button" className="chat-queue-text" title={item.text||'素材消息'} onClick={()=>edit(item.id,item.text)}>{item.text||'素材消息'}{(item.attachments.length||item.missingAttachments.length)>0&&<small> · {item.attachments.length+item.missingAttachments.length} 份素材{item.missingAttachments.length?'需重新添加':''}</small>}</button>
      {queue.paused&&index===0&&<span className="chat-queue-paused">已暂停</span>}
      <div className="chat-queue-actions">
        <button type="button" className="chat-queue-steer" aria-disabled={stopping || !!steering || !!editingId || !!item.missingAttachments.length || !onSteer} aria-describedby={hint?.itemId === item.id ? hintId : undefined} aria-label={`引导第 ${index+1} 条消息`} onPointerEnter={event => { if (event.pointerType !== 'touch') setHint({ anchor: event.currentTarget, itemId: item.id }); }} onPointerLeave={() => setHint(null)} onFocus={event => setHint({ anchor: event.currentTarget, itemId: item.id })} onBlur={() => setHint(null)} onKeyDown={event => { if (event.key === 'Escape') setHint(null); }} onClick={async () => {
          setHint(null);
          if (steeringLock.current || stopping) { showToast('正在等待停止确认，请稍候。'); return; }
          if (editingId) { showToast('请先保存或取消正在编辑的消息。'); return; }
          if (item.missingAttachments.length) { showToast('请先补回这条消息的素材，再进行引导。'); return; }
          if (!onSteer) { showToast('当前没有可引导的运行任务，消息已保留在队列中。'); return; }
          steeringLock.current = true; setSteering(item.id); showToast('正在停止当前生成，随后按所选消息继续…');
          try { const accepted = await onSteer(item.id); showToast(accepted ? '已按所选消息继续，其他队列消息保持暂停。' : '引导未完成：停止或发送尚未确认，消息已保留，请检查运行提示。', accepted ? 'success' : 'error'); }
          catch { showToast('引导失败，消息已保留，请重试。', 'error'); }
          finally { steeringLock.current = false; setSteering(null); }
        }}>↪ {steering===item.id?'引导中…':'引导'}</button>
        <button type="button" className="chat-queue-remove" aria-label={`删除第 ${index+1} 条消息`} onClick={()=>commit(removeQueuedMessage(sessionId,item.id))}><IconTrash size={13}/></button>
        <details className="chat-queue-menu"><summary aria-label={`第 ${index+1} 条消息更多操作`}>•••</summary><div className="chat-queue-menu-items" onClick={event=>{const target=event.target as HTMLElement;const button=target.closest('button');if(button&&!button.disabled)button.closest('details')?.removeAttribute('open');}}>
          <button type="button" onClick={()=>edit(item.id,item.text)}><IconEdit size={13}/>编辑消息</button>
          <button type="button" disabled={Boolean(editingId)||(queue.paused&&queue.items.some(row=>row.missingAttachments.length))} onClick={toggle}>{queue.paused?'继续排队':'关闭排队'}</button>
        </div></details>
        {item.missingAttachments.length>0&&<label className="chat-queue-reattach">{uploading===item.id?'添加中…':'补素材'}<input type="file" multiple hidden disabled={Boolean(uploading)} onChange={async event=>{
          const files=Array.from(event.target.files||[]);event.target.value='';if(!files.length)return;setUploading(item.id);pauseChatQueue(sessionId);
          try{commit(attachQueuedFiles(sessionId,item.id,await uploadFiles(files,sessionId)));}catch(cause){setError(cause instanceof Error?cause.message:'素材添加失败');}finally{setUploading(null);}
        }}/></label>}
      </div>
    </li>)}</ol>
    {(error||queue.error)&&<p role="status">{error||queue.error}</p>}
  </section>;
}
