import {useEffect,useRef,useState} from 'react';
import {fetchOfficeTaskModels} from '../lib/officeControls';
import {taskRequest,type TaskGoal,type GoalSpec} from '../lib/tasks';

function invalidateGeneration(ref:{current:number}){ref.current++;}

export type GoalEditor = {seed?:string;modelRef?:string;onConfigured?:()=>void;goal?:TaskGoal;welcome?:boolean};

/** Goal state is separate from the ordinary draft; both use the same composer. */
export function useChatGoalComposer({editor,sessionId,engine,modelRef,blocked,onChanged,onClose}:{
  editor?:GoalEditor|null;sessionId:string;engine:string;modelRef:string;blocked:boolean;
  onChanged?:()=>void;onClose?:()=>void;
}) {
  const goal=editor?.goal;
  const [objective,setObjective]=useState(''),[metric,setMetric]=useState('');
  const [iterations,setIterations]=useState(5),[seconds,setSeconds]=useState(1200),[tools,setTools]=useState(40),[images,setImages]=useState(0);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[savedId,setSavedId]=useState('');
  const [loading,setLoading]=useState(false),[verifiedModel,setVerifiedModel]=useState(''),[revision,setRevision]=useState(0),[savedModel,setSavedModel]=useState('');
  const submitting=useRef(false),saved=useRef(''),generation=useRef(0);
  const enabled=Boolean(editor),unsupported=engine==='codex';
  const seed=editor?.seed||goal?.objective||'';
  const executionModel=savedModel||goal?.modelRef||modelRef||editor?.modelRef||'';
  useEffect(()=>{
    generation.current++;saved.current='';submitting.current=false;
    setObjective(seed);setMetric(goal?.criteria?.find(item=>item.type==='review')?.value||'');
    setIterations(goal?.maxIterations||5);setSeconds(goal?.maxSeconds||1200);
    setTools(goal?.maxTools||40);setImages(goal?.maxImages||0);
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
  const validLimits=[[iterations,1,20],[seconds,60,7200],[tools,1,200],[images,0,16]].every(([value,min,max])=>Number.isInteger(value)&&value>=min&&value<=max);
  const canSubmit=enabled&&!disabled&&!loading&&Boolean(executionModel)&&verifiedModel===executionModel&&validLimits&&objective.trim().length>=3&&objective.trim().length<=6000&&metric.length<=1000;
  async function save(start=true){
    if(submitting.current||!canSubmit)return;
    submitting.current=true;setBusy(true);setError('');let key=saved.current;
    const version=generation.current;
    const current=()=>generation.current===version;
    try{
      if(!key){
        const criteria=goal?.criteria||[{type:'review' as const,label:'目标结果由我验收',value:''}];
        const review={type:'review' as const,label:metric.trim()?'可衡量结果':'目标结果由我验收',value:metric.trim()};
        const criteriaForSave=criteria.some(item=>item.type==='review')?criteria.map(item=>item.type==='review'?review:item):[...criteria,review];
        if(goal){await taskRequest(`/goals/${goal.id}`,{objective:objective.trim(),criteria:criteriaForSave},'PUT');key=goal.id;}
        else{const spec:GoalSpec={objective:objective.trim(),modelRef:executionModel,criteria:criteriaForSave,maxIterations:iterations,maxSeconds:seconds,maxTools:tools,maxImages:images};key=(await taskRequest<TaskGoal>('/goals',{sessionId,goal:spec})).id;}
        if(!current())return;
        saved.current=key;setSavedId(key);setSavedModel(executionModel);onChanged?.();editor?.onConfigured?.();
      }
      if(start)await taskRequest(`/goals/${key}/action`,{action:goal?'resume':'start'});
      if(current()){onChanged?.();onClose?.();}
    }catch(e){if(current())setError((key?'目标已保存，尚未确认启动。':'')+(e instanceof Error?e.message:'保存失败，请重试。'));}
    finally{if(current()){submitting.current=false;setBusy(false);}}
  }
  return{objective,setObjective,metric,setMetric,iterations,setIterations,seconds,setSeconds,tools,setTools,images,setImages,
    busy,error,savedId,loading,unsupported,locked,canSubmit,executionModel,modelLocked:Boolean(goal||savedId||busy),
    fieldsLocked:busy||locked||Boolean(savedId)||unsupported,
    label:busy?'正在设置目标':savedId?'重试启动目标':goal?'保存并继续目标':'开始目标',
    refreshModel:()=>setRevision(value=>value+1),save};
}
export type ChatGoalComposerState=ReturnType<typeof useChatGoalComposer>;
