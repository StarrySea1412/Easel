import type { TaskStage } from '../lib/tasks';
import { mediaUrl } from '../lib/api';

const labels: Record<TaskStage['status'], string> = {
  pending: '待开始', running: '执行中', completed: '交接已核验', blocked: '需要处理', unconfirmed: '等待核实',
};

export default function TaskStageBoard({ stages }: { stages: TaskStage[] }) {
  const finished = stages.filter(stage => stage.status === 'completed').length;
  return <section className="task-stage-board" aria-label="分工协作阶段">
    <div className="task-stage-heading"><strong>分工协作</strong><span>{finished}/{stages.length} 阶段已交接</span></div>
    <p className="task-stage-boundary">文件核验后交给下一角色，最终质量由你验收。</p>
    <ol>{stages.map((stage, index) => <li key={stage.id} className={`task-stage ${stage.status}`} aria-current={stage.status === 'running' ? 'step' : undefined}>
      <span className="task-stage-number" aria-hidden="true">{stage.status === 'completed' ? '✓' : index + 1}</span>
      <div className="task-stage-content"><div className="task-stage-title"><h4>{stage.title}</h4><span>{stage.role?.shortName || stage.role?.name || stage.roleId}</span></div>
        <p className="task-stage-status">{labels[stage.status]}{stage.attempts > 1 ? ` · 第 ${stage.attempts} 次执行` : ''}</p>
        {stage.status !== 'pending' && <details><summary>交付与核验记录</summary><p>{stage.objective}</p>
          <ul>{stage.criteria.map((criterion, i) => {
            const check = stage.checks[i];
            const delivered = stage.status === 'completed' && check?.state === 'passed';
            return <li key={i}><span>{delivered ? '✓' : '○'} {criterion.label}</span>
              {criterion.type === 'file' && (delivered ? <a href={mediaUrl(criterion.value)} target="_blank" rel="noreferrer">打开交接文件 ↗</a> : <small>等待本阶段文件核验</small>)}
              {check?.detail && <small>{check.detail}</small>}</li>;
          })}</ul>
          {stage.handoff && <p className="task-stage-receipt">{stage.handoff}</p>}
        </details>}
      </div>
    </li>)}</ol>
  </section>;
}
