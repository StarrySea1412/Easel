import { useId } from 'react';
import type { DemoDataPreference } from '../../lib/demoPreferences';
import Switch from '../ui/Switch';

export default function DemoDataSettingsCard({ enabled, saved, error, onChange }: DemoDataPreference & { onChange: (enabled: boolean) => void }) {
  const id = useId();
  return <section className="board demo-data-settings" aria-labelledby={`${id}-title`}>
    <header><h3 id={`${id}-title`}>演示数据</h3><p>统一管理内容分析与 Agent 办公室的内置样例。</p></header>
    <div className="demo-data-setting-row">
      <div><label id={`${id}-label`} htmlFor={`${id}-switch`}>显示演示数据</label>
        <p id={`${id}-description`}>关闭后，内容分析展示你的作品，办公室进入实时观测。没有记录时显示空状态。</p></div>
      <div className="demo-data-setting-control"><span aria-hidden="true">{enabled ? '已开启' : '已关闭'}</span>
        <Switch id={`${id}-switch`} checked={enabled} onChange={onChange} aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`} /></div>
    </div>
    {error ? <p className="save-note err" role="alert">{error}</p>
      : <p className="demo-data-save-state" role="status">{saved ? '已保存到当前浏览器，刷新后仍然生效。' : '更改后立即生效，并保存到当前浏览器。'}</p>}
    <p className="hint">已保存的作品、会话和员工角色卡会保留。需要体验样例时，可随时重新开启。</p>
  </section>;
}
