import { useState } from 'react';
import ChatArtifacts from './ChatArtifacts';
import ChatExecutionPanel from './ChatExecutionPanel';
import { IconFile } from './icons';
import type { ChatSession } from '../lib/store';
import type { useChatArtifacts } from '../hooks/useChatArtifacts';

export function ChatPanelFiles({ deliveries, selectedId }: { deliveries: ReturnType<typeof useChatArtifacts>; selectedId?: string }) {
  const [selection,setSelection]=useState('');
  const selected=deliveries.items.find(item=>item.id===(selection||selectedId));
  return <section className="chat-panel-files" aria-label="文件面板"><div className="chat-panel-tool-heading"><h2>文件</h2><span>{deliveries.items.length} 项</span></div><p className="chat-panel-scope">当前对话已登记的文件与产物。浏览和下载保留原轮次归属。</p>
    {deliveries.note&&<p role="status" className="chat-panel-error">{deliveries.note} <button type="button" onClick={deliveries.retry}>重新读取</button></p>}
    {deliveries.items.length?<><div className="chat-panel-file-list">{deliveries.items.map(item=><button type="button" key={item.id} aria-pressed={selected?.id===item.id} onClick={()=>setSelection(item.id)}><IconFile size={17}/><span><strong>{item.name}</strong><small>{item.mimeType} · {(item.size/1024).toFixed(1)} KB</small></span><small>{item.status==='ready'?'查看':item.status==='missing'?'已丢失':'读取失败'}</small></button>)}</div>{selected&&<ChatArtifacts artifacts={[selected]} onUpdated={deliveries.updated}/>}</>
      :<div className="chat-panel-tool-empty"><IconFile size={28}/><h3>当前对话还没有文件</h3><p>Agent 产出的文件会出现在这里；这不是整个磁盘的文件浏览器。</p></div>}
  </section>;
}

export function ChatPanelExecution({ session, kind }: { session: ChatSession; kind: 'terminal'|'changes' }) {
  const turnId=session.pendingTurnId||[...session.messages].reverse().find(message=>message.role==='assistant'&&message.turnId)?.turnId;
  const terminal=kind==='terminal';
  return <section className="chat-panel-execution" aria-label={terminal?'终端面板':'变更面板'}><div className="chat-panel-tool-heading"><h2>{terminal?'终端':'变更'}</h2><span>只读回执</span></div><p className="chat-panel-scope">{terminal?'当前或最近一轮的命令及执行输出，暂不支持手动输入命令。':'当前或最近一轮工具报告的文件变更；不是完整Git工作区审查。'}</p>
    {turnId?<ChatExecutionPanel key={`${session.id}:${turnId}`} sessionId={session.id} turnId={turnId} streaming={Boolean(session.pendingTurnId)} kinds={terminal?['command']:['file_change']} emptyMessage={terminal?'本轮还没有可展示的命令回执。':'本轮还没有可展示的文件变更。'}/>:<p className="chat-panel-home-empty">当前对话没有可读取的执行轮次。</p>}
  </section>;
}
