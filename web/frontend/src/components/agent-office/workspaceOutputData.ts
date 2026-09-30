import { useCallback, useEffect, useRef, useState } from 'react';

export type WorkspaceOutputKind = 'image' | 'video' | 'audio' | 'text' | 'document' | 'archive';
export interface WorkspaceOutput {
  id: string;
  name: string;
  path: string;
  kind: WorkspaceOutputKind;
  size: number;
  modifiedAt: string;
  href: string;
}
export interface WorkspaceOutputSnapshot {
  scope: 'workspace';
  source: 'local_output_metadata';
  observedAt: string;
  items: WorkspaceOutput[];
  truncated: boolean;
  warnings: string[];
  detail: string;
}

const KINDS = new Set<WorkspaceOutputKind>(['image', 'video', 'audio', 'text', 'document', 'archive']);
const basePath = () => window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/** Only the advertised relative path under our media endpoint can become a link. */
export function safeWorkspaceOutputHref(path: string, href: string): string | null {
  if (!text(path, 2048) || !text(href, 8192) || !href.startsWith('/api/media/') || /[?#\\]/.test(href)) return null;
  const segments = path.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[:\\]/.test(segment)
    || Array.from(segment).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) return null;
  try {
    const encoded = href.slice('/api/media/'.length).split('/');
    if (encoded.length !== segments.length || !encoded.every((segment, index) => decodeURIComponent(segment) === segments[index])) return null;
    return `${basePath()}${href}`;
  } catch { return null; }
}

export function decodeWorkspaceOutputs(value: unknown): WorkspaceOutputSnapshot {
  if (!record(value) || value.scope !== 'workspace' || value.source !== 'local_output_metadata'
    || !Array.isArray(value.items) || value.items.length > 20 || typeof value.truncated !== 'boolean'
    || typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt))) {
    throw new Error('工作区产出清单格式无效，无法确认文件来源。');
  }
  const ids = new Set<string>(), paths = new Set<string>();
  const items = value.items.map((item): WorkspaceOutput => {
    if (!record(item) || !text(item.id, 160) || ids.has(item.id) || !text(item.name, 512)
      || !text(item.path, 2048) || paths.has(item.path) || !text(item.href, 8192)
      || typeof item.kind !== 'string' || !KINDS.has(item.kind as WorkspaceOutputKind)
      || typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 0
      || typeof item.modifiedAt !== 'string' || !Number.isFinite(Date.parse(item.modifiedAt))
      || !safeWorkspaceOutputHref(item.path, item.href)) throw new Error('产出文件信息不完整或路径无效，请刷新后重试。');
    ids.add(item.id); paths.add(item.path);
    return { id: item.id, name: item.name, path: item.path, kind: item.kind as WorkspaceOutputKind, size: item.size, modifiedAt: item.modifiedAt, href: item.href };
  });
  return {
    scope: 'workspace', source: 'local_output_metadata', observedAt: value.observedAt, items, truncated: value.truncated,
    warnings: Array.isArray(value.warnings) ? value.warnings.filter((item): item is string => typeof item === 'string').slice(0, 5).map(item => item.slice(0, 500)) : [],
    detail: typeof value.detail === 'string' ? value.detail.slice(0, 800) : '工作区近期文件，仅有文件元数据，无法确认员工归属或成品状态。',
  };
}

export async function fetchWorkspaceOutputs(signal: AbortSignal): Promise<WorkspaceOutputSnapshot> {
  const response = await fetch(`${basePath()}/api/workspace-outputs`, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`工作区产出读取失败（HTTP ${response.status}），请稍后重试。`);
  return decodeWorkspaceOutputs(await response.json());
}

interface OutputObservation { snapshot: WorkspaceOutputSnapshot | null; loading: boolean; error: string | null }
const INITIAL: OutputObservation = { snapshot: null, loading: false, error: null };

/** Poll only after a previous request settles; hide/disable aborts its request. */
export function useWorkspaceOutputs(enabled: boolean) {
  const [state, setState] = useState<OutputObservation>(INITIAL);
  const trigger = useRef<(() => void) | null>(null);
  const refresh = useCallback(() => trigger.current?.(), []);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let request: AbortController | null = null;
    let timer: ReturnType<typeof window.setTimeout> | undefined;
    let deadline: ReturnType<typeof window.setTimeout> | undefined;
    let refreshAfterAbort = false;
    const read = async () => {
      if (disposed || document.hidden || request) return;
      window.clearTimeout(timer);
      const ownRequest = new AbortController();
      request = ownRequest;
      let timedOut = false;
      deadline = window.setTimeout(() => { timedOut = true; ownRequest.abort(); }, 12_000);
      setState(previous => ({ ...previous, loading: true }));
      try {
        const snapshot = await fetchWorkspaceOutputs(ownRequest.signal);
        if (timedOut) throw new Error('产出清单读取超时');
        if (!disposed && !ownRequest.signal.aborted) setState({ snapshot, loading: false, error: null });
      } catch (cause) {
        if (!disposed && (timedOut || !ownRequest.signal.aborted)) setState(previous => ({
          ...previous, loading: false, error: timedOut ? '产出清单读取超时，已保留上次快照。' : cause instanceof Error ? cause.message : '产出清单更新失败。',
        }));
      } finally {
        window.clearTimeout(deadline);
        if (request === ownRequest) request = null;
        if (!disposed) {
          setState(previous => previous.loading ? { ...previous, loading: false } : previous);
          if (!document.hidden) {
            if (refreshAfterAbort) { refreshAfterAbort = false; void read(); }
            else timer = window.setTimeout(() => void read(), 10_000);
          }
        }
      }
    };
    const visibility = () => {
      window.clearTimeout(timer);
      if (document.hidden) { refreshAfterAbort = false; request?.abort(); }
      else if (request) refreshAfterAbort = true;
      else void read();
    };
    const manual = () => { if (!request) void read(); };
    trigger.current = manual;
    document.addEventListener('visibilitychange', visibility);
    void read();
    return () => {
      disposed = true;
      if (trigger.current === manual) trigger.current = null;
      window.clearTimeout(timer); window.clearTimeout(deadline);
      request?.abort();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [enabled]);
  return { ...(enabled ? state : INITIAL), refresh, stale: enabled && Boolean(state.snapshot && state.error) };
}
