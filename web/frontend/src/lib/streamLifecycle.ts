/** Finalize only while the captured run still owns this session. */
export function drainStreamRun(isCurrent:()=>boolean, hasBuffered:()=>boolean, finalize:()=>void, schedule:(callback:()=>void)=>unknown=callback=>setTimeout(callback,60)):void {
 const check=()=>{if(!isCurrent())return;if(hasBuffered()){schedule(check);return;}finalize();};
 check();
}
