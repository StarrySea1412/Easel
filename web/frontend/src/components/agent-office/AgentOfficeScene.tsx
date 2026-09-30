import { useEffect, useRef, useState } from 'react';
import { OFFICE_STATE_LABELS, type OfficeAgent } from '../../lib/agentOffice';
import { createOfficeSceneRuntime, type OfficeSceneRuntime } from './OfficeSceneRuntime';
import './agent-office-scene.css';

export interface AgentOfficeSceneProps {
  agents: OfficeAgent[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  paused: boolean;
  resetKey: number;
  onUnavailable?: (message: string) => void;
}

export default function AgentOfficeScene(props: AgentOfficeSceneProps) {
  const host = useRef<HTMLDivElement>(null);
  const sign = useRef<HTMLSpanElement>(null);
  const labels = useRef(new Map<string, HTMLButtonElement>());
  const runtime = useRef<OfficeSceneRuntime | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!host.current || !sign.current) return;
    let active = true;
    const report = (message: string) => {
      if (!active) return;
      setUnavailable(message);
      latest.current.onUnavailable?.(message);
      // A lost GPU context is retried explicitly, without keeping a dead renderer.
      runtime.current?.dispose();
      runtime.current = null;
    };
    try {
      runtime.current = createOfficeSceneRuntime({
        ...latest.current,
        host: host.current,
        sign: sign.current,
        labels: labels.current,
        onSelect: (id) => latest.current.onSelect(id),
        onUnavailable: report,
      });
    } catch {
      report('当前设备暂时无法显示三维场景。Agent 状态仍可在列表中查看，也可以重试加载。');
    }
    return () => {
      active = false;
      runtime.current?.dispose();
      runtime.current = null;
    };
  }, [retryKey]);

  useEffect(() => {
    runtime.current?.update({ agents: props.agents, selectedId: props.selectedId, paused: props.paused });
  }, [props.agents, props.selectedId, props.paused]);

  useEffect(() => { runtime.current?.reset(); }, [props.resetKey]);

  return <div className={`agent-office-scene${unavailable ? ' agent-office-scene--unavailable' : ''}`} ref={host}>
    <div className="agent-office-scene__labels" aria-label="办公室中的 Agent" hidden={Boolean(unavailable)}>
      <span className="agent-office-scene__sign" ref={sign} aria-hidden="true">EASEL STUDIO</span>
      {props.agents.map((agent) => <button
        key={agent.id}
        type="button"
        className={`office-nameplate office-nameplate--${agent.state}${props.selectedId === agent.id ? ' is-selected' : ''}`}
        ref={(element) => { if (element) labels.current.set(agent.id, element); else labels.current.delete(agent.id); }}
        aria-pressed={props.selectedId === agent.id}
        aria-label={`${agent.name}，${OFFICE_STATE_LABELS[agent.state]}，${agent.task}`}
        title={`${agent.name} · ${agent.role}\n${agent.task}`}
        onClick={() => props.onSelect(agent.id)}
      >
        <span className="office-nameplate__heading"><span className="office-nameplate__dot" /><strong>{agent.name}</strong><span>{OFFICE_STATE_LABELS[agent.state]}</span></span>
        <span className="office-nameplate__task">{agent.task || '等待任务说明'}</span>
      </button>)}
    </div>
    {unavailable ? <div className="agent-office-scene__fallback" role="status">
      <span className="agent-office-scene__fallback-icon" aria-hidden="true">◇</span>
      <strong>三维场景暂不可用</strong>
      <p>{unavailable}</p>
      <button type="button" onClick={() => { setUnavailable(null); setRetryKey((value) => value + 1); }}>重新加载场景</button>
    </div> : <div className="agent-office-scene__hint" aria-hidden="true"><span>拖动旋转</span><i />滚动缩放<i /><span>点击 Agent 查看任务</span></div>}
  </div>;
}
