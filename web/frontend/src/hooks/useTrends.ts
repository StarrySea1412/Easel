import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchTrends } from '../lib/api';
import type { TrendGroup } from '../lib/api';

type TrendState = { group?: TrendGroup; loading: boolean; error: string };

/** Each source resolves independently; leaving it cancels only its own request. */
export function useTrends(selected: string[]) {
  const [entries, setEntries] = useState<Record<string, TrendState>>({});
  const selectedRef = useRef(selected);
  const loaded = useRef(new Set<string>());
  const pending = useRef(new Map<string, AbortController>());
  const alive = useRef(true);
  selectedRef.current = selected;

  const load = useCallback((platform: string, refresh = false) => {
    if (!selectedRef.current.includes(platform) || pending.current.has(platform)) return;
    const controller = new AbortController();
    pending.current.set(platform, controller);
    setEntries(previous => ({ ...previous, [platform]: { ...previous[platform], loading: true, error: '' } }));
    void fetchTrends(platform, 15, { refresh, signal: controller.signal }).then(data => {
      if (!alive.current || controller.signal.aborted || pending.current.get(platform) !== controller) return;
      const group = data.trends.find(item => item.platform === platform);
      if (!group) throw new Error('服务没有返回该来源，请重试。');
      loaded.current.add(platform);
      setEntries(previous => ({ ...previous, [platform]: { group, loading: false, error: '' } }));
    }).catch((error: unknown) => {
      if (!alive.current || controller.signal.aborted || pending.current.get(platform) !== controller) return;
      loaded.current.add(platform);
      setEntries(previous => ({ ...previous, [platform]: { ...previous[platform], loading: false,
        error: error instanceof Error ? error.message : '此来源获取失败，请检查连接后重试。' } }));
    }).finally(() => {
      if (pending.current.get(platform) === controller) pending.current.delete(platform);
    });
  }, []);

  useEffect(() => {
    for (const [platform, controller] of pending.current) {
      if (!selected.includes(platform)) { controller.abort(); pending.current.delete(platform); }
    }
    for (const platform of loaded.current) if (!selected.includes(platform)) loaded.current.delete(platform);
    setEntries(previous => Object.fromEntries(Object.entries(previous).filter(([platform]) => selected.includes(platform))));
    for (const platform of selected) if (!loaded.current.has(platform)) load(platform);
  }, [selected, load]);

  useEffect(() => {
    alive.current = true;
    const requests = pending.current;
    return () => { alive.current = false; for (const controller of requests.values()) controller.abort(); requests.clear(); };
  }, []);

  const refresh = () => { for (const platform of selectedRef.current) load(platform, true); };
  return { entries, refresh, retry: (platform: string) => load(platform, true),
    loading: selected.some(platform => entries[platform]?.loading !== false) };
}
