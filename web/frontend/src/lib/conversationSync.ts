import {decodeSessions, type ChatSession} from './store';
import {taskRequest} from './tasks';

const saved = new Map<string, string>();
const revisions = new Map<string, number>();
const pending = new Map<string, ChatSession>();
let running: Promise<void> | null = null;
const eligible = (session: ChatSession) => !session.importedFromBackup && !session.taskWorker && session.messages.length > 0;

/** Mirror visible records only. This never sends a prompt or creates a run. */
export function syncConversations(sessions: ChatSession[]): Promise<void> {
  for (const session of sessions) {
    if (eligible(session) && saved.get(session.id) !== JSON.stringify(session)) pending.set(session.id, session);
  }
  if (running) return running;
  running = (async () => {
    while (pending.size) {
      const batch = [...pending.values()].slice(0, 2);
      for (const session of batch) pending.delete(session.id);
      await Promise.all(batch.map(async session => {
        const serialized = JSON.stringify(session);
        if (saved.get(session.id) === serialized) return;
        try {
          const result = await taskRequest<{id: string; saved: boolean; reason?: string; revision?: number}>('/conversations', {conversation: session, baseRevision: revisions.get(session.id)}, 'POST', AbortSignal.timeout(15000));
          if (result.id === session.id && (result.saved || result.reason === 'newer_server_copy')) {
            saved.set(session.id, serialized);
            if (result.saved && Number.isInteger(result.revision)) revisions.set(session.id, result.revision!);
          }
        } catch { /* Local history remains intact; the next sync retries. */ }
      }));
    }
  })().finally(() => { running = null; });
  return running;
}

export async function readServerConversation(id: string): Promise<ChatSession> {
  const raw = await taskRequest<{conversation: unknown; revision: number}>(`/conversations/${encodeURIComponent(id)}`, undefined, 'GET', AbortSignal.timeout(15000));
  const session = decodeSessions(JSON.stringify([raw.conversation]))[0];
  if (!session || session.id !== id || session.importedFromBackup || session.taskWorker) throw Error('原对话记录无效，请重试');
  // Reading a divergent copy must not grant permission to overwrite it.
  // The next successful save acknowledges the exact adopted local snapshot.
  return session;
}

/** Discover conversations on another computer without downloading unchanged history. */
export async function readServerConversations(local: ChatSession[]): Promise<ChatSession[]> {
  const known = new Set(local.map(session => session.id));
  const loaded: ChatSession[] = [];
  let after = '';
  const pages = new Set<string>();
  do {
    if (pages.has(after)) throw Error('对话分页无效，请重试');
    pages.add(after);
    const page = await taskRequest<{conversations: {id:string;revision:number}[];next:string|null}>(`/conversations${after?'?after='+encodeURIComponent(after):''}`, undefined, 'GET', AbortSignal.timeout(15000));
    if (!Array.isArray(page.conversations)) throw Error('对话索引暂不可读');
    const changed = page.conversations.filter(row => typeof row.id === 'string' && Number.isInteger(row.revision) && (!known.has(row.id) || revisions.get(row.id) !== row.revision));
    for (let offset=0; offset<changed.length; offset+=2) {
      await Promise.all(changed.slice(offset,offset+2).map(async row => {
        try {
          loaded.push(await readServerConversation(row.id));
        } catch (error) {
          if (![404,410].includes((error as {status?:number})?.status || 0)) throw error;
        }
      }));
    }
    after = typeof page.next === 'string' ? page.next : '';
  } while (after);
  return loaded;
}

/** A longer server copy can hydrate a stale browser; divergent local work stays. */
export function mergeServerConversation(local: ChatSession[], remote: ChatSession): ChatSession[] {
  const current = local.find(session => session.id === remote.id);
  if (!current) return [...local, remote];
  if (current.importedFromBackup || current.messages.length >= remote.messages.length) return local;
  if (!current.messages.every((message, index) => {
    const other = remote.messages[index];
    return message.role === other.role && message.content === other.content && message.turnId === other.turnId;
  })) return local;
  return local.map(session => session.id === remote.id ? {...current, ...remote} : session);
}
