import {useEffect,useRef,useState} from 'react';
import {fetchOfficeTaskModels} from '../lib/officeControls';
import {taskRequest,type TaskGoal,type GoalSpec} from '../lib/tasks';

function invalidateGeneration(ref:{current:number}){ref.current++;}

/** Codex-style goal mode: the composer text is the objective, completion defaults
 *  to delivered evidence + explicit user confirmation, and limits keep product
 *  defaults instead of asking the user to configure them. */
export const DEFAULT_GOAL_LIMITS={maxIterations:5,maxSeconds:1200,maxTools:40,maxImages:0} as const;

export type GoalEditor = {seed?:string;modelRef?:string;onConfigured?:()=>void;goal?:TaskGoal;welcome?:boolean};

/** Goal state is separate from the ordinary draft; both use the same composer. */
export function useChatGoalComposer({editor,sessionId,engine,modelRef,blocked,onChanged,onClose}:{
  editor?:GoalEditor|null;sessionId:string;engine:string;modelRef:string;blocked:boolean;
  onChanged?:()=>void;onClose?:()=>void;
}) {
  const goal=editor?.goal;
  const [objective,setObjective]=useState('');
  const [workflow,setWorkflow]=useState<''|'research-delivery'>('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[savedId,setSavedId]=useState('');
  const [loading,setLoading]=useState(false),[verifiedModel,setVerifiedModel]=useState(''),[revision,setRevision]=useState(0),[savedModel,setSavedModel]=useState('');
  const submitting=useRef(false),saved=useRef(''),generation=useRef(0);
  const enabled=Boolean(editor),unsupported=engine==='codex';
  const seed=editor?.seed||goal?.objective||'';
  const executionModel=savedModel||goal?.modelRef||modelRef||editor?.modelRef||'';
  useEffect(()=>{
    generation.current++;saved.current='';submitting.current=false;
    setObjective(seed);
    setWorkflow(goal?.workflow||'');
    setSavedId('');setSavedModel('');setVerifiedModel('');setError('');setBusy(false);
    return()=>invalidateGeneration(generation);
  },[enabled,sessionId,seed,goal]);
  useEffect(()=>{
    if(!enabled||unsupported||savedId)return;
    if(goal){setVerifiedModel(executionModel);setLoading(false);return;}
    const controller=new AbortController();setLoading(true);setVerifiedModel('');
    void fetchOfficeTaskModels(sessionId,controller.signal).then(value=>{
      if(controller.signal.aborted)return;
      const ready=Boolean(value.available&&executionModel&&value.options.some(option=>option.configured&&option.id===executionModel));
      setVerifiedModel(ready?executionModel:'');setError(ready?'':'当前所选模型不可用，请在底部模型入口重新选择；不会自动更换模型。');
    }).catch(()=>{if(!controller.signal.aborted)setError('模型暂不可核验，请刷新模型后重试。');})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[enabled,sessionId,executionModel,unsupported,goal,revision,savedId]);
  const locked=Boolean(goal&&['active','completed','cancelled'].includes(goal.status));
  const disabled=busy||blocked||locked||unsupported;
  const canSubmit=enabled&&!disabled&&!loading&&Boolean(executionModel)&&verifiedModel===executionModel&&objective.trim().length>=3&&objective.trim().length<=6000;
  async function save(start=true){
    if(submitting.current||!canSubmit)return;
    submitting.current=true;setBusy(true);setError('');let key=saved.current;
    const version=generation.current;
    const current=()=>generation.current===version;
    try{
      if(!key){
        // Editing keeps the recorded criteria untouched; a new goal starts with
        // the single human-review criterion that Codex-style mode relies on.
        const criteriaForSave=goal?.criteria.length?goal.criteria:[{type:'review' as const,label:'目标结果由我验收',value:''}];
        if(goal){await taskRequest(`/goals/${goal.id}`,{objective:objective.trim(),criteria:criteriaForSave},'PUT');key=goal.id;}
        else{const spec:GoalSpec={objective:objective.trim(),modelRef:executionModel,criteria:criteriaForSave,...DEFAULT_GOAL_LIMITS,
          ...(workflow?{workflow,maxIterations:8}: {})};key=(await taskRequest<TaskGoal>('/goals',{sessionId,goal:spec})).id;}
        if(!current())return;
        saved.current=key;setSavedId(key);setSavedModel(executionModel);onChanged?.();editor?.onConfigured?.();
      }
      if(start)await taskRequest(`/goals/${key}/action`,{action:goal?'resume':'start'});
      if(current()){onChanged?.();onClose?.();}
    }catch(e){if(current())setError((key?'目标已保存，尚未确认启动。':'')+(e instanceof Error?e.message:'保存失败，请重试。'));}
    finally{if(current()){submitting.current=false;setBusy(false);}}
  }
  return{objective,setObjective,workflow,setWorkflow,busy,error,savedId,loading,unsupported,locked,canSubmit,executionModel,
    modelLocked:Boolean(goal||savedId||busy),fieldsLocked:busy||locked||Boolean(savedId)||unsupported,
    label:busy?'正在设置目标':savedId?'重试启动目标':goal?'保存并继续目标':'开始目标',
    refreshModel:()=>setRevision(value=>value+1),save};
}
export type ChatGoalComposerState=ReturnType<typeof useChatGoalComposer>;
