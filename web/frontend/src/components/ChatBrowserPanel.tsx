import { useEffect, useRef, useState } from 'react';
import { readBreakdownLink, type LinkReadResult } from '../lib/api';
import { addChatDraftQuote, setChatDraftText } from '../lib/chatDrafts';
import { browserPageQuote } from '../lib/chatPanels';
import { IconCompass } from './icons';
import { showToast } from '../lib/toast';
import ChatLiveBrowser from './ChatLiveBrowser';

export default function ChatBrowserPanel({sessionId, active = true, onSiteIcon}: {sessionId:string;active?:boolean;onSiteIcon?:(source:string)=>void}) {
  const [mode,setMode]=useState<'browser'|'reader'>('browser');
  return <div className="chat-browser-workspace"><div className="chat-browser-live-host" hidden={mode!=='browser'}><ChatLiveBrowser sessionId={sessionId} active={active&&mode==='browser'} onSiteIcon={onSiteIcon} onReadMode={()=>setMode('reader')}/></div><div className="chat-browser-reader-host" hidden={mode!=='reader'}><div className="browser-reader-toolbar"><button type="button" onClick={()=>setMode('browser')}>← 返回浏览器</button><span>正文读取</span></div><ChatPageReader sessionId={sessionId}/></div></div>;
}

export function ChatPageReader({ sessionId }: { sessionId: string }) {
  const [url,setUrl]=useState(''), [busy,setBusy]=useState(false), [error,setError]=useState('');
  const [snapshot,setSnapshot]=useState<{page: LinkReadResult; at: string}|null>(null);
  const controller=useRef<AbortController|null>(null);
  useEffect(()=>()=>controller.current?.abort(),[]);
  const read=async()=>{
    if(busy)return;
    let target: URL;
    try { target=new URL(url.trim()); if(!['http:','https:'].includes(target.protocol)||target.username||target.password)throw new Error(); }
    catch {setError('请输入不含账号密码的 HTTP 或 HTTPS 网页地址。');return;}
    const request=new AbortController();controller.current=request;setBusy(true);setError('');
    try {
      const page=await readBreakdownLink(target.href,request.signal);
      if(request.signal.aborted)return;
      if(!page.ok||!page.text?.trim()||!['http','browser'].includes(page.source||''))throw new Error(page.reason||'没有读取到可分析的网页正文。');
      let finalUrl: URL;
      try {finalUrl=new URL(page.url);if(!['http:','https:'].includes(finalUrl.protocol)||finalUrl.username||finalUrl.password)throw new Error();}
      catch {throw new Error('页面来源地址无效，请重新读取。');}
      setSnapshot({page:{...page,url:finalUrl.href},at:new Date().toISOString()});
    } catch(cause) {if(!request.signal.aborted)setError(cause instanceof Error?cause.message:'网页读取失败，请重试。');}
    finally {if(!request.signal.aborted)setBusy(false);}
  };
  const analyse=()=>{
    if(!snapshot)return;
    addChatDraftQuote(sessionId,browserPageQuote(snapshot.page,snapshot.at));
    setChatDraftText(sessionId,old=>[old,'请分析引用的网页：概括核心信息，指出有证据支持的结论与仍待核实的部分，并保留来源链接。'].filter(Boolean).join('\n\n'));
    showToast('页面证据已加入主对话草稿，发送后开始分析。','info');
  };
  return <section className="chat-browser-panel" aria-label="浏览器面板">
    <form className="chat-browser-address" onSubmit={event=>{event.preventDefault();void read();}}><IconCompass size={17}/><input aria-label="网页地址" placeholder="输入网页地址" type="url" value={url} onChange={event=>setUrl(event.target.value)} disabled={busy}/><button type="submit" disabled={busy||!url.trim()}>{busy?'读取中…':'读取'}</button></form>
    <p className="chat-panel-scope">网页正文模式 · 读取后可交给对话分析；当前不支持页面点击、截图与交互操作。</p>
    {error&&<p className="chat-panel-error" role="alert">{error}{snapshot?' 下方保留上次成功读取的页面。':''}</p>}
    {snapshot?<><header className="chat-browser-page-heading"><h3>{snapshot.page.title||'未提供标题'}</h3><a href={snapshot.page.url} target="_blank" rel="noreferrer">{snapshot.page.url}</a><small>{snapshot.page.source==='http'?'HTTP正文':'浏览器提取正文'} · {snapshot.page.text.length} 字 · {new Date(snapshot.at).toLocaleString('zh-CN',{hour12:false})}</small><button type="button" className="btn btn-sm" onClick={analyse} disabled={busy}>分析此页</button><p>将当前读取结果加入主对话草稿，保留你已输入的内容。</p></header><article className="chat-browser-page-text" aria-label="已读取网页正文">{snapshot.page.text}</article></>
      :<div className="chat-panel-tool-empty"><IconCompass size={28}/><h3>从一个网页开始</h3><p>读取页面标题、来源和正文，再让 Agent 根据页面证据分析。</p><p>内网页面与需要额外验证的页面可能无法读取；读取失败会显示原因。</p></div>}
  </section>;
}
