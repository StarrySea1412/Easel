import { useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import type { EnvJob, EnvTool } from '../lib/api';
import { IconInfo } from './icons';
import { envJobActive, useEnvironmentJobs } from '../lib/useEnvironmentJobs';
import '../styles/environment-install.css';
import {
  IconHexagon, IconFilm, IconFileCode, IconAudioWaveform, IconDatabase,
  IconPackage, IconMonitor, IconTv, IconGlobe, IconCompass, IconLibrary,
} from './settingsIcons';

interface Props {
  tools: EnvTool[];
  python: string;
  loading: boolean;
  error: string;
  onRefresh: () => void;
}

const ICONS: Record<string, ComponentType<{ size?: number }>> = {
  node: IconHexagon, ffmpeg: IconFilm, python: IconFileCode, fw: IconAudioWaveform,
  model: IconDatabase, rmdeps: IconPackage, shell: IconMonitor, biliup: IconTv,
  pw: IconGlobe, cft: IconCompass, pylibs: IconLibrary,
};
const GROUPS = [
  { id: 'rm', title: '视频与本地转写', note: '按创作需要准备' },
  { id: 'pub', title: '平台登录与发布', note: '安装后仍需账号授权' },
  { id: 'common', title: '图片、配音与文档', note: '常用技能依赖' },
];
const STATE_LABELS = { queued: '排队中', running: '安装中', ok: '已完成', fail: '失败' };

function ToolInfo({ tool }: { tool: EnvTool }) {
  const [open, setOpen] = useState(false);
  return <span className={`env-info${open ? ' is-open' : ''}`}>
    <button type="button" className="env-info-button" aria-label={`${tool.name}的用途与安装范围`} aria-expanded={open} onClick={() => setOpen(value => !value)} onBlur={() => setOpen(false)} onKeyDown={event => { if (event.key === 'Escape') setOpen(false); }}><IconInfo size={16} /></button>
    <span className="env-info-content" role="tooltip"><strong>{tool.name}</strong><span>{tool.purpose || tool.desc}</span><span>安装到：{tool.scope || '以当前安装器的输出为准。'}</span>{tool.notes && <span>{tool.notes}</span>}{tool.strategies && <span>最多 {tool.strategies} 个步骤{tool.timeoutSeconds ? `，本轮上限 ${formatEnvDuration(tool.timeoutSeconds)}` : ''}。</span>}</span>
  </span>;
}

function formatEnvDuration(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  if (value >= 3600) return `${Math.floor(value / 3600)} 小时 ${Math.floor(value % 3600 / 60)} 分`;
  return value >= 60 ? `${Math.floor(value / 60)} 分 ${value % 60} 秒` : `${value} 秒`;
}

function InstallMonitor({ jobs, disconnected, disabled, onRetry }: {
  jobs: EnvJob[]; disconnected: boolean; disabled: boolean; onRetry: (jobId: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState('');
  const [now, setNow] = useState(Date.now());
  const running = jobs.some(envJobActive);
  useEffect(() => {
    if (!running || disconnected) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, disconnected]);
  const job = jobs.find(item => item.jobId === selected) || jobs.find(envJobActive) || jobs.at(-1);
  if (!job) return null;
  const elapsed = job.started && job.state === 'running' && !disconnected
    ? Math.max(job.elapsedSeconds, (now / 1000) - job.started) : job.elapsedSeconds;
  const timeLabel = (timestamp: number) => new Date(timestamp * 1000).toLocaleTimeString('zh-CN', { hour12: false });
  return (
    <section className="env-monitor" aria-label="安装过程">
      <div className="env-monitor-heading">
        <h3>安装过程</h3>
        <span>{running ? '后台串行执行 · 切页后可恢复查看' : '保留本服务近期安装结果'}</span>
      </div>
      <div className="env-job-list" aria-label="选择安装任务">
        {jobs.map(item => (
          <button key={item.jobId} type="button" className={item.jobId === job.jobId ? 'selected' : ''}
            aria-pressed={item.jobId === job.jobId} onClick={() => setSelected(item.jobId)}>
            {item.name || item.id}<span className={item.state === 'fail' ? 'env-fail-text' : ''}>{STATE_LABELS[item.state]}</span>
          </button>
        ))}
      </div>
      <div className="env-job-summary">
        <strong>{job.name || job.id}</strong>
        <span className="env-job-stage" aria-live="polite">
          {disconnected && envJobActive(job) ? '上次状态：' : ''}
          {job.state === 'queued' ? `等待队列 · 第 ${job.queuePosition || 1} 位` : job.label}
        </span>
        <span>{job.state === 'queued' ? '尚未开始计时' : `已用 ${formatEnvDuration(elapsed || 0)}`}</span>
      </div>
      <dl className="env-job-facts">
        <div><dt>尝试</dt><dd>第 {job.attempt || 1} 轮{job.retryOf ? '（手动重试）' : ''}</dd></div>
        <div><dt>步骤</dt><dd>{job.strategyIndex ? `${job.strategyIndex} / ${job.strategyCount}` : '准备检测'}{job.strategy ? ` · ${job.strategy}` : ''}</dd></div>
        <div><dt>超时上限</dt><dd>{job.phaseTimeoutSeconds ? `当前步骤 ${formatEnvDuration(job.phaseTimeoutSeconds)}；` : ''}本轮 {formatEnvDuration(job.timeoutSeconds)}</dd></div>
        <div><dt>最近输出</dt><dd>{job.lastOutputAt ? timeLabel(job.lastOutputAt) : '尚无输出'}{job.ended ? ` · 结束于 ${timeLabel(job.ended)}` : ''}</dd></div>
      </dl>
      {job.state === 'fail' && <div className="env-job-error">
        <strong>失败原因</strong>
        <p>{job.result?.detail || '安装器未能完成校验，请查看输出。'}</p>
        {job.result?.nextStep && <p>{job.result.nextStep}</p>}
        <button type="button" className="btn btn-sm btn-fill" disabled={disabled || running || job.result?.retryable === false}
          onClick={() => void onRetry(job.jobId)}>重试这项安装</button>
        {job.result?.retryable === false && <span>请先处理未结束的旧进程，再重启工作台并检测。</span>}
      </div>}
      {job.state === 'ok' && <p className="env-job-success">安装器校验通过{job.result?.version ? ` · ${job.result.version}` : ''}。功能是否可用仍以实际运行结果为准。</p>}
      <details className="env-log-details" open>
        <summary>真实输出 <span>{job.logLineCount || job.lines.length} 行 · 最多保留最近 240 行</span></summary>
        <pre className="env-log" role="log" aria-label="安装输出" aria-live="off" tabIndex={0}>{job.lines.length ? job.lines.join('\n') :
          job.state === 'queued' ? '等待前一项完成后开始。' : '此步骤尚未产生输出；阶段、耗时和终态会继续更新。'}</pre>
      </details>
    </section>
  );
}

/** Environment results, recipe explanations and reconnectable server jobs. */
export default function EnvBoard({ tools, python, loading, error, onRefresh }: Props) {
  const controller = useEnvironmentJobs(onRefresh);
  const latestByTool = new Map<string, EnvJob>();
  controller.jobs.forEach(job => latestByTool.set(job.id, job));
  const jobs = [...latestByTool.values()];
  const anyRunning = controller.jobs.some(envJobActive);
  const disabled = controller.submitting || !controller.loaded || !!controller.connectionError || !!controller.blockedReason;
  const total = tools.length;
  const okCount = tools.filter(tool => tool.state === 'ok').length;
  const installable = (tool: EnvTool) => tool.state !== 'no_dir' && !tool.needsDir;
  const pendingIds = (list: EnvTool[]) => list.filter(tool => tool.state !== 'ok' && installable(tool) && !tool.big).map(tool => tool.id);

  const installTool = (tool: EnvTool) => {
    const previous = latestByTool.get(tool.id);
    if (previous?.state === 'fail') void controller.retry(previous.jobId);
    else void controller.install([tool.id]);
  };
  return (
    <section className="st-env">
      <div className="panel-top">
        <span className="pill sum">{loading ? '检测中…' : `已检测就绪 ${okCount} / ${total}`}</span>
        <span className="spacer" />
        <button className="btn btn-sm" onClick={onRefresh} disabled={loading || anyRunning}>重新检测</button>
        <button className="btn btn-sm btn-primary" onClick={() => void controller.install(pendingIds(tools))}
          disabled={disabled || loading || anyRunning || !pendingIds(tools).length}>安装缺少项</button>
      </div>
      <p className="env-intro">按要使用的功能补齐环境，标记为可选的库可以暂不安装。批量安装不包含大型转写模型。</p>
      <details className="env-runtime">
        <summary>安装到哪里 · 重试与超时规则</summary>
        <dl>
          <dt>目标 Python</dt><dd>{python || '等待环境检测…'}</dd>
          <dt>安装范围</dt><dd>Python 库使用上方解释器；系统工具、工程依赖、浏览器和模型各有不同目录，见每项说明。本页安装的系统依赖不保证随目录搬迁。</dd>
          <dt>重试规则</dt><dd>每次点击只运行一轮受控步骤。pip 默认源失败后可尝试镜像，每个源的网络重试最多 2 次、网络超时 30 秒；其他备用步骤和超时以任务记录为准。不会自动重新提交整轮安装，手动重试会记为新一轮。</dd>
          <dt>任务恢复</dt><dd>关闭或切换页面不会取消后台队列；返回后自动读取。网络恢复会继续取进度。服务重启后需重新检测环境，历史记录仅保留在当前服务。</dd>
        </dl>
      </details>
      {error && <div className="env-error" role="alert">{error}</div>}
      {controller.connectionError && <div className="env-connection" role="status">
        <strong>正在恢复进度连接</strong>
        <span>{controller.connectionError}。这不代表安装失败；已保留最后状态，最长每 15 秒重试读取。</span>
        <button className="btn btn-sm" onClick={() => void controller.reconnect()} disabled={controller.reading}>重新连接</button>
      </div>}
      {controller.blockedReason && <div className="env-error" role="alert">{controller.blockedReason}</div>}
      {controller.operationError && <div className="env-error" role="status">{controller.operationError}</div>}
      {controller.notice && <p className="env-notice" role="status">{controller.notice}</p>}
      {!controller.loaded && !controller.connectionError && <p className="env-notice">正在读取后台安装任务…</p>}
      <InstallMonitor jobs={jobs} disconnected={!!controller.connectionError} disabled={disabled} onRetry={controller.retry} />
      {loading && !tools.length && <div className="board"><div className="empty"><span className="spin" /> 正在检测环境…<span className="hint">单次最多 240 秒，不会重复启动检测。</span></div></div>}
      {GROUPS.map(group => {
        const list = tools.filter(tool => tool.group === group.id);
        if (!list.length) return null;
        const pending = pendingIds(list);
        return <div className="grp" key={group.id}>
          <div className="grp-hd">
            <h3>{group.title} <span className="en">{group.note}</span></h3>
            <span className="grp-stat">{list.filter(tool => tool.state === 'ok').length} / {list.length} 就绪</span>
            <button className="btn btn-sm" onClick={() => void controller.install(pending)} disabled={disabled || loading || anyRunning || !pending.length}>补装本组</button>
          </div>
          <div className="grid">
            {list.map(tool => {
              const job = latestByTool.get(tool.id);
              const active = job && envJobActive(job);
              const state = active ? 'busy' : tool.state === 'ok' ? 'ok' : job?.state === 'ok' ? 'ok' :
                job?.state === 'fail' ? 'fail' : !installable(tool) ? 'nodir' : tool.state === 'fail' ? 'fail' : 'missing';
              const badge = active ? STATE_LABELS[job.state] : state === 'ok' ? '已就绪' : state === 'fail' ? '失败' : state === 'nodir' ? '需视频工程' : '未安装';
              const Icon = ICONS[tool.id] || IconPackage;
              return <article className="card env-tool" key={tool.id} data-tool={tool.id} data-state={state}>
                <div className="card-top">
                  <span className="tile"><Icon size={17} /></span>
                  <span className={`badge pill ${state === 'ok' ? 'ok' : state === 'fail' ? 'fail' : active ? 'warn' : 'off'}`}>{badge}</span>
                </div>
                <div className="env-tool-title"><h4 className="card-name">{tool.name}</h4><ToolInfo tool={tool} /><span className="env-requirement">{tool.requirement || '按需安装'}</span></div>
                <p className="card-desc">{tool.purpose || tool.desc}</p>
                {!!tool.usedBy?.length && <p className="env-uses"><strong>用于</strong>{tool.usedBy.join(' · ')}</p>}
                <div className="card-foot">
                  <span className="foot-status">{active ? job.label : state === 'ok' ? job?.result?.version || tool.version || '检测通过' : state === 'nodir' ? '请先初始化 Remotion 视频工程' : state === 'fail' ? '上方安装过程可查看完整原因' : tool.big ? '约 3.1 GB · 单独下载' : ''}</span>
                  {active && <span className="spin" aria-hidden="true" />}
                  {state === 'nodir' ? <span className="env-directory-hint">工程内安装</span> :
                    <button className={`btn btn-sm ${state === 'ok' ? '' : 'btn-fill'}`} onClick={() => installTool(tool)}
                      disabled={disabled || loading || anyRunning || job?.result?.retryable === false}>
                      {active ? badge : state === 'fail' ? '重试' : state === 'ok' ? '检查并补装' : tool.big ? '下载模型' : '安装'}
                    </button>}
                </div>
                {state === 'fail' && (job?.result?.detail || tool.detail) && <p className="env-card-error">{job?.result?.detail || tool.detail}</p>}
              </article>;
            })}
          </div>
        </div>;
      })}
      <p className="foot-note">安装与检测均使用本机真实结果；不会自动登录、调用收费模型或向平台发布内容。</p>
    </section>
  );
}
