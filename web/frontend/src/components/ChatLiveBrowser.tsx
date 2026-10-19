import { useCallback, useEffect, useRef, useState } from 'react';
import { attachBrowserScreenshot, browserImageUrl, cancelBrowserCommand, closeBrowserSession, fetchBrowserState, runBrowserCommand, setBrowserControl } from '../lib/api';
import { browserQuote, type BrowserAction, type BrowserCommand, type BrowserElement, type BrowserState } from '../lib/browser';
import { addChatDraftQuote, appendChatDraftUploads, beginChatDraftUpload, finishChatDraftUpload, setChatDraftText } from '../lib/chatDrafts';
import { readLocalValue, writeLocalValue } from '../lib/localPersistence';
import { showToast } from '../lib/toast';

type View = 'image'|'text'|'elements'|'logs';
const tabKey = (sid: string) => `easel:browser-tab:${sid}`;
const message = (error: unknown) => error instanceof Error ? error.message : '浏览器操作失败，请重试。';
const operationNames: Record<string,string> = {create:'打开',navigate:'导航',back:'后退',forward:'前进',reload:'刷新',observe:'观察',click:'点击',fill:'填写',press:'按键',scroll:'滚动',close:'关闭',agent_control:'Agent控制',network:'网络',close_session:'关闭会话'};
const stateNames: Record<string,string> = {queued:'等待中',running:'进行中',completed:'已完成',failed:'失败',cancelled:'已中断',enabled:'已允许',disabled:'已关闭',blocked:'已拦截'};

export default function ChatLiveBrowser({sessionId, active = true}: {sessionId:string;active?:boolean}) {
  const [state,setState] = useState<BrowserState|null>(null), [error,setError] = useState('');
  const [url,setUrl] = useState(''), [tabId,setTabId] = useState(''), [view,setView] = useState<View>('image');
  const [requestId,setRequestId] = useState(''), [selected,setSelected] = useState(''), [fill,setFill] = useState('');
  const [adding,setAdding] = useState(false), [imageFailed,setImageFailed] = useState(false);
  const [selectedText,setSelectedText] = useState('');
  const generation = useRef(0), revision = useRef(0), currentSession = useRef(sessionId);
  const invalidate = useCallback(()=>{generation.current++;revision.current++;},[]);
  currentSession.current = sessionId;
  const refresh = useCallback(async(signal?:AbortSignal)=>{
    const seq=++revision.current;
    const result=await fetchBrowserState(sessionId,signal);
    if(currentSession.current===sessionId&&seq===revision.current&&!signal?.aborted)setState(result);
    return result;
  },[sessionId]);
  useEffect(()=>{
    const controller=new AbortController();
    generation.current++;setState(null);setError('');setUrl('');setSelected('');setRequestId('');
    setTabId(readLocalValue(tabKey(sessionId)).value||'');
    void refresh(controller.signal).catch(cause=>{if(!controller.signal.aborted)setError(message(cause));});
    return()=>{controller.abort();invalidate();};
  },[sessionId,refresh,invalidate]);
  useEffect(()=>{
    if(!active)return;
    const controller=new AbortController();
    const timer=setInterval(()=>{void refresh(controller.signal).catch(cause=>{if(!controller.signal.aborted)setError(message(cause));});},2000);
    return()=>{clearInterval(timer);controller.abort();};
  },[active,refresh]);
  const openTabs=state?.tabs.filter(tab=>!tab.closed)||[];
  const current=openTabs.find(tab=>tab.id===tabId)||openTabs.at(-1);
  const snapshot=current&&state?.snapshots[current.id];
  const liveJob=state&&[...state.jobs].reverse().find(job=>['queued','running'].includes(job.state)&&(!current||job.tabId===current.id));
  const busy=Boolean(requestId||liveJob);
  const usable=Boolean(snapshot&&!snapshot.stale&&!current?.stale&&!busy);
  const element=snapshot?.elements.find(item=>item.ref===selected);
  const chooseTab=(id:string)=>{setTabId(id);writeLocalValue(tabKey(sessionId),id);setSelected('');setFill('');};
  const currentId=current?.id, currentUrl=current?.url;
  useEffect(()=>{if(currentId)setUrl(currentUrl==='about:blank'?'':currentUrl||'');},[currentId,currentUrl]);
  useEffect(()=>{setSelected('');setFill('');setSelectedText('');setImageFailed(false);},[snapshot?.id]);

  const run=async(action:BrowserAction, extra:Partial<BrowserCommand>={})=>{
    if(busy)return;
    const id=crypto.randomUUID(), epoch=generation.current;
    setRequestId(id);setError('');
    try{
      const job=await runBrowserCommand(sessionId,{requestId:id,action,...(current?{tabId:current.id,snapshotId:snapshot?.id}:{}),...extra});
      if(generation.current!==epoch)return;
      if(job.tabId&&action!=='close')chooseTab(job.tabId);
      await refresh();
      if(generation.current===epoch&&job.state!=='completed')setError(job.error||'页面操作未确认完成，请重新观察。');
    }catch(cause){if(generation.current===epoch)setError(message(cause));}
    finally{if(generation.current===epoch)setRequestId('');}
  };
  const navigate=(event:React.FormEvent)=>{
    event.preventDefault();
    try{const target=new URL(url.trim());if(!['http:','https:'].includes(target.protocol)||target.username||target.password)throw new Error();
      void run(current?'navigate':'create',{url:target.href});
    }catch{setError('请输入不含账号密码的HTTP或HTTPS地址。');}
  };
  const cancel=async()=>{
    const id=requestId||liveJob?.id;if(!id)return;
    try{const job=await cancelBrowserCommand(sessionId,id);setError(job.error||'操作已中断，请重新观察页面。');await refresh();}
    catch(cause){setError(message(cause));}
  };
  const analyse=async(withImage=false, content:'page'|'selection'|BrowserElement='page')=>{
    if(!snapshot||!usable||adding)return;
    const token=withImage?beginChatDraftUpload(sessionId):null;
    if(withImage&&!token){setError('素材仍在处理中，请完成后再添加截图。');return;}
    setAdding(true);
    try{
      if(token){const evidence=await attachBrowserScreenshot(sessionId,snapshot.tabId,snapshot.id);appendChatDraftUploads(sessionId,token,[evidence.file]);}
      addChatDraftQuote(sessionId,browserQuote(content==='selection'&&selectedText?{...snapshot,selection:selectedText}:snapshot,content));
      setChatDraftText(sessionId,old=>[old,withImage?'请结合引用的页面资料与附带截图分析内容、布局和交互问题；用来源和观察证据支持结论，说明尚未验证之处。':'请分析引用的网页资料，概括核心信息，以观察证据支持结论并保留来源链接。'].filter(Boolean).join('\n\n'));
      showToast(withImage?'页面证据和截图已加入主草稿，发送后开始分析。':'页面证据已加入主草稿，发送后开始分析。','info');
      if(token)finishChatDraftUpload(sessionId,token,'');
    }catch(cause){setError(message(cause));if(token)finishChatDraftUpload(sessionId,token,message(cause));}
    finally{setAdding(false);}
  };
  const toggleControl=async()=>{
    if(!snapshot)return;
    const epoch=generation.current;
    try{const site=new URL(snapshot.url).origin;const result=await setBrowserControl(sessionId,snapshot.url,!state?.controlOrigins.includes(site));if(epoch===generation.current){revision.current++;setState(result);}}
    catch(cause){if(epoch===generation.current)setError(message(cause));}
  };
  const closeAll=async()=>{
    const epoch=generation.current;
    try{const result=await closeBrowserSession(sessionId);if(epoch===generation.current){revision.current++;setState(result);setRequestId('');setTabId('');setUrl('');setError('');}}
    catch(cause){if(epoch===generation.current)setError(message(cause));}
  };

  return <section className="chat-live-browser" aria-label="交互浏览器">
    <div className="browser-page-tabs" aria-label="浏览器网页标签">{openTabs.map(tab=><span key={tab.id}><button type="button" aria-pressed={tab.id===current?.id} title={tab.url} onClick={()=>chooseTab(tab.id)}>{tab.title}</button><button type="button" aria-label={`关闭网页：${tab.title}`} disabled={busy} onClick={()=>{chooseTab(tab.id);void run('close',{tabId:tab.id});}}>×</button></span>)}<button type="button" aria-label="新建网页标签" disabled={busy} onClick={()=>void run('create',{tabId:undefined})}>＋</button></div>
    <form className="chat-browser-address" onSubmit={navigate}>
      <button type="button" aria-label="网页后退" disabled={!current||busy} onClick={()=>void run('back')}>←</button>
      <button type="button" aria-label="网页前进" disabled={!current||busy} onClick={()=>void run('forward')}>→</button>
      <button type="button" aria-label="刷新网页" disabled={!current||busy} onClick={()=>void run('reload')}>↻</button>
      <input aria-label="交互网页地址" type="url" placeholder="输入网址，浏览与分析" value={url} onChange={event=>setUrl(event.target.value)} disabled={busy}/>
      <button type="submit" disabled={busy||!url.trim()}>前往</button>
    </form>
    {busy&&<div role="status" className="browser-running">页面操作中… <button type="button" onClick={()=>void cancel()}>停止操作</button></div>}
    {error&&<p role="alert" className="chat-panel-error">{error} <button type="button" onClick={()=>{const epoch=generation.current;void refresh().then(()=>{if(epoch===generation.current)setError('');}).catch(cause=>{if(epoch===generation.current)setError(message(cause));});}}>重新连接</button></p>}
    {snapshot?<><header className="browser-observation-heading"><strong>{snapshot.title||'未提供标题'}</strong><small>页面版本 {snapshot.version} · {new Date(snapshot.capturedAt).toLocaleTimeString('zh-CN',{hour12:false})}{snapshot.stale?' · 上次观察已过期':''}</small></header>
      <div className="browser-analysis-actions"><button type="button" disabled={!usable||adding} onClick={()=>void analyse()}>分析此页</button><button type="button" disabled={!usable||adding} onClick={()=>void analyse(true)}>{adding?'正在加入…':'带截图分析'}</button><button type="button" disabled={busy} onClick={()=>void run('observe')}>重新观察</button></div>
      <div className="browser-view-tabs" role="group" aria-label="页面观察内容">{([['image','页面'],['text','正文'],['elements','元素'],['logs','日志']] as const).map(([id,label])=><button type="button" key={id} aria-pressed={view===id} onClick={()=>setView(id)}>{label}</button>)}</div>
      {view==='image'&&<div className="browser-preview"><button type="button" className="browser-screenshot" aria-label="网页截图，鼠标点击页面操作，键盘激活查看元素" disabled={!usable||imageFailed} onClick={event=>{if(!usable)return;if(event.detail===0){setView('elements');return;}const box=event.currentTarget.getBoundingClientRect();void run('click',{x:(event.clientX-box.left)/box.width*snapshot.viewport.width,y:(event.clientY-box.top)/box.height*snapshot.viewport.height});}}>{imageFailed?<span>截图暂不可读，请重新观察。</span>:<img src={browserImageUrl(sessionId,snapshot.tabId,snapshot.id)} alt={`网页快照：${snapshot.title}`} onError={()=>setImageFailed(true)}/>}</button><p>当前页面快照 · 点击页面可交互，操作后重新观察。</p><div className="browser-scroll-actions"><button type="button" disabled={!usable} onClick={()=>void run('scroll',{deltaY:-600})}>向上滚动</button><button type="button" disabled={!usable} onClick={()=>void run('scroll',{deltaY:600})}>向下滚动</button></div></div>}
      {view==='text'&&<><article className="chat-browser-page-text" aria-label="浏览器实际正文" onMouseUp={event=>{const selection=window.getSelection();if(selection&&event.currentTarget.contains(selection.anchorNode)&&event.currentTarget.contains(selection.focusNode))setSelectedText(selection.toString().slice(0,8000));}}>{snapshot.text||'当前页面没有可读取的正文。'}</article>{(selectedText||snapshot.selection)&&<div className="browser-selection"><blockquote>{selectedText||snapshot.selection}</blockquote><button type="button" disabled={!usable} onPointerDown={event=>event.preventDefault()} onClick={()=>void analyse(false,'selection')}>引用页面选区</button></div>}</>}
      {view==='elements'&&<div className="browser-elements"><p>点击元素查看操作。标识只适用于本次观察；页面变化后重新观察。</p><div className="browser-element-list">{snapshot.elements.map(item=><button type="button" key={item.ref} aria-pressed={selected===item.ref} onClick={()=>{setSelected(item.ref);setFill('');}}><code>{item.ref}</code><span><small>{item.role}</small>{item.name||'未命名元素'}{item.disabled?' · 不可用':''}{item.sensitive?' · 手动处理':''}</span></button>)}</div>{element&&<div className="browser-element-actions"><strong>{element.name||element.ref}</strong><button type="button" disabled={!usable||element.disabled||element.sensitive} onClick={()=>void run('click',{ref:element.ref})}>点击元素</button>{(element.role==='textbox'||element.tag==='textarea'||element.tag==='input')&&!element.sensitive&&<><input aria-label="填写所选元素" value={fill} onChange={event=>setFill(event.target.value)} placeholder="输入要填写的文字"/><button type="button" disabled={!usable||element.disabled} onClick={()=>void run('fill',{ref:element.ref,text:fill})}>填写</button><button type="button" disabled={!usable||element.disabled} onClick={()=>void run('press',{ref:element.ref,key:'Enter'})}>按Enter</button></>}<button type="button" disabled={!usable} onClick={()=>void analyse(false,element)}>引用元素</button></div>}{snapshot.frames.length>0&&<p>页面含 {snapshot.frames.length} 个嵌入框架；元素列表展示当前顶层文档，截图包含可见框架。</p>}</div>}
      {view==='logs'&&<div className="browser-logs"><h4>控制台与网络（最近40条）</h4>{snapshot.logs.map((log,index)=><pre key={index}>{log.kind} {log.status||log.level||''} {log.text||log.url}</pre>)}<h4>浏览器操作</h4>{state?.events.slice(-30).reverse().map(event=><p key={event.id}>{operationNames[event.action]||event.action} · {stateNames[event.state]||event.state}{event.message?' · '+event.message:''}</p>)}</div>}
      <footer className="browser-session-footer"><label><input type="checkbox" checked={state?.controlOrigins.includes(new URL(snapshot.url==='about:blank'?'https://invalid.local':snapshot.url).origin)||false} onChange={()=>void toggleControl()} disabled={busy||snapshot.url==='about:blank'}/>允许Agent在此站点操作</label><small>当前对话独立浏览器配置；开启后Agent可点击和填写页面。</small></footer>
    </>:<div className="chat-panel-tool-empty"><h3>{state?'打开一个网页':'正在连接浏览器'}</h3><p>浏览真实页面、查看截图与元素，再把证据带入对话分析。</p>{state?.tabs.some(tab=>tab.closed)&&<details><summary>重新打开已断开的页面</summary>{state.tabs.filter(tab=>tab.closed&&tab.url&&tab.url!=='about:blank').slice(-6).map(tab=><button type="button" key={tab.id} disabled={busy} onClick={()=>void run('create',{url:tab.url,tabId:undefined})}>{tab.title}</button>)}</details>}</div>}
    {openTabs.length>0&&<button type="button" className="browser-close-session" disabled={busy} onClick={()=>void closeAll()}>关闭此对话的浏览器会话</button>}
  </section>;
}
