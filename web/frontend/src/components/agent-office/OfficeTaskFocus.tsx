import { useId, type ReactNode } from 'react';
import type { OfficeAgent, OfficeEvent } from '../../lib/agentOffice';
import { OFFICE_STATE_LABELS } from '../../lib/agentOffice';
import { NativeSelect as Select } from '../ui/Select';
import OfficeModelIdentity from './OfficeModelIdentity';
import { officeTaskFocusData } from './officeTaskFocusData';
import './office-task-focus.css';

export interface OfficeTaskFocusProps {
  agents: OfficeAgent[];
  events: OfficeEvent[];
  selectedId: string | null;
  mode: 'live' | 'demo';
  stale: boolean;
  displayName: (agent: OfficeAgent) => string;
  onSelect: (id: string) => void;
  onOpenProcess: (id: string) => void;
  onOpenOutputs: () => void;
  children?: ReactNode;
}

export default function OfficeTaskFocus({ agents, events, selectedId, mode, stale, displayName, onSelect, onOpenProcess, onOpenOutputs, children }: OfficeTaskFocusProps) {
  const titleId = useId();
  const { agent, members, latestReturn, active, waiting, done } = officeTaskFocusData(agents, events, selectedId, mode);
  const source = mode === 'demo' ? '模拟任务' : stale ? '上次快照 · 更新中断' : '已观测任务';
  return <section className="office-task-focus" aria-labelledby={titleId}>
    <header className="office-task-focus-heading">
      <div><p className="office-eyebrow">TASK / 任务与执行</p><h2 id={titleId}>任务进展与控制</h2></div>
      <span className="office-task-focus-source">{source}</span>
    </header>
    <p className="office-task-focus-team">{mode === 'demo' ? '模拟团队' : stale ? '上次快照中的团队' : '已观测团队'} · {members.length} 位成员 · 推进 {active} · 等待 {waiting} · 完成 {done}</p>
    {agent ? <>
      <label className="office-task-focus-member">查看成员的任务
        <Select aria-label="查看成员的任务" value={agent.id} onChange={event => onSelect(event.target.value)}>
          {members.map(member => <option key={member.id} value={member.id}>{displayName(member)} · {OFFICE_STATE_LABELS[member.state]}</option>)}
        </Select>
      </label>
      <div className="office-task-focus-layout">
        <div className="office-task-focus-summary">
          <div className="office-task-focus-current">
            <div><strong>{displayName(agent)}</strong><span className={`office-state office-state-${agent.state}`}><i aria-hidden="true" />{stale ? '快照 · ' : ''}{OFFICE_STATE_LABELS[agent.state]}</span></div>
            <p>{agent.task || '当前记录未提供任务描述。'}</p>
          </div>
          <dl className="office-task-focus-records">
            <div><dt>{stale ? '上次记录的步骤' : '当前步骤'}</dt><dd>{agent.action?.evidence === 'observed' || agent.action?.evidence === 'demo' ? agent.action.label : '具体操作尚未上报'}<small>{mode === 'demo' ? '来自模拟脚本' : '依据当前成员的可见操作记录'}</small></dd></div>
            <div><dt>最近回执</dt><dd>{latestReturn ? <><span className={latestReturn.status === 'failed' ? 'office-task-focus-failed' : undefined}>{latestReturn.status === 'failed' ? '报告错误' : '已返回'}{mode === 'demo' ? ' · 模拟' : ''}</span><p>{latestReturn.title}</p></> : '尚未观察到该成员的回执'}<small>{latestReturn ? '工具返回不等于任务完成；完整内容请查看过程。' : '没有回执记录不代表任务未执行。'}</small></dd></div>
          </dl>
          <OfficeModelIdentity agent={agent} stale={stale} />
          <div className="office-task-focus-actions"><button type="button" className="office-button" onClick={() => onOpenProcess(agent.id)}>查看工作过程 ↗</button><button type="button" className="office-button" onClick={onOpenOutputs}>查看产出与位置 ↓</button></div>
          <p className="office-task-focus-note">{mode === 'demo' ? '过程和产出示例均为模拟，不触发模型调用。' : '产出区展示整个工作区的文件及路径，不自动归属于当前成员或本轮任务。'}</p>
        </div>
        {children && <div className="office-task-focus-controls">{children}</div>}
      </div>
    </> : <div className="office-task-focus-empty"><p>{mode === 'demo' ? '暂无模拟成员。' : '收到成员身份与任务记录后，进展和对应控制会显示在这里。'}</p><button type="button" className="office-button" onClick={onOpenOutputs}>查看工作区产出 ↓</button></div>}
  </section>;
}
