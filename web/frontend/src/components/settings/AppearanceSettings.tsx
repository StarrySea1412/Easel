import { useId, useSyncExternalStore, type CSSProperties } from 'react';
import Select from '../ui/Select';
import { IconMonitor } from '../settingsIcons';
import { readTheme, setThemePreference, subscribeTheme, type ThemePreference } from '../../lib/theme';
import { DEFAULT_FONT_SIZE, FONT_SIZE_STEP, MAX_FONT_SIZE, MIN_FONT_SIZE, readFontSize, setFontSize, subscribeFontSize } from '../../lib/fontSize';
import '../../styles/appearance.css';

export default function AppearanceSettings() {
  const theme = useSyncExternalStore(subscribeTheme, readTheme);
  const font = useSyncExternalStore(subscribeFontSize, readFontSize);
  const fontId = useId();
  const progress = (font.size - MIN_FONT_SIZE) / (MAX_FONT_SIZE - MIN_FONT_SIZE) * 100;
  return <section className="appearance-card" aria-labelledby="appearance-title">
    <header className="appearance-heading"><span className="appearance-icon" aria-hidden="true"><IconMonitor size={22} /></span>
      <div><h3 id="appearance-title">工作台外观</h3><p>选择适合当下光线的界面，让创作更舒适。</p></div></header>
    <div className="appearance-control"><div><label id="theme-label">颜色模式</label><p id="theme-help">即时应用到整个工作台，无需刷新。</p></div>
      <Select aria-labelledby="theme-label" aria-describedby="theme-help" value={theme.preference} onChange={value => setThemePreference(value as ThemePreference)}
        options={[{ value: 'system', label: '跟随系统', description: '随设备自动切换浅色与深色' }, { value: 'light', label: '浅色', description: '明亮、清晰的日间界面' }, { value: 'dark', label: '深色 · 夜间模式', description: '降低大面积亮光，适合夜间使用' }]} />
    </div>
    <div className="appearance-font-control">
      <div className="appearance-font-heading"><div><label htmlFor={fontId}>字号大小</label><p id={`${fontId}-help`}>拖动滑块，即时调整工作台文字大小。默认 14px。</p></div>
        <div className="appearance-font-value"><output htmlFor={fontId}>{font.size}px</output><button type="button" className="btn btn-sm btn-ghost" disabled={font.size === DEFAULT_FONT_SIZE} onClick={() => setFontSize(DEFAULT_FONT_SIZE)}>恢复默认</button></div>
      </div>
      <div className="appearance-font-slider"><span aria-hidden="true">A</span><input id={fontId} type="range" min={MIN_FONT_SIZE} max={MAX_FONT_SIZE} step={FONT_SIZE_STEP} value={font.size}
        aria-describedby={`${fontId}-help`} aria-valuetext={`${font.size} 像素`} style={{ '--range-progress': `${progress}%` } as CSSProperties}
        onChange={event => setFontSize(Number(event.currentTarget.value))} /><span aria-hidden="true">A</span></div>
      <div className="appearance-font-limits" aria-hidden="true"><span>{MIN_FONT_SIZE}px</span><span>{MAX_FONT_SIZE}px</span></div>
      {!font.persisted && <p className="appearance-font-warning" role="status">字号已应用，但当前浏览器无法保存，下次打开将恢复默认。</p>}
    </div>
    <div className="appearance-preview" aria-hidden="true"><div className="appearance-preview-rail"><i /><i /><i /><i /></div>
      <div className="appearance-preview-page"><span className="appearance-preview-brand">Easel<span>创作，从一个想法开始</span></span>
        <div className="appearance-preview-message">把灵感写下来，剩下的交给我们。</div>
        <div className="appearance-preview-composer"><span>今天想创作些什么？</span><b>↑</b></div></div></div>
    <p className="appearance-status" role="status">当前为{theme.resolved === 'dark' ? '深色' : '浅色'}{theme.preference === 'system' ? '，随系统自动切换' : '，已手动选择'}。
      {theme.persisted ? '偏好保存在当前浏览器，下次打开继续使用。' : '当前浏览器无法保存偏好，本次访问仍可切换。'}</p>
  </section>;
}
