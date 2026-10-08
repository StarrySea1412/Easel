import { useState } from 'react';
import { DEFAULT_TREND_SOURCES, readTrendPreferences, saveTrendPreferences } from '../lib/trendPreferences';

export function useTrendSourceSelection() {
  const [initial] = useState(readTrendPreferences);
  const [selected, setSelected] = useState(initial.sources);
  const [saved, setSaved] = useState<string[] | null>(initial.saved ? initial.sources : null);
  const [error, setError] = useState(initial.error);
  const dirty = saved === null || JSON.stringify(selected) !== JSON.stringify(saved);
  const toggle = (key: string) => {
    setSelected(current => current.includes(key) ? current.filter(item => item !== key) : [...current, key]);
    setError('');
  };
  const save = () => {
    if (!saveTrendPreferences(selected)) { setError('热榜尚未保存，浏览器存储不可用或空间不足。请保留当前页面后重试。'); return; }
    setSaved([...selected]); setError('');
  };
  const reset = () => { setSelected([...DEFAULT_TREND_SOURCES]); setError(''); };
  return { selected, toggle, save, reset, dirty, error };
}
