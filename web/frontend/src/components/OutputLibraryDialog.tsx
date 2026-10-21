import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalFocus } from '../hooks/useModalFocus';
import type { LibraryFolder, OutputNode } from '../lib/api';
import Select from './ui/Select';
import { IconFolder } from './icons';

export type LibraryEdit = {kind:'create';parent:string}|{kind:'rename';folder:LibraryFolder}|{kind:'assign';file:OutputNode;folder:string};

export default function OutputLibraryDialog({edit,folders,onClose,onSave}: {
  edit:LibraryEdit;folders:LibraryFolder[];onClose:()=>void;onSave:(value:string)=>Promise<void>;
}) {
  const [value,setValue]=useState(edit.kind==='rename'?edit.folder.name:edit.kind==='assign'?edit.folder:'');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const close=useCallback(()=>{if(!busy)onClose();},[busy,onClose]);
  const ref=useModalFocus(true,close);
  const title=edit.kind==='assign'?'整理文件':edit.kind==='rename'?'重命名文件夹':'新建文件夹';
  const folderPath=(folder:LibraryFolder):string=>{
    const parts=[folder.name];let parent=folder.parent;
    for(let n=0;parent&&n<8;n++){const row=folders.find(f=>f.id===parent);if(!row)break;parts.unshift(row.name);parent=row.parent;}
    return parts.join(' / ');
  };
  const save=async(event:React.FormEvent)=>{
    event.preventDefault();if(busy)return;setBusy(true);setError('');
    try{await onSave(value.trim());onClose();}catch(e){setError(e instanceof Error?e.message:'保存失败');}finally{setBusy(false);}
  };
  return createPortal(<div className="overlay" onPointerDown={event=>{if(event.target===event.currentTarget)close();}}><div className="modal library-dialog" ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
    <h2><IconFolder size={20}/>{title}</h2>
    <form onSubmit={save}>
      {edit.kind==='assign'?<><p className="library-file-name" title={edit.file.path}>{edit.file.name}</p><label>文件夹<Select aria-label="目标文件夹" value={value} disabled={busy} onChange={setValue} options={[{value:'',label:'未归类'},...folders.map(f=>({value:f.id,label:folderPath(f)}))]}/></label></>:<label>名称<input data-modal-autofocus aria-label="文件夹名称" autoComplete="off" maxLength={80} required value={value} disabled={busy} onChange={event=>setValue(event.target.value)}/></label>}
      {edit.kind==='create'&&edit.parent&&<p className="library-dialog-hint">位于：{folders.find(f=>f.id===edit.parent)?.name}</p>}
      {error&&<p className="notice-error" role="alert">{error}</p>}
      <footer><button type="button" className="btn btn-sm" disabled={busy} onClick={close}>取消</button><button className="btn btn-primary btn-sm" type="submit" disabled={busy||(edit.kind!=='assign'&&!value.trim())}>{busy?<span className="spinner" aria-label="保存中"/>:'保存'}</button></footer>
    </form>
  </div></div>,document.body);
}
