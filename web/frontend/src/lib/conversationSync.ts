import {decodeSessions, type ChatSession} from './store';
import {taskRequest} from './tasks';

const saved = new Map<string, string>();
const revisions = new Map<string, number>();
const pending = new Map<string, {session: ChatSession; baseRevision?: number}>();
type Receipt = {revision: number; digest: string};
const receipts = new Map<string, Receipt>();
const reads = new WeakMap<ChatSession, Receipt & {unchangedLocal?: string}>();
const receiptKey = (id: string) => `easel_conversation_sync_v1:${id}`;
let running: Promise<void> | null = null;
const eligible = (session: ChatSession) => !session.importedFromBackup && !session.taskWorker && session.messages.length > 0;

function canonical(session: ChatSession): string {
  const normalized = decodeSessions(JSON.stringify([session]))[0];
  // Share capabilities belong to this browser, never to a server baseline.
  delete normalized.share; delete normalized.loadedShareAppends;
  const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,sorted(item)])) : value;
  return JSON.stringify(sorted(normalized));
}
async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte=>byte.toString(16).padStart(2,'0')).join('');
}
function receipt(id: string): Receipt | undefined {
  if (receipts.has(id)) return receipts.get(id);
  try {
    const value = JSON.parse(window.localStorage.getItem(receiptKey(id)) || 'null');
    if (Number.isInteger(value?.revision) && value.revision > 0 && /^[a-f0-9]{64}$/.test(value.digest)) {
      receipts.set(id,value);return value;
    }
  } catch { /* Missing baseline preserves local history. */ }
}
function remember(id: string, value: Receipt) {
  if ((receipt(id)?.revision || 0) > value.revision) return;
  receipts.set(id,{revision:value.revision,digest:value.digest});
  revisions.set(id,value.revision);
  try { window.localStorage.setItem(receiptKey(id),JSON.stringify({revision:value.revision,digest:value.digest})); }
  catch { /* A failed cache write cannot authorize replacing history after reload. */ }
}
function adopted(session: ChatSession) {
  const value = reads.get(session);
  if (value) {
    pending.delete(session.id);
    remember(session.id,value);saved.set(session.id,JSON.stringify(session));
  }
}

/** Mirror visible records only. This never sends a prompt or creates a run. */
export function syncConversations(sessions: ChatSession[]): Promise<void> {
  for (const session of sessions) {
    if (eligible(session) && saved.get(session.id) !== JSON.stringify(session)) pending.set(session.id,
      {session,baseRevision:revisions.get(session.id) ?? receipt(session.id)?.revision});
  }
  if (running) return running;
  running = (async () => {
    while (pending.size) {
      const batch = [...pending.values()].slice(0, 2);
      for (const {session} of batch) pending.delete(session.id);
      await Promise.all(batch.map(async ({session,baseRevision}) => {
        const serialized = JSON.stringify(session);
        if (saved.get(session.id) === serialized) return;
        try {
          const result = await taskRequest<{id: string; saved: boolean; reason?: string; revision?: number}>('/conversations', {conversation: session, baseRevision}, 'POST', AbortSignal.timeout(15000));
          if (result.id === session.id && (result.saved || result.reason === 'newer_server_copy')) {
            saved.set(session.id, serialized);
            if (result.saved && Number.isInteger(result.revision) && result.revision! > 0) {
              remember(session.id,{revision:result.revision!,digest:await digest(canonical(session))});
            }
          }
        } catch { /* Local history remains intact; the next sync retries. */ }
      }));
    }
  })().finally(() => { running = null; });
  return running;
}

export async function readServerConversation(id: string, local?: ChatSession): Promise<ChatSession> {
  const raw = await taskRequest<{conversation: unknown; revision: number}>(`/conversations/${encodeURIComponent(id)}`, undefined, 'GET', AbortSignal.timeout(15000));
  const session = decodeSessions(JSON.stringify([raw.conversation]))[0];
  if (!session || session.id !== id || session.importedFromBackup || session.taskWorker
      || !Number.isInteger(raw.revision) || raw.revision < 1) throw Error('原对话记录无效，请重试');
  const baseline = receipt(id), localValue = local && canonical(local);
  const unchanged = baseline && baseline.revision < raw.revision && localValue
    && baseline.digest === await digest(localValue) ? localValue : undefined;
  // A read alone grants no write authority; remember only a snapshot adopted below.
  reads.set(session,{revision:raw.revision,digest:await digest(canonical(session)),unchangedLocal:unchanged});
  return session;
}

/** Discover conversations on another computer without downloading unchanged history. */
export async function readServerConversations(local: ChatSession[]): Promise<ChatSession[]> {
  const known = new Map(local.map(session => [session.id,session]));
  const loaded: ChatSession[] = [];
  let after = '';
  const pages = new Set<string>();
  do {
    if (pages.has(after)) throw Error('对话分页无效，请重试');
    pages.add(after);
    const page = await taskRequest<{conversations: {id:string;revision:number}[];next:string|null}>(`/conversations${after?'?after='+encodeURIComponent(after):''}`, undefined, 'GET', AbortSignal.timeout(15000));
    if (!Array.isArray(page.conversations)) throw Error('对话索引暂不可读');
    const changed = page.conversations.filter(row => typeof row.id === 'string' && Number.isInteger(row.revision) && (!known.has(row.id) || (revisions.get(row.id) ?? receipt(row.id)?.revision) !== row.revision));
    for (let offset=0; offset<changed.length; offset+=2) {
      await Promise.all(changed.slice(offset,offset+2).map(async row => {
        try {
          loaded.push(await readServerConversation(row.id,known.get(row.id)));
        } catch (error) {
          if (![404,410].includes((error as {status?:number})?.status || 0)) throw error;
        }
      }));
    }
    after = typeof page.next === 'string' ? page.next : '';
  } while (after);
  return loaded;
}

/** Adopt newer facts only from an unchanged baseline or a matching message prefix. */
export function mergeServerConversation(local: ChatSession[], remote: ChatSession): ChatSession[] {
  const current = local.find(session => session.id === remote.id);
  if (!current) { adopted(remote);return [...local, remote]; }
  if (current.importedFromBackup || (current.engine || 'openclaw') !== (remote.engine || 'openclaw')) return local;
  const read = reads.get(remote), currentValue = canonical(current);
  if (read && read.revision < (receipt(remote.id)?.revision || 0)) return local;
  if (currentValue === canonical(remote)) { adopted(remote);return local; }
  if (read?.unchangedLocal === currentValue) {
    adopted(remote);
    return local.map(session=>session.id===remote.id ? {...remote,
      ...(current.share ? {share:current.share} : {}),
      ...(current.loadedShareAppends ? {loadedShareAppends:current.loadedShareAppends} : {})} : session);
  }
  if (current.messages.length >= remote.messages.length) return local;
  if (!current.messages.every((message, index) => {
    const other = remote.messages[index];
    return message.role === other.role && message.content === other.content && message.turnId === other.turnId;
  })) return local;
  adopted(remote);
  return local.map(session => session.id === remote.id ? {...current, ...remote} : session);
}
