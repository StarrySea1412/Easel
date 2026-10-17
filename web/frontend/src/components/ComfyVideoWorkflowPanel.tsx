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
import InlineInfo from './InlineInfo';
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
  const [pending, setPending] = useState<'live' | 'demo' | null>(null);
  const mounted = useRef(true);
  const polling = job?.state === 'running';
  const configured = Boolean(config?.configured);
  const demoReady = Boolean(config?.demoAvailable);

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
  const generate = async (demo: boolean) => {
    if (locked || polling || pending || !prompt.trim()) return;
    if (demo ? !demoReady : !configured) return;
    setPending(demo ? 'demo' : 'live'); setError('');
    try {
      const result = await startComfyVideo({ prompt: prompt.trim(), cinematic, sessionId: sessionId || undefined, demo });
      if (mounted.current) setJob({ jobId: result.jobId, state: 'running', mode: demo ? 'demo' : 'live', prompt: prompt.trim(), url: null, error: null, started: Date.now() / 1000 });
    } catch (value) { if (mounted.current) setError(value instanceof Error ? value.message : 'ComfyUI 提交失败'); }
    finally { if (mounted.current) setPending(null); }
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
    <div className="comfy-workflow-heading"><div>
      <h2>ComfyUI 视频工作流<InlineInfo label="ComfyUI 工作流说明" hover>
        <p>使用你配置的 API 工作流与本地/局域网节点服务；提交后 Easel 轮询队列，校验 MP4 后登记到原对话产物。</p>
        <p>启用真实提交需要两项配置：<code>COMFYUI_BASE_URL</code>（例如 http://127.0.0.1:8188）与 <code>COMFYUI_WORKFLOW_PATH</code>（API 格式的 workflow JSON）。提示词节点可留空，工作流里只有一个文本节点时自动识别。</p>
        <p>未配置时不会调用其他付费视频通道；“模拟运行”在本地生成明确标注的占位视频（需要本机 ffmpeg），只用于体验完整流程，不是任何模型服务的产物。</p>
      </InlineInfo></h2>
      <p>真实提交只走你配置的 ComfyUI；没配置或想先试流程时，用本地模拟运行。</p></div>
      <span className={`comfy-status-dot${configured ? ' is-ready' : ''}`} title={configured ? 'ComfyUI 已配置' : 'ComfyUI 未配置'} aria-label={configured ? 'ComfyUI 已配置' : 'ComfyUI 未配置'} /></div>
    <div className="comfy-workflow-meta"><span>{loading ? '正在读取配置…' : configured ? `${config?.workflowNodeCount} 个节点 · 提示词节点 ${config?.promptNode || '需指定'}` : config?.error || '未配置 COMFYUI_BASE_URL / COMFYUI_WORKFLOW_PATH'}</span><button type="button" className="link-btn" onClick={() => void refresh()}>刷新配置</button><button type="button" className="link-btn" onClick={() => void probe()} disabled={!configured}>测试连接</button></div>
    {health && <p className="comfy-health" role="status">{health}</p>}
    <details className="comfy-cinematic-details"><summary>镜头语言参数（可选）<span className="comfy-info-inline" onClick={event => event.preventDefault()}><InlineInfo label="镜头语言参数说明" hover>按电影镜头语言组织提示词：填写后会合并进工作流的提示词节点，留空则只发送主提示词。调整不调用任何模型。</InlineInfo></span></summary><div className="comfy-cinematic-grid">{CINEMATIC_FIELDS.map(([key, label, placeholder]) => <label key={key}><span>{label}</span><input value={cinematic[key] || ''} placeholder={placeholder} disabled={locked || polling} onChange={event => setCinematic(old => ({ ...old, [key]: event.target.value }))} /></label>)}</div></details>
    <div className="comfy-workflow-actions">
      <button type="button" className="btn btn-primary" disabled={locked || polling || Boolean(pending) || !configured || !prompt.trim()} title={configured ? '提交到你配置的 ComfyUI 工作流' : '未配置 ComfyUI，可先用右侧“模拟运行”体验流程'} onClick={() => void generate(false)}>{pending === 'live' ? '正在提交…' : polling && job?.mode !== 'demo' ? 'ComfyUI 生成中…' : '提交到 ComfyUI'}</button>
      <button type="button" className="btn" disabled={locked || polling || Boolean(pending) || !demoReady || !prompt.trim()} title={demoReady ? '在本地生成明确标注的占位视频，不调用任何模型服务' : config ? '模拟运行需要后端支持与本地 ffmpeg；重启工作台后端后可用' : '正在读取配置…'} onClick={() => void generate(true)}>{pending === 'demo' ? '正在准备…' : polling && job?.mode === 'demo' ? '模拟生成中…' : '模拟运行'}</button>
      {polling && <button type="button" className="link-btn" onClick={() => void cancel()}>{job?.mode === 'demo' ? '取消模拟' : '停止本地轮询'}</button>}
      <span>{configured ? config?.note : '未配置 ComfyUI：可先用“模拟运行”体验流程，配置后“提交到 ComfyUI”自动可用。'}</span>
    </div>
    {job?.state === 'running' && <p className="comfy-job-note" role="status">{job.mode === 'demo' ? '正在本地生成占位视频（不调用任何模型服务）。' : '已进入 ComfyUI 队列，Easel 正在读取历史结果。'}</p>}
    {job?.state === 'done' && job.url && <div className="comfy-result"><div className="comfy-result-head">{job.mode === 'demo' && <span className="comfy-demo-badge">模拟</span>}<video src={job.url} controls playsInline preload="metadata" aria-label={job.mode === 'demo' ? '模拟占位视频' : 'ComfyUI 视频结果'} /></div><a href={`${job.url}&download=true`} download>下载视频</a>{job.mode === 'demo' && <small className="comfy-demo-note">这是本地生成的占位视频，用于体验提交与交付流程；不是 ComfyUI 或任何模型服务的产物。</small>}</div>}
    {job?.state === 'cancelled' && <p className="comfy-job-note" role="status">{job.error}</p>}
    {(error || job?.state === 'error') && <p className="image-error" role="alert">{error || job?.error || 'ComfyUI 工作流失败'}</p>}
  </section>;
}
