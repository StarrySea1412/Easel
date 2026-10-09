import type { ChatMessage, ChatSession } from './store';
import type { ThinkingLevel } from './api';
import { historicalGatewayAuthError } from './chatErrors';

export const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
export const MAX_BACKUP_SESSIONS = 5000;
export const MAX_BACKUP_MESSAGES = 100000;

export interface BackupMessage {
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  activity?: string;
  error?: string;
  requestedThinkingLevel?: ThinkingLevel;
}

export interface BackupSession {
  title: string;
  created: number;
  archived?: boolean;
  incomplete?: boolean;
  messages: BackupMessage[];
}

export interface ConversationBackup {
  format: 'easel-conversation-backup';
  version: 1;
  exportedAt: string;
  sessions: BackupSession[];
}

export interface BackupLiveSnapshot {
  content: string;
  thinking: string;
  activity: string;
}

const encoder = new TextEncoder();
const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive', 'max', 'ultra',
];

function invalid(path: string, reason: string): never {
  throw new Error(`会话备份格式无效：${path} ${reason}`);
}

function tooLarge(): never {
  throw new Error('会话备份超过 20 MiB 大小限制，无法处理整份备份。');
}

function checkSize(text: string) {
  if (text.length > MAX_BACKUP_BYTES || encoder.encode(text).byteLength > MAX_BACKUP_BYTES) tooLarge();
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path, '必须是对象。');
  return value as Record<string, unknown>;
}

function textField(value: unknown, path: string, budget: { bytes: number }): string {
  if (typeof value !== 'string') invalid(path, '必须是字符串。');
  if (value.length > MAX_BACKUP_BYTES) tooLarge();
  // Bound exported/in-memory objects as well as parsed text. JSON escaping can
  // make control characters much larger than their original UTF-8 strings.
  const serialized = JSON.stringify(value);
  if (serialized.length > MAX_BACKUP_BYTES) tooLarge();
  budget.bytes += encoder.encode(serialized).byteLength;
  if (budget.bytes > MAX_BACKUP_BYTES) tooLarge();
  return value;
}

function booleanField(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid(path, '必须是布尔值。');
  return value;
}

/** Validate the entire document, then return only the portable text fields. */
function validateBackup(value: unknown): ConversationBackup {
  const source = record(value, '根节点');
  if (source.format !== 'easel-conversation-backup') invalid('format', '不是 Easel 会话备份。');
  if (source.version !== 1) invalid('version', '仅支持版本 1。');
  const budget = { bytes: 0 };
  const exportedAt = textField(source.exportedAt, 'exportedAt', budget);
  const exportTime = new Date(exportedAt);
  if (!Number.isFinite(exportTime.getTime()) || exportTime.toISOString() !== exportedAt) {
    invalid('exportedAt', '必须是有效的 ISO UTC 时间。');
  }
  if (!Array.isArray(source.sessions) || source.sessions.length === 0) invalid('sessions', '必须包含至少一个会话。');
  if (source.sessions.length > MAX_BACKUP_SESSIONS) {
    throw new Error(`会话备份超过 ${MAX_BACKUP_SESSIONS} 个会话的数量限制。`);
  }

  let messageCount = 0;
  const sessions = source.sessions.map((value, index): BackupSession => {
    const path = `sessions[${index}]`;
    const session = record(value, path);
    const title = textField(session.title, `${path}.title`, budget);
    if (typeof session.created !== 'number' || !Number.isFinite(session.created)
      || session.created < 0 || session.created > 8640000000000000) {
      invalid(`${path}.created`, '必须是有效的非负时间戳。');
    }
    if (!Array.isArray(session.messages) || session.messages.length === 0) {
      invalid(`${path}.messages`, '必须包含至少一条消息。');
    }
    messageCount += session.messages.length;
    if (messageCount > MAX_BACKUP_MESSAGES) {
      throw new Error(`会话备份超过 ${MAX_BACKUP_MESSAGES} 条消息的总数量限制。`);
    }
    const messages = session.messages.map((value, messageIndex): BackupMessage => {
      const messagePath = `${path}.messages[${messageIndex}]`;
      const message = record(value, messagePath);
      if (message.role !== 'user' && message.role !== 'assistant') {
        invalid(`${messagePath}.role`, '只能是 user 或 assistant。');
      }
      const result: BackupMessage = {
        role: message.role,
        content: textField(message.content, `${messagePath}.content`, budget),
      };
      for (const field of ['thinking', 'activity', 'error'] as const) {
        if (message[field] !== undefined) result[field] = textField(message[field], `${messagePath}.${field}`, budget);
      }
      if (message.requestedThinkingLevel !== undefined) {
        if (typeof message.requestedThinkingLevel !== 'string'
          || !THINKING_LEVELS.includes(message.requestedThinkingLevel as ThinkingLevel)) {
          invalid(`${messagePath}.requestedThinkingLevel`, '不是受支持的思考强度。');
        }
        result.requestedThinkingLevel = message.requestedThinkingLevel as ThinkingLevel;
      }
      return result;
    });
    return {
      title,
      created: session.created,
      ...(session.archived !== undefined ? { archived: booleanField(session.archived, `${path}.archived`) } : {}),
      ...(session.incomplete !== undefined ? { incomplete: booleanField(session.incomplete, `${path}.incomplete`) } : {}),
      messages,
    };
  });
  const backup: ConversationBackup = { format: 'easel-conversation-backup', version: 1, exportedAt, sessions };
  checkSize(JSON.stringify(backup));
  return backup;
}

function visibleMessage(message: ChatMessage): BackupMessage {
  const historical = message.role === 'assistant' && !message.error
    ? historicalGatewayAuthError(message.content)
    : undefined;
  return {
    role: message.role,
    content: historical ? '' : message.content,
    ...(message.thinking !== undefined ? { thinking: message.thinking } : {}),
    ...(message.activity !== undefined ? { activity: message.activity } : {}),
    ...(message.requestedThinkingLevel !== undefined ? { requestedThinkingLevel: message.requestedThinkingLevel } : {}),
    ...(historical || message.error ? { error: historical?.message ?? message.error!.message } : {}),
  };
}

/** Export compact JSON with JSON.stringify(result); empty placeholders are omitted. */
export function createConversationBackup(
  sessions: ChatSession[],
  live: Record<string, BackupLiveSnapshot> = {},
): ConversationBackup {
  const exported: BackupSession[] = [];
  let messageCount = 0;
  for (const session of sessions) {
    const snapshot = Object.hasOwn(live, session.id) ? live[session.id] : undefined;
    const last = session.messages.at(-1);
    const alreadyPersisted = Boolean(session.pendingTurnId && last?.role === 'assistant'
      && last.turnId === session.pendingTurnId);
    const appendSnapshot = snapshot !== undefined && !alreadyPersisted;
    if (!session.messages.length && !appendSnapshot) continue;
    if (exported.length >= MAX_BACKUP_SESSIONS) {
      throw new Error(`会话备份超过 ${MAX_BACKUP_SESSIONS} 个会话的数量限制，未截断任何会话。`);
    }
    messageCount += session.messages.length + (appendSnapshot ? 1 : 0);
    if (messageCount > MAX_BACKUP_MESSAGES) {
      throw new Error(`会话备份超过 ${MAX_BACKUP_MESSAGES} 条消息的总数量限制，未截断任何消息。`);
    }
    const messages = session.messages.map(visibleMessage);
    if (appendSnapshot) {
      messages.push(visibleMessage({ role: 'assistant', content: snapshot.content, thinking: snapshot.thinking, activity: snapshot.activity }));
    }
    const importedIncomplete = 'backupIncomplete' in session && session.backupIncomplete === true;
    exported.push({
      title: session.title,
      created: session.created,
      ...(session.archived !== undefined ? { archived: session.archived } : {}),
      ...(session.pendingTurnId || snapshot !== undefined || importedIncomplete ? { incomplete: true } : {}),
      messages,
    });
  }
  if (!exported.length) throw new Error('没有可备份的对话内容，空会话占位不会导出。');
  return validateBackup({
    format: 'easel-conversation-backup', version: 1, exportedAt: new Date().toISOString(), sessions: exported,
  });
}

export function parseConversationBackup(text: string): ConversationBackup {
  if (typeof text !== 'string') invalid('文件内容', '必须是 JSON 文本。');
  checkSize(text);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { invalid('文件内容', '不是有效的 JSON。'); }
  return validateBackup(parsed);
}

/** Imported histories get fresh local identities and no executable associations. */
export function createImportedSessions(backup: ConversationBackup, existingIds: Iterable<string>): ChatSession[] {
  const validated = validateBackup(backup);
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('当前环境无法生成安全的会话标识，请使用 localhost 或 HTTPS 后重试。');
  }
  const usedIds = new Set(existingIds);
  return validated.sessions.map((session) => {
    let id = '';
    for (let attempt = 0; attempt < 16; attempt++) {
      const candidate = globalThis.crypto.randomUUID();
      if (!usedIds.has(candidate)) { id = candidate; break; }
    }
    if (!id) throw new Error('无法生成不冲突的会话标识，未导入任何会话，请重试。');
    usedIds.add(id);
    return {
      id,
      title: session.title,
      created: session.created,
      ...(session.archived !== undefined ? { archived: session.archived } : {}),
      importedFromBackup: true,
      backupIncomplete: session.incomplete === true,
      messages: session.messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.thinking !== undefined ? { thinking: message.thinking } : {}),
        ...(message.activity !== undefined ? { activity: message.activity } : {}),
        ...(message.requestedThinkingLevel !== undefined ? { requestedThinkingLevel: message.requestedThinkingLevel } : {}),
        ...(message.error !== undefined ? { error: { message: message.error } } : {}),
      })),
    };
  });
}
