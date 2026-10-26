import type { TaskStage } from '../lib/tasks';
import { mediaUrl } from '../lib/api';
import '../styles/task-stages.css';

const labels: Record<TaskStage['status'], string> = {
  pending: '待开始', running: '执行中', completed: '交接已核验', blocked: '需要处理', unconfirmed: '等待核实',
};

export default function TaskStageBoard({ stages, compact=false, onRework, disabled=false }: { stages: TaskStage[]; compact?:boolean; onRework?:(id:string)=>void; disabled?:boolean }) {
  const finished = stages.filter(stage => stage.status === 'completed').length;
  const running = stages.filter(stage => stage.status === 'running').length;
  return <section className={`task-stage-board${compact?' is-compact':''}`} aria-label="分工协作阶段">
    <div className="task-stage-heading"><strong>分工协作</strong><span>{running>1?`${running} 个阶段执行中 · `:''}{finished}/{stages.length} 阶段已交接</span></div>
    <ol>{stages.map((stage, index) => <li key={stage.id} className={`task-stage ${stage.status}`} aria-current={stage.status === 'running' ? 'step' : undefined}>
      <span className="task-stage-number" aria-hidden="true">{stage.status === 'completed' ? '✓' : index + 1}</span>
      <div className="task-stage-content"><div className="task-stage-title"><h4>{stage.title}</h4><span>{stage.role?.shortName || stage.role?.name || stage.roleId}</span></div>
        <p className="task-stage-status">{stage.status==='pending'&&stage.dependsOn?.some(id=>!stages.some(s=>s.id===id&&s.status==='completed'))?'等待上游':labels[stage.status]}{stage.review?` · 模型建议${({pass:'通过',revise:'返工',blocked:'暂停'})[stage.review.decision]}`:''}{stage.attempts > 1 ? ` · 第 ${stage.attempts} 次执行` : ''}</p>
        {!compact && stage.status !== 'pending' && <details><summary>交付与核验记录</summary><p>{stage.objective}</p>
          <ul>{stage.criteria.map((criterion, i) => {
            const check = stage.checks[i];
            const delivered = stage.status === 'completed' && check?.state === 'passed';
            return <li key={i}><span>{delivered ? '✓' : '○'} {criterion.label}</span>
              {criterion.type === 'file' && (delivered ? <a href={mediaUrl(criterion.value)} target="_blank" rel="noreferrer">打开交接文件 ↗</a> : <small>等待本阶段文件核验</small>)}
              {check?.detail && <small>{check.detail}</small>}</li>;
          })}</ul>
          {!stage.review && stage.handoff && <p className="task-stage-receipt">{stage.handoff}</p>}
          {stage.review&&<><p>{stage.review.summary}</p><ul>{stage.review.findings.map((finding,i)=><li key={i}>{finding}</li>)}</ul></>}
          {stage.steps?.length? <ul>{stage.steps.map(step=><li key={step.id}>{step.title} · {({pending:'待开始',in_progress:'进行中',completed:'已报告完成',blocked:'需要处理'})[step.status]}</li>)}</ul>:null}
          {onRework && (stage.dependsOn===undefined?stages.slice(0,index):stages.filter(item=>stage.dependsOn!.includes(item.id))).every(item=>item.status==='completed') && <button type="button" className="btn btn-sm" disabled={disabled} onClick={()=>onRework(stage.id)}>从此阶段重做</button>}
        </details>}
      </div>
    </li>)}</ol>
  </section>;
}
