import { useMemo, useState } from 'react';
import { OFFICE_STATE_LABELS, type OfficeAgent, type OfficeEvent } from '../../lib/agentOffice';
import { deriveOfficeWorkflow, type WorkflowLane } from '../../lib/officeWorkflow';
import './office-workflow.css';

const LANES: [WorkflowLane, string, string][] = [
  ['active', '正在推进', '01'], ['waiting', '等待协作', '02'], ['attention', '需要关注', '03'], ['finished', '已经完成', '04'],
];
const EVENT_LABELS = { call: '调用', result: '回执', spawn: '分派记录', status: '状态记录' };
const ATTENTION_STATES = [
  { state: 'error', label: '报告问题', note: '查看过程中的错误记录，确认原因和下一步。' },
  { state: 'stopped', label: '已停止', note: '确认停止原因与是否需要继续；停止不一定代表失败。' },
  { state: 'unknown', label: '状态待核对', note: '当前无法确认成员状态，请查看已记录的过程；不代表执行失败。' },
] as const;
export default function OfficeWorkflowPanel({ agents, events, mode, elapsed, selectedId, stale, onSelect, onOpenProcess, displayName }: {
  agents: OfficeAgent[]; events: OfficeEvent[]; mode: 'live' | 'demo'; elapsed: number;
  selectedId: string | null; stale: boolean; onSelect: (id: string) => void; onOpenProcess: (id: string) => void;
  displayName: (agent: OfficeAgent) => string;
}) {
  const [onlySelected, setOnlySelected] = useState(false);
  const flow = useMemo(() => deriveOfficeWorkflow(agents, events, mode, elapsed), [agents, events, mode, elapsed]);
  const name = (id: string) => { const agent = flow.members.find(item => item.id === id); return agent ? displayName(agent) : id; };
  const records = flow.records.filter(event => !onlySelected || event.agentId === selectedId).slice(-12).reverse();
  const attentionCount = flow.members.filter(agent => ATTENTION_STATES.some(item => item.state === agent.state)).length;
  return <section className="office-workflow" aria-label="协作工作流">
    <header><div><p className="office-eyebrow">TEAM FLOW / 协作工作流</p><h2>谁在推进，下一棒交给谁。</h2></div><span className="workflow-source">{mode === 'demo' ? '模拟协作' : stale ? '上次快照 · 更新中断' : '已观测记录'}</span></header>
    <p className="workflow-note">{mode === 'demo' ? '与办公室同一条演示时间轴；阶段按钮可暂停查看分工、交接和返工。' : '只展示当前会话已上报的成员、任务与上级关系。工具返回不等于任务完成；未上报的依赖和成员通讯不会补写。'}</p>
    <section className="workflow-attention" aria-label="需要处理">
      <div className="workflow-attention-heading"><h3>{mode === 'demo' ? '模拟 · 需要处理' : stale ? '历史快照 · 需要核对' : '需要处理'} <span>{attentionCount} 位</span></h3><small>{mode === 'demo' ? '演示脚本状态，非真实告警' : stale ? '更新已中断，不代表当前状态' : '依据最近已观测状态'}</small></div>
      <p className="workflow-note">仅汇总报告问题、已停止和状态未知的成员。缺少任务说明或上级关系不会计为故障。</p>
      <div className="workflow-attention-groups">{ATTENTION_STATES.map(item => {
        const members = flow.members.filter(agent => agent.state === item.state);
        return members.length ? <section className="workflow-attention-group" key={item.state} aria-label={item.label}>
          <h4>{item.label} · {members.length}</h4><p>{item.note}</p>
          <ul>{members.map(agent => <li key={agent.id}><button type="button" onClick={() => onOpenProcess(agent.id)}><strong>{name(agent.id)}</strong><span>{agent.task || '任务说明未上报'}</span><small>{mode === 'demo' ? '模拟过程' : stale ? '已保留过程' : '查看过程'} ↗</small></button></li>)}</ul>
        </section> : null;
      })}</div>
      {!attentionCount && <p className="workflow-empty">{mode === 'demo' ? '当前模拟阶段' : stale ? '这份历史快照' : '已观测成员中'}暂无上述状态；未观测到的成员不在统计范围内。</p>}
      <details className="workflow-waiting-summary"><summary>等待中的成员 · {flow.lanes.waiting.length}</summary><p className="workflow-note">等待单独列出，不计入需要处理。等待原因未由状态说明，不能据此判断正在等待审批或出现阻塞；请查看过程。</p><ul>{flow.lanes.waiting.map(agent => <li key={agent.id}><button type="button" onClick={() => onOpenProcess(agent.id)}>{name(agent.id)} · {mode === 'demo' ? '模拟等待' : stale ? '历史等待状态' : '已观测等待'} · 查看过程 ↗</button></li>)}</ul>{!flow.lanes.waiting.length && <p className="workflow-empty">没有已记录为等待的成员。</p>}</details>
    </section>
    <div className="workflow-lanes">{LANES.map(([key, title, number]) => <section key={key} className={`workflow-lane workflow-lane-${key}`} aria-label={`${title}任务`}>
      <h3><span>{number}</span>{title}<b>{flow.lanes[key].length}</b></h3>
      <div className="workflow-cards">{flow.lanes[key].map(agent => <button type="button" key={agent.id} className="workflow-task" aria-pressed={selectedId === agent.id} onClick={() => onSelect(agent.id)}>
        <span className="workflow-task-top"><strong>{name(agent.id)}</strong><small>{OFFICE_STATE_LABELS[agent.state]}</small></span>
        <span className="workflow-role">{agent.role}</span><span className="workflow-task-copy">{agent.task || '尚未上报任务'}</span>
        <span className="workflow-task-parent">{agent.parentId && flow.members.some(item => item.id === agent.parentId) ? `上级：${name(agent.parentId)}` : '未上报协作上级'} · 定位工位 ↗</span>
      </button>)}{!flow.lanes[key].length && <p className="workflow-empty">暂无{title}的成员</p>}</div>
    </section>)}</div>
    <div className="workflow-bottom"><section aria-label="分派与交接关系"><h3>分派与交接</h3><p className="workflow-note">{mode === 'demo' ? '交接为模拟脚本；交接前仍可并行构思。' : '箭头表示已记录的协作上级关系，不代表任务依赖或已发送消息。'}</p>
      <ul className="workflow-links">{flow.links.map(link => <li key={`${link.kind}:${link.from}:${link.to}`}><button type="button" onClick={() => onSelect(link.from)}>{name(link.from)}</button><span aria-hidden="true">→</span><button type="button" onClick={() => onSelect(link.to)}>{name(link.to)}</button><small>{link.kind === 'parent' ? '协作关系' : `${link.delivered ? '已交接' : '待交接'} · ${link.label} · 模拟`}</small></li>)}</ul>
      {!flow.links.length && <p className="workflow-empty">尚无可核验的协作关系</p>}
    </section><section aria-label="协作事件时间线"><div className="workflow-feed-heading"><h3>协作动态</h3><label><input type="checkbox" checked={onlySelected} onChange={event => setOnlySelected(event.target.checked)} />仅选中成员</label></div>
      <p className="workflow-note">最近 12 条可见记录 · {mode === 'demo' ? '模拟时间' : stale ? '保留的历史快照' : '按后台返回顺序'}；点击查看过程。</p>
      <ol className="workflow-feed">{records.map(event => <li key={event.id}><button type="button" onClick={() => onOpenProcess(event.agentId)}><span><strong>{name(event.agentId)}</strong><small>{EVENT_LABELS[event.kind]} · {event.status === 'failed' ? '报告错误' : event.kind === 'result' ? '已返回，结果见记录' : '已记录'}</small></span><p>{event.title}</p><time>{mode === 'demo' ? `${Math.floor(event.elapsedSeconds || 0)}s · 模拟` : event.at ? new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false }) : '时间未上报'}</time></button></li>)}</ol>
      {!records.length && <p className="workflow-empty">尚无符合筛选条件的记录</p>}
    </section></div>
  </section>;
}
