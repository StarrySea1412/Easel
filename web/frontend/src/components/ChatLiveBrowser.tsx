import { useCallback, useEffect, useRef, useState } from 'react';
import { attachBrowserScreenshot, browserImageUrl, browserDownloadUrl, cancelBrowserCommand, closeBrowserSession, fetchBrowserState, runBrowserCommand, setBrowserControl } from '../lib/api';
import { browserQuote, decodeBrowserState, type BrowserAction, type BrowserCommand, type BrowserElement, type BrowserState } from '../lib/browser';
import { browserCastUrl, createLiveInput, setUserBrowserControl, type LiveInputChannel, type LiveInputEvent } from '../lib/browserLive';
import { addChatDraftQuote, appendChatDraftUploads, beginChatDraftUpload, finishChatDraftUpload, setChatDraftText } from '../lib/chatDrafts';
import { readLocalValue, writeLocalValue } from '../lib/localPersistence';
import { showToast } from '../lib/toast';
import { IconChat, IconChevron, IconCompass, IconImage, IconPlus, IconRefresh, IconSpark, IconStop } from './icons';
import SiteIcon from './BrowserSiteIcon';
import { recordPageSource } from '../lib/chatSources';

type View = 'image'|'text'|'elements'|'logs'|'downloads';
const tabKey = (sid: string) => `easel:browser-tab:${sid}`;
const message = (error: unknown) => error instanceof Error ? error.message : '浏览器操作失败，请重试。';
const operationNames: Record<string,string> = {create:'打开',navigate:'导航',back:'后退',forward:'前进',reload:'刷新',observe:'观察',click:'点击',fill:'填写',press:'按键',scroll:'滚动',resize:'适配网页',download:'下载',close:'关闭',agent_control:'Agent控制',user_control:'人工接管',network:'网络',close_session:'关闭会话'};
const stateNames: Record<string,string> = {queued:'等待中',running:'进行中',completed:'已完成',failed:'失败',cancelled:'已中断',enabled:'已允许',disabled:'已关闭',blocked:'已拦截'};
const downloadNames:Record<string,string> = {receiving:'正在下载',saving:'正在保存',cancelling:'正在取消',completed:'已保存',failed:'下载失败'};
const fileSize=(size:number)=>size>=1048576?`${(size/1048576).toFixed(1)} MB`:size>=1024?`${(size/1024).toFixed(1)} KB`:`${size} B`;

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
  const [notice,setNotice] = useState(''), [live,setLive] = useState(false), [liveNonce,setLiveNonce] = useState(0);
  const [manual,setManual] = useState(false), [resuming,setResuming] = useState(false);
  const composing = useRef(false), liveText = useRef<HTMLTextAreaElement>(null);
  const controlEpoch = useRef(0);
  const [selectedText,setSelectedText] = useState(''), [addressFocused,setAddressFocused] = useState(false);
  const stage = useRef<HTMLDivElement>(null), menu = useRef<HTMLDetailsElement>(null), address = useRef<HTMLInputElement>(null);
  const liveImage = useRef<HTMLImageElement>(null), liveChannel = useRef<LiveInputChannel|null>(null);
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
    setTabId(readLocalValue(tabKey(sessionId)).value||'');setLive(true);setNotice('');setManual(false);setResuming(false);
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
  useEffect(()=>{
    if(snapshot&&!snapshot.stale&&snapshot.sessionId===sessionId)recordPageSource(sessionId,{id:`browser:${snapshot.id}`,url:snapshot.url,title:snapshot.title,at:snapshot.capturedAt,kind:'browser'});
  },[snapshot,sessionId]);
  useEffect(()=>{onSiteIcon?.(snapshot?.favicon||'');},[snapshot?.favicon,onSiteIcon]);
  const liveJob=state&&[...state.jobs].reverse().find(job=>['queued','running'].includes(job.state)&&(!current||job.tabId===current.id));
  const busy=Boolean(requestId||liveJob);
  const usable=Boolean(snapshot&&!snapshot.stale&&!current?.stale&&!busy);
  const element=snapshot?.elements.find(item=>item.ref===selected);
  const chooseTab=useCallback((id:string)=>{setTabId(id);writeLocalValue(tabKey(sessionId),id);setSelected('');setFill('');},[sessionId]);
  const currentId=current?.id, currentUrl=current?.url, currentClosed=Boolean(current?.closed);
  const supportsLive=Boolean(state?.capabilities.includes('live-input'));
  const usingLive=live&&supportsLive;
  const userControl=manual||Boolean(current?.userControl);
  useEffect(()=>{controlEpoch.current++;setManual(false);setResuming(false);composing.current=false;},[currentId]);
  useEffect(()=>{if(currentId)setUrl(currentUrl==='about:blank'?'':currentUrl||'');},[currentId,currentUrl]);
  useEffect(()=>{setSelected('');setFill('');setSelectedText('');setImageFailed(false);},[snapshot?.id]);
  useEffect(()=>{
    if(!active||!usingLive||!currentId||currentClosed){liveChannel.current?.close();liveChannel.current=null;return;}
    const channel=createLiveInput(sessionId,currentId);
    const off=channel.onError(setNotice);
    liveChannel.current=channel;
    return()=>{off();channel.close();if(liveChannel.current===channel)liveChannel.current=null;};
  },[active,usingLive,sessionId,currentId,currentClosed]);

  const run=useCallback(async(action:BrowserAction, extra:Partial<BrowserCommand>={})=>{
    if(commandPending.current)return;
    commandPending.current=true;
    const id=crypto.randomUUID(), epoch=generation.current;
    setRequestId(id);if(action!=='resize'){setError('');setNotice('');}
    try{
      if(current&&supportsLive&&action!=='create'&&action!=='observe'&&action!=='resize') {
        const targetId=extra.tabId||current.id;
        await setUserBrowserControl(sessionId,targetId,true);
        if(generation.current!==epoch)return;
        if(targetId===current.id)setManual(true);
      } else if(busy) { return; }
      const job=await runBrowserCommand(sessionId,{requestId:id,action,...(action==='create'&&viewport?viewport:{}),...(current?{tabId:current.id,snapshotId:snapshot?.id}:{}),...extra});
      if(generation.current!==epoch)return;
      if(job.tabId&&action!=='close')chooseTab(job.tabId);
      if(job.notice)setNotice(job.notice);
      if(job.focusRef){setView('elements');setSelected(job.focusRef);}
      await refresh();
      if(generation.current===epoch&&job.state!=='completed'&&!job.recovered)setError(job.error||'页面操作未确认完成，请重新观察。');
    }catch(cause){if(generation.current===epoch)setError(message(cause));}
    finally{if(generation.current===epoch){commandPending.current=false;setRequestId('');}}
  },[busy,sessionId,current,snapshot,viewport,refresh,chooseTab,supportsLive]);
  useEffect(()=>{
    if(!active||!current||!snapshot||!viewport||busy||userControl||snapshot.stale||current.stale)return;
    if(snapshot.viewport.width===viewport.width&&snapshot.viewport.height===viewport.height)return;
    const key=`${sessionId}:${current.id}:${viewport.width}:${viewport.height}`;
    if(resizeFailed.current===key)return;
    resizeFailed.current=key;
    void run('resize',viewport);
  },[active,current,snapshot,viewport,busy,userControl,sessionId,run]);
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
  const sendLive=(event:LiveInputEvent)=>{
    if(resuming||!liveChannel.current)return;
    setManual(true);
    liveChannel.current.send(event);
  };
  const resumeAgent=async()=>{
    if(!current||resuming)return;
    if(composing.current||liveChannel.current?.pending()){setNotice('输入尚在发送，请稍后继续。');return;}
    const epoch=generation.current;
    setResuming(true);setNotice('');
    const tabEpoch=controlEpoch.current;
    try {
      const result=decodeBrowserState(await setUserBrowserControl(sessionId,current.id,false),sessionId);
      if(epoch===generation.current&&tabEpoch===controlEpoch.current){revision.current++;setState(result);setManual(false);}
    } catch(cause){if(epoch===generation.current&&tabEpoch===controlEpoch.current)setNotice(message(cause));}
    finally{if(epoch===generation.current&&tabEpoch===controlEpoch.current)setResuming(false);}
  };
  const toggleLive=()=>{
    if(live){setLive(false);void run('observe');return;}
    if(!current||currentClosed)return;
    setLive(true);setLiveNonce(value=>value+1);setView('image');setError('');setNotice('');
  };
  const livePoint=(event:React.MouseEvent<HTMLDivElement>)=>{
    const box=event.currentTarget.getBoundingClientRect();
    // Input is sent in the page's CSS viewport, not in frame pixels: the
    // streamed JPEG can be scaled or downsampled independently.
    const width=current?.viewport?.width||snapshot?.viewport.width||1280;
    const height=current?.viewport?.height||snapshot?.viewport.height||800;
    const x=(event.clientX-box.left)/Math.max(1,box.width)*width;
    const y=(event.clientY-box.top)/Math.max(1,box.height)*height;
    return {x:Math.round(Math.max(0,Math.min(width-1,x))),y:Math.round(Math.max(0,Math.min(height-1,y)))};
  };
  const liveClick=(event:React.MouseEvent<HTMLDivElement>)=>{
    if(event.button!==0)return;
    event.preventDefault();
    liveText.current?.focus({preventScroll:true});
    const point=livePoint(event);
    sendLive({type:'click',...point});
  };
  const liveWheel=(event:React.WheelEvent<HTMLDivElement>)=>{
    if(!liveChannel.current)return;
    event.preventDefault();
    const delta=Math.max(-1600,Math.min(1600,Math.round(event.deltaY*(event.deltaMode===1?20:1))));
    if(delta)sendLive({type:'wheel',deltaY:delta});
  };
  const liveKey=(event:React.KeyboardEvent<HTMLDivElement>)=>{
    const channel=liveChannel.current;if(!channel)return;
    if(composing.current||event.nativeEvent.isComposing||event.key==='Process')return;
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='a'){
      event.preventDefault();sendLive({type:'key',key:event.metaKey?'Meta+A':'Control+A'});return;
    }
    if(['Enter','Tab','Escape','Backspace','Delete','Home','End','PageUp','PageDown','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)){
      event.preventDefault();sendLive({type:'key',key:event.key});
    }
  };
  const livePaste=(event:React.ClipboardEvent<HTMLDivElement>)=>{
    const text=event.clipboardData.getData('text');
    if(!text)return;
    event.preventDefault();
    sendLive({type:'text',text:text.slice(0,2000)});
  };
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
      <div className="browser-history-group"><button type="button" className="browser-icon-button" aria-label="网页后退" title="后退" disabled={!current||Boolean(requestId)} onClick={()=>void run('back')}><IconChevron size={15} className="browser-back-icon"/></button><button type="button" className="browser-icon-button" aria-label="网页前进" title="前进" disabled={!current||Boolean(requestId)} onClick={()=>void run('forward')}><IconChevron size={15}/></button></div>
      <button type="button" className="browser-icon-button browser-round-button" aria-label={busy?'停止操作':'刷新网页'} title={busy?'停止操作':'刷新网页'} disabled={!current&&!busy} onClick={stopOrReload}>{busy?<IconStop size={13}/>:<IconRefresh size={15}/>}</button>
      <button type="button" className="browser-icon-button browser-round-button" aria-label="查看页面元素" title="查看页面元素" aria-pressed={view==='elements'} disabled={!snapshot} onClick={()=>setView(view==='elements'?'image':'elements')}><InspectIcon/></button>
      {supportsLive&&<button type="button" className={'browser-icon-button browser-round-button browser-live-toggle'+(usingLive?' is-on':'')} aria-label={usingLive?'退出实时画面':'实时画面'} aria-pressed={usingLive} title={usingLive?'退出实时画面':'实时画面：可直接点击和输入'} disabled={!current||currentClosed} onClick={toggleLive}><IconSpark size={15}/></button>}
      {userControl&&<button type="button" className="browser-icon-button" aria-label="恢复Agent操作" title="恢复Agent操作" disabled={resuming} onClick={()=>void resumeAgent()}>{resuming?<IconRefresh size={15} className="spin"/>:<IconChevron size={15}/>}</button>}
      <form className="browser-location" onSubmit={navigate}>
        <input ref={address} aria-label="交互网页地址" type="text" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="输入网址" value={addressFocused?url:readableAddress(url)} onFocus={()=>{setAddressFocused(true);requestAnimationFrame(()=>address.current?.select());}} onBlur={()=>setAddressFocused(false)} onChange={event=>setUrl(event.target.value)} disabled={Boolean(requestId)}/>
      </form>
      {state?.capabilities.includes('downloads')&&<button type="button" className="browser-icon-button browser-round-button" aria-label="文件与下载" title={`文件与下载 · ${state.downloads.length}`} aria-pressed={view==='downloads'} onClick={()=>setView(view==='downloads'?'image':'downloads')}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></svg>{state.downloads.length>0&&<small>{state.downloads.length}</small>}</button>}
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
    {notice&&<div role="status" className="browser-notice"><span>{notice}</span><button type="button" aria-label="收起提示" onClick={()=>setNotice('')}>×</button></div>}
    <div className="browser-stage" ref={stage} aria-busy={busy}>
      {busy&&<div className="browser-loading-line" role="status"><span className="browser-sr-only">页面操作中</span></div>}
      {usingLive&&active&&current&&!currentClosed?<div className="browser-live-stage">
        <img ref={liveImage} src={`${browserCastUrl(sessionId,current.id)}?v=${liveNonce}`} alt={`实时画面：${current.title}`} draggable={false}
          onError={()=>{setLive(false);setNotice('实时画面连接中断，已退回快照模式。');}}/>
        <div className="browser-live-surface" tabIndex={0} role="application" aria-label="实时网页画面，可点击和输入"
          onFocus={event=>{if(event.target===event.currentTarget)liveText.current?.focus({preventScroll:true});}}
          onMouseDown={liveClick} onWheel={liveWheel} onKeyDown={liveKey} onPaste={livePaste}>
          <textarea ref={liveText} className="browser-live-ime" aria-label="网页键盘输入" autoComplete="off" autoCorrect="off" spellCheck={false} disabled={resuming}
            onCompositionStart={()=>{composing.current=true;}}
            onCompositionEnd={event=>{composing.current=false;const value=event.currentTarget.value;event.currentTarget.value='';if(value)sendLive({type:'text',text:value.slice(0,2000)});}}
            onInput={event=>{if(composing.current)return;const value=event.currentTarget.value;event.currentTarget.value='';if(value)sendLive({type:'text',text:value.slice(0,2000)});}}/>
        </div>
      </div>
        :snapshot&&snapshot.url!=='about:blank'?<button type="button" className="browser-screenshot" aria-label="网页截图，鼠标点击页面操作，键盘激活查看元素" disabled={!usable||imageFailed}
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
      {(snapshot||view==='downloads')&&view!=='image'&&<section className="browser-inspector" aria-label="页面资料">
        <header><div className="browser-view-tabs" role="group" aria-label="页面观察内容">{([['text','正文'],['elements','元素'],['logs','日志'],['downloads','下载']] as const).filter(([id])=>id!=='downloads'||state?.capabilities.includes('downloads')).map(([id,label])=><button type="button" key={id} aria-pressed={view===id} disabled={!snapshot&&id!=='downloads'} onClick={()=>setView(id)}>{label}</button>)}</div><button type="button" className="browser-icon-button" aria-label="关闭页面资料" onClick={()=>setView('image')}>×</button></header>
        <div className="browser-inspector-content">
          {view==='downloads'&&<div className="browser-downloads"><h4>网页下载</h4><p>网页触发的文件自动保存到当前对话。下载完成后可取回本机或加入草稿。</p>{state?.downloads.length?state.downloads.slice().reverse().map(file=><article key={file.id}><strong>{file.name}</strong><span role="status">{downloadNames[file.state]||file.state} · {fileSize(file.bytes)}</span>{file.error&&<p role="alert">{file.error}</p>}{file.state==='completed'&&file.file&&<div><a href={browserDownloadUrl(sessionId,file.id)} download={file.name}>下载到本机</a><button type="button" onClick={()=>{const token=beginChatDraftUpload(sessionId);if(!token){showToast('当前草稿暂不可添加附件，请稍后重试。','info');return;}appendChatDraftUploads(sessionId,token,[file.file!]);finishChatDraftUpload(sessionId,token,'');showToast('已加入当前对话草稿。','info');}}>加入对话</button></div>}</article>):<p>暂无下载。可点击网页中的下载按钮，或从下方已识别入口选择文件。</p>}{Boolean(snapshot?.downloadCandidates?.length)&&<><h4>当前页面的下载入口</h4><p>入口可能打开预览或菜单，实际文件保存后才会显示“已保存”。</p>{snapshot?.downloadCandidates?.map(item=><button type="button" key={item.ref} disabled={!usable} onClick={()=>void run('download',{ref:item.ref})}>{item.name||'下载文件'}</button>)}</>}</div>}
          {view==='text'&&snapshot&&<><article className="chat-browser-page-text" aria-label="浏览器实际正文" onMouseUp={event=>{const selection=window.getSelection();if(selection&&event.currentTarget.contains(selection.anchorNode)&&event.currentTarget.contains(selection.focusNode))setSelectedText(selection.toString().slice(0,8000));}}>{snapshot.text||'当前页面没有可读取的正文。'}</article>{(selectedText||snapshot.selection)&&<div className="browser-selection"><blockquote>{selectedText||snapshot.selection}</blockquote><button type="button" disabled={!usable} onPointerDown={event=>event.preventDefault()} onClick={()=>void analyse(false,'selection')}>引用页面选区</button></div>}</>}
          {view==='elements'&&snapshot&&<div className="browser-elements"><p>选择元素以点击、填写或引用。</p><div className="browser-element-list">{snapshot.elements.map(item=><button type="button" key={item.ref} aria-pressed={selected===item.ref} onClick={()=>{setSelected(item.ref);setFill('');}}><code>{item.ref}</code><span><small>{item.role}</small>{item.name||'未命名元素'}{item.disabled?' · 不可用':''}{item.sensitive?' · 手动处理':''}</span></button>)}</div>{element&&<div className="browser-element-actions"><strong>{element.name||element.ref}</strong><button type="button" disabled={!usable||element.disabled||element.sensitive} onClick={()=>void run('click',{ref:element.ref})}>点击元素</button>{(element.role==='textbox'||element.tag==='textarea'||element.tag==='input')&&!element.sensitive&&<><input aria-label="填写所选元素" value={fill} onChange={event=>setFill(event.target.value)} placeholder="输入要填写的文字"/><button type="button" disabled={!usable||element.disabled} onClick={()=>void run('fill',{ref:element.ref,text:fill})}>填写</button><button type="button" disabled={!usable||element.disabled} onClick={()=>void run('press',{ref:element.ref,key:'Enter'})}>按Enter</button></>}<button type="button" disabled={!usable} onClick={()=>void analyse(false,element)}>引用元素</button></div>}{snapshot.frames.length>0&&<p>含 {snapshot.frames.length} 个嵌入框架；当前列表为顶层文档元素。</p>}</div>}
          {view==='logs'&&snapshot&&<div className="browser-logs"><h4>控制台与网络</h4>{snapshot.logs.length?snapshot.logs.map((log,index)=><pre key={index}>{log.kind} {log.status||log.level||''} {log.text||log.url}</pre>):<p>暂无日志</p>}<h4>浏览器操作</h4>{state?.events.slice(-30).reverse().map(event=><p key={event.id}>{operationNames[event.action]||event.action} · {stateNames[event.state]||event.state}{event.message?' · '+event.message:''}</p>)}</div>}
        </div>
      </section>}
    </div>
    {(usingLive&&current&&!currentClosed)||(snapshot&&snapshot.url!=='about:blank')?<footer className="browser-statusbar"><span className={'browser-status-dot'+(usingLive?' is-live':busy?' is-busy':snapshot?.stale||current?.stale?' is-stale':'')}/><span title={snapshot?`${snapshot.title} · 版本 ${snapshot.version}`:current?.title}>{usingLive?(userControl?'你正在操作网页':'实时画面'):busy?'正在更新页面':snapshot?.stale||current?.stale?'页面已变化，需重新观察':'页面快照 · 可点击与滚动'}</span>{granted&&!userControl&&<span className="browser-control-status">Agent可操作</span>}{!usingLive&&<div className="browser-scroll-actions"><button type="button" aria-label="向上滚动" title="向上滚动" disabled={!usable} onClick={()=>void run('scroll',{deltaY:-600})}><IconChevron size={12} className="browser-up-icon"/></button><button type="button" aria-label="向下滚动" title="向下滚动" disabled={!usable} onClick={()=>void run('scroll',{deltaY:600})}><IconChevron size={12} className="browser-down-icon"/></button></div>}</footer>:null}
  </section>;
}
