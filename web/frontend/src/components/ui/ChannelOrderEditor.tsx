import { useState } from 'react';
import { moveChannel, orderedChannels, readChannelOrder, saveChannelOrder } from '../../lib/channelOrder';

export default function ChannelOrderEditor({ providers, names = {}, onChange, disabled = false }: { providers: string[]; names?: Record<string, string>; onChange: (order: string[])=>void; disabled?: boolean }) {
  const [saved,setSaved]=useState(readChannelOrder);
  const [dragged,setDragged]=useState<string|null>(null);
  const [error,setError]=useState('');
  const order=orderedChannels(providers,saved);
  const move=(from:string,to:string)=>{if(disabled)return;const next=moveChannel(order,from,to);if(next===order)return;setSaved(next);onChange(next);setError(saveChannelOrder(next)?'':'渠道顺序未能保存，刷新后请重新调整。');};
  return <details className="channel-order-editor"><summary>渠道排序</summary>
    <ol aria-label="渠道排序">{order.map((provider,index)=><li key={provider} draggable={!disabled}
      onDragStart={event=>{if(disabled){event.preventDefault();return;}setDragged(provider);event.dataTransfer.setData('text/plain',provider);event.dataTransfer.effectAllowed='move';}}
      onDragOver={event=>{if(!disabled && dragged){event.preventDefault();event.dataTransfer.dropEffect='move';}}}
      onDrop={event=>{event.preventDefault();if(dragged)move(dragged,provider);setDragged(null);}} onDragEnd={()=>setDragged(null)}>
      <span aria-hidden="true">⠿</span><strong>{names[provider] || '未命名渠道'}</strong>
      <button type="button" aria-label={`上移渠道 ${names[provider] || '未命名渠道'}`} disabled={disabled || index===0} onClick={()=>move(provider,order[index-1])}>↑</button>
      <button type="button" aria-label={`下移渠道 ${names[provider] || '未命名渠道'}`} disabled={disabled || index===order.length-1} onClick={()=>move(provider,order[index+1])}>↓</button>
    </li>)}</ol>{error&&<p role="status">{error}</p>}
  </details>;
}
