import type { OfficeAgent, OfficeEvent } from '../../lib/agentOffice';
import type { selectOfficeEventSteps } from './officeProcessData';

export type OfficeRecordFilter = 'all' | 'unmatched' | 'returned' | 'failed';
export interface OfficeRecordExportInput {
  agent: OfficeAgent;
  turnId?: string | null;
  stale: boolean;
  query: string;
  filter: OfficeRecordFilter;
  totalRecords: number;
  steps: ReturnType<typeof selectOfficeEventSteps>;
}

/** Copy only fields displayed in the panel. Never serialize the agent/event objects. */
export function createOfficeRecordExport({ agent, turnId, stale, query, filter, totalRecords, steps }: OfficeRecordExportInput) {
  if (!steps.length) throw new Error('当前没有可导出的调用记录。');
  if (agent.source === 'live' && !turnId) throw new Error('轮次无法确认，请刷新后导出。');
  const visibleEvent = (event: OfficeEvent) => {
    if (event.agentId !== agent.id || event.source !== agent.source) throw new Error('记录身份不一致，请刷新后导出。');
    return {
      kind: event.kind, status: event.status, title: event.title, toolName: event.toolName || null,
      at: agent.source === 'live' && event.at && Number.isFinite(Date.parse(event.at)) ? new Date(event.at).toISOString() : null,
      elapsedSeconds: agent.source === 'demo' && Number.isFinite(event.elapsedSeconds) ? Math.max(0, event.elapsedSeconds!) : null,
    };
  };
  return {
    format: 'easel-office-records', version: 1,
    exportedAt: new Date().toISOString(),
    source: agent.source,
    scope: 'visible_filtered_snapshot',
    stale,
    turnId: agent.source === 'live' ? turnId : null,
    agent: {
      id: agent.id, name: agent.name,
      displayName: agent.appearance?.id === 'generic' ? agent.name : agent.appearance?.name || agent.name,
      state: agent.state, task: agent.task,
    },
    filter: { query, status: filter },
    totalRecords, exportedRecords: steps.length,
    limitations: [
      agent.source === 'demo' ? '模拟演示记录，不是真实工具执行。' : '仅为当前快照中已取得并匹配筛选的调用与回执，不是完整执行历史。',
      '不包含思考正文、原始工具参数或未上报的输出。',
      '无匹配回执不表示仍在执行；收到回执不表示成功。',
      ...(stale ? ['观测已中断，记录可能不是最新。'] : []),
    ],
    records: steps.map(({ event, result }) => ({ event: visibleEvent(event), result: result ? visibleEvent(result) : null })),
  };
}

/** A successful click starts a browser download; it cannot confirm disk persistence. */
export function downloadOfficeRecordExport(value: ReturnType<typeof createOfficeRecordExport>) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  try {
    anchor.href = url;
    anchor.download = `easel-office-${value.source}-records-${value.exportedAt.replace(/[:.]/g, '-')}.json`;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Keep alive across navigation/unmount while the browser starts saving.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
