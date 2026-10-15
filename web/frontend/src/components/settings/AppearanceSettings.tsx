import { useSyncExternalStore } from 'react';
import Select from '../ui/Select';
import { IconMonitor } from '../settingsIcons';
import { readTheme, setThemePreference, subscribeTheme, type ThemePreference } from '../../lib/theme';
import '../../styles/appearance.css';

export default function AppearanceSettings() {
  const theme = useSyncExternalStore(subscribeTheme, readTheme);
  return <section className="appearance-card" aria-labelledby="appearance-title">
    <header className="appearance-heading"><span className="appearance-icon" aria-hidden="true"><IconMonitor size={22} /></span>
      <div><h3 id="appearance-title">工作台外观</h3><p>选择适合当下光线的界面，让创作更舒适。</p></div></header>
    <div className="appearance-control"><div><label id="theme-label">颜色模式</label><p id="theme-help">即时应用到整个工作台，无需刷新。</p></div>
      <Select aria-labelledby="theme-label" aria-describedby="theme-help" value={theme.preference} onChange={value => setThemePreference(value as ThemePreference)}
        options={[{ value: 'system', label: '跟随系统', description: '随设备自动切换浅色与深色' }, { value: 'light', label: '浅色', description: '明亮、清晰的日间界面' }, { value: 'dark', label: '深色 · 夜间模式', description: '降低大面积亮光，适合夜间使用' }]} />
    </div>
    <div className="appearance-preview" aria-hidden="true"><div className="appearance-preview-rail"><i /><i /><i /><i /></div>
      <div className="appearance-preview-page"><span className="appearance-preview-brand">Easel<span>创作，从一个想法开始</span></span>
        <div className="appearance-preview-message">把灵感写下来，剩下的交给我们。</div>
        <div className="appearance-preview-composer"><span>今天想创作些什么？</span><b>↑</b></div></div></div>
    <p className="appearance-status" role="status">当前为{theme.resolved === 'dark' ? '深色' : '浅色'}{theme.preference === 'system' ? '，随系统自动切换' : '，已手动选择'}。
      {theme.persisted ? '偏好保存在当前浏览器，下次打开继续使用。' : '当前浏览器无法保存偏好，本次访问仍可切换。'}</p>
  </section>;
}
