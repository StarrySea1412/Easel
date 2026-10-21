import { useCallback, useEffect, useRef, useState } from 'react';
import { assignLibraryFile, deleteLibraryFolder, fetchOutputLibrary, saveLibraryFolder, type OutputLibraryState } from '../lib/api';

export default function useOutputLibrary() {
  const [state,setState]=useState<OutputLibraryState>({folders:[],files:{}});
  const [loading,setLoading]=useState(true), [error,setError]=useState('');
  const sequence=useRef(0);
  const invalidate=useCallback(()=>{sequence.current++;},[]);
  const reload=useCallback(async()=>{
    const seq=++sequence.current;
    setLoading(true); setError('');
    try {
      const result=await fetchOutputLibrary();
      if (!Array.isArray(result.folders) || !result.files || typeof result.files!=='object') throw new Error('文件夹列表暂不可用');
      if (seq===sequence.current) setState(result);
    } catch (e) { if (seq===sequence.current) setError(e instanceof Error ? e.message : '文件夹列表读取失败'); }
    finally { if (seq===sequence.current) setLoading(false); }
  },[]);
  useEffect(()=>{
    void reload();
    const listener=()=>void reload();
    window.addEventListener('easel:library-updated',listener);
    return ()=>{invalidate();window.removeEventListener('easel:library-updated',listener);};
  },[reload,invalidate]);
  const changed=()=>window.dispatchEvent(new window.Event('easel:library-updated'));
  return {state,loading,error,reload,
    save:async(name:string,parent:string,id?:string)=>{const result=await saveLibraryFolder(name,parent,id);changed();return result;},
    remove:async(id:string)=>{await deleteLibraryFolder(id);changed();},
    assign:async(path:string,folder:string)=>{await assignLibraryFile(path,folder);changed();},
  };
}
