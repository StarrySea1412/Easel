import { useEffect, useRef, useState } from 'react';

type RemoteLink = { href: string; status: string; message: string; localPath?: string };
type Receipt = { sessionId: string; turnId: string; runtime: string | null; links: RemoteLink[] };
const LINK = /\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"\n]*")?\s*\)/g;

function decode(value: unknown, session: string, turn: string): Receipt {
  const row = value as Partial<Receipt> | null;
  if (!row || row.sessionId !== session || row.turnId !== turn || !Array.isArray(row.links)) throw new Error('文件回执不属于当前对话和轮次。');
  return {sessionId: session, turnId: turn, runtime: row.runtime === 'qizhi' ? 'qizhi' : null, links: row.links.slice(0, 40).filter(link =>
    link && typeof link.href === 'string' && typeof link.status === 'string' && typeof link.message === 'string').map(link => ({...link,
      localPath: typeof link.localPath === 'string' && link.localPath.split('/').every(part => part && !part.startsWith('.') && !part.startsWith('_') && !/[\\:\x00-\x1f]/.test(part)) ? link.localPath : undefined}))};
}

/** Reads only the original turn; POST rechecks files, never dispatches an Agent. */
export function useRemoteOutputs(content: string, sessionId: string | undefined, turnId: string | undefined, enabled: boolean) {
  const [saved, setSaved] = useState<{key: string; receipt: Receipt | null; error: string}>({key: '', receipt: null, error: ''});
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const requestRef = useRef<AbortController | null>(null);
  const eligible = enabled && Boolean(sessionId && turnId) && /\]\(\s*<?(?:\/(?!\/)|\.?\/?outputs\/|#\/outputs\/)/.test(content);
  const key = JSON.stringify([sessionId, turnId, content, revision]);
  const currentKey = useRef(key); currentKey.current = key;
  const receipt = eligible && saved.key === key ? saved.receipt : null;
  const loading = eligible && saved.key !== key;
  const base = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
  const endpoint = base + '/api/chat/remote-outputs/' + encodeURIComponent(sessionId || '') + '/' + encodeURIComponent(turnId || '');
  useEffect(() => {
    if (!eligible || !sessionId || !turnId) return;
    let alive = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    void fetch(endpoint, {signal: controller.signal, cache: 'no-store'}).then(async response => {
      if (!response.ok) throw new Error('原轮文件记录暂不可读取，请稍后重新检查。');
      return decode(await response.json(), sessionId, turnId);
    }).then(value => { if (!controller.signal.aborted) setSaved({key, receipt: value, error: ''}); })
      .catch(() => { if (alive) setSaved({key, receipt: null, error: '原轮文件来源暂不可核验，请稍后重新检查。'}); })
      .finally(() => clearTimeout(timer));
    return () => { alive = false; clearTimeout(timer); controller.abort(); };
  }, [key, eligible, endpoint, sessionId, turnId]);
  useEffect(() => () => requestRef.current?.abort(), []);
  const messages: Record<string, string> = {};
  const replacements = new Map<string, string>();
  if (receipt?.runtime === 'qizhi') receipt.links.forEach((link, index) => {
    const target = link.status === 'ready' && link.localPath ? 'outputs/' + link.localPath : '#/remote-output/' + index;
    replacements.set(link.href, target);
    if (target.startsWith('#')) messages[target] = link.message || '远端文件尚未同步。';
  });
  const resolvedContent = replacements.size ? content.replace(LINK, (all, angle: string | undefined, plain: string | undefined) => {
    const href = angle || plain || '';
    return replacements.has(href) ? all.replace(href, replacements.get(href)!) : all;
  }) : content;
  const recheck = async () => {
    if (busy) return;
    if (receipt?.runtime !== 'qizhi' || !sessionId || !turnId) { setRevision(value => value + 1); return; }
    setBusy(true);
    const controller = new AbortController(); requestRef.current = controller;
    const timer = setTimeout(() => controller.abort(), 50000);
    try {
      const response = await fetch(endpoint + '/recheck', {method: 'POST', signal: controller.signal, cache: 'no-store'});
      const value: unknown = await response.json();
      if (!response.ok) {
        const detail = (value as {detail?: unknown})?.detail;
        throw new Error(typeof detail === 'string' ? detail : '原文件同步尚未完成，请稍后重新检查。');
      }
      const decoded = decode(value, sessionId, turnId);
      if (currentKey.current === key) setSaved({key, receipt: decoded, error: ''});
    } catch (cause) {
      if (currentKey.current === key) setSaved({key, receipt, error: cause instanceof Error && cause.name !== 'AbortError' ? cause.message : '原文件检查超时；不会重跑 Agent，请稍后重新检查。'});
    } finally { clearTimeout(timer); requestRef.current = null; setBusy(false); }
  };
  return {content: resolvedContent, messages, qizhi: receipt?.runtime === 'qizhi', loading, busy,
    error: saved.key === key ? saved.error : '', recheck};
}
