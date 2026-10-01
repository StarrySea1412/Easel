import type { OfficeAction, OfficeActionKind, OfficeAgent, OfficeEvent } from './agentOffice';

const TERMINAL: Partial<Record<OfficeAgent['state'], [OfficeActionKind, string]>> = {
  done: ['completed', '任务已完成'], error: ['error', '执行遇到错误'], stopped: ['stopped', '任务已停止'],
  waiting: ['waiting', '等待任务或协作结果'], thinking: ['thinking', '正在思考'],
};

function toolAction(name: string): [OfficeActionKind, string] {
  const tool = name.split('.').at(-1) || name;
  if (['sessions_spawn','spawn_agent'].includes(tool)) return ['delegating', '协调协作'];
  if (tool === 'sessions_list') return ['reading', '查看协作状态'];
  // The public receipt omits arguments, so `subagents` does not establish
  // whether the operation lists, steers or stops an existing child.
  if (tool === 'subagents') return ['executing', '执行协作工具'];
  if (['read','read_file','search','web_search','web_fetch','fetch','browser'].includes(tool)) return ['reading', '读取与查阅'];
  if (['write','write_file','edit','apply_patch'].includes(tool)) return ['writing', '编写与编辑'];
  if (['imagegen','image_generate','generate_image','image','canvas'].includes(tool)) return ['designing', '处理视觉内容'];
  return ['executing', '执行工具'];
}

/** Specific live gestures require an observed, unmatched tool call. */
export function describeOfficeAction(agent: OfficeAgent, events: OfficeEvent[]): OfficeAction {
  const terminal = TERMINAL[agent.state];
  if (terminal) return { kind: terminal[0], label: terminal[1], evidence: agent.source === 'demo' ? 'demo' : 'observed' };
  if (agent.source === 'demo') {
    const actions: Record<string, [OfficeActionKind, string]> = {
      coordinator: ['delegating', '分配任务、跟进协作'], researcher: ['reading', '查阅资料、整理研究摘要'],
      designer: ['designing', '绘制版式与视觉方案'], writer: ['writing', '撰写提案与内容正文'],
      tester: ['executing', '核对引用与交付清单'], reviewer: ['reading', '审阅成果与修改意见'],
    };
    const action = actions[agent.id] || ['executing', '处理演示任务'];
    return { kind: action[0], label: action[1], evidence: 'demo' };
  }
  const own = events.filter(event => event.agentId === agent.id && event.source === 'live');
  const returned = new Set(own.filter(event => event.kind === 'result' && event.operationId).map(event => event.operationId));
  const pending = [...own].reverse().find(event => event.kind === 'call' && event.toolName && event.operationId && !returned.has(event.operationId));
  if (agent.state === 'working' && pending?.toolName) {
    const [kind, label] = toolAction(pending.toolName);
    return { kind, label: `${label} · ${pending.toolName}`, evidence: 'observed', toolName: pending.toolName };
  }
  return { kind: 'unreported', label: agent.state === 'working' ? '执行中 · 具体操作未上报' : '尚未上报执行状态', evidence: 'unreported' };
}
