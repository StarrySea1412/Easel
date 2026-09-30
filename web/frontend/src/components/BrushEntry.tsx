import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CAPABILITY_MENU } from '../lib/capabilityMenu';
import { fetchSkills } from '../lib/api';
import type { SkillItem } from '../lib/api';
import { displayName } from '../lib/skillDisplayNames';
import SkillGuidePreview from './SkillGuidePreview';
import '../styles/skill-picker.css';

interface BrushEntryProps {
  selectedSkills: string[];
  onPick: (text: string, skill: string, example?: boolean) => void;
  onRemove: (skill: string) => void;
}

/** Choose installed skills while keeping their actual SKILL.md guide in view. */
export default function BrushEntry({ selectedSkills, onPick, onRemove }: BrushEntryProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState(0);
  const [q, setQ] = useState('');
  const [skills, setSkills] = useState<SkillItem[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [position, setPosition] = useState({ left: 12, top: 12, width: 860, height: 560 });
  const popupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const panelId = useId();
  const gradientId = useId();

  function close() { setOpen(false); triggerRef.current?.focus(); }

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setLoadError('');
    setSkills(null);
    fetchSkills().then((data) => { if (!stale) setSkills(data); })
      .catch((error) => { if (!stale) setLoadError(error instanceof Error ? error.message : '技能列表读取失败'); });
    searchRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!popupRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      stale = true;
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, reload]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      if (!trigger) return;
      const width = Math.min(900, document.documentElement.clientWidth - 24);
      const height = Math.min(600, window.innerHeight - 24);
      setPosition({ left: Math.max(12, Math.min(trigger.left, document.documentElement.clientWidth - width - 12)), top: Math.max(12, Math.min(trigger.top - height - 10, window.innerHeight - height - 12)), width, height });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  const installed = useMemo(() => new Map((skills || []).map((skill) => [skill.name, skill])), [skills]);
  const knownNames = useMemo(() => new Set(CAPABILITY_MENU.tabs.flatMap((entry) => entry.groups.flatMap((group) => group.items.map((item) => item.skill)))), []);
  const tabs = useMemo(() => [...CAPABILITY_MENU.tabs.map((entry) => ({ id: entry.id, label: entry.label, groups: entry.groups.map((group) => ({ label: group.label, skills: group.items.flatMap((item) => item.skill && installed.has(item.skill) ? [installed.get(item.skill)!] : []) })) })), {
    id: 'installed-extra', label: '更多已安装', groups: [{ label: '本机其他技能', skills: (skills || []).filter((skill) => !knownNames.has(skill.name)) }],
  }], [installed, skills, knownNames]);
  const query = q.trim().toLowerCase();
  const groups = (query ? tabs.flatMap((entry) => entry.groups) : tabs[tab]?.groups || []).map((group) => ({ ...group, skills: group.skills.filter((skill) => !query || `${skill.name} ${displayName(skill.name)} ${skill.description}`.toLowerCase().includes(query)) })).filter((group) => group.skills.length);

  function pick(skill: SkillItem) {
    if (selectedSkills.includes(skill.name)) onRemove(skill.name);
    else onPick(`帮我做「${displayName(skill.name)}」`, skill.name);
    setPreview(skill.name);
  }

  return <div className={`brush-entry${open ? ' open' : ''}`}>
    <button ref={triggerRef} type="button" className="brush-btn" onClick={() => setOpen((value) => !value)} aria-label="选择创作技能" title="选择创作技能" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#8adfce" /><stop offset="1" stopColor="#2f6fae" /></linearGradient></defs><g transform="rotate(45 12 12)"><rect x="11.15" y="1.6" width="1.7" height="10" rx=".85" fill={`url(#${gradientId})`} /><rect x="10.6" y="11.5" width="2.8" height="1.75" rx=".6" fill="#b9e3d9" /><path d="M10.7 13.2 C9.95 16.6 10.2 19.9 11.95 22.6 C13.7 19.9 13.95 16.6 13.2 13.2 Z" fill="#2f6fae" /></g></svg>
      <span className="brush-mark" aria-hidden="true" /><span className="brush-tip">看看能做什么</span>
    </button>
    {open && createPortal(<div ref={popupRef} id={panelId} className="brush-panel skill-picker" role="dialog" aria-label="选择创作技能" style={position}>
      <div className="brush-panel-head"><div className="brush-panel-headline"><div className="brush-panel-title">能做的都在这</div><div className="brush-panel-sub">可多选 · 悬停或聚焦看详细说明 · 已选技能会保留在创作框</div></div><button type="button" className="brush-close" onClick={close} aria-label="关闭技能选择">×</button></div>
      <div className="skill-picker-toolbar"><input ref={searchRef} className="brush-search" placeholder="搜索已安装技能…" aria-label="搜索创作技能" value={q} onChange={(event) => setQ(event.target.value)} /><span>{skills ? `${skills.length} 个已安装` : '正在读取本机技能'}</span></div>
      <div className="brush-tabs">{tabs.map((entry, index) => <button type="button" key={entry.id} className={`brush-tab${index === tab && !query ? ' on' : ''}`} aria-pressed={index === tab && !query} onClick={() => { setTab(index); setQ(''); }}>{entry.label}</button>)}</div>
      <div className="skill-picker-content"><div className="brush-body" aria-label="可选技能">
        {loadError ? <div className="skill-picker-empty" role="alert">{loadError}<button className="link-btn" type="button" onClick={() => setReload((value) => value + 1)}>重新加载</button></div> : !skills ? <p className="skill-picker-empty" role="status">正在确认已安装的技能…</p> : !groups.length ? <p className="skill-picker-empty">{query ? `没有匹配「${q}」的已安装技能` : '当前分类暂无已安装技能'}</p> : groups.map((group) => <div key={group.label} className="brush-grp"><div className="brush-grp-name">{group.label} · {group.skills.length}</div>{group.skills.map((skill) => {
          const selected = selectedSkills.includes(skill.name);
          const needsSetup = skill.needsApi && !skill.apiConfigured;
          return <button key={skill.name} type="button" className={`brush-item${selected ? ' is-selected' : ''}${preview === skill.name ? ' is-previewed' : ''}`} aria-pressed={selected} onMouseEnter={() => setPreview(skill.name)} onFocus={() => setPreview(skill.name)} onClick={() => pick(skill)}><span className={`brush-dot ${needsSetup ? 's-need' : 's-ready'}`} aria-hidden="true" /><span className="brush-item-copy"><span className="brush-il">{displayName(skill.name)}</span><span className="brush-idesc">{skill.description || skill.name}</span>{needsSetup && <span className="brush-needs">需要配置 API</span>}</span><span className="brush-iadd" aria-hidden="true">{selected ? '✓' : '＋'}</span></button>;
        })}</div>)}
      </div><SkillGuidePreview skillName={preview && installed.has(preview) ? preview : null} onPick={(text, skill) => { if (installed.has(skill)) { onPick(text, skill, true); close(); } }} /></div>
      <footer className="skill-picker-footer"><span>已选 {selectedSkills.length} 个 · 点击已选项可移除</span><button type="button" className="btn btn-primary btn-sm" onClick={close}>完成选择</button></footer>
    </div>, document.body)}
  </div>;
}
