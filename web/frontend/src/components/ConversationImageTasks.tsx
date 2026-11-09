import { useEffect, useRef, useState } from 'react';
import { artifactUrl, uniqueImageArtifacts, groupImageArtifacts } from '../lib/chatArtifacts';
import type { ChatArtifact, ChatImageJob } from '../lib/chatArtifacts';
import { IconImage, IconCheck, IconExpand, IconDownload, IconPlus, IconPublish, IconRefresh } from './icons';
import XhsCardSetStatus from './XhsCardSetStatus';
import PublishSpinner from './PublishSpinner';
import RetryImageJob from './RetryImageJob';
import '../styles/conversation-image-tasks.css';

type Props = {
  sessionId: string | null; items: ChatArtifact[]; jobs: ChatImageJob[]; note?: string;
  targetId: string | null; onUpdated: (item: ChatArtifact) => void; onRefresh: () => void;
  onAddToChat: (item: ChatArtifact) => Promise<void>; onPublish: (item: ChatArtifact) => void;
};
const phaseLabels = {queued:'排队中', running:'生成中', done:'已完成', error:'生成失败', unconfirmed:'待核实'};
function jobLabel(job: ChatImageJob) {
  if (job.phase === 'running' && job.stage === 'downloading') return '正在保存';
  if (job.phase === 'running' && job.stage === 'recovering') return '正在接回';
  if (job.phase === 'queued' && job.queueReason === 'memory_pressure') return '等待服务器资源';
  return phaseLabels[job.phase];
}
function ImageCard({item, copies, hydrate, ...props}: Props & {item: ChatArtifact; copies: number; hydrate: boolean}) {
  const [busy, setBusy] = useState<'chat'|'refresh'|null>(null), [note, setNote] = useState('');
  const [broken, setBroken] = useState(false), [attempt, setAttempt] = useState(0);
  const pending = useRef(false), alive = useRef(true), controller = useRef<AbortController|null>(null);
  useEffect(() => { alive.current=true; return () => {alive.current=false;controller.current?.abort();}; }, []);
  useEffect(() => {setBroken(false);setNote('');}, [item.version, props.targetId]);
  const refresh = async (silent = false) => {
    if (pending.current) return;
    pending.current=true;
    const request=new AbortController();controller.current=request;
    if(!silent){setBusy('refresh');setNote('');}
    try {
      const response=await fetch(artifactUrl(item,'refresh'),{method:'POST',signal:request.signal,cache:'no-store'});
      if(!response.ok)throw new Error();
      const value=await response.json() as ChatArtifact;
      if(!alive.current||request.signal.aborted)return;
      if(value.sessionId!==item.sessionId||value.id!==item.id)throw new Error();
      props.onUpdated({...value,turnId:item.turnId});
      if(!silent){setAttempt(x=>x+1);setBroken(false);setNote(value.status==='ready'?'已核对现有文件':value.status==='missing'?'文件已移动或删除':value.error||'文件暂不可读');}
    } catch {if(alive.current&&!silent&&!request.signal.aborted)setNote('暂时无法读取文件，请稍后刷新');}
    finally {pending.current=false;if(alive.current)setBusy(null);}
  };
  const latestRefresh=useRef(refresh);latestRefresh.current=refresh;
  // Upgrade legacy receipts using existing files, with a bounded visible batch.
  // This never submits generation or model work.
  useEffect(()=>{if(hydrate)void latestRefresh.current(true);},[hydrate]);
  const add = async () => {
    if(pending.current||!props.targetId)return;
    pending.current=true;setBusy('chat');setNote('');
    try {await props.onAddToChat(item);if(alive.current)setNote('已加入目标对话草稿');}
    catch(reason){if(alive.current)setNote(reason instanceof Error?reason.message:'添加失败，请重试');}
    finally {pending.current=false;if(alive.current)setBusy(null);}
  };
  const ready=item.status==='ready', url=artifactUrl(item,'file',attempt);
  return <article className="conversation-image-card" aria-label={'图片：'+item.name}>
    <a className="conversation-image-preview" href={ready?url:undefined} target="_blank" rel="noreferrer" aria-label={'查看原图：'+item.name}>
      {ready&&!broken?<img src={url} alt={item.description||item.name} loading="lazy" onError={()=>setBroken(true)}/>:<span className="conversation-image-placeholder"><IconImage size={28}/>{item.status==='missing'?'文件已移动或删除':broken?'预览暂不可用':'文件暂不可读'}</span>}
      {ready&&!broken&&<span className="conversation-image-zoom"><IconExpand size={13}/>查看原图</span>}
    </a>
    <div className="conversation-image-info"><strong title={item.name}>{item.name}</strong><span>{ready?'已保存':'需核对'} · {(item.size/1024/1024).toFixed(1)} MB{copies>1?' · 合并 '+copies+' 份相同文件':''}</span></div>
    <div className="conversation-image-actions">
      <button type="button" disabled={!ready||!props.targetId||!!busy} title={props.targetId?'加入所选对话的草稿，不会发送':'先在上方选择目标对话'} onClick={()=>void add()}>{busy==='chat'?<PublishSpinner/>:<IconPlus size={14}/>}<span>{busy==='chat'?'正在添加':'添加到对话'}</span></button>
      <button type="button" disabled={!ready||!!busy} title="加入发布草稿，仍需确认发布" onClick={()=>{try{props.onPublish(item);setNote('已加入发布草稿');}catch(reason){setNote(reason instanceof Error?reason.message:'添加失败');}}}><IconPublish size={14}/><span>用于发布</span></button>
    </div>
    <footer className="conversation-image-footer">{ready&&<a href={url+'&download=true'}><IconDownload size={13}/>下载原图</a>}<button type="button" disabled={!!busy} onClick={()=>void refresh()} aria-label={'刷新图片：'+item.name}><IconRefresh size={13}/>{busy==='refresh'?'正在核对':'刷新'}</button></footer>
    {note&&<p className="conversation-image-feedback" role="status">{note}</p>}
  </article>;
}
export default function ConversationImageTasks(props: Props) {
  const items=props.items.filter(item=>item.sessionId===props.sessionId),jobs=props.jobs.filter(job=>job.sessionId===props.sessionId);
  const images=uniqueImageArtifacts(items), ready=images.filter(({artifact})=>artifact.status==='ready').length;
  const {groups, other}=groupImageArtifacts(images.map(({artifact})=>artifact),jobs);
  const copies=new Map(images.map(row=>[row.artifact.id,row.copies]));
  const active=jobs.filter(job=>job.phase==='queued'||job.phase==='running').length;
  const attention=jobs.filter(job=>job.phase==='error'||job.phase==='unconfirmed').length;
  if(!images.length&&!jobs.length&&!props.note)return null;
  const legacy=new Set(images.filter(({artifact})=>artifact.status==='ready'&&!/^[a-f0-9]{64}$/.test(artifact.contentSha256||'')).slice(0,16).map(({artifact})=>artifact.id));
  return <section className="conversation-image-tasks" aria-label="对话中的图片任务">
    <header className="conversation-image-heading"><span className="conversation-image-symbol"><IconImage size={18}/></span><div><h3>对话中的图片任务</h3><p>生成记录与已保存图片 · 添加到草稿后继续创作</p></div><span className={'conversation-image-summary'+(active?' is-active':attention?' is-attention':'')}>{active?<PublishSpinner/>:attention?<span aria-hidden="true">!</span>:<IconCheck size={13}/>} {active?active+' 个进行中':attention?attention+' 个需核对':ready+' 张已保存'}</span></header>
    <XhsCardSetStatus jobs={jobs}/>
    {!!groups.length&&<div className="conversation-image-job-list">{groups.map(({job,artifacts})=><section key={job.jobId} className="conversation-prompt-card" aria-label="提示词与对应图片"><details open={job.phase==='error'} className={'conversation-image-job is-'+job.phase}><summary><span className="conversation-image-job-name"><strong>提示词</strong>{job.prompt||'图片生成任务'}</span><span className="conversation-image-phase">{['queued','running'].includes(job.phase)&&<PublishSpinner/>}{jobLabel(job)}</span></summary><p className="conversation-image-prompt">{job.prompt}</p><small>任务 {job.jobId.slice(0,12)}</small>{job.error&&<p className="conversation-image-error">{job.error}</p>}<RetryImageJob job={job} onChanged={props.onRefresh}/>{job.phase==='unconfirmed'&&<p>任务结果尚未确认，请在对话任务记录中核对或接回原任务。</p>}</details><div className="conversation-prompt-results"><header><strong>对应图片{artifacts.length>1?' · '+artifacts.length+' 张':''}</strong><button type="button" onClick={props.onRefresh} title="重新读取已有任务与图片，不会重新生图"><IconRefresh size={13}/>刷新任务状态</button></header>{artifacts.length?<div className="conversation-image-grid">{artifacts.map(artifact=><ImageCard key={artifact.id+':'+artifact.version+':'+props.targetId} {...props} item={artifact} copies={copies.get(artifact.id)||1} hydrate={legacy.has(artifact.id)}/>)}</div>:<p className="conversation-image-empty">{['queued','running'].includes(job.phase)?'图片完成后会显示在这里':'暂未找到明确关联的图片'} · 刷新不会重新生图</p>}</div></section>)}</div>}
    {!!other.length&&<div className="conversation-image-grid">{other.map(artifact=><ImageCard key={artifact.sessionId+':'+artifact.turnId+':'+artifact.id+':'+artifact.version+':'+props.targetId} {...props} item={artifact} copies={copies.get(artifact.id)||1} hydrate={legacy.has(artifact.id)}/>)}</div>}
    {!images.length&&!!jobs.length&&<p className="conversation-image-empty">{active?'图片保存后会出现在这里':'暂无可展示的已保存图片，请查看任务记录'}</p>}
    {props.note&&<div className="conversation-image-notice" role="status"><span>{props.note}</span><button type="button" onClick={props.onRefresh}>重新读取</button></div>}
  </section>;
}
