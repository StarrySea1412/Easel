import { useChatRun } from '../hooks/useChatRun';
import { describeOfficeAction } from '../lib/officeActions';
import { OpenClawIcon, AgentActionIcon, ModelIdentityLabel } from './AgentIdentity';
import { IconRefresh, IconChevron } from './icons';
import '../styles/chat-run-progress.css';

/** The office snapshot is only attached to its exact conversation turn. */
export default function ChatAgentActivity({sessionId,turnId}:{sessionId:string;turnId:string}) {
  const run=useChatRun();
  if(!run||run.sessionId!==sessionId||run.turnId!==turnId||run.engine==='codex')return null;
  const {office}=run, current=office.turnId===turnId;
  const snapshot=run.execution.current?.turnId===turnId?run.execution.current:null;
  const children=current?office.agents.filter(agent=>agent.parentId):[];
  const spawn=snapshot?.operations.filter(row=>['sessions_spawn','spawn_agent'].includes(row.name)).at(-1);
  const collaboration=children.length?`已观察到 ${children.length} 个子 Agent`:spawn?.status==='failed'||spawn?.status==='denied'?'委派请求未成功':spawn?'已记录委派请求，等待身份回执':'尚未收到委派回执';
  return <section className="chat-agent-activity" aria-label="本轮 Agent 行为">
    <div className="chat-agent-engine"><OpenClawIcon/><strong>OpenClaw</strong><span>{office.error?'观测中断 · 上次快照':office.loading&&!current?'正在读取行为':current?'本轮行为':'等待本轮行为回执'}</span></div>
    {current&&office.agents.map(agent=>{const action=describeOfficeAction(agent,office.events);return <div className="chat-agent-row" key={agent.id} data-agent-id={agent.id}>
      <div className="chat-agent-action"><AgentActionIcon kind={action.kind}/><strong>{agent.parentId?'子 Agent':'主 Agent'}{agent.parentId?` · ${agent.name}`:''}</strong><span>{action.label}</span></div>
      <ModelIdentityLabel identity={agent.observedModel}/>
      {agent.parentId&&<small className="chat-agent-coverage">任务：{agent.task} · 状态来自父会话回执</small>}
    </div>;})}
    {snapshot&&<details className="chat-agent-capabilities"><summary><IconChevron size={12}/><span>计划{snapshot.plan?.length?` · ${snapshot.plan.length} 项`:' · 未收到更新'}</span><span>子 Agent · {collaboration}</span></summary>
      <p>{snapshot.plan?.length?'计划来自本轮成功的工具回执；步骤完成仍需核验结果。':'本轮尚无计划更新回执；复杂任务应先建立计划，并在阶段变化时更新。'}</p>
      <p>{snapshot.runtime? snapshot.runtime.subagentsConfigured?'本轮启动配置允许协作，工具可用性以网关回执为准。独立子任务适合并行分工，简单或串行任务由主 Agent 完成。':`本轮未开放子 Agent：${snapshot.runtime.subagentReason||'请检查设置中的启动模型和委派限制。'}`:'历史记录未保存协作配置，无法据此判断当时是否允许委派。'}</p>
      <p>{current?'以上是本轮已观测回执；未收到回执不代表后台一定未执行。':'当前尚未取得本轮 Agent 身份快照，请结合操作记录核实。'}</p>
    </details>}
    {office.error&&<button type="button" className="btn btn-sm btn-ghost chat-agent-refresh" disabled={office.loading} onClick={office.refresh}>
      <IconRefresh size={14}/>{office.loading?'读取中…':'重新读取行为'}
    </button>}
  </section>;
}
