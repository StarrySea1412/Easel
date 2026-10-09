import type { OfficeAgent } from '../../lib/agentOffice';
import { officeWorkSurface } from './officeWorkSurface';
import './office-work-preview.css';

export default function OfficeWorkPreview({ agent, stale, observedAt, onOpen }: { agent: OfficeAgent; stale: boolean; observedAt?: string | null; onOpen: () => void }) {
  const work = officeWorkSurface(agent, { stale, observedAt });
  const name = agent.appearance?.id !== 'generic' ? agent.appearance?.name || agent.name : agent.name;
  if (work.kind === 'unreported' && !agent.task) return <section className="office-work-preview office-work-preview--compact" aria-label={`${name}的工位屏幕`}><strong>{stale ? '上次快照 · ' : ''}暂无任务与操作记录</strong><p>收到该成员的后台记录后更新。</p></section>;
  return <section className={`office-work-preview office-work-preview--${work.kind}`} aria-label={`${name}的工位屏幕`}>
    <div className="office-work-preview__screen">
      <header><span><i aria-hidden="true" />{work.title}</span><small>{work.source}</small></header>
      <div className="office-work-preview__body">
        <div className={`office-work-preview__visual is-${work.kind}`} aria-hidden="true">
          {work.kind === 'designing' ? <><div className="work-artboard"><i /><b>{work.sample ? '春日' : '画板'}</b></div><div className="work-swatches"><i /><i /><i /></div></>
            : work.kind === 'delegating' ? <div className="work-flow"><span>任务</span><i>↓</i><span>协作</span></div>
            : ['completed', 'error', 'stopped', 'waiting', 'unreported', 'thinking'].includes(work.kind)
              ? <strong className="work-state-symbol">{{completed:'✓', error:'!', stopped:'Ⅱ', waiting:'…', unreported:'?', thinking:'…'}[work.kind as 'completed']}</strong>
              : <div className="work-document"><i /><i /><i /><i /></div>}
          <small>{work.kind === 'designing' ? '画板示意' : work.title}</small>
        </div>
        <div className="office-work-preview__copy"><p className="office-work-preview__eyebrow">{name} · {work.state}</p><h3>{work.task}</h3><p>{work.stale ? '上次记录：' : ''}{work.detail}</p>{work.toolLabel && <code>{work.toolLabel}</code>}</div>
      </div>
    </div>
    <div className="office-work-preview__footer"><span>{work.sample ? '演示文稿和画板均为模拟示例。' : '屏幕根据该员工的任务与操作记录生成；未读取远程桌面或未上报正文。'}</span><button type="button" onClick={onOpen}>展开工作过程 ↗</button></div>
  </section>;
}
