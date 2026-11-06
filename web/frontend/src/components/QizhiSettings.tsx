import { useEffect, useState } from 'react';
import { fetchQizhiSettings, saveQizhiSettings, type QizhiSettingsData } from '../lib/api';

export default function QizhiSettings({ onConfigured }: { onConfigured: () => void }) {
  const [config, setConfig] = useState<QizhiSettingsData | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  useEffect(() => {
    let alive = true;
    fetchQizhiSettings().then(value => { if (alive) setConfig(value); })
      .catch(() => { if (alive) setNote('Qizhi 配置读取失败，请重新打开设置。'); });
    return () => { alive = false; };
  }, []);
  const save = async () => {
    if (!config) return;
    setBusy(true); setNote('');
    try {
      const value = await saveQizhiSettings({ baseUrl: config.baseUrl, projectPath: config.projectPath,
        model: config.model, ...(key ? { apiKey: key } : {}) });
      setConfig(value); setKey(''); onConfigured();
      setNote('Qizhi 配置已保存。请保存底座，再新建无本地附件和技能的对话。');
    } catch (cause) { setNote(cause instanceof Error ? cause.message : '保存失败'); }
    finally { setBusy(false); }
  };
  return <div className="qizhi-settings" aria-label="Qizhi 远程配置">
    <p className="desc" role="note">Qizhi 的工具在远程服务器执行。当前接入支持文字与远程续聊；本地附件、画像和技能不会自动上传。断开连接不表示远程任务已停止。</p>
    {config && <>
      {([['baseUrl', '服务根地址'], ['projectPath', '远程项目目录'], ['model', '远程模型']] as const).map(([field, label]) =>
        <div className="settings-field" key={field}><label htmlFor={`qizhi-${field}`} className="settings-field-label">{label}</label>
          <div className="settings-field-body"><input id={`qizhi-${field}`} className="mock" value={config[field]} disabled={busy}
            onChange={event => setConfig({ ...config, [field]: event.target.value })} /></div></div>)}
      <div className="settings-field"><label htmlFor="qizhi-key" className="settings-field-label">API Key</label>
        <div className="settings-field-body"><input id="qizhi-key" className="mock" type="password" autoComplete="new-password"
          value={key} disabled={busy} placeholder={config.keyStored ? '已保存；留空保留' : '填写 X-API-Key'}
          onChange={event => setKey(event.target.value)} /></div></div>
      <button className="btn btn-sm" type="button" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存 Qizhi 配置'}</button>
    </>}
    {note && <p className="desc" role="status">{note}</p>}
  </div>;
}
