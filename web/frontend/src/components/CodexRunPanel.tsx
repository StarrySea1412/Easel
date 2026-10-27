import { useEffect, useRef, useState } from 'react';
import { codexRequest, type CodexTurn, type CodexPending } from '../lib/codex';
import '../styles/codex.css';
import ChatExecutionPanel from './ChatExecutionPanel';
import { CODEX_RECOVERED } from '../lib/codexRecovery';

function print(value: unknown) { return typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
function RequestCard({request, sessionId, turnId, refresh}: {request: CodexPending; sessionId:string; turnId:string; refresh:()=>void}) {
  const [answers, setAnswers] = useState<Record<string,string>>({}), [error,setError] = useState(''), [busy,setBusy] = useState(false);
  const submit = async (decision?: string) => {
    setBusy(true); setError('');
    try { await codexRequest('answer', {sessionId,turnId,requestId:request.requestId,decision,
      answers:Object.fromEntries(Object.entries(answers).map(([id,value])=>[id,[value]]))}); refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '提交失败'); }
    finally { setBusy(false); }
  };
  const userInput = request.method === 'item/tool/requestUserInput';
  const mcp = request.method === 'mcpServer/elicitation/request';
  return <div className="codex-request" role="group" aria-label={userInput ? 'Codex 提问' : 'Codex 审批'}>
    <strong>{userInput ? 'Codex 需要你的回答' : 'Codex 等待审批'}</strong>
    {request.params.reason && <p>{request.params.reason}</p>}
    {userInput ? request.params.questions?.map(question=><fieldset key={question.id}><legend>{question.question}</legend>
      {question.options?.map(option=><button type="button" key={option.label} disabled={busy} title={option.description} aria-pressed={answers[question.id]===option.label} onClick={()=>setAnswers(a=>({...a,[question.id]:option.label}))}>{option.label}</button>)}
      <input aria-label={question.header || question.question} type={question.isSecret ? 'password' : 'text'} value={answers[question.id] || ''} onChange={e=>setAnswers(a=>({...a,[question.id]:e.target.value}))} disabled={busy} placeholder="选择选项或输入回答"/>
    </fieldset>) : <pre>{print(request.params)}</pre>}
    <div className="codex-actions">{userInput ? <button type="button" disabled={busy || !request.params.questions?.every(q=>answers[q.id]?.trim())} onClick={()=>void submit()}>提交回答</button> : <>
      {!mcp && <button type="button" disabled={busy} onClick={()=>void submit('accept')}>{request.method === 'item/permissions/requestApproval' ? '本轮授予所示权限' : '允许本次操作'}</button>}
      <button type="button" disabled={busy} onClick={()=>void submit('decline')}>拒绝</button>
    </>}</div>{mcp && <p>此版暂不支持 MCP 授权表单；可拒绝此请求。</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
export default function CodexRunPanel({sessionId,turnId,streaming,onProgressOwnership}: {sessionId:string;turnId:string;streaming:boolean;onProgressOwnership?:(owned:boolean)=>void}) {
  const [turn,setTurn]=useState<CodexTurn|null>(null), [error,setError]=useState(''), [revision,setRevision]=useState(0);
  const [checking,setChecking]=useState(false);
  const notifiedRecovery=useRef('');
  useEffect(()=>{
    const controller=new AbortController(); let reading=false;
    const read=async()=>{if(reading || controller.signal.aborted)return; reading=true;
      try { const value=await codexRequest<CodexTurn>(`turn/${encodeURIComponent(sessionId)}/${encodeURIComponent(turnId)}`,undefined,controller.signal);
        if(!controller.signal.aborted && value.sessionId===sessionId && value.turn_id===turnId){
          setTurn(value);setError('');
          const recoveryKey=`${sessionId}:${turnId}`;
          if(value.recovery?.status==='adopted'&&notifiedRecovery.current!==recoveryKey){
            notifiedRecovery.current=recoveryKey;
            window.dispatchEvent(new CustomEvent(CODEX_RECOVERED,{detail:{sessionId,turnId}}));
          }
        } }
      catch(cause){if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:'记录读取失败。');}
      finally{reading=false;}
    }; void read(); const timer=streaming?setInterval(()=>void read(),1500):undefined;
    return()=>{controller.abort();clearInterval(timer);};
  },[sessionId,turnId,streaming,revision]);
  const current=turn?.sessionId===sessionId&&turn.turn_id===turnId?turn:null;
  const reconcile=async()=>{
    setChecking(true);setError('');
    try {
      const value=await codexRequest<CodexTurn>('reconcile',{sessionId,turnId});
      if(value.sessionId!==sessionId||value.turn_id!==turnId)throw new Error('结果不属于本轮。');
      setTurn(value);setRevision(v=>v+1);
    }catch(cause){setError(cause instanceof Error?cause.message:'核对失败。');}
    finally{setChecking(false);}
  };
  const reasoning=current?.thinkingStatus==='available'?'服务已返回思考摘要':current?.thinkingStatus==='partial'?'思考摘要不完整（本轮中断或失败）':current?.thinkingStatus==='unavailable'?'本轮服务未返回思考摘要':'等待服务返回思考摘要';
  return <div className="codex-run-panel">
    <p className="codex-reasoning-state" role="status">Codex · {current?.outcome==='unconfirmed'?'结果未确认':reasoning}{current?.outcome==='interrupted'?' · 已停止':''}
      {current?.outcome==='unconfirmed'&&<button type="button" className="btn btn-sm" disabled={checking} onClick={()=>void reconcile()}>{checking?'核对中…':'核对结果'}</button>}
      {current?.recovery?.status==='adopted'&&' · 已收回原轮次结果'}
    </p>
    {current?.outcome==='unconfirmed'&&current.recovery?.message&&<p role="status">{current.recovery.message}</p>}
    {current?.pending.map(request=><RequestCard key={request.requestId} request={request} sessionId={sessionId} turnId={turnId} refresh={()=>setRevision(v=>v+1)}/>)}
    <ChatExecutionPanel key={revision} sessionId={sessionId} turnId={turnId} streaming={streaming} onProgressOwnership={onProgressOwnership}/>
    <details className="execution-runtime"><summary>本轮引擎与用量</summary><p>请求模型：{current?.requestedModelRef || '等待回执'} · 运行模型：{current?.actualModel || '未返回'}。网页检索：{current?.webSearch==='cached'?'缓存检索':'未上报'}。</p>{Boolean(current?.tokenUsage)&&<pre>{print(current?.tokenUsage)}</pre>}</details>
    {error && <p role="alert">{error}<button type="button" onClick={()=>setRevision(v=>v+1)}>重新读取</button></p>}
  </div>;
}
