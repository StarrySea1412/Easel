import { useEffect, useRef, useState } from 'react';
import { fetchChannelNames, saveChannelName } from '../../lib/channelStatus';
import { showToast } from '../../lib/toast';

export default function ChannelNameEditor({ provider }: { provider: string }) {
  const [name, setName] = useState(''), [original, setOriginal] = useState(''), [source, setSource] = useState('');
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const saveRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setSaving(false); setError(''); setName(''); setOriginal(''); setSource('');
    fetchChannelNames(controller.signal).then(channels => { if (!controller.signal.aborted) { const item = channels[provider]; setName(item?.name === '未命名渠道' ? '' : item?.name || ''); setOriginal(item?.name === '未命名渠道' ? '' : item?.name || ''); setSource(item?.sourceName || ''); } })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '名称读取失败'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); saveRequest.current?.abort(); };
  }, [provider]);
  return <div className="channel-name-editor">
    <label>渠道名称<input aria-label="渠道名称" placeholder="填写渠道名称" maxLength={80} value={name} disabled={loading || saving || !!error} onChange={event => setName(event.target.value)}/></label>
    <button type="button" className="btn btn-sm" disabled={loading || saving || !!error || !name.trim() || name.trim() === original} onClick={async () => {
      const controller = new AbortController(); saveRequest.current = controller;
      setSaving(true); const requested = name.trim();
      try { await saveChannelName(provider, requested, controller.signal); if (!controller.signal.aborted) { setOriginal(requested); showToast('已保存渠道名称', 'success'); } }
      catch (cause) { if (!controller.signal.aborted) showToast(cause instanceof Error ? cause.message : '名称保存失败', 'error'); }
      finally { if (!controller.signal.aborted) setSaving(false); }
    }}>{saving ? '保存中…' : '保存名称'}</button>
    {source && <small>CC Switch 来源名称：{source}</small>}{error && <p role="alert">{error}</p>}
  </div>;
}
