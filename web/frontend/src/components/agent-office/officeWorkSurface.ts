import { OFFICE_STATE_LABELS, type OfficeAgent, type OfficeActionKind } from '../../lib/agentOffice';

export interface OfficeWorkSurface {
  kind: OfficeActionKind;
  title: string;
  task: string;
  detail: string;
  tool: string | null;
  source: string;
  state: string;
  sample: boolean;
}

const TITLES: Record<OfficeActionKind, string> = {
  reading: '资料阅读', writing: '文稿编辑', designing: '视觉画板', executing: '工具执行',
  delegating: '协作分工', thinking: '整理思路', waiting: '等待任务', completed: '本轮完成',
  error: '需要处理', stopped: '执行已停止', unreported: '等待操作记录',
};
const SAMPLE: Partial<Record<OfficeActionKind, string>> = {
  reading: '研究摘要：春日场景、受众偏好与参考资料',
  writing: '提案草稿：让春日灵感走进日常生活',
  designing: '版式草图：主视觉、标题区与春日配色',
  executing: '检查项目：引用来源、文案与交付文件',
  delegating: '分工示例：研究 → 设计 / 文案 → 审阅',
};

/** Every live word comes from this employee's observed state/task/action. */
export function officeWorkSurface(agent: OfficeAgent): OfficeWorkSurface {
  const terminal: Partial<Record<OfficeAgent['state'], OfficeActionKind>> = { done: 'completed', error: 'error', stopped: 'stopped', waiting: 'waiting', thinking: 'thinking' };
  const kind: OfficeActionKind = terminal[agent.state]
    || (agent.action?.evidence !== 'unreported' ? agent.action?.kind : undefined) || 'unreported';
  const sample = agent.source === 'demo';
  const tool = agent.state === 'working' && agent.action?.evidence === 'observed' ? agent.action.toolName || null : null;
  return {
    kind, title: TITLES[kind], task: agent.task || '尚未上报任务说明',
    detail: sample && SAMPLE[kind] ? SAMPLE[kind]! : kind === 'unreported'
      ? '具体操作未上报，等待该员工的工作记录。'
      : agent.action?.label || OFFICE_STATE_LABELS[agent.state],
    tool, sample, source: sample ? '模拟屏幕 · 演示内容' : '观测记录 · 非远程桌面', state: OFFICE_STATE_LABELS[agent.state],
  };
}
