import { useEffect, useRef, useState } from 'react';
import type { OfficeAgent } from '../../lib/agentOffice';
import { fetchOfficeControls, saveOfficeAgentModel, stopOfficeAgent, OFFICE_MODEL_SCOPE_LABELS, type OfficeControls,
  type OfficeControlIdentity } from '../../lib/officeControls';
import AgentModelRoutingSettings from '../settings/AgentModelRoutingSettings';
import './office-agent-controls.css';

export interface OfficeAgentControlsProps {
  agent: OfficeAgent;
  sessionId: string | null;
  turnId: string | null;
  stale: boolean;
  observationKey?: string | null;
  onChanged?: () => void;
  onOpenModelSettings?: () => void;
}

export default function OfficeAgentControls(props: OfficeAgentControlsProps) {
  if (props.agent.source !== 'live') return <p className="office-control-note">演示员工不连接真实模型，也不会发送停止请求。</p>;
  if (!props.sessionId || !props.turnId) return <p className="office-control-note">当前记录缺少可核验的会话或轮次，请刷新后查看控制选项。</p>;
  const identity = { sessionId: props.sessionId, turnId: props.turnId, agentId: props.agent.id };
  return <LiveOfficeAgentControls key={JSON.stringify(identity)} {...props} identity={identity} />;
}

function LiveOfficeAgentControls({ agent, identity, stale, observationKey, onChanged, onOpenModelSettings }: OfficeAgentControlsProps & { identity: OfficeControlIdentity }) {
  const [controls, setControls] = useState<OfficeControls | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState<'model' | 'stop' | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [stoppedRun, setStoppedRun] = useState<string | null>(null);
  const latestControls = useRef<OfficeControls | null>(null);
  const lastKnownRun = useRef<string | null>(null);
  const lastLifecycle = useRef({ state: agent.state, stale, revision });
  const operation = useRef<AbortController | null>(null);
  const active = useRef(true);
  const { sessionId, turnId, agentId } = identity;
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; operation.current?.abort(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    if (!latestControls.current || lastLifecycle.current.state !== agent.state
      || lastLifecycle.current.stale !== stale || lastLifecycle.current.revision !== revision) setLoading(true);
    lastLifecycle.current = { state: agent.state, stale, revision };
    setError('');
    fetchOfficeControls({ sessionId, turnId, agentId }, controller.signal).then(value => {
      if (!controller.signal.aborted) {
        if (value.stop.runId && lastKnownRun.current && value.stop.runId !== lastKnownRun.current) {
          setMessage(''); setStoppedRun(null);
        }
        if (value.stop.runId) lastKnownRun.current = value.stop.runId;
        latestControls.current = value;
        setControls(value);
      }
    }).catch(cause => {
      if (!controller.signal.aborted) { latestControls.current = null; setControls(null); setError(cause instanceof Error ? cause.message : '控制选项读取失败。'); }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [sessionId, turnId, agentId, agent.state, agent.updatedAt, observationKey, stale, revision]);

  const locked = stale || loading || Boolean(busy);
  const isRoot = !agent.parentId && agent.id === `root:${sessionId}`;
  const stopAllowed = controls?.stop.available && (controls.stop.scope === 'agent' || (isRoot && controls.stop.scope === 'session'));
  const controlRun = controls?.stop.runId || `${turnId}:${agentId}`;
  const terminal = stoppedRun === controlRun || ['done', 'error', 'stopped'].includes(agent.state);
  const run = async (kind: 'model' | 'stop', modelRef?: string) => {
    if (locked || operation.current || !controls) return;
    if (kind === 'stop' && (!stopAllowed || terminal)) return;
    if (kind === 'model' && (!controls.model.available || !controls.model.options.some(option => option.id === modelRef && option.configured))) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(kind); setError(''); setMessage('');
    try {
      if (kind === 'model') {
        const receipt = await saveOfficeAgentModel(identity, modelRef!, controller.signal);
        if (!active.current || controller.signal.aborted) return;
        if (receipt.applied && receipt.modelRef === modelRef && receipt.scope === controls.model.scope) {
          setMessage(`模型分配已保存并确认。${OFFICE_MODEL_SCOPE_LABELS[receipt.scope]}`);
          setRevision(value => value + 1);
        } else setError(`后台尚未确认模型分配，请刷新配置后检查。${receipt.message}`);
      } else {
        const expectedRunId = controls.stop.runId || undefined;
        const receipt = await stopOfficeAgent(identity, controller.signal, expectedRunId);
        if (!active.current || controller.signal.aborted) return;
        if (receipt.confirmed && receipt.scope === controls.stop.scope && (receipt.scope === 'agent' || isRoot)
          && (!expectedRunId || receipt.runId === expectedRunId)
          && (!expectedRunId || !lastKnownRun.current || lastKnownRun.current === expectedRunId)) {
          setStoppedRun(controlRun);
          setMessage(receipt.scope === 'session' ? '后台已确认本轮会话停止。' : '后台已确认该 Agent 停止。');
          setRevision(value => value + 1);
        } else setError(`停止结果尚未确认，当前状态未更改，请刷新后检查。${receipt.message}`);
      }
      onChanged?.();
    } catch (cause) {
      if (active.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : '操作结果尚未确认，请刷新后检查。');
    } finally {
      if (operation.current === controller) operation.current = null;
      if (active.current) setBusy(null);
    }
  };

  return <section className="office-agent-controls" aria-label="Agent 模型与执行控制">
    <div className="office-controls-heading"><h3>模型与执行</h3><button type="button" className="office-control-link" disabled={Boolean(busy) || loading} onClick={() => setRevision(value => value + 1)}>刷新控制状态</button></div>
    {stale && <p className="office-control-note" role="status">当前为上次快照，刷新协作记录后才能操作。</p>}
    {loading && <p className="office-control-note" role="status">正在核验可用控制…</p>}
    {controls && <>
      <AgentModelRoutingSettings capability={controls.model} disabled={locked} saving={busy === 'model'} onSave={modelRef => void run('model', modelRef)} onOpenModelSettings={onOpenModelSettings} />
      <div className="office-agent-stop">
        <h4>执行控制</h4>
        <p className="office-control-note">{controls.stop.scope === 'session' && isRoot ? '此操作停止当前会话整轮任务。' : stopAllowed ? '停止当前 Agent 及其派生任务，不停止父 Agent 或其他同级员工。' : controls.stop.reason}</p>
        {controls.stop.scope === 'session' && !isRoot && <p className="office-control-note">后台仅提供整轮停止，不能作为该员工的独立停止操作。</p>}
        <button type="button" className="office-button office-control-stop" disabled={locked || !stopAllowed || terminal} onClick={() => void run('stop')}>
          {busy === 'stop' ? '等待后台确认…' : controls.stop.scope === 'session' && isRoot ? '停止本轮会话' : '停止此 Agent'}
        </button>
      </div>
    </>}
    {error && <p className="office-control-error" role="alert">{error}</p>}
    {message && <p className="office-control-message" role="status">{message}</p>}
  </section>;
}
