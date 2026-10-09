import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { showToast } from '../lib/toast';
import { getChatQueue, subscribeChatQueue, removeQueuedMessage, moveQueuedMessage, resumeChatQueue, pauseChatQueue, attachQueuedFiles } from '../lib/chatQueue';
import { uploadFiles } from '../lib/api';
import { IconEdit, IconTrash } from './icons';

function QueueGripIcon() {
  return <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor" aria-hidden="true">{[3,7,11].map(y=><g key={y}><circle cx="4" cy={y} r="1"/><circle cx="8" cy={y} r="1"/></g>)}</svg>;
}
function QueueSteerIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 5 4 10l5 5M4 10h9a6 6 0 0 1 6 6v3" /></svg>;
}

export default function ChatQueueTray({ sessionId, editingId, onEdit, onSteer, isStreaming = false, stopping = false }: { sessionId: string; editingId?: string; onEdit: (id: string, text: string) => void; onSteer?: (id: string) => Promise<boolean>; isStreaming?: boolean; stopping?: boolean }) {
  const queue = useSyncExternalStore(subscribeChatQueue, () => getChatQueue(sessionId));
  const [error,setError]=useState(''),[uploading,setUploading]=useState<string|null>(null);
  const dragged = useRef<string | null>(null);
  const tray = useRef<HTMLElement>(null);
  const menuGroup = useId();
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      tray.current?.querySelectorAll<HTMLDetailsElement>('.chat-queue-menu[open]').forEach(menu => {
        if (!menu.contains(event.target as Node)) menu.open = false;
      });
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      tray.current?.querySelectorAll<HTMLDetailsElement>('.chat-queue-menu[open]').forEach(menu => {
        menu.open = false; menu.querySelector<HTMLElement>('summary')?.focus();
      });
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeOnEscape); };
  }, []);
  const touchTarget = useRef<string | null>(null);
  const [steering, setSteering] = useState<string | null>(null);
  const steeringLock = useRef(false);
  const [dragTarget, setDragTarget] = useState<string | null>(null);
  const [dragVisual, setDragVisual] = useState<{ id: string; left: number; top: number; width: number; height: number; step: number; startX: number; startY: number; offsetX: number; offset: number } | null>(null);
  const dragRows = useRef<{ id: string; top: number; height: number }[]>([]);
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
    setHint(null);
  };
  const commit=(accepted:boolean)=>{setError(accepted?'':'更改未保存，请检查浏览器存储或输入内容。');return accepted;};
  const edit=(id:string,value:string)=>{pauseChatQueue(sessionId);onEdit(id,value);};
  const toggle = () => {
    if (editingId) { showToast('请先保存或取消正在编辑的消息，再继续排队。'); return; }
    if (stopping || steeringLock.current) { showToast('正在处理所选消息，请稍候再继续排队。'); return; }
    if (queue.paused && queue.items.some(item => item.missingAttachments.length)) { showToast('请先补回队列消息的素材，再继续排队。'); return; }
    if (queue.paused) {
      const resumed = resumeChatQueue(sessionId); commit(resumed);
      showToast(resumed ? (isStreaming ? '已继续排队，本轮结束后按顺序发送。' : '已继续排队，将按顺序发送。') : '队列未恢复，请检查页面提示。', resumed ? 'success' : 'error');
    } else { pauseChatQueue(sessionId); showToast('已暂停排队，待发送消息已保留。'); }
  };
  const dragItem = queue.items.find(item => item.id === dragVisual?.id);
  const sourceIndex = queue.items.findIndex(item => item.id === dragVisual?.id);
  const targetIndex = queue.items.findIndex(item => item.id === dragTarget);
  const dragShift = (index: number) => !dragVisual || sourceIndex < 0 || targetIndex < 0 ? 0
    : index > sourceIndex && index <= targetIndex ? -dragVisual.step
    : index < sourceIndex && index >= targetIndex ? dragVisual.step : 0;
  if(!queue.items.length&&!queue.error)return null;
  return <section ref={tray} className="chat-queue is-compact" aria-label="待发送消息">
    {dragVisual && dragItem && createPortal(<div className="chat-queue-row chat-queue-drag-preview" aria-hidden="true" style={{ left: dragVisual.left + dragVisual.offsetX, top: dragVisual.top, width: dragVisual.width, height: dragVisual.height, transform: `translateY(${dragVisual.offset}px)` }}>
      <span className="chat-queue-grip"><QueueGripIcon/></span><span className="chat-queue-text">{dragItem.text || '素材消息'}{(dragItem.attachments.length || dragItem.missingAttachments.length) > 0 && <small> · {dragItem.attachments.length + dragItem.missingAttachments.length} 份素材{dragItem.missingAttachments.length ? '需重新添加' : ''}</small>}</span>{queue.paused && queue.items[0].id === dragItem.id && <span className="chat-queue-paused">已暂停</span>}<span className="chat-queue-actions"><span className="chat-queue-steer"><QueueSteerIcon/>引导</span><span className="chat-queue-remove"><IconTrash size={13}/></span><span>•••</span></span>
    </div>, document.body)}
    {hint && queue.items.some(item => item.id === hint.itemId) && createPortal(<div ref={hintPanel} id={hintId} role="tooltip" className="chat-queue-steer-hint" style={hintPosition}>{isStreaming ? '停止当前生成，按此消息继续' : '发送这条消息'}<br/><small>{isStreaming ? '保留已生成内容，其他队列保持暂停' : '其他队列消息保持暂停'}</small></div>, document.body)}
    <ol className={dragVisual ? 'is-dragging' : undefined}>{queue.items.map((item,index)=><li data-queue-id={item.id} className={`chat-queue-row ${editingId===item.id?'is-editing':''} ${dragTarget===item.id?'is-drop-target':''} ${dragVisual?.id===item.id?'is-drag-placeholder':''}`} key={item.id}
      style={dragVisual ? { transform: `translateY(${dragShift(index)}px)` } : undefined}
      onDragOver={event => { if (!dragged.current) return; event.preventDefault(); setDragTarget(item.id); }} onDrop={event => { if (!dragged.current) return; event.preventDefault(); reorder(item.id); }}>
      <button type="button" className="chat-queue-grip" draggable={false} aria-label={`拖动第 ${index+1} 条消息调整顺序`} title="拖动排序，或用上下方向键移动"
        onDragStart={event => { dragged.current = item.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/easel-queue', item.id); }} onDragEnd={() => { dragged.current = null; setDragTarget(null); }}
        onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); const offset = event.key === 'ArrowUp' ? -1 : 1; if (index + offset >= 0 && index + offset < queue.items.length) { const saved = moveQueuedMessage(sessionId, item.id, offset); commit(saved); showToast(saved ? '已调整消息顺序' : '消息顺序未能保存。', saved ? 'success' : 'error'); } } }}
        onPointerDown={event => { if (event.button === 0) {
          dragged.current = item.id; touchTarget.current = item.id; setHint(null);
          const rect = event.currentTarget.closest('li')!.getBoundingClientRect();
          dragRows.current = Array.from(tray.current?.querySelectorAll<HTMLElement>('[data-queue-id]') || []).map(row => {
            const bounds = row.getBoundingClientRect(); return { id: row.dataset.queueId!, top: bounds.top, height: bounds.height };
          });
          const gap = parseFloat(getComputedStyle(tray.current!.querySelector('ol')!).rowGap) || 6;
          setDragVisual({ id:item.id,left:rect.left,top:rect.top,width:rect.width,height:rect.height,step:rect.height+gap,startX:event.clientX,startY:event.clientY,offsetX:0,offset:0 });
          event.currentTarget.setPointerCapture(event.pointerId);
        } }}
        onPointerMove={event => { if (dragged.current) {
          setDragVisual(current=>current?{...current,offsetX:event.clientX-current.startX,offset:event.clientY-current.startY}:null);
          // Use original positions: moving neighbours must not change the
          // target under the pointer and cause oscillation.
          const rows = dragRows.current;
          const within = rows.length && event.clientY >= rows[0].top && event.clientY <= rows[rows.length - 1].top + rows[rows.length - 1].height;
          const nearest = within ? rows.reduce((best, row) => Math.abs(event.clientY - row.top - row.height / 2) < Math.abs(event.clientY - best.top - best.height / 2) ? row : best) : null;
          touchTarget.current = nearest?.id || null; setDragTarget(touchTarget.current);
        } }}
        onPointerUp={() => { if (dragged.current) reorder(touchTarget.current || item.id); }} onPointerCancel={() => { dragged.current = null; touchTarget.current = null; setDragTarget(null); setDragVisual(null); }}>
        <QueueGripIcon/>
      </button>
      <button type="button" className="chat-queue-text" title={item.text||'素材消息'} onClick={()=>edit(item.id,item.text)}>{item.text||'素材消息'}{(item.attachments.length||item.missingAttachments.length)>0&&<small> · {item.attachments.length+item.missingAttachments.length} 份素材{item.missingAttachments.length?'需重新添加':''}</small>}</button>
      {queue.paused&&index===0&&<span className="chat-queue-paused">已暂停</span>}
      <div className="chat-queue-actions">
        <button type="button" className="chat-queue-steer" aria-disabled={stopping || !!steering || !!editingId || !!item.missingAttachments.length || !onSteer} aria-describedby={hint?.itemId === item.id ? hintId : undefined} aria-label={`引导第 ${index+1} 条消息`} onPointerEnter={event => { if (event.pointerType !== 'touch' && !dragged.current) setHint({ anchor: event.currentTarget, itemId: item.id }); }} onPointerLeave={() => setHint(null)} onFocus={event => { if (!dragged.current) setHint({ anchor: event.currentTarget, itemId: item.id }); }} onBlur={() => setHint(null)} onKeyDown={event => { if (event.key === 'Escape') setHint(null); }} onClick={async () => {
          setHint(null);
          if (steeringLock.current || stopping) { showToast('正在等待停止确认，请稍候。'); return; }
          if (editingId) { showToast('请先保存或取消正在编辑的消息。'); return; }
          if (item.missingAttachments.length) { showToast('请先补回这条消息的素材，再进行引导。'); return; }
          if (!onSteer) { showToast('当前对话无法发送，消息已保留在队列中。'); return; }
          steeringLock.current = true; setSteering(item.id); showToast(isStreaming ? '正在停止当前生成，随后按所选消息继续…' : '正在发送所选消息…');
          try { const accepted = await onSteer(item.id); showToast(accepted ? (getChatQueue(sessionId).paused && getChatQueue(sessionId).items.length ? '已发送所选消息；剩余消息有修改或缺少素材，请确认后继续。' : '已发送所选消息，剩余队列将在本轮结束后按顺序继续。') : getChatQueue(sessionId).error || '消息未发送，已保留在队列中，请重试。', accepted ? 'success' : 'error'); }
          catch { showToast('引导失败，消息已保留，请重试。', 'error'); }
          finally { steeringLock.current = false; setSteering(null); }
        }}><QueueSteerIcon/>{steering===item.id?'引导中…':'引导'}</button>
        <button type="button" className="chat-queue-remove" aria-label={`删除第 ${index+1} 条消息`} onClick={()=>commit(removeQueuedMessage(sessionId,item.id))}><IconTrash size={13}/></button>
        <details className="chat-queue-menu" name={`chat-queue-${menuGroup}`} onToggle={event => {
          if (event.currentTarget.open) tray.current?.querySelectorAll<HTMLDetailsElement>('.chat-queue-menu').forEach(menu => { if (menu !== event.currentTarget) menu.open = false; });
        }}><summary aria-label={`第 ${index+1} 条消息更多操作`}>•••</summary><div className="chat-queue-menu-items" onClick={event=>{const target=event.target as HTMLElement;const button=target.closest('button');if(button&&!button.disabled)button.closest('details')?.removeAttribute('open');}}>
          <button type="button" onClick={()=>edit(item.id,item.text)}><IconEdit size={13}/>编辑消息</button>
          <button type="button" aria-disabled={Boolean(editingId)||stopping||!!steering||(queue.paused&&queue.items.some(row=>row.missingAttachments.length))} onClick={toggle}>{queue.paused?'继续排队':'关闭排队'}</button>
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
