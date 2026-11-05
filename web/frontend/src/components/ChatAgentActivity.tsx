import { useChatRun } from '../hooks/useChatRun';
import { useAgentOffice } from '../hooks/useAgentOffice';
import { describeOfficeAction } from '../lib/officeActions';
import { OpenClawIcon, AgentActionIcon, ModelIdentityLabel } from './AgentIdentity';
import { IconRefresh } from './icons';
import ChatSubagentActivity from './ChatSubagentActivity';
import '../styles/chat-run-progress.css';

/** The office snapshot is only attached to its exact conversation turn. */
export default function ChatAgentActivity({sessionId,turnId}:{sessionId:string;turnId:string}) {
  const run=useChatRun();
  const shared=run?.sessionId===sessionId&&run.turnId===turnId;
  const historical=useAgentOffice(sessionId,Boolean(run&&run.engine!=='codex'&&!shared),turnId,false);
  if(!run||run.sessionId!==sessionId||run.engine==='codex')return null;
  const office=shared?run.office:historical, current=office.turnId===turnId;
  if(!shared&&!current&&!office.error)return null;
  return <section className="chat-agent-activity" aria-label="本轮 Agent 行为">
    <div className="chat-agent-engine"><OpenClawIcon/><strong>OpenClaw</strong><span>{office.error?'观测中断 · 上次快照':office.loading&&!current?'正在读取行为':current?'本轮行为':'等待本轮行为回执'}</span></div>
    {current&&office.agents.map(agent=>{if(agent.parentId)return <ChatSubagentActivity key={`${sessionId}:${turnId}:${agent.id}`} sessionId={sessionId} turnId={turnId} agent={agent} events={office.events} stale={Boolean(office.error)}/>;const action=describeOfficeAction(agent,office.events);return <div className="chat-agent-row" key={agent.id} data-agent-id={agent.id}>
      <div className="chat-agent-action"><AgentActionIcon kind={action.kind}/><strong>{agent.parentId?'子 Agent':'主 Agent'}{agent.parentId?` · ${agent.name}`:''}</strong><span>{action.label}</span></div>
      <ModelIdentityLabel identity={agent.observedModel}/>
    </div>;})}
    {office.error&&<button type="button" className="btn btn-sm btn-ghost chat-agent-refresh" disabled={office.loading} onClick={office.refresh}>
      <IconRefresh size={14}/>{office.loading?'读取中…':'重新读取行为'}
    </button>}
  </section>;
}
