import type { Operation } from './execution';
import type { ChatSession } from './store';
import { readLocalValue, writeLocalValue } from './localPersistence';

export type PageReference = { url: string; title: string };
export type PageObservation = PageReference & { id: string; at: string; kind: 'browser'|'reader' };
export type SourceEvidence = { id: string; turnId?: string; label: string; status: string; query?: string };
export type SourcePage = PageReference & { evidence: SourceEvidence[] };
const sourceKey = (sessionId: string) => `easel:page-sources:${sessionId}`;
const webTool = (name: string) => /^(web_search|webSearch|web_fetch|easel_browser|browser(?:_\w+)?)$/.test(name);

/** Links are data from observed tools, never HTML or links scraped from an answer. */
export function sourceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4000 || [...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (/\[已隐藏\]|\[REDACTED/i.test(decodeURIComponent(url.href))) return null;
    for (const key of url.searchParams.keys()) {
      if (/(?:token|password|secret|signature|credential|authorization|api[_-]?key|^key$|^sig$)/i.test(key)) return null;
    }
    url.hash = '';
    return url.href;
  } catch { return null; }
}

export function operationSources(row: Operation): PageReference[] {
  if (row.contentHidden) return [];
  const found = new Map<string, PageReference>();
  const add = (value: unknown, title: unknown = '') => {
    const url = sourceUrl(value);
    if (url && found.size < 100) found.set(url, { url, title: typeof title === 'string' && title ? title.slice(0, 300) : found.get(url)?.title || '' });
  };
  for (const link of Array.isArray(row.webSources) ? row.webSources : []) if (link) add(link.url, link.title);
  add(row.url);
  // Older backends retained the textual web result. Restrict recovery to web
  // tools: URLs in shell output, generated text and local grep are not sources.
  if (webTool(row.name) && ['returned', 'completed'].includes(row.status)) {
    let remaining = 1200;
    const visit = (value: unknown, depth = 0) => {
      if (--remaining < 0 || depth > 7 || !value) return;
      if (Array.isArray(value)) { value.slice(0, 100).forEach(item => visit(item, depth + 1)); return; }
      if (typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      add(record.url || record.uri || record.link, record.title || record.name);
      for (const key of ['results', 'sources', 'citations', 'links', 'content', 'data', 'items', 'resources', 'structuredContent', 'snapshot', 'tabs']) visit(record[key], depth + 1);
    };
    try { visit(JSON.parse(row.output)); } catch { /* Text responses are handled below. */ }
    const plain = row.output.replace(/\[([^\]\n]{1,300})\]\((https?:\/\/[^\s<>]+)\)/g, (_match, title, url) => { add(url, title); return ''; });
    for (const match of plain.matchAll(/https?:\/\/[^\s<>"\][{}]+/g)) {
      const value = match[0].replace(/[.,;:!?，。；：！？)）]+$/, '');
      if (!found.has(sourceUrl(value) || '')) add(value);
    }
  }
  return [...found.values()];
}

export function readPageSources(sessionId: string): PageObservation[] {
  const saved = readLocalValue(sourceKey(sessionId));
  try {
    const values: unknown = JSON.parse(saved.value || '[]');
    return Array.isArray(values) ? values.filter((item): item is PageObservation => item && typeof item.id === 'string'
      && typeof item.title === 'string' && typeof item.at === 'string' && ['browser', 'reader'].includes(item.kind)
      && sourceUrl(item.url) === item.url).slice(-200) : [];
  } catch { return []; }
}

export function recordPageSource(sessionId: string, page: PageObservation) {
  const url = sourceUrl(page.url);
  if (!url) return;
  const previous = readPageSources(sessionId);
  if (previous.some(item => item.id === page.id)) return;
  const next = [...previous, { ...page, url, title: page.title.slice(0, 300) }].slice(-200);
  writeLocalValue(sourceKey(sessionId), JSON.stringify(next));
  window.dispatchEvent(new window.CustomEvent('easel:page-sources', { detail: { sessionId, pages: next } }));
}

export function collectSources(operations: { turnId: string; rows: Operation[] }[], observations: PageObservation[]) {
  const pages = new Map<string, SourcePage>();
  const tools = new Map<string, { name: string; calls: number; failed: number }>();
  const add = (link: PageReference, evidence: SourceEvidence) => {
    const url = sourceUrl(link.url);
    if (!url) return;
    const existing = pages.get(url) || { url, title: '', evidence: [] };
    if (link.title) existing.title = link.title;
    if (!existing.evidence.some(item => item.id === evidence.id)) existing.evidence.push(evidence);
    pages.set(url, existing);
  };
  for (const { turnId, rows } of operations) for (const row of rows) {
    const tool = tools.get(row.name) || { name: row.name, calls: 0, failed: 0 };
    tool.calls++; if (['failed', 'denied', 'stopped'].includes(row.status)) tool.failed++;
    tools.set(row.name, tool);
    const label = row.name === 'web_fetch' ? '网页工具返回' : row.kind === 'browser' || row.name === 'easel_browser' ? '浏览器返回' : row.kind === 'search' ? '检索返回' : '工具返回';
    for (const link of operationSources(row)) add(link, { id: `${turnId}:${row.id}`, turnId, label, status: row.status, query: row.query });
  }
  for (const page of observations) add(page, { id: page.id, label: page.kind === 'reader' ? '正文读取' : '浏览器观察', status: 'completed' });
  return { pages: [...pages.values()].reverse(), tools: [...tools.values()] };
}

export function sourceTurns(session: ChatSession): string[] {
  if (session.importedFromBackup) return [];
  return [...new Set([...session.messages.filter(message => !message.externalSource && !message.shareAppend).map(message => message.turnId), session.pendingTurnId].filter((id): id is string => Boolean(id)))].reverse();
}
