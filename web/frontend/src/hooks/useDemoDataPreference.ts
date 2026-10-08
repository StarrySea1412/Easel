import { useCallback, useEffect, useState } from 'react';
import { DEMO_DATA_PREFERENCE_KEY, readDemoDataPreference, saveDemoDataPreference } from '../lib/demoPreferences';

/** App owns this preference so all pages change together, including open tabs. */
export function useDemoDataPreference() {
  const [preference, setPreference] = useState(readDemoDataPreference);

  useEffect(() => {
    const refresh = () => setPreference(readDemoDataPreference());
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== DEMO_DATA_PREFERENCE_KEY) return;
      try { if (event.storageArea && event.storageArea !== localStorage) return; } catch { /* refresh reports denied access */ }
      refresh();
    };
    window.addEventListener('storage', onStorage);
    // Close the gap between the initial read and subscribing to other tabs.
    refresh();
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const onChange = useCallback((enabled: boolean) => {
    if (!saveDemoDataPreference(enabled)) {
      setPreference(current => ({ ...current, saved: false, error: '无法保存演示数据设置，当前开关未更改。请检查浏览器存储权限或可用空间后重试。' }));
      return;
    }
    setPreference({ enabled, saved: true, error: '' });
  }, []);

  return { ...preference, onChange };
}
