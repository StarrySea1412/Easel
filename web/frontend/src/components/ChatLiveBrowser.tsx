import { useCallback, useEffect, useRef, useState } from 'react';
import { attachBrowserScreenshot, browserImageUrl, cancelBrowserCommand, closeBrowserSession, fetchBrowserState, runBrowserCommand, setBrowserControl } from '../lib/api';
import { browserQuote, type BrowserAction, type BrowserCommand, type BrowserElement, type BrowserState } from '../lib/browser';
import { addChatDraftQuote, appendChatDraftUploads, beginChatDraftUpload, finishChatDraftUpload, setChatDraftText } from '../lib/chatDrafts';
import { readLocalValue, writeLocalValue } from '../lib/localPersistence';
import { showToast } from '../lib/toast';
import { IconChat, IconChevron, IconCompass, IconImage, IconPlus, IconRefresh, IconStop } from './icons';
import SiteIcon from './BrowserSiteIcon';

type View = 'image'|'text'|'elements'|'logs';
const tabKey = (sid: string) => `easel:browser-tab:${sid}`;
const message = (error: unknown) => error instanceof Error ? error.message : '浏览器操作失败，请重试。';
const operationNames: Record<string,string> = {create:'打开',navigate:'导航',back:'后退',forward:'前进',reload:'刷新',observe:'观察',click:'点击',fill:'填写',press:'按键',scroll:'滚动',resize:'适配网页',close:'关闭',agent_control:'Agent控制',network:'网络',close_session:'关闭会话'};
const stateNames: Record<string,string> = {queued:'等待中',running:'进行中',completed:'已完成',failed:'失败',cancelled:'已中断',enabled:'已允许',disabled:'已关闭',blocked:'已拦截'};

function InspectIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3"/><path d="m9 9 3 9 1.5-4.5L18 12Z"/></svg>;
}
function MoreIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>;
}
function readableAddress(value: string) {
  try { const parsed=new URL(value); return parsed.host || value; } catch { return value; }
}

export default function ChatLiveBrowser({sessionId, active = true, onReadMode, onSiteIcon}: {sessionId:string;active?:boolean;onReadMode?:()=>void;onSiteIcon?:(source:string)=>void}) {
  const [state,setState] = useState<BrowserState|null>(null), [actionError,setError] = useState(''), [connectionError,setConnectionError]=useState('');
  const error=[connectionError,actionError].filter(Boolean).join(' ');
  const [url,setUrl] = useState(''), [tabId,setTabId] = useState(''), [view,setView] = useState<View>('image');
  const [requestId,setRequestId] = useState(''), [selected,setSelected] = useState(''), [fill,setFill] = useState('');
  const [adding,setAdding] = useState(false), [imageFailed,setImageFailed] = useState(false);
  const [selectedText,setSelectedText] = useState(''), [addressFocused,setAddressFocused] = useState(false);
  const stage = useRef<HTMLDivElement>(null), menu = useRef<HTMLDetailsElement>(null), address = useRef<HTMLInputElement>(null);
  const [viewport,setViewport] = useState<{width:number;height:number}|null>(null);
  const resizeFailed = useRef('');
  const commandPending = useRef(false);
  useEffect(()=>{
    const target=stage.current;
    if(!target||typeof ResizeObserver==='undefined')return;
    let timer:ReturnType<typeof setTimeout>;
    const observer=new ResizeObserver(()=>{
      clearTimeout(timer);
      timer=setTimeout(()=>{
        const rect=target.getBoundingClientRect();
        if(rect.width>=280&&rect.height>=240)setViewport(old=>{
          const next={width:Math.min(1920,Math.floor(rect.width)),height:Math.min(1600,Math.floor(rect.height))};
          return old?.width===next.width&&old?.height===next.height?old:next;
        });
      },350);
    });
    observer.observe(target);
    return()=>{clearTimeout(timer);observer.disconnect();};
  },[]);
  useEffect(()=>{
    const close=(event:PointerEvent)=>{if(menu.current&&!menu.current.contains(event.target as Node))menu.current.open=false;};
    document.addEventListener('pointerdown',close);
    return()=>document.removeEventListener('pointerdown',close);
  },[]);
  const dismissMenu=()=>{if(menu.current)menu.current.open=false;};
  const generation = useRef(0), revision = useRef(0), currentSession = useRef(sessionId);
  const invalidate = useCallback(()=>{generation.current++;revision.current++;},[]);
  currentSession.current = sessionId;
  const refresh = useCallback(async(signal?:AbortSignal)=>{
    const seq=++revision.current;
    const result=await fetchBrowserState(sessionId,signal);
    if(currentSession.current===sessionId&&seq===revision.current&&!signal?.aborted){setState(result);setConnectionError('');}
    return result;
  },[sessionId]);
  useEffect(()=>{
    const controller=new AbortController();
    generation.current++;commandPending.current=false;resizeFailed.current='';setState(null);setView('image');setError('');setConnectionError('');setUrl('');setSelected('');setRequestId('');
    setTabId(readLocalValue(tabKey(sessionId)).value||'');
    void refresh(controller.signal).catch(cause=>{if(!controller.signal.aborted)setConnectionError(message(cause));});
    return()=>{controller.abort();invalidate();};
  },[sessionId,refresh,invalidate]);
  useEffect(()=>{
    if(!active)return;
    let disposed=false,reading=false;
    let timer:ReturnType<typeof setTimeout>|undefined;
    let request:AbortController|undefined;
    const read=async()=>{
      if(disposed||document.hidden||reading)return;
      reading=true;request=new AbortController();const currentRequest=request;
      const deadline=setTimeout(()=>currentRequest.abort(),12000);
      try{await refresh(currentRequest.signal);if(currentRequest.signal.aborted&&!disposed)setConnectionError('浏览器连接超时，请重新连接。');}
      catch(cause){if(!disposed)setConnectionError(currentRequest.signal.aborted?'浏览器连接超时，请重新连接。':message(cause));}
      finally{clearTimeout(deadline);reading=false;if(!disposed&&!document.hidden)timer=setTimeout(()=>void read(),2000);}
    };
    const visibility=()=>{clearTimeout(timer);if(!document.hidden)void read();};
    document.addEventListener('visibilitychange',visibility);
    timer=setTimeout(()=>void read(),2000);
    return()=>{disposed=true;clearTimeout(timer);request?.abort();document.removeEventListener('visibilitychange',visibility);};
  },[active,refresh]);
  const openTabs=state?.tabs.filter(tab=>!tab.closed)||[];
  const current=openTabs.find(tab=>tab.id===tabId)||openTabs.at(-1);
  const snapshot=current&&state?.snapshots[current.id];
  useEffect(()=>{onSiteIcon?.(snapshot?.favicon||'');},[snapshot?.favicon,onSiteIcon]);
  const liveJob=state&&[...state.jobs].reverse().find(job=>['queued','running'].includes(job.state)&&(!current||job.tabId===current.id));
  const busy=Boolean(requestId||liveJob);
  const usable=Boolean(snapshot&&!snapshot.stale&&!current?.stale&&!busy);
  const element=snapshot?.elements.find(item=>item.ref===selected);
  const chooseTab=useCallback((id:string)=>{setTabId(id);writeLocalValue(tabKey(sessionId),id);setSelected('');setFill('');},[sessionId]);
  const currentId=current?.id, currentUrl=current?.url;
  useEffect(()=>{if(currentId)setUrl(currentUrl==='about:blank'?'':currentUrl||'');},[currentId,currentUrl]);
  useEffect(()=>{setSelected('');setFill('');setSelectedText('');setImageFailed(false);},[snapshot?.id]);

  const run=useCallback(async(action:BrowserAction, extra:Partial<BrowserCommand>={})=>{
    if(busy||commandPending.current)return;
    commandPending.current=true;
    const id=crypto.randomUUID(), epoch=generation.current;
    setRequestId(id);if(action!=='resize')setError('');
    try{
      const job=await runBrowserCommand(sessionId,{requestId:id,action,...(action==='create'&&viewport?viewport:{}),...(current?{tabId:current.id,snapshotId:snapshot?.id}:{}),...extra});
      if(generation.current!==epoch)return;
      if(job.tabId&&action!=='close')chooseTab(job.tabId);
      await refresh();
      if(generation.current===epoch&&job.state!=='completed')setError(job.error||'页面操作未确认完成，请重新观察。');
    }catch(cause){if(generation.current===epoch)setError(message(cause));}
    finally{if(generation.current===epoch){commandPending.current=false;setRequestId('');}}
  },[busy,sessionId,current,snapshot,viewport,refresh,chooseTab]);
  useEffect(()=>{
    if(!active||!current||!snapshot||!viewport||busy||snapshot.stale||current.stale)return;
    if(snapshot.viewport.width===viewport.width&&snapshot.viewport.height===viewport.height)return;
    const key=`${sessionId}:${current.id}:${viewport.width}:${viewport.height}`;
    if(resizeFailed.current===key)return;
    resizeFailed.current=key;
    void run('resize',viewport);
  },[active,current,snapshot,viewport,busy,sessionId,run]);
  const navigate=(event:React.FormEvent)=>{
    event.preventDefault();
    try{const target=new URL(/^[a-z][a-z\d+.-]*:/i.test(url.trim())?url.trim():'https://'+url.trim());if(!['http:','https:'].includes(target.protocol)||target.username||target.password)throw new Error();
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

  const inspect=(next:View)=>{setView(next);dismissMenu();};
  const granted=Boolean(snapshot&&snapshot.url!=='about:blank'&&state?.controlOrigins.includes(new URL(snapshot.url).origin));
  const stopOrReload=()=>busy?void cancel():void run('reload');
  const reconnect=()=>{const epoch=generation.current;void refresh().then(()=>{if(epoch===generation.current)setError('');}).catch(cause=>{if(epoch===generation.current)setError(message(cause));});};
  return <section className="chat-live-browser" aria-label="交互浏览器" onKeyDown={event=>{
    if(event.key==='Escape'){
      if(menu.current?.open){dismissMenu();menu.current.querySelector('summary')?.focus();}
      else if(view!=='image'){setView('image');}
    }
  }}>
    {openTabs.length>1&&<div className="browser-page-tabs" aria-label="浏览器网页标签">{openTabs.map(tab=><span key={tab.id} className={tab.id===current?.id?'is-on':''}>
      <button type="button" aria-pressed={tab.id===current?.id} title={tab.url} onClick={()=>chooseTab(tab.id)}><SiteIcon source={state?.snapshots[tab.id]?.favicon}/><span>{tab.title==='about:blank'?'新标签页':tab.title}</span></button>
      <button type="button" aria-label={`关闭网页：${tab.title}`} disabled={busy} onClick={()=>{chooseTab(tab.id);void run('close',{tabId:tab.id});}}>×</button>
    </span>)}<button type="button" className="browser-icon-button" aria-label="新建网页标签" title="新建网页标签" disabled={busy} onClick={()=>void run('create',{tabId:undefined})}><IconPlus size={15}/></button></div>}
    <div className="browser-toolbar">
      <div className="browser-history-group"><button type="button" className="browser-icon-button" aria-label="网页后退" title="后退" disabled={!current||busy} onClick={()=>void run('back')}><IconChevron size={15} className="browser-back-icon"/></button><button type="button" className="browser-icon-button" aria-label="网页前进" title="前进" disabled={!current||busy} onClick={()=>void run('forward')}><IconChevron size={15}/></button></div>
      <button type="button" className="browser-icon-button browser-round-button" aria-label={busy?'停止操作':'刷新网页'} title={busy?'停止操作':'刷新网页'} disabled={!current&&!busy} onClick={stopOrReload}>{busy?<IconStop size={13}/>:<IconRefresh size={15}/>}</button>
      <button type="button" className="browser-icon-button browser-round-button" aria-label="查看页面元素" title="查看页面元素" aria-pressed={view==='elements'} disabled={!snapshot} onClick={()=>setView(view==='elements'?'image':'elements')}><InspectIcon/></button>
      <form className="browser-location" onSubmit={navigate}>
        <input ref={address} aria-label="交互网页地址" type="text" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="输入网址" value={addressFocused?url:readableAddress(url)} onFocus={()=>{setAddressFocused(true);requestAnimationFrame(()=>address.current?.select());}} onBlur={()=>setAddressFocused(false)} onChange={event=>setUrl(event.target.value)} disabled={busy}/>
      </form>
      <button type="button" className="browser-icon-button browser-round-button browser-analyse-button" aria-label="分析此页" title="分析此页，加入对话草稿" disabled={!usable||adding} onClick={()=>void analyse()}><IconChat size={15}/></button>
      <details className="browser-more" ref={menu}>
        <summary className="browser-icon-button browser-round-button" aria-label="浏览器更多操作" title="更多操作"><MoreIcon/></summary>
        <div className="browser-menu">
          <span className="browser-menu-label">页面工具</span>
          <button type="button" disabled={!usable||adding} onClick={()=>{dismissMenu();void analyse(true);}}><IconImage size={15}/><span>{adding?'正在加入…':'带截图分析'}</span></button>
          <button type="button" disabled={!current||busy} onClick={()=>{dismissMenu();void run('observe');}}><IconRefresh size={15}/><span>重新观察</span></button>
          <button type="button" disabled={!snapshot} onClick={()=>inspect('text')}><span className="browser-menu-glyph">Aa</span><span>网页正文</span></button>
          <button type="button" disabled={!snapshot} onClick={()=>inspect('logs')}><span className="browser-menu-glyph">⌘</span><span>操作日志</span></button>
          <div className="browser-menu-divider"/>
          <label className="browser-control-toggle"><input type="checkbox" checked={granted} onChange={()=>void toggleControl()} disabled={busy||!snapshot||snapshot.url==='about:blank'}/><span>允许Agent在此站点操作<small>仅当前对话，可随时关闭</small></span></label>
          <div className="browser-menu-divider"/>
          <button type="button" disabled={busy} onClick={()=>{dismissMenu();void run('create',{tabId:undefined});}}><IconPlus size={15}/><span>新建网页标签</span></button>
          {current&&<button type="button" disabled={busy} onClick={()=>{dismissMenu();void run('close');}}><span className="browser-menu-glyph">×</span><span>关闭当前网页</span></button>}
          {onReadMode&&<button type="button" onClick={()=>{dismissMenu();onReadMode();}}><span className="browser-menu-glyph">Aa</span><span>正文读取</span></button>}
          {openTabs.length>0&&<button type="button" disabled={busy} onClick={()=>{dismissMenu();void closeAll();}}><span className="browser-menu-glyph">×</span><span>关闭浏览器会话</span></button>}
          {snapshot&&<p className="browser-menu-meta" title={snapshot.title}>{snapshot.title}<br/>版本 {snapshot.version} · {new Date(snapshot.capturedAt).toLocaleTimeString('zh-CN',{hour12:false})}</p>}
        </div>
      </details>
    </div>
    {error&&<div role="alert" className="browser-error"><span>{error}</span>{current&&<button type="button" disabled={busy} onClick={()=>void run('observe')}>重新观察</button>}<button type="button" onClick={reconnect}>重新连接</button><button type="button" aria-label="收起浏览器提示" onClick={()=>{setError('');setConnectionError('');}}>×</button></div>}
    <div className="browser-stage" ref={stage} aria-busy={busy}>
      {busy&&<div className="browser-loading-line" role="status"><span className="browser-sr-only">页面操作中</span></div>}
      {snapshot&&snapshot.url!=='about:blank'?<button type="button" className="browser-screenshot" aria-label="网页截图，鼠标点击页面操作，键盘激活查看元素" disabled={!usable||imageFailed}
        onWheel={event=>{if(usable&&Math.abs(event.deltaY)>4)void run('scroll',{deltaY:Math.round(Math.max(-1600,Math.min(1600,event.deltaY*(event.deltaMode===1?20:1))))});}}
        onKeyDown={event=>{if(['PageDown','PageUp','ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();if(usable)void run('scroll',{deltaY:['PageDown','ArrowDown'].includes(event.key)?600:-600});}}}
        onClick={event=>{
          if(!usable)return;
          if(event.detail===0){setView('elements');return;}
          const image=event.currentTarget.querySelector('img');if(!image)return;
          const box=image.getBoundingClientRect();
          void run('click',{x:(event.clientX-box.left)/box.width*snapshot.viewport.width,y:(event.clientY-box.top)/box.height*snapshot.viewport.height});
        }}>{imageFailed?<span className="browser-image-error">截图暂不可读，请从更多操作重新观察。</span>:<img src={browserImageUrl(sessionId,snapshot.tabId,snapshot.id)} alt={`网页快照：${snapshot.title}`} draggable={false} onError={()=>setImageFailed(true)}/>}</button>
        :<div className="browser-start"><span className="browser-start-icon"><IconCompass size={32}/></span><h3>{state?'从一个网页开始':'正在连接浏览器'}</h3><p>浏览网页，把发现带回对话。</p><form className="browser-start-address" onSubmit={navigate}><IconCompass size={16}/><input aria-label="起始网页地址" type="text" inputMode="url" placeholder="输入网址，按 Enter 打开" value={url} onChange={event=>setUrl(event.target.value)} disabled={busy}/><button type="submit" aria-label="打开网页" disabled={busy||!url.trim()}><IconChevron size={16}/></button></form>
          {state?.tabs.some(tab=>tab.closed)&&<details className="browser-reopen"><summary>最近关闭</summary>{state.tabs.filter(tab=>tab.closed&&tab.url&&tab.url!=='about:blank').slice(-6).map(tab=><button type="button" key={tab.id} disabled={busy} onClick={()=>void run('create',{url:tab.url,tabId:undefined})}><SiteIcon/><span>{tab.title}</span></button>)}</details>}
        </div>}
      {snapshot&&view!=='image'&&<section className="browser-inspector" aria-label="页面资料">
        <header><div className="browser-view-tabs" role="group" aria-label="页面观察内容">{([['text','正文'],['elements','元素'],['logs','日志']] as const).map(([id,label])=><button type="button" key={id} aria-pressed={view===id} onClick={()=>setView(id)}>{label}</button>)}</div><button type="button" className="browser-icon-button" aria-label="关闭页面资料" onClick={()=>setView('image')}>×</button></header>
        <div className="browser-inspector-content">
          {view==='text'&&<><article className="chat-browser-page-text" aria-label="浏览器实际正文" onMouseUp={event=>{const selection=window.getSelection();if(selection&&event.currentTarget.contains(selection.anchorNode)&&event.currentTarget.contains(selection.focusNode))setSelectedText(selection.toString().slice(0,8000));}}>{snapshot.text||'当前页面没有可读取的正文。'}</article>{(selectedText||snapshot.selection)&&<div className="browser-selection"><blockquote>{selectedText||snapshot.selection}</blockquote><button type="button" disabled={!usable} onPointerDown={event=>event.preventDefault()} onClick={()=>void analyse(false,'selection')}>引用页面选区</button></div>}</>}
          {view==='elements'&&<div className="browser-elements"><p>选择元素以点击、填写或引用。</p><div className="browser-element-list">{snapshot.elements.map(item=><button type="button" key={item.ref} aria-pressed={selected===item.ref} onClick={()=>{setSelected(item.ref);setFill('');}}><code>{item.ref}</code><span><small>{item.role}</small>{item.name||'未命名元素'}{item.disabled?' · 不可用':''}{item.sensitive?' · 手动处理':''}</span></button>)}</div>{element&&<div className="browser-element-actions"><strong>{element.name||element.ref}</strong><button type="button" disabled={!usable||element.disabled||element.sensitive} onClick={()=>void run('click',{ref:element.ref})}>点击元素</button>{(element.role==='textbox'||element.tag==='textarea'||element.tag==='input')&&!element.sensitive&&<><input aria-label="填写所选元素" value={fill} onChange={event=>setFill(event.target.value)} placeholder="输入要填写的文字"/><button type="button" disabled={!usable||element.disabled} onClick={()=>void run('fill',{ref:element.ref,text:fill})}>填写</button><button type="button" disabled={!usable||element.disabled} onClick={()=>void run('press',{ref:element.ref,key:'Enter'})}>按Enter</button></>}<button type="button" disabled={!usable} onClick={()=>void analyse(false,element)}>引用元素</button></div>}{snapshot.frames.length>0&&<p>含 {snapshot.frames.length} 个嵌入框架；当前列表为顶层文档元素。</p>}</div>}
          {view==='logs'&&<div className="browser-logs"><h4>控制台与网络</h4>{snapshot.logs.length?snapshot.logs.map((log,index)=><pre key={index}>{log.kind} {log.status||log.level||''} {log.text||log.url}</pre>):<p>暂无日志</p>}<h4>浏览器操作</h4>{state?.events.slice(-30).reverse().map(event=><p key={event.id}>{operationNames[event.action]||event.action} · {stateNames[event.state]||event.state}{event.message?' · '+event.message:''}</p>)}</div>}
        </div>
      </section>}
    </div>
    {snapshot&&snapshot.url!=='about:blank'&&<footer className="browser-statusbar"><span className={'browser-status-dot'+(busy?' is-busy':snapshot.stale||current?.stale?' is-stale':'')}/><span title={`${snapshot.title} · 版本 ${snapshot.version}`}>{busy?'正在更新页面':snapshot.stale||current?.stale?'页面已变化，需重新观察':'页面快照 · 可点击与滚动'}</span>{granted&&<span className="browser-control-status">Agent可操作</span>}<div className="browser-scroll-actions"><button type="button" aria-label="向上滚动" title="向上滚动" disabled={!usable} onClick={()=>void run('scroll',{deltaY:-600})}><IconChevron size={12} className="browser-up-icon"/></button><button type="button" aria-label="向下滚动" title="向下滚动" disabled={!usable} onClick={()=>void run('scroll',{deltaY:600})}><IconChevron size={12} className="browser-down-icon"/></button></div></footer>}
  </section>;
}
