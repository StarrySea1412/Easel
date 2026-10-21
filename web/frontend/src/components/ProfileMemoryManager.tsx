import { useEffect, useRef, useState } from 'react';
import { NativeSelect as Select } from './ui/Select';
import { confirmModal } from './ui/ConfirmModal';
import { memoryRequest, mutateMemory, proposeMemory, refreshMemory, useProfileMemory, type MemoryEntry, type MemoryScope } from '../lib/profileMemory';
import PublishSpinner from './PublishSpinner';
import '../styles/profile-memory.css';

const statuses = {pending:'待确认',active:'有效经验',invalidated:'已失效',rejected:'已拒绝'};
const scopeLabel = (scope:MemoryScope) => scope.kind==='profile'?'当前画像 · 跨平台':`${scope.platform} · 账号 ${scope.accountId}`;
export default function ProfileMemoryManager({name,onSource}:{name:string;onSource?:(id:string)=>void}) {
  const {data,loading,error}=useProfileMemory(name);
  const [filter,setFilter]=useState('all'),[query,setQuery]=useState('');
  const [scopeKind,setScope]=useState('profile'),[platform,setPlatform]=useState('zhihu'),[account,setAccount]=useState('');
  const [text,setText]=useState(''),[busy,setBusy]=useState(false),[failure,setFailure]=useState('');
  const [editing,setEditing]=useState<{entry:MemoryEntry;profileRevision:number;text:string;date:string}|null>(null);
  const [history,setHistory]=useState<{id:string;rows:MemoryEntry[]}|null>(null);
  const [snapshot,setSnapshot]=useState('');
  const [context,setContext]=useState<MemoryEntry[]|null>(null);
  const [externalFile,setExternalFile]=useState<{text:string;hash:string}|null>(null);
  const currentRevision=useRef(data?.revision);currentRevision.current=data?.revision;
  useEffect(()=>{setContext(null);setHistory(null);setSnapshot('');setExternalFile(null);},[data?.revision]);
  const selected:MemoryScope=scopeKind==='profile'?{kind:'profile'}:{kind:'account',platform,accountId:account.trim()};
  const run=async(action:()=>Promise<unknown>)=>{if(busy)return;setBusy(true);setFailure('');try{await action();}catch(reason){setFailure(reason instanceof Error?reason.message:'经验操作失败');}finally{setBusy(false);}};
  const change=(entry:MemoryEntry,action:string,extra:Record<string,unknown>={})=>run(async()=>{
    if(!data)return;
    if(action==='delete'&&!await confirmModal('永久删除这条经验及其历史版本？删除后将停止读取，相关旧资料快照也会清理。',{confirmLabel:'永久删除'}))return;
    await mutateMemory(name,`/entries/${entry.id}/${action}`,{revision:entry.revision,profileRevision:data.revision,contentHash:entry.contentHash,scopeHash:entry.scopeHash,...extra});
    setContext(null);if(action==='delete'){setHistory(null);setSnapshot('');}
  });
  const rows=data?.entries.filter(entry=>(filter==='all'||(filter==='review'?entry.needsReview:entry.status===filter))&&`${entry.text} ${scopeLabel(entry.scope)}`.toLowerCase().includes(query.toLowerCase()))||[];
  return <section className="profile-memory" aria-label="经验沉淀管理">
    <header><div><h2>经验沉淀</h2><p>先提出候选，再确认适用范围。当前要求优先，经验不替代偏好与红线。</p></div><button className="btn btn-sm" disabled={loading} onClick={()=>void refreshMemory(name)}>{loading&&<PublishSpinner/>}刷新</button></header>
    {(failure||error||data?.warning)&&<p className="notice-error" role="alert">{failure||error||data?.warning}</p>}
    {!data&&loading&&<p role="status"><PublishSpinner/>正在读取经验…</p>}
    {data&&<>
      <div className="memory-scope"><label>适用范围<Select value={scopeKind} onChange={event=>setScope(event.target.value)}><option value="profile">当前画像，跨平台</option><option value="account">指定平台账号</option></Select></label>{scopeKind==='account'&&<><label>平台<Select value={platform} onChange={event=>setPlatform(event.target.value)}>{['zhihu','xiaohongshu','douyin','kuaishou','weixin-channels','bilibili','wechat-oa'].map(value=><option key={value} value={value}>{({zhihu:'知乎',xiaohongshu:'小红书',douyin:'抖音',kuaishou:'快手','weixin-channels':'视频号',bilibili:'B站','wechat-oa':'公众号'} as Record<string,string>)[value]}</option>)}</Select></label><label>稳定账号ID<input className="field" value={account} onChange={event=>setAccount(event.target.value)} placeholder="使用账号ID，不填写昵称"/></label></>}</div>
      {!data.managed&&<div className="memory-legacy"><h3>旧经验尚未托管</h3><p>原文与哈希会保留，日期和来源不明时保持未知。导入后的旧内容仍需确认，不自动变成已验证效果。</p><details><summary>查看导入原文</summary><pre>{data.legacy?.text||'旧文件为空'}</pre></details><button className="btn btn-sm" disabled={busy||scopeKind==='account'&&!account.trim()} onClick={()=>void run(async()=>{await mutateMemory(name,'/import',{hash:data.legacy?.hash,profileRevision:data.revision,scope:selected});})}>确认导入并开始管理</button></div>}
      {data.managed&&<><label className="memory-new">提出新经验<textarea className="field" rows={3} value={text} onChange={event=>setText(event.target.value)} placeholder="写下可复用结论、适用条件与局限；不要填密码或Cookie"/></label><button className="btn btn-sm" disabled={busy||!text.trim()||scopeKind==='account'&&!account.trim()} onClick={()=>void run(async()=>{await proposeMemory(name,text,selected);setText('');})}>保存为待确认候选</button></>}
      {!data.projectionReady&&<button className="btn btn-sm" disabled={busy} onClick={()=>void run(async()=>{setExternalFile(await memoryRequest<{text:string;hash:string}>(name,'/file-changes'));})}>对照外部修改并修复</button>}
      {externalFile&&<div className="memory-legacy"><h3>当前外部文件原文</h3><pre>{externalFile.text||'文件为空或已删除'}</pre><p>确认后将原文保存为待确认候选，再从数据库重建兼容文件；原有有效经验保留。</p><button className="btn btn-sm" disabled={busy} onClick={()=>void run(async()=>{await mutateMemory(name,'/reconcile',{hash:externalFile.hash,profileRevision:data.revision});setExternalFile(null);})}>保存候选并重建</button></div>}
      <div className="memory-filters"><input className="field" type="search" aria-label="搜索经验" placeholder="搜索经验或账号" value={query} onChange={event=>setQuery(event.target.value)}/><Select aria-label="筛选经验状态" value={filter} onChange={event=>setFilter(event.target.value)}><option value="all">全部经验</option>{Object.entries(statuses).map(([value,label])=><option key={value} value={value}>{label}</option>)}<option value="review">需要复查</option></Select></div>
      <div className="memory-entries">{!rows.length&&<p className="dash-empty">当前没有匹配的经验。</p>}{rows.map(entry=><article key={entry.id} className="memory-entry">
        <div className="memory-entry-heading"><strong>{statuses[entry.status]} · v{entry.revision}</strong><span>{scopeLabel(entry.scope)}</span></div><p className="memory-entry-text">{entry.text}</p>
        <small>{entry.quality==='legacy-unverified'?'旧资料 · 未核验':entry.source.type==='analysis'?'分析假设 · 需结合材料复核':'用户整理的经验参考'}{entry.userEdited?' · 用户修订':''} · {entry.source.capturedAt?new Date(entry.source.capturedAt).toLocaleString('zh-CN'):'观察日期未知'}</small>
        {entry.source.sampleCount!==undefined&&<p>依据 {entry.source.sampleCount} 篇已保存作品，不能据此断言因果或增长效果。</p>}
        {entry.needsReview&&<p className="notice-error">{entry.sourceStatus==='available'?'已到复查日期，仍保留，等待你复核。':entry.sourceStatus==='missing'?'原对话或材料已删除；该经验暂停注入，保留已确认记录供处理。':'来源已变化或不可用；该经验暂停注入，请重新提取候选。'}</p>}
        <div className="memory-entry-actions">
          {entry.status==='pending'&&<><button className="btn btn-sm btn-primary" disabled={busy||!data.managed||entry.sourceStatus!=='available'} onClick={()=>void change(entry,'accept')}>确认生效</button><button className="btn btn-sm" disabled={busy} onClick={()=>void change(entry,'reject')}>拒绝</button></>}
          {entry.status==='active'&&<button className="btn btn-sm" disabled={busy} onClick={()=>void change(entry,'invalidate')}>标记失效</button>}
          {entry.status==='invalidated'&&<button className="btn btn-sm" disabled={busy||entry.sourceStatus!=='available'} onClick={()=>void change(entry,'restore')}>恢复有效</button>}
          {entry.status!=='rejected'&&<button className="btn btn-sm" disabled={busy} onClick={()=>setEditing({entry,profileRevision:data.revision,text:entry.text,date:entry.reviewAfter||''})}>编辑</button>}
          <button className="btn btn-sm" disabled={busy} onClick={()=>void run(async()=>{const value=await memoryRequest<{revisions:MemoryEntry[]}>(name,`/entries/${entry.id}/history`);if(currentRevision.current===data.revision)setHistory({id:entry.id,rows:value.revisions});})}>查看版本</button>
          {entry.source.sessionId&&onSource&&<button className="btn btn-sm" disabled={entry.sourceStatus==='missing'} onClick={()=>onSource(entry.source.sessionId!)}>回到来源对话</button>}
          <button className="btn btn-sm" disabled={busy} onClick={()=>void change(entry,'delete')}>删除</button>
        </div>
        {editing?.entry.id===entry.id&&<div className="memory-editor">{editing.profileRevision!==data.revision&&<div role="alert"><p>资料已有更新，你的草稿仍保留。上方展示当前版本，请对照后继续。</p><button className="btn btn-sm" onClick={()=>setEditing({...editing,entry,profileRevision:data.revision})}>以当前版本继续修订</button></div>}<label>修订正文<textarea className="field" rows={4} value={editing.text} onChange={event=>setEditing({...editing,text:event.target.value})}/></label><label>复查日期（选填）<input className="field" type="date" value={editing.date} onChange={event=>setEditing({...editing,date:event.target.value})}/></label><button className="btn btn-sm" disabled={busy||!editing.text.trim()} onClick={()=>void run(async()=>{await mutateMemory(name,`/entries/${entry.id}/edit`,{revision:editing.entry.revision,profileRevision:editing.profileRevision,text:editing.text,reviewAfter:editing.date||null});setEditing(null);setContext(null);})}>保存修订</button><button className="btn btn-sm" onClick={()=>setEditing(null)}>取消</button></div>}
        {history?.id===entry.id&&<details open><summary>版本记录</summary>{history.rows.map(row=><div key={row.revision}><small>v{row.revision} · {statuses[row.status]} · {new Date(row.updatedAt).toLocaleString('zh-CN')}</small><pre>{row.text}</pre></div>)}</details>}
      </article>)}</div>
      {data.managed&&<details><summary>读取范围与迁移原文</summary><p>查看当前范围可用于后续任务的有效经验，不会发送消息或调用模型。</p><button className="btn btn-sm" disabled={busy||scopeKind==='account'&&!account.trim()} onClick={()=>void run(async()=>{const params=new URLSearchParams({query});if(selected.kind==='account'){params.set('platform',selected.platform);params.set('accountId',selected.accountId);}const value=await memoryRequest<{entries:MemoryEntry[]}>(name,`/context?${params}`);if(currentRevision.current===data.revision)setContext(value.entries);})}>查看可用经验</button>{context&&<div role="status">{context.length?context.map(row=><p key={row.id}>{row.text}</p>):'当前范围没有可用经验。'}</div>}<button className="btn btn-sm" disabled={busy} onClick={()=>void run(async()=>{const value=await memoryRequest<{snapshot:{text:string}|null}>(name,'/legacy');if(currentRevision.current===data.revision)setSnapshot(value.snapshot?.text||'没有保留的迁移原文。');})}>查看迁移前原文</button>{snapshot&&<pre>{snapshot}</pre>}</details>}
    </>}
  </section>;
}
