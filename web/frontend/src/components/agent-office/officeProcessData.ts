import type { OfficeAgent, OfficeEvent } from '../../lib/agentOffice';
import type { ChatMessage, ChatSession, StreamState } from '../../lib/store';
const DEMO_PROCESS: Record<string, string> = {
  coordinator: '演示流程：接收春日品牌提案需求，拆分研究、视觉、文案和检查任务；随后跟进协作进度并汇总成果。',
  researcher: '演示流程：确定研究方向，整理受众偏好和参考资料，再把摘要交给设计与文案岗位。',
  designer: '演示流程：等待研究摘要，构思配色与版式，再制作提案中的视觉方案。',
  writer: '演示流程：根据受众与研究方向组织内容结构，撰写标题、正文和行动建议。',
  tester: '演示流程：检查引用、格式和交付清单，记录演示中的引用问题，再核对修正结果。',
  reviewer: '演示流程：阅读视觉与文案成果，整理审阅意见，核对方案是否回应最初目标。',
};

interface VisibleProcess {
  thinking: string;
  activity: string;
  error?: ChatMessage['error'];
  origin: 'stream' | 'history' | 'unavailable' | 'demo';
  explanation: string;
}

/** A root's display name or apparent role is never sufficient identity evidence. */
export function selectOfficeProcess({ agent, session, stream, turnId }: { agent: OfficeAgent; session?: ChatSession; stream?: StreamState; turnId?: string | null }): VisibleProcess {
  const unavailable = (explanation: string): VisibleProcess => ({ thinking: '', activity: '', origin: 'unavailable', explanation });
  if (agent.source === 'demo') return {
    thinking: '', activity: DEMO_PROCESS[agent.id] || '演示流程：接收任务、处理内容并返回结果。', origin: 'demo',
    explanation: '这是预设的模拟过程摘要，不是模型实际返回的思考或真实工具执行。',
  };
  if (agent.parentId) return unavailable('该子 Agent 未上报内部思考和活动正文。这里只展示它自己的调用与状态记录，不使用主 Agent 的思考补充。');
  if (!session || agent.id !== `root:${session.id}`) return unavailable('没有与该 Agent 精确对应的会话，无法读取它的思考和活动正文。');
  if (session.importedFromBackup) return unavailable('导入备份不关联实时员工过程，不能用于核验该员工的思考。');
  if (!turnId) return unavailable('当前快照没有轮次标识，暂时无法核验本轮思考与工作步骤。');
  if (stream && session.pendingTurnId === turnId) return {
    thinking: stream.thinking || '', activity: stream.activity || '', origin: 'stream',
    explanation: '来自该会话、该轮次正在接收的模型思考与活动记录。',
  };
  const message = session.messages.findLast(item => item.role === 'assistant' && item.turnId === turnId);
  if (!message) return unavailable('尚未找到与本轮标识匹配的思考记录，不会使用其他轮次的内容。');
  return {
    thinking: message.thinking || '', activity: message.activity || '', error: message.error,
    origin: 'history', explanation: '来自该会话、该轮次已保存的模型思考与活动记录。',
  };
}

interface EventStep {
  event: OfficeEvent;
  result?: OfficeEvent;
}

/** Results pair only through the safe operation ID and matching tool identity. */
export function selectOfficeEventSteps(agent: OfficeAgent, events: OfficeEvent[], turnId?: string | null): EventStep[] {
  if (agent.source === 'live' && !turnId) return [];
  const seen = new Set<string>();
  const own = events.filter(event => {
    if (event.agentId !== agent.id || event.source !== agent.source || seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });
  const timestamp = (event: OfficeEvent) => event.source === 'demo' ? event.elapsedSeconds : event.at ? Date.parse(event.at) : undefined;
  // A partial clock cannot establish ordering; retain the backend's event order.
  if (own.every(event => Number.isFinite(timestamp(event)))) own.sort((a, b) => Number(timestamp(a)) - Number(timestamp(b)));
  const pairedResults = new Set<string>();
  const pairs = new Map<string, OfficeEvent>();
  for (const event of own) {
    if (event.kind !== 'call' || !event.operationId || !/^[a-f0-9]{24}$/.test(event.operationId) || !event.toolName) continue;
    const calls = own.filter(item => item.kind === 'call' && item.operationId === event.operationId && item.toolName === event.toolName);
    const results = own.filter(item => item.kind === 'result' && item.operationId === event.operationId && item.toolName === event.toolName);
    // Ambiguous duplicate receipts remain separate; never guess which run won.
    if (calls.length === 1 && results.length === 1) {
      pairs.set(event.id, results[0]);
      pairedResults.add(results[0].id);
    }
  }
  return own.filter(event => !pairedResults.has(event.id)).map(event => ({ event, result: pairs.get(event.id) }));
}
