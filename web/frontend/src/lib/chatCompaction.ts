export interface ChatCompaction { phase:'start'|'end'; outcome?:'completed'|'failed'|'skipped'|'aborted' }
export function decodeChatCompaction(value:unknown):ChatCompaction|undefined {
 if(!value || typeof value!=='object' || Array.isArray(value))return;
 const row=value as Record<string,unknown>;
 if(row.phase==='start')return {phase:'start'};
 if(row.phase==='end' && ['completed','failed','skipped','aborted'].includes(String(row.outcome)))return {phase:'end',outcome:row.outcome as ChatCompaction['outcome']};
}
