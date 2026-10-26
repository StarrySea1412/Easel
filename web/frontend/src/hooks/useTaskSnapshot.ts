import {useEffect, useState, useCallback} from 'react';
import {taskRequest, type TaskSnapshot} from '../lib/tasks';
import type {ChatSession} from '../lib/store';

export interface TaskSync {loading:boolean; refreshing:boolean; readAt:number|null; error:string}
const empty:TaskSnapshot = {goals:[],runs:[],plans:[],serverTime:0};

/** One reader stays mounted in App; page changes never create a second task authority. */
export function useTaskSnapshot() {
  const [snapshot,setSnapshot] = useState(empty);
  const [sessions,setSessions] = useState<ChatSession[]|null>(null);
  const [revision,setRevision] = useState(0);
  const [sync,setSync] = useState<TaskSync>({loading:true,refreshing:true,readAt:null,error:''});
  const refresh = useCallback(() => setRevision(value => value+1),[]);
  useEffect(() => {
    const controller = new AbortController();
    let timer:ReturnType<typeof setTimeout>;
    async function read() {
      setSync(old => ({...old,refreshing:true}));
      const attempt = new AbortController();
      const deadline = setTimeout(()=>attempt.abort(),15000);
      const abort = () => {attempt.abort();clearTimeout(deadline);};
      controller.signal.addEventListener('abort',abort,{once:true});
      const [tasks,remote] = await Promise.allSettled([
        taskRequest<TaskSnapshot>('',undefined,'GET',attempt.signal),
        taskRequest<{sessions:ChatSession[]}>('/sessions',undefined,'GET',attempt.signal),
      ]);
      clearTimeout(deadline);controller.signal.removeEventListener('abort',abort);
      if (controller.signal.aborted) return;
      if (tasks.status === 'fulfilled') setSnapshot(tasks.value);
      if (remote.status === 'fulfilled') setSessions(remote.value.sessions);
      const errors = [tasks.status==='rejected'?'任务状态读取失败':'',remote.status==='rejected'?'对话同步失败':''].filter(Boolean);
      setSync(old => ({loading:false,refreshing:false,readAt:tasks.status==='fulfilled'?Date.now():old.readAt,error:errors.join('；')}));
      timer = setTimeout(() => void read(),3000);
    }
    void read();
    return () => {controller.abort();clearTimeout(timer);};
  },[revision]);
  return {snapshot,sessions,sync,refresh};
}
