import type { OfficeAgent, OfficeEvent, OfficeRelation } from './agentOffice';

export type WorkflowLane = 'active' | 'waiting' | 'finished' | 'attention';
export interface WorkflowLink { from: string; to: string; label: string; kind: 'parent' | 'demo-handoff' | 'assignment' | 'dependency'; delivered?: boolean }

/** Relations come from explicit parent identities; prose and return status never create dependencies. */
export function deriveOfficeWorkflow(agents: OfficeAgent[], events: OfficeEvent[], mode: 'live' | 'demo', elapsed = 0, relations: OfficeRelation[] = []) {
  const members = agents.filter(agent => agent.source === mode);
  const ids = new Set(members.map(agent => agent.id));
  const lanes: Record<WorkflowLane, OfficeAgent[]> = { active: [], waiting: [], finished: [], attention: [] };
  for (const agent of members) {
    const lane: WorkflowLane = ['working', 'thinking'].includes(agent.state) ? 'active'
      : agent.state === 'waiting' ? 'waiting' : agent.state === 'done' ? 'finished' : 'attention';
    lanes[lane].push(agent);
  }
  const links: WorkflowLink[] = members.filter(agent => agent.parentId && agent.parentId !== agent.id && ids.has(agent.parentId))
    .map(agent => ({ from: agent.parentId!, to: agent.id, label: agent.assignment ? '调度分工' : '协作上级 → 成员', kind: agent.assignment ? 'assignment' : 'parent' }));
  if (mode === 'live') for (const relation of relations) {
    if (relation.kind === 'dependency' && ids.has(relation.from) && ids.has(relation.to) && relation.from !== relation.to
      && !links.some(link=>link.from===relation.from&&link.to===relation.to&&link.kind==='dependency')) {
      links.push({...relation,label:'阶段依赖'});
    }
  }
  if (mode === 'demo') {
    const handoffs: [string, string, number, string][] = [
      ['researcher', 'designer', 17, '研究摘要'], ['researcher', 'writer', 17, '受众结论'],
      ['designer', 'tester', 31, '视觉方案'], ['writer', 'reviewer', 33, '文案初稿'],
      ['reviewer', 'coordinator', 45, '审阅意见'],
    ];
    for (const [from, to, at, label] of handoffs) if (ids.has(from) && ids.has(to)) {
      links.push({ from, to, label, kind: 'demo-handoff', delivered: Number.isFinite(elapsed) && elapsed >= at });
    }
  }
  // Preserve server order, including equal/absent timestamps; retain only this mode and roster.
  const records = events.filter(event => event.source === mode && ids.has(event.agentId));
  return { members, lanes, links, records };
}
