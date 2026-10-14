import { useId } from 'react';
import type { DemoDataPreference } from '../../lib/demoPreferences';
import Switch from '../ui/Switch';

export default function DemoDataSettingsCard({ enabled, saved, error, onChange }: DemoDataPreference & { onChange: (enabled: boolean) => void }) {
  const id = useId();
  return <section className="board demo-data-settings" aria-labelledby={`${id}-title`}>
    <header><h3 id={`${id}-title`}>通用偏好</h3></header>
    <div className="demo-data-setting-row">
      <div><label id={`${id}-label`} htmlFor={`${id}-switch`}>显示演示数据</label>
        <p id={`${id}-description`}>内容分析与 Agent 办公室的内置样例。</p></div>
      <div className="demo-data-setting-control"><span aria-hidden="true">{enabled ? '已开启' : '已关闭'}</span>
        <Switch id={`${id}-switch`} checked={enabled} onChange={onChange} aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`} /></div>
    </div>
    {error ? <p className="save-note err" role="alert">{error}</p>
      : <p className="demo-data-save-state" role="status">{saved ? '已保存到当前浏览器，刷新后仍然生效。' : '更改后立即生效，并保存到当前浏览器。'}</p>}
  </section>;
}
