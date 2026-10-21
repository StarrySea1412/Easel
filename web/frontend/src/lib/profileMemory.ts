import { useEffect, useSyncExternalStore } from 'react';
import { publishWorkbenchChange, watchWorkbenchChange } from './workbenchEvents';

export type MemoryScope = {kind:'profile'} | {kind:'account';platform:string;accountId:string};
export type MemoryEntry = {id:string;profileId:string;text:string;status:'pending'|'active'|'invalidated'|'rejected';revision:number;contentHash:string;scopeHash:string;scope:MemoryScope;quality:string;reviewAfter:string|null;needsReview?:boolean;sourceStatus?:string;createdAt:string;updatedAt:string;confirmedAt:string|null;userEdited?:boolean;source:{type:string;bindingId?:string;sessionId?:string;turnId?:string;contentIds?:string[];sampleCount?:number;sourceHash:string;capturedAt:string|null;limitation?:string}};
export type MemoryState = {name:string;profileId:string;revision:number;managed:boolean;entries:MemoryEntry[];legacy:{text:string;hash:string}|null;projectionReady:boolean;warning:string|null};
type ReadState = {data?:MemoryState;loading:boolean;error:string};
const empty:ReadState = {loading:false,error:''};
const reads = new Map<string,ReadState>();
const pending = new Map<string,Promise<void>>();
const epochs = new Map<string,number>();
const listeners = new Set<()=>void>();
const emit = () => listeners.forEach(listener=>listener());
export async function memoryRequest<T>(name:string, path='', method='GET', body?:unknown):Promise<T> {
  const response = await fetch(`/api/persona/${encodeURIComponent(name)}/memory${path}`, {method,cache:'no-store',...(body!==undefined?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
  const value = await response.json();
  if (!response.ok) throw new Error(value.detail || `经验操作失败（${response.status}）`);
  return value;
}
function accept(data:MemoryState, reason?:string) {
  const current=reads.get(data.name)?.data;
  if(current?.profileId===data.profileId&&current.revision>data.revision)return;
  if(reason)epochs.set(data.name,(epochs.get(data.name)||0)+1);
  reads.set(data.name,{data,loading:false,error:''}); emit();
  if (reason) publishWorkbenchChange({domain:'profile-memory',name:data.name,profileId:data.profileId,revision:data.revision,reason});
}
export function refreshMemory(name:string):Promise<void> {
  if (!name) return Promise.resolve();
  const old = pending.get(name); if(old) return old;
  const epoch=epochs.get(name)||0;
  reads.set(name,{...(reads.get(name)||empty),loading:true,error:''}); emit();
  const task = memoryRequest<MemoryState>(name).then(data=>{if(epoch===(epochs.get(name)||0))accept(data);}).catch(error=>{
    if(epoch!==(epochs.get(name)||0))return;
    reads.set(name,{...(reads.get(name)||empty),loading:false,error:String(error.message||error)}); emit();
  }).finally(()=>{pending.delete(name);if(epoch!==(epochs.get(name)||0))void refreshMemory(name);});
  pending.set(name,task); return task;
}
export function useProfileMemory(name:string) {
  const value = useSyncExternalStore(listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},()=>reads.get(name)||empty);
  useEffect(()=>{
    void refreshMemory(name);
    const focus=()=>{void refreshMemory(name);}; window.addEventListener('focus',focus);
    const unwatch=watchWorkbenchChange('profile-memory',change=>{
      if ((!change.name||change.name===name) && change.revision!==reads.get(name)?.data?.revision) {epochs.set(name,(epochs.get(name)||0)+1);void refreshMemory(name);}
    });
    return()=>{window.removeEventListener('focus',focus);unwatch();};
  },[name]);
  return value;
}
export async function proposeMemory(name:string, text:string, scope:MemoryScope, source:{type:string;bindingId?:string}={type:'manual'}):Promise<MemoryEntry> {
  const result = await memoryRequest<{entry:MemoryEntry;state:MemoryState}>(name,'/candidates','POST',{text,scope,source});
  accept(result.state,'candidate'); return result.entry;
}
export async function mutateMemory(name:string,path:string,body:unknown) {
  try { const value=await memoryRequest<MemoryState>(name,path,'POST',body);accept(value,path);return value; }
  catch(error){void refreshMemory(name);throw error;}
}
