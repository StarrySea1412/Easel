import { useEffect, useRef, useState } from 'react';
import { memoryRequest, useProfileMemory, memoryRecallSummary, type MemoryEntry, type MemoryRecall } from '../lib/profileMemory';
import PublishSpinner from './PublishSpinner';

type Use = {turnId:string;profileId:string;profileRevision:number;at:string;entries:{id:string;revision:number}[];recall?:MemoryRecall};
export default function MemoryUsage({name,sessionId,refreshKey}:{name:string;sessionId:string;refreshKey?:string}) {
  const {data}=useProfileMemory(name);
  const [turns,setTurns]=useState<Use[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  const [selected,setSelected]=useState<{key:string;text:string}|null>(null);
  const epoch=useRef(0);
  const currentRevision=useRef(data?.revision);currentRevision.current=data?.revision;
  useEffect(()=>{setSelected(null);},[data?.revision]);
  useEffect(()=>{
    let alive=true;setLoading(true);
    void memoryRequest<{turns:Use[]}>(name,`/usage?sessionId=${encodeURIComponent(sessionId)}`).then(value=>{if(alive){setTurns(value.turns);setError('');}}).catch(reason=>{if(alive)setError(reason.message);}).finally(()=>{if(alive)setLoading(false);});
    return()=>{alive=false;};
  },[name,sessionId,refreshKey,data?.revision]);
  const inspect=async(row:{id:string;revision:number})=>{
    const key=`${row.id}/${row.revision}`;
    const request=++epoch.current,revision=currentRevision.current;
    try{const result=await memoryRequest<{revisions:MemoryEntry[]}>(name,`/entries/${row.id}/history`);if(request===epoch.current&&revision===currentRevision.current)setSelected({key,text:result.revisions.find(item=>item.revision===row.revision)?.text||'该历史版本已不可用。'});}
    catch{if(request===epoch.current&&revision===currentRevision.current)setSelected({key,text:'经验已删除或不可读；不恢复已删除正文。'});}
  };
  return <details className="source-section memory-usage"><summary>本对话使用的经验 · {name}{loading&&<PublishSpinner/>}</summary>
    <p>最近20轮在当前画像下组装的经验引用。记录条目和版本，不代表模型一定采纳。</p>
    {error&&<p role="alert">{error}</p>}
    {!turns.length&&!loading&&<p>还没有本画像的轮次记录。</p>}
    {turns.map(turn=><div key={turn.turnId}><small>{new Date(turn.at).toLocaleString('zh-CN')} · 画像版本 {turn.profileRevision}{turn.recall&&turn.entries.length?` · ${memoryRecallSummary(turn.recall)}`:''}</small>{turn.entries.length?turn.entries.map(row=><div key={row.id}><button className="btn btn-sm" onClick={()=>void inspect(row)}>{row.id.slice(0,8)} · v{row.revision}</button>{selected?.key===`${row.id}/${row.revision}`&&<p style={{whiteSpace:'pre-wrap'}}>{selected.text}</p>}</div>):<p>{memoryRecallSummary(turn.recall)}</p>}</div>)}
  </details>;
}
