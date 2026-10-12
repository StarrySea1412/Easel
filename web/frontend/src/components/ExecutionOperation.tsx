import { useEffect, useRef, useState } from 'react';
import type { Operation } from '../lib/execution';
import { operationKind, operationTitle } from '../lib/execution';
import { formatChatElapsed } from '../lib/chatTiming';
import { IconTerminal, IconEdit, IconFile, IconSearch, IconCompass, IconSkills, IconChevron } from './icons';

const labels = {running:'执行中',returned:'工具已返回',completed:'执行已结束',failed:'失败',unconfirmed:'结果未确认',stopped:'已停止',denied:'已拒绝'};
function Copy({text,label}:{text:string;label:string}) {
  const [state,setState]=useState('');
  return <button type="button" className="execution-copy" aria-label={label} onClick={()=>{void Promise.resolve().then(()=>navigator.clipboard.writeText(text)).then(()=>setState('已复制')).catch(()=>setState('复制失败'));}}>{state||label}</button>;
}
function Output({row}:{row:Operation}) {
  const [following,setFollowing]=useState(true); const output=useRef<HTMLPreElement>(null);
  useEffect(()=>{if(following && output.current)output.current.scrollTop=output.current.scrollHeight;},[row.output,following]);
  return <section className="execution-output" aria-label="工具输出"><div className="execution-detail-heading"><strong>{row.kind==='command'?'终端输出':'工具回执'}</strong><span><Copy text={row.output} label="复制输出"/>{row.status==='running'&&<button type="button" aria-pressed={following} onClick={()=>setFollowing(x=>!x)}>{following?'暂停跟随':'跟随输出'}</button>}</span></div><pre ref={output}>{row.output}</pre>{row.truncated?.output&&<p className="execution-note">输出超过展示上限，仅保留前 64,000 字符。</p>}</section>;
}
function Artifact({path}:{path:string}) {
  const [check,setCheck]=useState<{path:string;exists:boolean;failed?:boolean}|null>(null),[revision,setRevision]=useState(0);
  useEffect(()=>{const controller=new AbortController();const base=window.location.pathname.replace(/\/index\.html$/,'').replace(/\/$/,'');
    void fetch(`${base}/api/output-status?path=${encodeURIComponent(path)}`,{signal:controller.signal,cache:'no-store'}).then(async r=>{if(!r.ok)throw Error();return r.json();}).then(data=>{if(!controller.signal.aborted)setCheck({path,exists:data.exists===true && data.isDirectory!==true});}).catch(()=>{if(!controller.signal.aborted)setCheck({path,exists:false,failed:true});});
    return()=>controller.abort();
  },[path,revision]);
  const current=check?.path===path?check:null;
  return <div className="execution-artifact">{current?.exists?<a href={`#/outputs/${encodeURIComponent(path)}`}>查看已保存文件 ↗</a>:<span>{!current?'正在核验文件…':current.failed?'暂时无法核验文件':'当前数据目录未找到有效文件'}</span>}<button type="button" onClick={()=>setRevision(x=>x+1)}>重新核验</button></div>;
}
export default function ExecutionOperation({row,running}:{row:Operation;running:boolean}) {
  const [now,setNow]=useState(Date.now),[expanded,setExpanded]=useState(false);
  useEffect(()=>{if(!running||row.status!=='running'||!row.startedAt)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[running,row.status,row.startedAt]);
  const duration=row.elapsedSeconds!==undefined?row.elapsedSeconds*1000:running&&row.status==='running'&&row.startedAt?Math.max(0,now-Date.parse(row.startedAt)):undefined;
  const url=row.url&&/^https?:\/\//i.test(row.url)?row.url:undefined;
  const Icon=row.kind==='command'?IconTerminal:row.kind==='file_change'?IconEdit:row.kind==='read'?IconFile:row.kind==='search'?IconSearch:row.kind==='browser'?IconCompass:IconSkills;
  const normal=row.status==='returned'||row.status==='completed';
  return <details className={`chat-execution-row is-${row.status}`} open={expanded} onToggle={event=>setExpanded(event.currentTarget.open)}>
    <summary><span className="execution-kind" title={operationKind(row)}><Icon size={14}/></span><span className="chat-execution-title" title={row.path||row.command||row.name}>{operationTitle(row)}</span>{!normal&&<span className={`chat-execution-state is-${row.status}`}>{labels[row.status]}</span>}{row.status==='running'&&duration!==undefined&&Number.isFinite(duration)&&<small>{formatChatElapsed(duration)}</small>}<span className="execution-chevron" aria-hidden="true"><IconChevron size={12}/></span></summary>
    {expanded&&<div className="chat-execution-detail"><div className="execution-metadata"><span>{labels[row.status]}{duration!==undefined&&Number.isFinite(duration)?` · ${formatChatElapsed(duration)}`:''}{row.diff&&<span className="chat-execution-diff-count"> · +{row.added??0} −{row.removed??0}</span>}</span><span>工具：{row.name}</span>{row.cwd&&<span>工作目录：{row.cwd}</span>}{row.path&&<span>文件：{row.path}</span>}{row.exitCode!==undefined&&<span>退出码：{row.exitCode}</span>}{row.exitSignal&&<span>退出信号：{row.exitSignal}</span>}{row.processSessionId&&<span>进程会话：{row.processSessionId}</span>}</div>
      {row.command&&<section className="execution-command"><div className="execution-detail-heading"><strong>命令</strong><Copy text={row.command} label="复制命令"/></div><pre>{row.command}</pre>{row.truncated?.command&&<p className="execution-note">命令超过展示上限，已截断。</p>}</section>}
      {url&&<p><a href={url} target="_blank" rel="noreferrer">{url}</a></p>}
      {row.diff&&<section aria-label="文件差异"><div className="execution-detail-heading"><strong>文件差异</strong><Copy text={row.diff} label="复制差异"/></div><pre className="chat-execution-diff">{row.diff.split('\n').map((line,index)=><span key={index} className={line.startsWith('+')&&!line.startsWith('+++')?'is-added':line.startsWith('-')&&!line.startsWith('---')?'is-removed':''}>{line}{'\n'}</span>)}</pre>{row.truncated?.diff&&<p className="execution-note">差异超过展示上限，已截断。</p>}</section>}
      {row.output&&<Output row={row}/>}
      {!row.diff&&!row.output&&<p className="execution-note">{row.contentHidden?'凭据或配置文件内容已隐藏。':'尚未收到可展示的工具结果。'}</p>}
      {row.artifactPath&&<Artifact path={row.artifactPath}/>}
      {row.status==='returned'&&<p className="execution-note">工具已返回；任务结果以实际文件或后续核验为准。</p>}
      {row.processSessionId&&row.status==='running'&&<p className="execution-note">后台进程仍在运行，等待结束回执。</p>}
    </div>}
  </details>;
}
