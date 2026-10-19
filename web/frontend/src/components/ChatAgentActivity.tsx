import { useChatRun } from '../hooks/useChatRun';
import { describeOfficeAction } from '../lib/officeActions';
import { OpenClawIcon, AgentActionIcon, ModelIdentityLabel } from './AgentIdentity';
import '../styles/chat-run-progress.css';

/** The office snapshot is only attached to its exact conversation turn. */
export default function ChatAgentActivity({sessionId,turnId}:{sessionId:string;turnId:string}) {
  const run=useChatRun();
  if(!run||run.sessionId!==sessionId||run.turnId!==turnId||run.engine==='codex')return null;
  const {office}=run, current=office.turnId===turnId;
  return <section className="chat-agent-activity" aria-label="本轮 Agent 行为">
    <div className="chat-agent-engine"><OpenClawIcon/><strong>OpenClaw</strong><span>{office.error?'观测中断 · 上次快照':office.loading&&!current?'正在读取行为':current?'本轮行为':'等待本轮行为回执'}</span></div>
    {current&&office.agents.map(agent=>{const action=describeOfficeAction(agent,office.events);return <div className="chat-agent-row" key={agent.id} data-agent-id={agent.id}>
      <div className="chat-agent-action"><AgentActionIcon kind={action.kind}/><strong>{agent.parentId?'子 Agent':'主 Agent'}{agent.parentId?` · ${agent.name}`:''}</strong><span>{action.label}</span></div>
      <ModelIdentityLabel identity={agent.observedModel}/>
      {agent.parentId&&<small className="chat-agent-coverage">任务：{agent.task} · 状态来自父会话回执</small>}
    </div>;})}
    {office.error&&<button type="button" onClick={office.refresh}>重新读取行为</button>}
  </section>;
}
