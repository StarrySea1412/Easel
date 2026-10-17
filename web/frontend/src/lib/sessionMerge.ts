import type {ChatSession} from './store';

/**
 * Only the explicit entries — the sidebar 新建对话 button and the dashboard
 * 开始创作 composer — add a conversation row. Every other start (看热点一键做成
 * 内容, 技能开聊, 爆款拆解) merges into the conversation that is currently
 * selected; a new row is created only when there is nothing safe to merge into
 * (no selection, a backup import, or a session that is still running).
 */
export function pickMergeTarget(sessions:ChatSession[],activeSessionId:string|null,isBusy:(id:string)=>boolean):ChatSession|undefined {
  if(!activeSessionId)return undefined;
  const session=sessions.find(item=>item.id===activeSessionId);
  if(!session||session.importedFromBackup||session.pendingTurnId)return undefined;
  return isBusy(session.id)?undefined:session;
}
