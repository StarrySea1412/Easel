import type {ChatGoalComposerState} from '../hooks/useChatGoalComposer';
import type {TaskGoal} from '../lib/tasks';
import '../styles/chat-goal.css';

/** Inline goal mode: the composer text itself is the goal (Codex-style, no settings form). */
export default function ChatGoalComposer({state,goal,blocked,onExit}:{state:ChatGoalComposerState;goal?:TaskGoal;blocked:boolean;onExit:()=>void}){
  return <div className="composer-goal-options" onKeyDown={event=>{if(event.key==='Escape'&&!event.nativeEvent.isComposing){event.preventDefault();event.stopPropagation();onExit();}}}>
    <p className="chat-goal-current-model">执行模型：{state.executionModel||'尚未选择'}{state.modelLocked?'（已锁定）':''}。输入的内容就是目标，完成以交付证据和你的确认为准。</p>
    <small className="chat-goal-keyboard-hint">Enter 开始 · Shift+Enter 换行 · Escape 返回对话 · 执行上限沿用默认（5轮 · 20分钟 · 40次工具）</small>
    <button type="button" className="link-btn" disabled={!state.canSubmit||Boolean(state.savedId)} onClick={()=>void state.save(false)}>仅保存，稍后开始</button>
    {state.unsupported&&<p role="status" className="task-reason">Codex 目标执行尚未接入。退出后可继续普通对话，不会自动切换引擎。</p>}
    {(blocked||state.locked)&&<p role="status" className="task-reason">请先暂停并等待当前执行结束，再设置或修改目标。草稿已保留。</p>}
    {state.error&&<p role="alert" className="task-error">{state.error}{!goal&&!state.savedId&&<button type="button" className="link-btn" onClick={state.refreshModel} disabled={state.loading||state.busy}>刷新模型</button>}</p>}
  </div>;
}
