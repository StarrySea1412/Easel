import { useState } from 'react';
import { NativeSelect as Select } from './ui/Select';
import { memoryTaskTypes, type MemoryConditions } from '../lib/profileMemory';

const keywords=(text:string)=>[...new Set(text.split(/[,，、\n]/).map(word=>word.trim().toLowerCase()).filter(Boolean))].sort();
export default function MemoryConditionsEditor({value,onChange,disabled=false}:{value:MemoryConditions;onChange:(value:MemoryConditions)=>void;disabled?:boolean}) {
  const [required,setRequired]=useState(value.allKeywords.join('、'));
  const [excluded,setExcluded]=useState(value.excludeKeywords.join('、'));
  return <div className="memory-condition-fields">
    <label>任务类型<Select aria-label="添加适用任务类型" value="" disabled={disabled} onChange={event=>{if(event.target.value)onChange({...value,taskTypes:[...value.taskTypes,event.target.value].sort()});}}><option value="">{value.taskTypes.length?'添加任务类型':'不限类型'}</option>{Object.entries(memoryTaskTypes).filter(([key])=>!value.taskTypes.includes(key)).map(([key,label])=><option key={key} value={key}>{label}</option>)}</Select></label>
    {!!value.taskTypes.length&&<div className="memory-condition-tags">{value.taskTypes.map(type=><button type="button" className="btn btn-sm" key={type} disabled={disabled} aria-label={`移除${memoryTaskTypes[type]||type}`} onClick={()=>onChange({...value,taskTypes:value.taskTypes.filter(item=>item!==type)})}>{memoryTaskTypes[type]||type} ×</button>)}</div>}
    <label>必须包含<input className="field" disabled={disabled} value={required} placeholder="多个词用顿号分隔" onChange={event=>{setRequired(event.target.value);onChange({...value,allKeywords:keywords(event.target.value)});}}/></label>
    <label>排除关键词<input className="field" disabled={disabled} value={excluded} placeholder="多个词用顿号分隔" onChange={event=>{setExcluded(event.target.value);onChange({...value,excludeKeywords:keywords(event.target.value)});}}/></label>
  </div>;
}
