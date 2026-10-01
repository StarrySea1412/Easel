import { createDemoOfficeAgents, createDemoOfficeEvents, OFFICE_STATE_LABELS, type OfficeAgent, type OfficeEvent } from './agentOffice';

/** Scene capacity only: the observed roster is never sliced or filtered in place. */
export const OFFICE_ZONE_CAPACITY = 8;
export const OFFICE_DEMO_TEAM_SIZES = [6, 12, 20, 50] as const;
export type OfficeDemoTeamSize = typeof OFFICE_DEMO_TEAM_SIZES[number];

export function officeZoneForAgent(agents: readonly OfficeAgent[], selectedId: string | null) {
  const index = Math.max(0, agents.findIndex(agent => agent.id === selectedId));
  const zone = Math.floor(index / OFFICE_ZONE_CAPACITY);
  const start = zone * OFFICE_ZONE_CAPACITY;
  return {
    index: zone,
    count: Math.max(1, Math.ceil(agents.length / OFFICE_ZONE_CAPACITY)),
    start,
    agents: agents.slice(start, start + OFFICE_ZONE_CAPACITY),
  };
}

export function searchOfficeTeam(agents: readonly OfficeAgent[], query: string) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return agents.filter(agent => {
    const text = [agent.id, agent.name, agent.appearance?.name, agent.role, agent.task, OFFICE_STATE_LABELS[agent.state]].join(' ').toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  });
}

export function demoOfficeCardId(agentId: string) { return agentId.split(':demo:')[0]; }
export function demoOfficeNameSuffix(agentId: string) {
  const number = agentId.split(':demo:')[1];
  return number ? ` · ${number}` : '';
}

/** Larger demos are deterministic work packages, never a source of live identities. */
export function createTeamDemoOfficeAgents(elapsed: number, count: OfficeDemoTeamSize): OfficeAgent[] {
  const base = createDemoOfficeAgents(elapsed);
  return Array.from({ length: count }, (_, index) => {
    if (index < base.length) return base[index];
    const template = base[1 + (index - base.length) % (base.length - 1)];
    const number = String(index + 1).padStart(2, '0');
    return { ...template, id: `${template.id}:demo:${number}`, name: `${template.name} · ${number}`, task: `模拟工作包 ${number}：${template.task}` };
  });
}

export function createTeamDemoOfficeEvents(elapsed: number, agents: readonly OfficeAgent[]): OfficeEvent[] {
  const base = createDemoOfficeEvents(elapsed);
  return agents.flatMap(agent => base.filter(event => event.agentId === demoOfficeCardId(agent.id)).map(event => ({
    ...event, id: `${event.id}:${agent.id}`, agentId: agent.id,
    title: agent.id.includes(':demo:') ? `${event.title} · 模拟工作包 ${agent.id.split(':demo:')[1]}` : event.title,
  }))).sort((a, b) => (a.elapsedSeconds || 0) - (b.elapsedSeconds || 0));
}
