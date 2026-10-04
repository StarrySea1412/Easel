import type { EmployeeAppearance } from './employeeAppearance';
import { decodeObservedModel, type OfficeObservedModel } from './modelProviders';
export type OfficeAgentState = 'working' | 'thinking' | 'waiting' | 'done' | 'error' | 'stopped' | 'unknown';
export type OfficeActionKind = 'reading' | 'writing' | 'designing' | 'executing' | 'delegating' | 'thinking' | 'waiting' | 'completed' | 'error' | 'stopped' | 'unreported';
export interface OfficeAction { kind: OfficeActionKind; label: string; evidence: 'demo' | 'observed' | 'unreported'; toolName?: string }
export interface OfficeAgent {
  id: string;
  name: string;
  role: string;
  task: string;
  state: OfficeAgentState;
  parentId?: string;
  source: 'live' | 'demo';
  updatedAt?: string;
  evidence?: string;
  action?: OfficeAction;
  appearance?: EmployeeAppearance;
  observedModel?: OfficeObservedModel;
}

export interface OfficeSnapshot {
  turnId: string | null;
  agents: OfficeAgent[];
  events: OfficeEvent[];
  observedAt: string | null;
  coverage: string;
  /** Confirmed identities in this snapshot, not a claim about all backend agents. */
  observedAgentCount?: number;
  identityScanLimited?: boolean;
}

export interface OfficeEvent {
  id: string;
  agentId: string;
  kind: 'call' | 'result' | 'spawn' | 'status';
  title: string;
  status: 'called' | 'returned' | 'failed' | 'observed';
  at?: string;
  elapsedSeconds?: number;
  source: 'live' | 'demo';
  toolName?: string;
  operationId?: string;
}

export const DEMO_DURATION_SECONDS = 48;
export const OFFICE_STATE_LABELS: Record<OfficeAgentState, string> = {
  working: '工作中', thinking: '思考中', waiting: '等待中', done: '已完成', error: '遇到问题', stopped: '已停止', unknown: '状态未知',
};

const STATUS_MAP: Record<string, OfficeAgentState> = {
  running: 'working', thinking: 'thinking', completed: 'done', failed: 'error', stopped: 'stopped', waiting: 'waiting', unknown: 'unknown',
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function shortText(value: unknown, fallback = '', limit = 500): string {
  return typeof value === 'string' ? value.slice(0, limit) : fallback;
}

/** Only structured server observations create live agents; prose never does. */
export function decodeOfficeSnapshot(value: unknown, sessionId: string): OfficeSnapshot {
  if (!record(value) || value.sessionId !== sessionId || !Array.isArray(value.agents)) {
    throw new Error('Agent 观测数据不完整或不属于当前会话。');
  }
  const ids = new Set<string>();
  const agents = value.agents.map((item): OfficeAgent => {
    if (!record(item) || typeof item.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(item.id) || ids.has(item.id)
      || (item.role !== 'root' && item.role !== 'subagent')) throw new Error('Agent 身份数据无效。');
    ids.add(item.id);
    return {
      id: item.id,
      name: shortText(item.name, item.role === 'root' ? '主 Agent' : '子 Agent', 80),
      role: item.role === 'root' ? '任务协调' : '协作 Agent',
      task: shortText(item.task, '尚未观察到任务说明'),
      state: Object.hasOwn(STATUS_MAP, String(item.status)) ? STATUS_MAP[String(item.status)] : 'unknown',
      source: 'live',
      observedModel: decodeObservedModel(item.observedModel),
      ...(typeof item.parentId === 'string' ? { parentId: item.parentId } : {}),
      ...(typeof item.updatedAt === 'string' && Number.isFinite(Date.parse(item.updatedAt)) ? { updatedAt: item.updatedAt } : {}),
      ...(typeof item.evidence === 'string' ? { evidence: shortText(item.evidence) } : {}),
    };
  });
  for (const agent of agents) if (agent.parentId === agent.id || !ids.has(agent.parentId || '')) delete agent.parentId;
  const coverage = record(value.coverage) ? shortText(value.coverage.detail) : '';
  const warnings = Array.isArray(value.warnings) ? value.warnings.filter((warning): warning is string => typeof warning === 'string').slice(0, 4) : [];
  const eventIds = new Set<string>();
  const events: OfficeEvent[] = [];
  if (value.events !== undefined && (!Array.isArray(value.events) || value.events.length > 80)) throw new Error('调用记录格式无效。');
  for (const item of Array.isArray(value.events) ? value.events : []) {
    if (!record(item) || typeof item.id !== 'string' || !item.id || eventIds.has(item.id)
      || typeof item.agentId !== 'string' || !ids.has(item.agentId)
      || !['call', 'result', 'spawn', 'status'].includes(String(item.kind))) continue;
    eventIds.add(item.id);
    events.push({
      id: item.id, agentId: item.agentId, kind: item.kind as OfficeEvent['kind'], title: shortText(item.title, '已观察到调用记录'),
      status: ['called', 'returned', 'failed', 'observed'].includes(String(item.status)) ? item.status as OfficeEvent['status'] : 'observed',
      source: 'live', ...(typeof item.at === 'string' && Number.isFinite(Date.parse(item.at)) ? { at: item.at } : {}),
      ...(typeof item.toolName === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(item.toolName) ? { toolName: item.toolName } : {}),
      ...(typeof item.operationId === 'string' && /^[a-f0-9]{24}$/.test(item.operationId) ? { operationId: item.operationId } : {}),
    });
  }
  return {
    agents, events,
    observedAgentCount: agents.length,
    identityScanLimited: record(value.coverage) && value.coverage.identityScanLimited === true,
    turnId: typeof value.turnId === 'string' && /^[A-Za-z0-9_.-]{1,120}$/.test(value.turnId) ? value.turnId : null,
    observedAt: typeof value.observedAt === 'string' && Number.isFinite(Date.parse(value.observedAt)) ? value.observedAt : null,
    coverage: [coverage || '仅展示已观察到的 Agent 身份；没有记录不代表未发生调用。', ...warnings].join(' '),
  };
}

export async function fetchAgentOffice(sessionId: string, signal: AbortSignal): Promise<OfficeSnapshot> {
  const base = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
  const response = await fetch(`${base}/api/agent-office?${new URLSearchParams({ sessionId })}`, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`Agent 观测暂不可用（HTTP ${response.status}），请稍后重试。`);
  return decodeOfficeSnapshot(await response.json(), sessionId);
}

/** Deterministic, explicitly synthetic choreography; never written to live data. */
export function createDemoOfficeAgents(elapsedSeconds: number): OfficeAgent[] {
  const t = Math.min(DEMO_DURATION_SECONDS, Math.max(0, Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0));
  const final = t >= DEMO_DURATION_SECONDS;
  const make = (id: string, name: string, role: string, state: OfficeAgentState, task: string): OfficeAgent => ({
    id, name, role, state: final ? 'done' : state, task: final ? '演示任务完成 · 等待下一次协作' : task,
    source: 'demo', ...(id === 'coordinator' ? {} : { parentId: 'coordinator' }),
  });
  return [
    make('coordinator', 'Easel', '任务协调', t < 8 ? 'working' : t < 40 ? 'thinking' : 'working',
      t < 8 ? '拆解「制作春日品牌提案」，分配协作任务' : t < 40 ? '跟踪研究、设计与文案进展，协调交接' : '汇总各 Agent 的成果，整理最终提案'),
    make('researcher', 'Scout', '资料研究', t < 4 ? 'thinking' : t < 17 ? 'working' : 'done',
      t < 4 ? '确定研究方向与资料清单' : t < 17 ? '研究用户偏好，整理可引用的素材' : '研究摘要已交给设计与文案 Agent'),
    make('designer', 'Pixel', '视觉设计', t < 8 ? 'waiting' : t < 14 ? 'thinking' : t < 31 ? 'working' : 'done',
      t < 8 ? '等待研究摘要' : t < 14 ? '构思色彩、版式和视觉方向' : t < 31 ? '制作品牌提案的视觉与页面布局' : '视觉方案已交付核对'),
    make('writer', 'Quill', '文案创作', t < 12 ? 'waiting' : t < 18 ? 'thinking' : t < 33 ? 'working' : 'done',
      t < 12 ? '等待研究方向与受众结论' : t < 18 ? '提炼故事结构与传播重点' : t < 33 ? '撰写提案正文，打磨标题和行动建议' : '文案初稿已完成并送审'),
    make('tester', 'Check', '质量检查', t < 26 ? 'waiting' : t < 32 ? 'working' : t < 36 ? 'error' : t < 43 ? 'working' : 'done',
      t < 26 ? '等待第一版提案' : t < 32 ? '核对引用、格式与交付清单' : t < 36 ? '发现一处引用不一致，请求协作修正（演示）' : t < 43 ? '重新核对已修正的内容' : '交付检查完成'),
    make('reviewer', 'Sage', '审阅整合', t < 28 ? 'waiting' : t < 34 ? 'thinking' : t < 45 ? 'working' : 'done',
      t < 28 ? '等待设计与文案结果' : t < 34 ? '审阅方案是否回应最初目标' : t < 45 ? '整理评审意见，完成最终一致性检查' : '评审完成，交给协调 Agent 汇总'),
  ];
}

const DEMO_EVENTS: Array<[number, string, OfficeEvent['kind'], string, OfficeEvent['status']]> = [
  [0, 'coordinator', 'call', '接收演示需求：制作春日品牌提案', 'called'],
  [3, 'coordinator', 'spawn', '分配研究、设计、文案与审阅任务', 'observed'],
  [4, 'researcher', 'call', '检索资料与受众偏好（模拟）', 'called'],
  [8, 'designer', 'status', '收到研究方向，开始构思视觉方案', 'observed'],
  [12, 'writer', 'call', '整理提案结构与标题方向（模拟）', 'called'],
  [17, 'researcher', 'result', '资料摘要已返回给协调 Agent', 'returned'],
  [18, 'writer', 'call', '编写提案正文与行动建议（模拟）', 'called'],
  [20, 'designer', 'call', '制作版式与视觉素材（模拟）', 'called'],
  [26, 'tester', 'call', '检查引用与格式（模拟）', 'called'],
  [28, 'reviewer', 'status', '开始审阅第一版提案', 'observed'],
  [31, 'designer', 'result', '视觉方案已返回', 'returned'],
  [32, 'tester', 'result', '检测到一处引用不一致（模拟问题）', 'failed'],
  [33, 'writer', 'result', '文案初稿已返回', 'returned'],
  [36, 'tester', 'call', '重新检查已修正的引用（模拟）', 'called'],
  [40, 'coordinator', 'call', '汇总协作产物（模拟）', 'called'],
  [43, 'tester', 'result', '修正后检查结果已返回', 'returned'],
  [45, 'reviewer', 'result', '审阅意见与交付清单已返回', 'returned'],
  [48, 'coordinator', 'status', '本轮协作演示完成', 'observed'],
];

export function createDemoOfficeEvents(elapsedSeconds: number): OfficeEvent[] {
  const elapsed = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0;
  return DEMO_EVENTS.filter(([at]) => at <= elapsed).map(([at, agentId, kind, title, status], index) => ({
    id: `demo-event-${index}`, agentId, kind, title, status, elapsedSeconds: at, source: 'demo',
  }));
}
