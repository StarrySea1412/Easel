import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalFocus } from '../hooks/useModalFocus';
import { fetchOutputOrigins, type OutputNode } from '../lib/api';
import { outputReferences, outputSessionDeleted, type OutputOrigin } from '../lib/outputReferences';
import type { ChatSession } from '../lib/store';
import { IconChat, IconChevron } from './icons';
import { Sk } from './Skeleton';

export default function OutputConversationDialog({file,sessions,sessionsLoading,onOpen,onClose}: {
  file:OutputNode;sessions:ChatSession[];sessionsLoading:boolean;onOpen:(id:string,file:OutputNode)=>Promise<boolean>;onClose:()=>void;
}) {
  const ref=useModalFocus(true,onClose);
  const [origins,setOrigins]=useState<OutputOrigin[]>(()=>outputReferences(file.path));
  const [loading,setLoading]=useState(true),[error,setError]=useState(''),[opening,setOpening]=useState('');
  useEffect(()=>{
    let cancelled=false;
    fetchOutputOrigins(file.path).then(result=>{if(!cancelled)setOrigins([...result.origins,...outputReferences(file.path)]);})
      .catch(()=>{if(!cancelled)setError('交付来源暂时无法读取');}).finally(()=>{if(!cancelled)setLoading(false);});
    return ()=>{cancelled=true;};
  },[file.path]);
  const rows=useMemo(()=>{
    const unique=new Map<string,OutputOrigin>();
    for(const origin of origins)if(!unique.has(origin.sessionId))unique.set(origin.sessionId,origin);
    return [...unique.values()];
  },[origins]);
  const open=async(id:string)=>{
    if(opening)return;setOpening(id);
    try { if(await onOpen(id,file))onClose(); }
    catch(e){setError(e instanceof Error?e.message:'暂时无法打开原对话');}
    finally { setOpening(''); }
  };
  return createPortal(<div className="overlay" onPointerDown={e=>{if(e.target===e.currentTarget)onClose();}}><div className="modal library-dialog" role="dialog" aria-modal="true" aria-label="文件关联对话" ref={ref} tabIndex={-1}>
    <h2><IconChat size={20}/>返回对话</h2><p className="library-file-name" title={file.path}>{file.name}</p>
    {loading||sessionsLoading?<div role="status" aria-label="读取来源中"><Sk h={42}/></div>:<>
      {error&&<p className="notice-error" role="alert">{error}</p>}
      {!rows.length&&<p role="status">{error?'稍后重试即可查询原对话。':'这个文件尚未记录来源对话。'}</p>}
      <div className="library-origin-list">{rows.map(origin=>{
        const session=sessions.find(s=>s.id===origin.sessionId), deleted=origin.deleted||outputSessionDeleted(origin.sessionId);
        const status=deleted?'原对话已删除':!session?'未找到原对话，可能已删除或不在当前记录中':session.importedFromBackup?'只读备份':session.archived?'已归档 · 恢复后继续':origin.evidence==='delivery'?'来源对话':'引用此文件的对话';
        return <button key={origin.sessionId} className="library-origin" disabled={Boolean(opening)||deleted||!session||session.importedFromBackup} onClick={()=>void open(origin.sessionId)}>
          <IconChat size={17}/><span><strong>{session?.title||origin.title||'原对话'}</strong><small>{status}</small></span>{opening===origin.sessionId?<span className="spinner"/>:<IconChevron size={14}/>}</button>;
      })}</div>
    </>}
    <footer><button className="btn btn-sm" type="button" onClick={onClose}>关闭</button></footer>
  </div></div>,document.body);
}
