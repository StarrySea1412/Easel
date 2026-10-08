import type { OfficeAgent, OfficeEvent } from '../../lib/agentOffice';

/** Keep the task summary within the selected observation source and roster. */
export function officeTaskFocusData(agents: OfficeAgent[], events: OfficeEvent[], selectedId: string | null, mode: 'live' | 'demo') {
  const members = agents.filter(agent => agent.source === mode);
  const agent = members.find(member => member.id === selectedId) ?? members[0];
  // The server's sequence is authoritative, including missing/equal timestamps.
  // A return is evidence of a receipt only, never an inferred completed task.
  const latestReturn = agent ? events.findLast(event => event.source === mode && event.agentId === agent.id
    && event.kind === 'result' && (event.status === 'returned' || event.status === 'failed')) : undefined;
  return {
    agent, members, latestReturn,
    active: members.filter(member => member.state === 'working' || member.state === 'thinking').length,
    waiting: members.filter(member => member.state === 'waiting').length,
    done: members.filter(member => member.state === 'done').length,
  };
}
