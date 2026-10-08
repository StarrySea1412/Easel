import type { OfficeAgent } from '../../lib/agentOffice';
import { modelProvider, officeModelLabel } from '../../lib/modelProviders';

export default function OfficeModelIdentity({ agent, stale = false }: { agent: OfficeAgent; stale?: boolean }) {
  const identity = agent.observedModel;
  if (agent.source === 'demo') return <section className="office-model-identity" aria-label="模型身份"><strong>模拟员工 · 未调用真实模型</strong><p>品牌形象请从「模型厂商 3D 形象审核」预览。</p></section>;
  return <section className="office-model-identity" aria-label="模型身份">
    <strong style={{ borderColor: modelProvider(identity?.provider).color }}>{stale ? '上次快照 · ' : ''}{officeModelLabel(identity)}</strong>
    <dl><div><dt>接入渠道</dt><dd>{identity?.channel || '未上报'}</dd></div><div><dt>记录时间</dt><dd>{identity?.observedAt ? new Date(identity.observedAt).toLocaleString('zh-CN', { hour12: false }) : '未上报'}</dd></div></dl>
    <p>{identity?.evidence || '尚未观察到该 Agent 的模型记录。'}{identity?.provider === 'unknown' && identity?.model ? ' 使用通配身份，不依据别名猜测厂商。' : ''}</p>
    <small>调用记录标识不独立证明中转服务底层模型。模型配置用于后续调用，不改变已观测身份。</small>
  </section>;
}
