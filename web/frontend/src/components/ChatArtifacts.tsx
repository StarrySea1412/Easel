import { useEffect, useRef, useState } from 'react';
import { artifactUrl } from '../lib/chatArtifacts';
import type { ChatArtifact, ChatImageJob } from '../lib/chatArtifacts';
import '../styles/chat-artifacts.css';

function ArtifactCard({ artifact, onUpdated }: { artifact: ChatArtifact; onUpdated: (value: ChatArtifact) => void }) {
  const [busy, setBusy] = useState(false), [note, setNote] = useState(''), [attempt, setAttempt] = useState(0), [failed, setFailed] = useState(false);
  const controller = useRef<AbortController | null>(null), generation = useRef(0);
  const pending = useRef(false);
  const element = useRef<HTMLElement>(null);
  useEffect(() => { setFailed(false); setNote(''); }, [artifact.id, artifact.version]);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, [artifact.sessionId, artifact.id]);
  const refresh = async (automatic = false) => {
    if (pending.current) return;
    controller.current?.abort(); const request = new AbortController(); controller.current = request;
    const own = ++generation.current; pending.current = true; if (!automatic) { setBusy(true); setNote(''); }
    try {
      const response = await fetch(artifactUrl(artifact, 'refresh'), { method: 'POST', signal: request.signal, cache: 'no-store' });
      if (!response.ok) throw new Error();
      const value = await response.json() as ChatArtifact;
      if (request.signal.aborted || own !== generation.current || value.id !== artifact.id || value.sessionId !== artifact.sessionId) return;
      onUpdated({ ...value, turnId: artifact.turnId }); if (!automatic) { setAttempt(x => x + 1); setFailed(false); }
      if (!automatic) setNote(value.status === 'ready' ? '已读取最新文件' : value.status === 'missing' ? '文件已移动或删除' : value.error || '文件暂不可读');
    } catch { if (!automatic && !request.signal.aborted && own === generation.current) setNote('刷新失败，请重试；没有重新生成文件。'); }
    finally { if (own === generation.current) { setBusy(false); pending.current = false; } }
  };
  const latestRefresh = useRef(refresh); latestRefresh.current = refresh;
  useEffect(() => {
    if (!element.current || typeof IntersectionObserver === 'undefined') return;
    let visible = false;
    const observer = new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting); });
    observer.observe(element.current);
    const timer = setInterval(() => { if (visible && document.visibilityState !== 'hidden' && !controller.current?.signal.aborted && !busy) void latestRefresh.current(true); }, 8000);
    return () => { observer.disconnect(); clearInterval(timer); };
  }, [artifact.id, artifact.sessionId, busy]);
  const image = artifact.mimeType.startsWith('image/') && artifact.mimeType !== 'image/svg+xml', html = artifact.mimeType === 'text/html', video = artifact.mimeType.startsWith('video/');
  const url = artifactUrl(artifact, 'file', attempt);
  return <article ref={element} className={`chat-artifact${html ? ' is-html' : ''}`} aria-label={`产物：${artifact.name}`}>
    <header><div><strong title={artifact.name}>{artifact.name}</strong><small>{artifact.description || (html ? 'HTML · 可交互预览' : image ? '图片' : video ? '视频 · 可直接播放' : artifact.mimeType)} · {(artifact.size / 1024).toFixed(1)} KB</small></div><button type="button" onClick={() => void refresh()} aria-disabled={busy} aria-busy={busy} aria-label={`刷新${artifact.name}`} title="重新读取已保存文件，不调用模型">{busy ? '读取中…' : '刷新预览'}</button></header>
    {artifact.status === 'ready' && image && !failed && <a href={url} target="_blank" rel="noreferrer" aria-label={`打开图片${artifact.name}`}><img key={`${artifact.version}:${attempt}`} src={url} alt={artifact.name} loading="lazy" onError={() => setFailed(true)} /></a>}
    {artifact.status === 'ready' && html && <details open className="chat-artifact-html"><summary>页面预览</summary><iframe key={`${artifact.version}:${attempt}`} src={artifactUrl(artifact, 'preview', attempt)} sandbox="allow-scripts" title={`预览${artifact.name}`} onError={() => setFailed(true)} /><p>独立预览 · 页面内联网请求和嵌套网页不可用</p></details>}
    {artifact.status === 'ready' && video && <video key={`${artifact.version}:${attempt}`} className="chat-artifact-video" src={url} controls playsInline preload="metadata" aria-label={`播放${artifact.name}`} onError={() => setFailed(true)} />}
    {(failed || artifact.status !== 'ready') && <p className="chat-artifact-error" role="status">{artifact.status === 'missing' ? '文件已移动或删除' : artifact.error || '预览加载失败，请刷新重试'}</p>}
    <footer><a href={`${url}&download=true`}>下载{html ? ' HTML' : video ? ' 视频' : '原文件'}</a><span role="status">{note}</span></footer>
  </article>;
}
function ImageJob({ job, onChanged }: { job: ChatImageJob; onChanged?: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const acknowledge = async () => {
    if (busy) return;
    setBusy(true); setError(''); const request = new AbortController(); controller.current = request;
    try {
      const base = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
      const response = await fetch(`${base}/api/chat/artifacts/${encodeURIComponent(job.sessionId)}/jobs/${job.jobId}/acknowledge`, { method: 'POST', signal: request.signal });
      if (!response.ok) throw new Error();
      if (!request.signal.aborted) onChanged?.();
    } catch { if (!request.signal.aborted) setError('未能解除占位，请重新读取任务状态。'); }
    finally { if (!request.signal.aborted) setBusy(false); }
  };
  return <article className="chat-image-job" aria-label="生图任务"><strong>{job.phase === 'queued' ? '等待图片通道' : job.phase === 'running' ? '图片生成中' : job.phase === 'unconfirmed' ? '生成结果未确认' : job.phase === 'done' ? '图片已保存' : '图片任务已结束'}</strong><p>{job.prompt}</p><small>任务 {job.jobId.slice(0, 12)}</small>{job.error && <p role="status">{job.error}</p>}{job.phase === 'unconfirmed' && <button type="button" disabled={busy} onClick={() => void acknowledge()}>{busy ? '更新中…' : '已核对供应商，解除占位'}</button>}{error && <p role="alert">{error}</p>}</article>;
}
export default function ChatArtifacts({ artifacts, onUpdated, jobs = [], onJobsChanged }: { artifacts: ChatArtifact[]; onUpdated: (value: ChatArtifact) => void; jobs?: ChatImageJob[]; onJobsChanged?: () => void }) {
  if (!artifacts.length && !jobs.length) return null;
  const singleVisual = artifacts.filter(item => item.mimeType.startsWith('image/') || item.mimeType.startsWith('video/')).length <= 1;
  return <section className={`chat-artifacts${singleVisual ? ' chat-artifacts-single' : ''}`} aria-label="本轮生成文件">{jobs.filter(job => job.phase !== 'done' || job.error).map(job => <ImageJob key={job.jobId} job={job} onChanged={onJobsChanged} />)}{artifacts.map(artifact => <ArtifactCard key={artifact.id} artifact={artifact} onUpdated={onUpdated} />)}</section>;
}
