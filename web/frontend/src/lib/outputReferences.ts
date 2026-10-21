import { marked } from 'marked';
import type { ChatSession } from './store';
import { readLocalValue, writeLocalValue } from './localPersistence';
import { linkifyOutputs } from './linkifyOutputs';

export interface OutputOrigin { sessionId: string; title?: string; turnId?: string; evidence: 'delivery' | 'reference'; deleted?: boolean }
type Index = { references: Record<string, OutputOrigin[]>; deleted: string[] };
const key = 'easel:output-references:v1';

export function outputLinkPath(href: string): string | null {
  const prefix = href.startsWith('/api/media/') ? '/api/media/' : href.startsWith('#/outputs/') ? '#/outputs/' : '';
  if (!prefix) return null;
  try {
    const path = decodeURIComponent(href.slice(prefix.length).split(/[?#]/)[0]);
    return path && !Array.from(path).some(c=>c==='\\'||c.charCodeAt(0)<32) && path.split('/').every(p=>p && !p.startsWith('.') && !p.startsWith('_')) ? path : null;
  } catch { return null; }
}

export function referencedOutputs(markdown: string): string[] {
  if (!markdown.includes('outputs')&&!markdown.includes('/api/media/')) return [];
  const paths = new Set<string>();
  marked.walkTokens(marked.lexer(linkifyOutputs(markdown)), token => {
    if (token.type === 'link' || token.type === 'image') {
      const path = outputLinkPath(token.href);
      if (path) paths.add(path);
    }
  });
  return [...paths];
}

function read(): Index | null {
  const stored = readLocalValue(key);
  if (!stored.ok) return null;
  if (stored.value === null) return {references:{}, deleted:[]};
  try {
    const data = JSON.parse(stored.value);
    if (!data || typeof data.references !== 'object' || !data.references || Array.isArray(data.references) || !Array.isArray(data.deleted)
      || !data.deleted.every((id:unknown)=>typeof id==='string')
      || !Object.entries(data.references).every(([path,rows])=>outputLinkPath('/api/media/'+path.split('/').map(encodeURIComponent).join('/'))===path&&Array.isArray(rows)&&rows.every(row=>row&&typeof row.sessionId==='string'&&typeof row.title==='string'))) return null;
    return data as Index;
  } catch { return null; }
}

const parsed = new WeakMap<object, string[]>();
export function rememberOutputReferences(sessions: ChatSession[]): void {
  const index = read();
  if (!index) return;
  const previous = JSON.stringify(index);
  for (const session of sessions) {
    if (session.importedFromBackup) continue;
    for (const message of session.messages) {
      if (message.role !== 'assistant') continue;
      let paths = parsed.get(message);
      if (!paths) { paths=referencedOutputs(message.content); parsed.set(message, paths); }
      for (const path of paths) {
        const rows = Array.isArray(index.references[path]) ? index.references[path] : [];
        const row = { sessionId:session.id, title:session.title, evidence:'reference' as const };
        const found=rows.findIndex(r=>r.sessionId===session.id);
        if (found < 0) rows.push(row); else rows[found]=row;
        index.references[path]=rows;
      }
    }
  }
  const next=JSON.stringify(index);
  if (next !== previous) writeLocalValue(key, next);
}

export function markOutputSessionDeleted(sessionId: string): void {
  const index=read();
  if (index && !index.deleted.includes(sessionId)) { index.deleted.push(sessionId); writeLocalValue(key,JSON.stringify(index)); }
}

export function outputReferences(path: string): OutputOrigin[] {
  const index=read();
  const rows=index?.references[path];
  return Array.isArray(rows) ? rows.filter(r=>r && typeof r.sessionId==='string').map(r=>({...r, evidence:'reference', deleted:index!.deleted.includes(r.sessionId)})) : [];
}

export function outputSessionDeleted(id: string): boolean { return read()?.deleted.includes(id) || false; }

export function renameOutputReferences(old: string, renamed: string): void {
  const index=read();
  if (!index) return;
  for (const [path, rows] of Object.entries(index.references)) {
    if (path === old || path.startsWith(old+'/')) {
      index.references[renamed+path.slice(old.length)]=rows;
      delete index.references[path];
    }
  }
  writeLocalValue(key,JSON.stringify(index));
}
