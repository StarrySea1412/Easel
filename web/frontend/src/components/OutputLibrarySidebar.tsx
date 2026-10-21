import type { LibraryFolder } from '../lib/api';
import { IconOutputs, IconFolder, IconPlus, IconEdit, IconTrash } from './icons';
import { Sk } from './Skeleton';

export default function OutputLibrarySidebar({folders,counts,active,loading,onSelect,onCreate,onRename,onDelete}: {
  folders:LibraryFolder[]; counts:Record<string,number>;active:string;loading:boolean;
  onSelect:(id:string)=>void;onCreate:(parent:string)=>void;onRename:(folder:LibraryFolder)=>void;onDelete:(folder:LibraryFolder)=>void;
}) {
  const rows=(parent:string,depth=0):React.ReactNode=>folders.filter(f=>f.parent===parent).map(folder=><div key={folder.id}>
    <div className={`library-folder-row ${active===folder.id?'active':''}`} style={{paddingLeft:Math.min(depth*10,30)}}>
      <button className="library-folder-select" onClick={()=>onSelect(folder.id)} aria-current={active===folder.id?'page':undefined} title={folder.name}><IconFolder size={16}/><span>{folder.name}</span><small>{counts[folder.id]||0}</small></button>
      <div className="library-folder-actions"><button className="icon-btn" title="新建子文件夹" aria-label={`在${folder.name}中新建文件夹`} onClick={()=>onCreate(folder.id)}><IconPlus size={13}/></button><button className="icon-btn" title="重命名" aria-label={`重命名文件夹${folder.name}`} onClick={()=>onRename(folder)}><IconEdit size={13}/></button><button className="icon-btn" title="删除文件夹" aria-label={`删除文件夹${folder.name}`} onClick={()=>onDelete(folder)}><IconTrash size={13}/></button></div>
    </div>{depth<7&&rows(folder.id,depth+1)}
  </div>);
  return <nav className="library-sidebar" aria-label="内容分类">
    <button className={`library-folder-select ${active==='all'?'active':''}`} onClick={()=>onSelect('all')} aria-current={active==='all'?'page':undefined}><IconOutputs size={16}/><span>全部文件</span><small>{counts.all||0}</small></button>
    <button className={`library-folder-select ${active==='unfiled'?'active':''}`} disabled={loading} onClick={()=>onSelect('unfiled')} aria-current={active==='unfiled'?'page':undefined}><IconFolder size={16}/><span>未归类</span><small>{loading?'—':counts.unfiled||0}</small></button>
    <div className="library-sidebar-heading"><span>我的文件夹</span><button className="icon-btn" aria-label="新建文件夹" title="新建文件夹" disabled={loading} onClick={()=>onCreate('')}><IconPlus size={15}/></button></div>
    {loading&&!folders.length?<Sk h={28} w="100%"/>:rows('')}
  </nav>;
}
