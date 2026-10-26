import type {ChatGoalComposerState} from '../hooks/useChatGoalComposer';
import type {TaskGoal,GoalSpec} from '../lib/tasks';
import Select from './ui/Select';
import {IconTarget} from './icons';
import '../styles/chat-goal.css';

/** Inline goal mode: the composer text itself is the goal (Codex-style, no settings form). */
export default function ChatGoalComposer({state,goal,onExit}:{state:ChatGoalComposerState;goal?:TaskGoal;onExit:()=>void}){
  return <span className="composer-goal-control" onKeyDown={event=>{if(event.key==='Escape'&&!event.nativeEvent.isComposing){event.preventDefault();event.stopPropagation();onExit();}}}>
    <Select className="composer-goal-workflow" aria-label="目标推进方式" value={state.workflow||''}
      triggerIcon={<IconTarget size={16}/>} triggerLabel={state.workflow?'协作':'目标'} menuMinWidth={132}
      title={`目标推进方式：${state.workflow==='parallel-reviewed-delivery'?'并行协作':state.workflow?'分工协作':'直接推进'}`}
      disabled={state.fieldsLocked||Boolean(goal)} onChange={value=>state.setWorkflow(value as ''|NonNullable<GoalSpec['workflow']>)}
      options={[{value:'',label:'直接推进'},{value:state.workflow==='research-delivery'?'research-delivery':'reviewed-delivery',label:'分工协作'},{value:'parallel-reviewed-delivery',label:'并行协作'}]}/>
    <button type="button" className="composer-goal-close" aria-label="退出目标设置" title="退出目标模式（Esc）" disabled={state.busy} onClick={onExit}>×</button>
  </span>;
}

export function ChatGoalNotice({state,goal,blocked}:{state:ChatGoalComposerState;goal?:TaskGoal;blocked:boolean}){
  if(!(state.unsupported||blocked||state.locked||state.error))return null;
  return <p role={state.error?'alert':'status'} className={`composer-goal-notice ${state.error?'task-error':'task-reason'}`}>{state.unsupported?'此引擎暂不支持目标':blocked||state.locked?'请先暂停当前任务':state.error}{state.error&&!goal&&!state.savedId&&<button type="button" className="link-btn" aria-label="重新检查模型" title="重新检查模型" onClick={state.refreshModel} disabled={state.loading||state.busy}>↻</button>}</p>;
}
