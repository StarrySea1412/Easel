import type { ChatMessage, ChatSession } from './store';
import type { UploadedFile } from './api';

export function editBranchPlan(source: ChatSession, userIndex: number, text: string) {
  if (source.importedFromBackup || source.pendingTurnId || !text.trim()
    || !Number.isInteger(userIndex) || source.messages[userIndex]?.role !== 'user') {
    throw new Error('当前消息不能编辑，请等待本轮结束后重试。');
  }
  const prefix = source.messages.slice(0, userIndex);
  if (source.messages.slice(0, userIndex + 1).some(message => message.agentContent?.includes('【附件素材】') && !message.attachments?.length)) {
    throw new Error('此前消息仅保留旧版附件路径，请重新上传附件后在新对话发送。');
  }
  if (prefix.length > 200 || prefix.reduce((n, message) => n + message.content.length, 0) > 200000) {
    throw new Error('此前对话超过编辑快照范围（200 条 / 200000 字），请从更早的消息开始编辑。');
  }
  const attachments = [...new Map(source.messages.slice(0, userIndex + 1)
    .flatMap(message => message.attachments || []).map(file => [file.path, file])).values()];
  return { prefix, original: source.messages[userIndex], text: text.trim(), attachments };
}

export function remapEditedMessage(message: ChatMessage, files: Record<string, UploadedFile>): ChatMessage {
  // Native turn/audit IDs and enhanced prompts belong to the source runtime.
  const { turnId: _turn, agentContent: _agent, thinking: _thinking, activity: _activity, ...snapshot } = message;
  return { ...snapshot, ...(message.attachments ? { attachments: message.attachments.map(file => {
    if (!files[file.path]) throw new Error('分支附件复制不完整，请重试。');
    return files[file.path];
  }) } : {}) };
}

export function editBranchSeed(session: ChatSession, userIndex: number) {
  if (!session.editBranch || userIndex !== session.editBranch.prefixLength) return undefined;
  return {
    history: session.messages.slice(0, userIndex).map(({ role, content }) => ({ role, content })),
    attachments: [...new Map(session.messages.slice(0, userIndex + 1)
      .flatMap(message => message.attachments || []).map(file => [file.path, file])).values()],
  };
}
