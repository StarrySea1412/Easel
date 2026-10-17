import { useEffect, useRef, useState } from 'react';
import {
  cancelComfyVideoJob,
  checkComfyVideoHealth,
  fetchComfyVideoConfig,
  fetchComfyVideoJob,
  startComfyVideo,
  type ComfyVideoConfig,
  type ComfyVideoJob,
} from '../lib/api';
import '../styles/chat-artifacts.css';

const CINEMATIC_FIELDS: Array<[string, string, string]> = [
  ['subject', '主体', '人物、物体或环境'],
  ['action', '动作', '主体如何运动'],
  ['shot', '景别', '特写、中景、远景'],
  ['movement', '运镜', '推、拉、摇、移、环绕'],
  ['angle', '角度', '平视、低角度、俯拍'],
  ['lens', '镜头', '广角、长焦、浅景深'],
  ['lighting', '灯光', '柔光、轮廓光、体积光'],
  ['composition', '构图', '对称、留白、前景遮挡'],
  ['color', '色彩', '冷暖、低饱和、霓虹'],
  ['time', '时间', '清晨、黄昏、夜晚'],
  ['effects', '特效', '雨、烟雾、粒子'],
  ['transition', '转场', '连续镜头、淡入淡出'],
  ['style', '风格', '纪录片、广告、电影感'],
];

export default function ComfyVideoWorkflowPanel({ prompt, locked, sessionId }: { prompt: string; locked: boolean; sessionId?: string | null }) {
  const [config, setConfig] = useState<ComfyVideoConfig | null>(null);
  const [job, setJob] = useState<ComfyVideoJob | null>(null);
  const [cinematic, setCinematic] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [health, setHealth] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const mounted = useRef(true);
  const polling = job?.state === 'running';

  useEffect(() => () => { mounted.current = false; }, []);
  const refresh = async () => {
    setLoading(true); setError('');
    try { const next = await fetchComfyVideoConfig(); if (mounted.current) setConfig(next); }
    catch (value) { if (mounted.current) setError(value instanceof Error ? value.message : 'ComfyUI 配置读取失败'); }
    finally { if (mounted.current) setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!job || job.state !== 'running') return;
    let alive = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await fetchComfyVideoJob(job.jobId);
        if (!alive || !mounted.current) return;
        setJob(next);
        if (next.state === 'done') window.dispatchEvent(new Event('easel:outputs-updated'));
        else if (next.state === 'running') timer = window.setTimeout(() => { void poll(); }, 2000);
      } catch (value) {
        if (alive && mounted.current) { setError(value instanceof Error ? value.message : 'ComfyUI 进度读取失败'); timer = window.setTimeout(() => { void poll(); }, 3000); }
      }
    };
    void poll();
    return () => { alive = false; if (timer) window.clearTimeout(timer); };
  }, [job]);
  const generate = async () => {
    if (locked || polling || submitting || !config?.configured || !prompt.trim()) return;
    setSubmitting(true); setError('');
    try {
      const result = await startComfyVideo({ prompt: prompt.trim(), cinematic, sessionId: sessionId || undefined });
      if (mounted.current) setJob({ jobId: result.jobId, state: 'running', prompt: prompt.trim(), url: null, error: null, started: Date.now() / 1000 });
    } catch (value) { if (mounted.current) setError(value instanceof Error ? value.message : 'ComfyUI 提交失败'); }
    finally { if (mounted.current) setSubmitting(false); }
  };
  const cancel = async () => {
    if (!job || !polling) return;
    try { const next = await cancelComfyVideoJob(job.jobId); if (mounted.current) setJob(next); }
    catch (value) { if (mounted.current) setError(value instanceof Error ? value.message : '停止 ComfyUI 轮询失败'); }
  };
  const probe = async () => {
    setHealth('读取中…');
    try { const result = await checkComfyVideoHealth(); if (mounted.current) setHealth(result.detail); }
    catch (value) { if (mounted.current) setHealth(value instanceof Error ? value.message : '连接失败'); }
  };
  return <section className="comfy-workflow-panel" aria-label="ComfyUI 视频工作流">
    <div className="comfy-workflow-heading"><div><h2>ComfyUI 视频工作流</h2><p>使用你配置的 API 工作流和本地节点服务，未配置时不会调用其他付费通道。</p></div><span className={`comfy-status-dot${config?.configured ? ' is-ready' : ''}`} title={config?.configured ? 'ComfyUI 已配置' : 'ComfyUI 未配置'} aria-label={config?.configured ? 'ComfyUI 已配置' : 'ComfyUI 未配置'} /></div>
    <div className="comfy-workflow-meta"><span>{loading ? '正在读取配置…' : config?.configured ? `${config.workflowNodeCount} 个节点 · 提示词节点 ${config.promptNode || '需指定'}` : config?.error || '未配置 COMFYUI_BASE_URL / COMFYUI_WORKFLOW_PATH'}</span><button type="button" className="link-btn" onClick={() => void refresh()}>刷新配置</button><button type="button" className="link-btn" onClick={() => void probe()} disabled={!config?.configured}>测试连接</button></div>
    {health && <p className="comfy-health" role="status">{health}</p>}
    <details className="comfy-cinematic-details"><summary>镜头语言参数（可选）</summary><div className="comfy-cinematic-grid">{CINEMATIC_FIELDS.map(([key, label, placeholder]) => <label key={key}><span>{label}</span><input value={cinematic[key] || ''} placeholder={placeholder} disabled={locked || polling} onChange={event => setCinematic(old => ({ ...old, [key]: event.target.value }))} /></label>)}</div></details>
    <div className="comfy-workflow-actions"><button type="button" className="btn btn-primary" disabled={locked || polling || submitting || !config?.configured || !prompt.trim()} onClick={() => void generate()}>{submitting ? '正在提交…' : polling ? 'ComfyUI 生成中…' : '提交到 ComfyUI'}</button>{polling && <button type="button" className="link-btn" onClick={() => void cancel()}>停止本地轮询</button>}<span>{config?.note}</span></div>
    {job?.state === 'running' && <p className="comfy-job-note" role="status">已进入 ComfyUI 队列，Easel 正在读取历史结果。</p>}
    {job?.state === 'done' && job.url && <div className="comfy-result"><video src={job.url} controls playsInline preload="metadata" aria-label="ComfyUI 视频结果" /><a href={`${job.url}&download=true`} download>下载视频</a></div>}
    {job?.state === 'cancelled' && <p className="comfy-job-note" role="status">{job.error}</p>}
    {(error || job?.state === 'error') && <p className="image-error" role="alert">{error || job?.error || 'ComfyUI 工作流失败'}</p>}
  </section>;
}

