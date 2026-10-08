import type { useTrendSourceSelection } from '../hooks/useTrendSourceSelection';
import { TREND_SOURCES } from '../lib/trendPreferences';
import PlatformIcon from './PlatformIcon';
import { IconBookmark, IconCheck } from './icons';

export default function TrendSourcePicker({ selection }: { selection: ReturnType<typeof useTrendSourceSelection> }) {
  const { selected, toggle, save, reset, dirty, error } = selection;
  return <section className="trend-source-picker" aria-label="管理我的热榜">
    <div className="trend-source-picker-head">
      <div><strong>我的热榜</strong><span>已选 {selected.length} 个</span></div>
      <div className="trend-source-picker-actions">
        <button type="button" className="link-btn" onClick={reset}>恢复默认</button>
        <button type="button" className="btn btn-sm" disabled={!dirty} onClick={save}>
          {dirty ? <IconBookmark size={14} /> : <IconCheck size={14} />}{dirty ? '保存热榜' : '已保存'}
        </button>
      </div>
    </div>
    <div className="trend-platforms" role="group" aria-label="选择热点来源">
      {TREND_SOURCES.map(source => <button type="button" key={source.key} className={`chip${selected.includes(source.key) ? ' active' : ''}`}
        aria-label={source.label} aria-pressed={selected.includes(source.key)} onClick={() => toggle(source.key)}>
        <span aria-hidden="true"><PlatformIcon platform={source.key} name={source.label} className="trend-platform-icon" /></span><span>{source.label}</span>
      </button>)}
    </div>
    <p className={error ? 'trend-preference-error' : 'trend-preference-status'} role={error ? 'alert' : 'status'}>
      {error || (dirty ? '当前选择尚未保存。点击“保存热榜”，下次打开会恢复这份列表。' : '热榜已保存到当前浏览器，下次打开会自动恢复。')}
    </p>
  </section>;
}
