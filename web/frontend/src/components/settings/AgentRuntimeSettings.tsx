import { useEffect, useMemo, useState } from 'react';
import Select from '../ui/Select';
import { IconAgentOffice, IconSettings2 } from '../icons';
import { fetchAgentRuntimeSettings, saveAgentRuntimeSettings, type AgentRuntimeSettings as RuntimeSettings } from '../../lib/api';
import '../../styles/agent-runtime-settings.css';

function bounded(value: string, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
}

export default function AgentRuntimeSettings({ onOpenModels }: { onOpenModels?: () => void }) {
  const [settings, setSettings] = useState<RuntimeSettings | null>(null);
  // Multiagent defaults to on: saving keeps it enabled unless the user turns it off.
  const [enabled, setEnabled] = useState(true);
  const [startupModel, setStartupModel] = useState('');
  const [maxConcurrent, setMaxConcurrent] = useState(4);
  const [maxChildrenPerAgent, setMaxChildrenPerAgent] = useState(3);
  const [maxSpawnDepth, setMaxSpawnDepth] = useState(1);
  const [runTimeoutSeconds, setRunTimeoutSeconds] = useState(900);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const apply = (value: RuntimeSettings) => {
    setSettings(value);
    // A never-configured workspace presents the default: on, pending one save.
    setEnabled(value.enabled || value.defaulted === true);
    // It also starts on its main model: preselect it so one save turns
    // multiagent on without a hidden model choice.
    setStartupModel(value.startupModel || value.suggestedModel || '');
    setMaxConcurrent(value.maxConcurrent); setMaxChildrenPerAgent(value.maxChildrenPerAgent);
    setMaxSpawnDepth(value.maxSpawnDepth); setRunTimeoutSeconds(value.runTimeoutSeconds);
  };
  useEffect(() => {
    let alive = true;
    fetchAgentRuntimeSettings().then(value => { if (alive) apply(value); })
      .catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : 'Agent 设置读取失败'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const options = useMemo(() => (settings?.options || []).map(option => ({
    value: option.id, label: option.label || option.id,
    description: option.configured ? '已配置，可作为 Agent 启动模型' : '未配置，不可启动',
    disabled: !option.configured,
  })), [settings?.options]);
  const save = async () => {
    setSaving(true); setError(''); setMessage('');
    try {
      const value = await saveAgentRuntimeSettings({ enabled, startupModel: startupModel || null,
        maxConcurrent, maxChildrenPerAgent, maxSpawnDepth, runTimeoutSeconds });
      apply(value); setMessage(value.note || 'Agent 执行设置已保存。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Agent 设置保存失败'); }
    finally { setSaving(false); }
  };

  return <section className="agent-runtime-settings" aria-labelledby="agent-runtime-title">
    <header><span className="provider-glyph" aria-hidden="true"><IconAgentOffice size={20} /></span><div><h3 id="agent-runtime-title">多 AI 协作</h3><p>让主助手把任务分给其他 AI。先选择协作助手使用的模型，再保存启用。</p></div>
      <span className={`agent-runtime-badge${settings?.ready ? ' is-ready' : ''}`}>{loading ? '核验中…' : error && !settings ? '状态未确认' : settings?.ready ? '已启用' : '未启用'}</span></header>
    <div className="agent-runtime-warning" role="note"><strong>模型使用范围</strong><span>协作助手使用这里保存的启动模型。未配置时无法启动子 Agent，也不会自动重试。</span></div>
    <label className="agent-runtime-toggle"><input type="checkbox" checked={enabled} disabled={loading || saving || !startupModel} onChange={event => setEnabled(event.target.checked)} /><span><strong>允许多个 AI 分工协作</strong><small>默认开启；保存后生效，关闭时阻断子 Agent 启动。</small></span></label>
    <div className="agent-runtime-field"><label htmlFor="agent-startup-model">协作助手使用的模型</label><Select id="agent-startup-model" value={startupModel} disabled={loading || saving} onChange={setStartupModel} options={options} placeholder="默认跟随当前主模型" />
      <small>{settings?.defaulted ? '未保存前已为你预选当前主模型。' : ''}协作助手使用这里保存的模型；建议选择适合分工任务的模型。</small></div>
    <details className="model-settings-details agent-advanced"><summary><span aria-hidden="true"><IconSettings2 size={16} /></span>高级设置 <small>同时工作数量、任务层级与超时</small></summary>
    <div className="agent-runtime-grid">
      <label>并行 Agent 数<input type="number" min={1} max={8} value={maxConcurrent} disabled={loading || saving} onChange={event => setMaxConcurrent(bounded(event.target.value, 4, 1, 8))} /><small>1–8，越高越快也越消耗额度</small></label>
      <label>单个父 Agent 子任务数<input type="number" min={1} max={5} value={maxChildrenPerAgent} disabled={loading || saving} onChange={event => setMaxChildrenPerAgent(bounded(event.target.value, 3, 1, 5))} /><small>1–5，避免一次爆发</small></label>
      <label>嵌套层级<input type="number" min={0} max={2} value={maxSpawnDepth} disabled={loading || saving} onChange={event => setMaxSpawnDepth(bounded(event.target.value, 1, 0, 2))} /><small>建议 1，禁止无限递归</small></label>
      <label>单任务上限（秒）<input type="number" min={60} max={3600} value={runTimeoutSeconds} disabled={loading || saving} onChange={event => setRunTimeoutSeconds(bounded(event.target.value, 900, 60, 3600))} /><small>超时收尾，不重复发起</small></label>
    </div>
    <p className="agent-runtime-note">启动模型保存到 OpenClaw 的 subagents.model，不启用备用模型回退。</p>
    </details>
    {!loading && !settings?.options.length && <p className="agent-runtime-error" role="alert">当前没有可核验的模型配置，请先配置模型渠道。</p>}
    {settings?.reason && <p className="agent-runtime-note" role="status">{settings.reason}</p>}
    {message && <p className="agent-runtime-success" role="status">{message}</p>}
    {error && <p className="agent-runtime-error" role="alert">{error}</p>}
    <div className="agent-runtime-actions"><button type="button" className="settings-primary-button" disabled={loading || saving || (enabled && !startupModel)} onClick={() => void save()}>{saving ? '保存并同步中…' : '保存 Agent 设置'}</button>{onOpenModels && <button type="button" className="settings-secondary-button" disabled={saving} onClick={onOpenModels}>管理模型渠道 ↗</button>}</div>
  </section>;
}
