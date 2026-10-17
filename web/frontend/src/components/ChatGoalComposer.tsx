import type {ChatGoalComposerState} from '../hooks/useChatGoalComposer';
import type {TaskGoal} from '../lib/tasks';
import '../styles/chat-goal.css';

/** Optional goal settings inside the shared composer; never a second input form. */
export default function ChatGoalComposer({state,goal,blocked,onExit}:{state:ChatGoalComposerState;goal?:TaskGoal;blocked:boolean;onExit:()=>void}){
  return <div className="composer-goal-options" onKeyDown={event=>{if(event.key==='Escape'&&!event.nativeEvent.isComposing){event.preventDefault();event.stopPropagation();onExit();}}}>
    <details className="chat-goal-settings">
      <summary>执行选项 <span>{state.iterations}轮 · {Math.round(state.seconds/60)}分钟</span></summary>
      <label className="chat-goal-metric"><span>可衡量结果 <small>可选</small></span><input value={state.metric} maxLength={1000} disabled={state.fieldsLocked} onChange={event=>state.setMetric(event.target.value)} placeholder="例如：交付 8 张卡片，并检查中文排版" /></label>
      <div className="chat-goal-budget">{[
        {label:'轮次',value:state.iterations,set:state.setIterations,min:1,max:20},
        {label:'秒数',value:state.seconds,set:state.setSeconds,min:60,max:7200},
        {label:'工具',value:state.tools,set:state.setTools,min:1,max:200},
        {label:'生图',value:state.images,set:state.setImages,min:0,max:16},
      ].map(item=><label key={item.label}>{item.label}<input type="number" required min={item.min} max={item.max} value={item.value} disabled={Boolean(goal)||state.fieldsLocked} onChange={event=>item.set(Number(event.target.value))}/></label>)}</div>
      <p>最多{state.iterations}轮、{state.seconds}秒、{state.tools}次工具、{state.images}张图。修改目标保留累计限额；Token与金额暂不硬封顶。</p>
      <p className="chat-goal-current-model">执行模型：{state.executionModel||'尚未选择'}{state.modelLocked?'（已锁定）':''}</p>
      <button type="button" className="link-btn" disabled={!state.canSubmit||Boolean(state.savedId)} onClick={()=>void state.save(false)}>仅保存，稍后开始</button>
      <small className="chat-goal-keyboard-hint">Enter 开始 · Shift+Enter 换行 · Escape 返回对话</small>
    </details>
    {state.unsupported&&<p role="status" className="task-reason">Codex 目标执行尚未接入。退出后可继续普通对话，不会自动切换引擎。</p>}
    {(blocked||state.locked)&&<p role="status" className="task-reason">请先暂停并等待当前执行结束，再设置或修改目标。草稿已保留。</p>}
    {state.error&&<p role="alert" className="task-error">{state.error}{!goal&&!state.savedId&&<button type="button" className="link-btn" onClick={state.refreshModel} disabled={state.loading||state.busy}>刷新模型</button>}</p>}
  </div>;
}
