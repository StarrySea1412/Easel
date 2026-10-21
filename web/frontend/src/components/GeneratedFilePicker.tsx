import { useCallback, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { fetchOutputs, type OutputNode } from '../lib/api';
import { returnGeneratedFileToChat } from '../lib/creationWorkspace';
import { useModalFocus } from '../hooks/useModalFocus';
import { IconFile, IconOutputs, IconPlus, IconRefresh } from './icons';
import PublishSpinner from './PublishSpinner';
import '../styles/generated-file-picker.css';

function generatedFiles(nodes: OutputNode[]): OutputNode[] {
  return nodes.flatMap(node => node.type === 'dir' ? generatedFiles(node.children || []) : node.type === 'file' && typeof node.path === 'string' ? [node] : []).sort((a,b)=>(b.mtime || 0)-(a.mtime || 0));
}
export default function GeneratedFilePicker({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [files,setFiles] = useState<OutputNode[]>([]), [query,setQuery] = useState('');
  const [loading,setLoading] = useState(true), [error,setError] = useState(''), [insertionError,setInsertionError] = useState(''), [busy,setBusy] = useState('');
  const [added,setAdded] = useState<string[]>([]), [retry,setRetry] = useState(0);
  const close = useCallback(()=>{ if (!busy) onClose(); },[busy,onClose]);
  const ref = useModalFocus(true,close), id = useId();
  useEffect(()=>{let alive=true;setLoading(true);setError('');void fetchOutputs().then(nodes=>{if(alive)setFiles(generatedFiles(nodes));}).catch(()=>{if(alive)setError('文件列表读取失败，请重试');}).finally(()=>{if(alive)setLoading(false);});return()=>{alive=false;};},[retry]);
  const visible = files.filter(file=>(file.name+' '+file.path).toLowerCase().includes(query.toLowerCase()));
  return createPortal(<div className="overlay" onPointerDown={event=>{if(event.target===event.currentTarget)close();}}><div ref={ref} role="dialog" aria-modal="true" aria-labelledby={id} className="modal generated-file-picker" tabIndex={-1}>
    <header><h2 id={id}><IconOutputs size={19}/>已生成文件</h2><button type="button" className="btn btn-sm" aria-label="关闭已生成文件" disabled={Boolean(busy)} onClick={close}>×</button></header>
    <input className="field" data-modal-autofocus aria-label="搜索已生成文件" placeholder="搜索文件名或路径" value={query} onChange={event=>setQuery(event.target.value)}/>
    {loading ? <div role="status" aria-label="读取文件中"><PublishSpinner/></div> : error ? <div role="alert">{error}<button className="btn btn-sm" onClick={()=>setRetry(value=>value+1)}><IconRefresh size={14}/>重试</button></div> : <div className="generated-file-list">{visible.length ? visible.map(file=><article key={file.path}><IconFile size={20}/><div><strong>{file.name}</strong><small title={file.path}>{file.path}</small></div><button className="btn btn-sm" disabled={Boolean(busy) || added.includes(file.path) || (file.size || 0)>32*1024*1024} title={(file.size || 0)>32*1024*1024?'文件超过32MB':undefined} onClick={async()=>{setBusy(file.path);setInsertionError('');try{await returnGeneratedFileToChat(sessionId,file.path);setAdded(previous=>[...previous,file.path]);}catch(reason){setInsertionError(reason instanceof Error?reason.message:'添加失败，请重试');}finally{setBusy('');}}}>{busy===file.path?<PublishSpinner/>:<IconPlus size={14}/>} {added.includes(file.path)?'已添加':'添加'}</button></article>):<p>{query?'没有匹配文件':'还没有已生成文件'}</p>}</div>}
    {insertionError && <p role="alert">{insertionError}</p>}
    <footer><span>{added.length ? `已添加 ${added.length} 个文件到草稿` : '添加到当前对话草稿'}</span><button className="btn btn-primary" disabled={Boolean(busy)} onClick={close}>完成</button></footer>
  </div></div>,document.body);
}
