import { useState, useRef, useEffect, useId, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { resolveThinkingPreference, THINKING_LEVELS, THINKING_LABELS, type ThinkingPreference } from '../lib/thinkingLevel';
import { IconChevron } from './icons';
import '../styles/thinking-level-picker.css';

export function ThinkingLevelPicker({ value, onChange, disabled, supportedLevels }: { value: ThinkingPreference; onChange: (value: ThinkingPreference) => void; disabled: boolean; supportedLevels?: string[] }) {
  const [open, setOpen] = useState(false);
  const menuOpen = open && !disabled;
  const strengthLevels = THINKING_LEVELS.filter(level => level !== 'adaptive' && supportedLevels?.includes(level));
  const resolved = resolveThinkingPreference(value, supportedLevels);
  const displayLevel = resolved ? THINKING_LABELS[resolved] : '自动';
  const index = Math.max(0, strengthLevels.indexOf(resolved || 'medium'));
  const minIndex = 0, maxIndex = Math.max(0, strengthLevels.length - 1);
  const sliderIndex = Math.min(maxIndex, index);
  const progress = maxIndex ? sliderIndex / maxIndex * 100 : 0;
  const rootRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 12, top: 12 });
  const pickerId = useId();
  const openMenu = () => {
    if (disabled) return;
    setOpen(true);
  };
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const place = () => {
      const root = rootRef.current?.getBoundingClientRect(), menu = menuRef.current?.getBoundingClientRect();
      if (!root || !menu) return;
      const above = root.top - menu.height - 8;
      const top = Math.max(12, above >= 12 ? above : root.bottom + menu.height + 8 <= window.innerHeight - 12 ? root.bottom + 8 : window.innerHeight - menu.height - 12);
      setMenuPosition({ left: Math.max(12, Math.min(root.right - menu.width, window.innerWidth - menu.width - 12)), top });
    };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [menuOpen, value, supportedLevels]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menuOpen]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (menuOpen) {
      if (sliderRef.current && !sliderRef.current.disabled) sliderRef.current.focus();
      else menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    }
  }, [menuOpen]);
  const choose = (nextIndex: number) => {
    if (disabled) return;
    const level = strengthLevels[Math.min(strengthLevels.length - 1, Math.max(0, Math.round(nextIndex)))];
    if (level && supportedLevels?.length && !supportedLevels.includes(level)) {
      return;
    }
    if (level && level !== value) onChange(level);
  };
  const closeAndFocus = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const handleSliderKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault(); choose(Math.min(maxIndex, index + 1));
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault(); choose(Math.max(minIndex, index - 1));
    } else if (event.key === 'Home') {
      event.preventDefault(); choose(minIndex);
    } else if (event.key === 'End') {
      event.preventDefault(); choose(maxIndex);
    } else if (event.key === 'Enter') {
      event.preventDefault(); closeAndFocus();
    }
  };
  return <div className={`thinking-level-picker${resolved === 'ultra' ? ' is-ultra' : ''}${resolved === 'adaptive' ? ' is-adaptive' : ''}`} ref={rootRef} style={{ '--thinking-progress': `${progress}%`, '--thinking-available': '100%' } as React.CSSProperties}>
    <button ref={triggerRef} type="button" className="thinking-level-trigger" disabled={disabled}
      aria-haspopup="dialog" aria-expanded={menuOpen} aria-controls={menuOpen ? `${pickerId}-menu` : undefined} aria-label={`思考强度：${displayLevel}`} title={`思考强度：${displayLevel}${value === 'auto' ? '（自动选择最高支持档位）' : ''}`}
      onClick={() => open ? setOpen(false) : openMenu()}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openMenu(); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); openMenu(); }
        else if (event.key === 'Escape') setOpen(false);
      }}>
      <strong>{displayLevel}</strong><IconChevron size={13} />
    </button>
    {menuOpen && createPortal(<div ref={menuRef} id={`${pickerId}-menu`} className={`thinking-level-menu${resolved === 'ultra' ? ' is-ultra' : ''}${resolved === 'adaptive' ? ' is-adaptive' : ''}`} role="dialog" aria-label="思考强度"
      style={{ ...menuPosition, '--thinking-progress': `${progress}%`, '--thinking-available': '100%' } as React.CSSProperties}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeAndFocus(); } }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null) && !rootRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
      {resolved && <div className="thinking-level-heading"><strong>{displayLevel}</strong>
        <button type="button" className="thinking-level-reset" aria-label="恢复默认思考强度" title="恢复自适应最高" disabled={disabled || value === 'auto'}
          onClick={() => { onChange('auto'); sliderRef.current?.focus(); }}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M3 7a5 5 0 1 1 .9 4M3 2v5h5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>}
      <div className="thinking-level-modes">
        <button type="button" className="thinking-level-auto" aria-pressed={value === 'auto'} disabled={disabled} onClick={() => onChange('auto')}>自适应最高</button>
        {supportedLevels?.includes('adaptive') && <button type="button" className="thinking-level-adaptive" aria-pressed={value === 'adaptive'} title="由模型自动决定强度" disabled={disabled} onClick={() => onChange('adaptive')}>模型自适应</button>}
      </div>
      {strengthLevels.length > 1 && <div className="thinking-level-slider-wrap">
        {resolved === 'ultra' && <div className="thinking-level-particles" aria-hidden="true">{Array.from({ length: 9 }, (_, particle) => <i key={particle} />)}</div>}
        <input ref={sliderRef} className="thinking-level-slider" type="range" min={0} max={maxIndex} step={1} value={sliderIndex}
          aria-label="思考强度" aria-valuetext={displayLevel} aria-describedby={`${pickerId}-hint`} disabled={disabled}
          onChange={event => choose(Number(event.target.value))} onKeyDown={handleSliderKeyDown} />
        <div className="thinking-level-ticks">{strengthLevels.map((level, tick) => <button type="button" key={level} data-thinking-level={level} disabled={disabled} aria-label={`选择${THINKING_LABELS[level]}思考强度`} aria-pressed={level===resolved} title={THINKING_LABELS[level]} className={`${level === resolved ? 'is-current' : tick < sliderIndex ? 'is-filled' : ''}`} onClick={()=>choose(tick)}><span/></button>)}</div>
      </div>}
      {strengthLevels.length > 0 ? <p className="thinking-level-supported">当前可选：{strengthLevels.map(level => THINKING_LABELS[level]).join(' · ')}</p> : <p className="thinking-level-supported">{supportedLevels?.includes('adaptive') ? '由模型自动决定思考强度。' : '尚未确认模型档位，沿用模型默认。'}</p>}
      <span id={`${pickerId}-hint`} className="thinking-level-note">支持程度取决于模型，调整立即保存，对下一轮生效。</span>
    </div>, document.body)}
  </div>;
}
