import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CAPABILITY_MENU } from '../lib/capabilityMenu';
import { fetchClawHubSkill, fetchSkills, searchClawHub } from '../lib/api';
import type { ClawHubDetail, ClawHubSearch, ClawHubSkill, SkillItem } from '../lib/api';
import { displayName } from '../lib/skillDisplayNames';
import SkillGuidePreview from './SkillGuidePreview';
import SkillDependencyBadges from './SkillDependencyBadges';
import { IconSpark } from './icons';
import '../styles/skill-picker.css';

interface BrushEntryProps {
  openRequest?: number;
  compact?: boolean;
  selectedSkills: string[];
  onPick: (text: string, skill: string, example?: boolean) => void;
  onRemove: (skill: string) => void;
}

/** Choose installed skills while keeping their actual SKILL.md guide in view. */
export default function BrushEntry({ selectedSkills, onPick, onRemove, compact = false, openRequest = 0 }: BrushEntryProps) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<'installed' | 'clawhub'>('installed');
  const [tab, setTab] = useState(0);
  const [q, setQ] = useState('');
  const [skills, setSkills] = useState<SkillItem[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [clawQuery, setClawQuery] = useState('');
  const [clawResult, setClawResult] = useState<ClawHubSearch | null>(null);
  const [clawPending, setClawPending] = useState(false);
  const [clawError, setClawError] = useState('');
  const [clawSelected, setClawSelected] = useState<ClawHubSkill | null>(null);
  const [clawDetail, setClawDetail] = useState<ClawHubDetail | null>(null);
  const [clawDetailPending, setClawDetailPending] = useState(false);
  const [clawDetailError, setClawDetailError] = useState('');
  const [reload, setReload] = useState(0);
  const [position, setPosition] = useState({ left: 12, top: 12, width: 860, height: 560 });
  const popupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const clawSearchRequest = useRef<AbortController | null>(null);
  const clawDetailRequest = useRef<AbortController | null>(null);
  const clawDetailOpener = useRef<HTMLElement | null>(null);
  const clawRestoreFocus = useRef(false);
  const clawDetailHeading = useRef<HTMLHeadingElement>(null);
  const panelId = useId();
  const gradientId = useId();

  function abortClawRequests() {
    clawSearchRequest.current?.abort();
    clawDetailRequest.current?.abort();
  }

  function close() { abortClawRequests(); setClawPending(false); setClawDetailPending(false); setOpen(false); triggerRef.current?.focus(); }
  useEffect(() => { if (openRequest) setOpen(true); }, [openRequest]);

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
      if (!popupRef.current?.contains(target) && !triggerRef.current?.contains(target)) { abortClawRequests(); setClawPending(false); setClawDetailPending(false); setOpen(false); }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      stale = true;
      abortClawRequests();
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, reload]);

  useEffect(() => {
    if (clawSelected) clawDetailHeading.current?.focus();
    else if (clawRestoreFocus.current) { clawRestoreFocus.current = false; clawDetailOpener.current?.focus(); }
  }, [clawSelected]);

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

  function resetClawHub() {
    abortClawRequests();
    setClawQuery(''); setClawResult(null); setClawPending(false); setClawError('');
    setClawSelected(null); setClawDetail(null); setClawDetailPending(false); setClawDetailError('');
  }

  async function searchClawHubSkills() {
    const term = clawQuery.trim();
    if (!term) { setClawError('请输入要查找的技能或用途。'); return; }
    clawSearchRequest.current?.abort();
    clawDetailRequest.current?.abort();
    const request = new AbortController();
    clawSearchRequest.current = request;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; request.abort(); }, 10000);
    setClawPending(true); setClawError(''); setClawResult(null); setClawSelected(null); setClawDetail(null); setClawDetailPending(false); setClawDetailError('');
    try {
      const response = await searchClawHub(term, request.signal);
      if (!request.signal.aborted) setClawResult(response);
    } catch (reason) {
      if (!request.signal.aborted || timedOut) setClawError(timedOut ? 'ClawHub 检索超时，请稍后重试。' : reason instanceof Error ? reason.message : 'ClawHub 暂时无法访问，请重试。');
    } finally {
      window.clearTimeout(timeout);
      if (!request.signal.aborted || timedOut) setClawPending(false);
    }
  }

  async function openClawHubDetail(skill: ClawHubSkill, retry = false) {
    clawDetailRequest.current?.abort();
    const request = new AbortController();
    clawDetailRequest.current = request;
    if (!retry) clawDetailOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; request.abort(); }, 8000);
    setClawSelected(skill); setClawDetail(null); setClawDetailError(''); setClawDetailPending(true);
    try {
      const response = await fetchClawHubSkill(skill, request.signal);
      if (!request.signal.aborted) setClawDetail(response);
    } catch (reason) {
      if (!request.signal.aborted || timedOut) setClawDetailError(timedOut ? '详情读取超时，请重试。' : reason instanceof Error ? reason.message : '技能详情读取失败，请重试。');
    } finally {
      window.clearTimeout(timeout);
      if (!request.signal.aborted || timedOut) setClawDetailPending(false);
    }
  }

  function closeClawHubDetail() {
    clawDetailRequest.current?.abort();
    clawRestoreFocus.current = true;
    setClawSelected(null); setClawDetail(null); setClawDetailError(''); setClawDetailPending(false);
  }

  function clawHubUrl(value: string | null | undefined): string | undefined {
    if (!value) return undefined;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 'clawhub.ai' && !url.username && !url.password && !url.port ? url.href : undefined;
    } catch { return undefined; }
  }

  function clawHubDate(value: number | null): string {
    if (!value || !Number.isFinite(value)) return '未提供';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '未提供' : date.toLocaleDateString('zh-CN');
  }

  return <div className={`brush-entry${open ? ' open' : ''}`}>
    <button ref={triggerRef} type="button" className={compact ? 'composer-skill-button' : 'brush-btn'} onClick={() => { if (open) close(); else setOpen(true); }} aria-label="选择创作技能" title={selectedSkills.length ? `已选 ${selectedSkills.length} 个创作技能，点击调整` : '选择创作技能'} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined}>
      {compact ? <><IconSpark size={15} /><span className="composer-skill-label">技能</span>{selectedSkills.length > 0 && <span className="composer-skill-count" aria-label={`已选 ${selectedSkills.length} 个技能`}>{selectedSkills.length}</span>}<svg className="composer-skill-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></> : <>
      <svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#8adfce" /><stop offset="1" stopColor="#2f6fae" /></linearGradient></defs><g transform="rotate(45 12 12)"><rect x="11.15" y="1.6" width="1.7" height="10" rx=".85" fill={`url(#${gradientId})`} /><rect x="10.6" y="11.5" width="2.8" height="1.75" rx=".6" fill="#b9e3d9" /><path d="M10.7 13.2 C9.95 16.6 10.2 19.9 11.95 22.6 C13.7 19.9 13.95 16.6 13.2 13.2 Z" fill="#2f6fae" /></g></svg>
      <span className="brush-mark" aria-hidden="true" /><span className="brush-tip">看看能做什么</span>
      </>}
    </button>
    {open && createPortal(<div ref={popupRef} id={panelId} className="brush-panel skill-picker" role="dialog" aria-label="选择创作技能" style={position}>
      <div className="brush-panel-head"><div className="brush-panel-headline"><div className="brush-panel-title">能做的都在这</div><div className="brush-panel-sub">可多选 · 悬停或聚焦看详细说明 · 已选技能会保留在创作框</div></div><button type="button" className="brush-close" onClick={close} aria-label="关闭技能选择">×</button></div>
      <div className="brush-source-tabs" role="tablist" aria-label="技能来源"><button type="button" role="tab" className={`brush-tab${source === 'installed' ? ' on' : ''}`} aria-selected={source === 'installed'} onClick={() => { setSource('installed'); resetClawHub(); searchRef.current?.focus(); }}>本机已安装</button><button type="button" role="tab" className={`brush-tab${source === 'clawhub' ? ' on' : ''}`} aria-selected={source === 'clawhub'} onClick={() => { setSource('clawhub'); setQ(''); resetClawHub(); window.setTimeout(() => searchRef.current?.focus(), 0); }}>ClawHub</button></div>
      <form className="skill-picker-toolbar" role="search" aria-label={source === 'clawhub' ? '检索 ClawHub 技能' : '搜索已安装技能'} onSubmit={(event) => { event.preventDefault(); if (source === 'clawhub') void searchClawHubSkills(); }}><input ref={searchRef} className="brush-search" placeholder={source === 'clawhub' ? '搜索 ClawHub 技能…' : '搜索已安装技能…'} aria-label={source === 'clawhub' ? '搜索 ClawHub 技能' : '搜索已安装技能'} value={source === 'clawhub' ? clawQuery : q} onChange={(event) => source === 'clawhub' ? setClawQuery(event.target.value) : setQ(event.target.value)} />{source === 'clawhub' ? <button type="submit" className="btn btn-sm brush-search-submit" disabled={clawPending || !clawQuery.trim()}>{clawPending ? '搜索中…' : '搜索'}</button> : <span>{skills ? `${skills.length} 个已安装` : '正在读取本机技能'}</span>}</form>
      {source === 'installed' && <div className="brush-tabs">{tabs.map((entry, index) => <button type="button" key={entry.id} className={`brush-tab${index === tab && !query ? ' on' : ''}`} aria-pressed={index === tab && !query} onClick={() => { setTab(index); setQ(''); }}>{entry.label}</button>)}</div>}
      <div className={`skill-picker-content${source === 'clawhub' ? ' is-clawhub' : ''}${clawSelected ? ' has-detail' : ''}`}><div className="brush-body" aria-label={source === 'clawhub' ? 'ClawHub 搜索结果' : '可选技能'}>
        {source === 'installed' ? (loadError ? <div className="skill-picker-empty" role="alert">{loadError}<button className="link-btn" type="button" onClick={() => setReload((value) => value + 1)}>重新加载</button></div> : !skills ? <p className="skill-picker-empty" role="status">正在确认已安装的技能…</p> : !groups.length ? <p className="skill-picker-empty">{query ? `没有匹配「${q}」的已安装技能` : '当前分类暂无已安装技能'}</p> : groups.map((group) => <div key={group.label} className="brush-grp"><div className="brush-grp-name">{group.label} · {group.skills.length}</div>{group.skills.map((skill) => {
          const selected = selectedSkills.includes(skill.name);
          const needsSetup = skill.needsApi && !skill.apiConfigured;
          return <button key={skill.name} type="button" className={`brush-item${selected ? ' is-selected' : ''}${preview === skill.name ? ' is-previewed' : ''}`} aria-pressed={selected} onMouseEnter={() => setPreview(skill.name)} onFocus={() => setPreview(skill.name)} onClick={() => pick(skill)}><span className={`brush-dot ${needsSetup ? 's-need' : 's-ready'}`} aria-hidden="true" /><div className="brush-item-copy"><span className="brush-il">{displayName(skill.name)}</span><span className="brush-idesc">{skill.description || skill.name}</span><div className="brush-item-meta">{needsSetup && <span className="brush-needs">需要配置 API</span>}<SkillDependencyBadges skill={skill} /></div></div><span className="brush-iadd" aria-hidden="true">{selected ? '✓' : '＋'}</span></button>;
        })}</div>)) : (clawError ? <div className="skill-picker-empty" role="alert">{clawError}<button className="link-btn" type="button" onClick={() => void searchClawHubSkills()}>重新搜索</button></div> : clawPending ? <p className="skill-picker-empty" role="status">正在检索 ClawHub…</p> : !clawResult ? <p className="skill-picker-empty">输入技能名称或用途后，点击搜索 ClawHub。</p> : !clawResult.results.length ? <p className="skill-picker-empty">没有找到匹配「{clawResult.query}」的 ClawHub 技能，试试更短的关键词。</p> : clawResult.results.map((skill) => <article key={skill.id} className="brush-clawhub-item"><div className="brush-clawhub-source">ClawHub · 外部技能</div><button type="button" className="brush-clawhub-open" aria-label={`查看 ${skill.displayName} 详情`} onClick={() => void openClawHubDetail(skill)}><strong>{skill.displayName}</strong><span>{skill.ownerHandle ? `${skill.ownerHandle}/${skill.slug}` : skill.slug}</span><p>{skill.summary || '暂无摘要，查看详情了解用途。'}</p><small>版本 {skill.version || '未提供'} · 更新 {clawHubDate(skill.updatedAt)}</small></button><div className="brush-clawhub-actions">{clawHubUrl(skill.canonicalUrl) && <a href={clawHubUrl(skill.canonicalUrl)} target="_blank" rel="noopener noreferrer">官方页面 ↗</a>}<span>仅查看，不会安装</span></div></article>))}
      </div>{source === 'installed' ? <SkillGuidePreview skillName={preview && installed.has(preview) ? preview : null} onPick={(text, skill) => { if (installed.has(skill)) { onPick(text, skill, true); close(); } }} /> : <section className="brush-guide brush-clawhub-detail" aria-label="ClawHub 技能详情" aria-busy={clawDetailPending} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeClawHubDetail(); } }}>{clawSelected ? <><header><div className="brush-clawhub-detail-head"><h3 ref={clawDetailHeading} tabIndex={-1}>{clawSelected.displayName}</h3><button type="button" className="brush-close" onClick={closeClawHubDetail} aria-label="关闭 ClawHub 详情">×</button></div><code>{clawSelected.ownerHandle ? `${clawSelected.ownerHandle}/${clawSelected.slug}` : clawSelected.slug}</code></header>{clawDetailPending && <p role="status">正在读取作者说明…</p>}{clawDetailError && <div className="brush-guide-error" role="alert">{clawDetailError}<button type="button" className="link-btn" onClick={() => void openClawHubDetail(clawSelected, true)}>重试详情</button></div>}{clawDetail && <><dl className="brush-clawhub-meta"><div><dt>作者</dt><dd>{clawDetail.owner.displayName || clawDetail.owner.handle || '未提供'}</dd></div><div><dt>版本</dt><dd>{clawDetail.latestVersion?.version || clawSelected.version || '未提供'}</dd></div><div><dt>更新</dt><dd>{clawHubDate(clawDetail.latestVersion?.createdAt || clawSelected.updatedAt)}</dd></div></dl><h4>作者说明</h4><p>{clawDetail.skill.description || clawDetail.skill.summary || '作者未提供说明。'}</p>{clawDetail.latestVersion?.changelog && <details><summary>版本更新说明</summary><p>{clawDetail.latestVersion.changelog}</p></details>}{clawDetail.skill.topics?.length > 0 && <p className="brush-guide-muted">标签：{clawDetail.skill.topics.join(' · ')}</p>} {(clawDetail.moderation?.isMalwareBlocked || clawDetail.moderation?.isSuspicious) && <div className="brush-guide-error">ClawHub 标记：{clawDetail.moderation.isMalwareBlocked ? '已阻止的技能。' : '该技能存在可疑内容。'} {clawDetail.moderation.summary}</div>}<p className="brush-guide-muted">外部技能尚未在 Easel 中验证，同名本地技能不代表同一作者或版本。</p>{clawHubUrl(clawDetail.skill.canonicalUrl) && <a className="btn btn-sm" href={clawHubUrl(clawDetail.skill.canonicalUrl)} target="_blank" rel="noopener noreferrer">在 ClawHub 查看 ↗</a>}</>}</> : <p className="brush-guide-empty"><strong>选择一个 ClawHub 技能</strong><span>这里只读取公开信息，不会安装或运行外部技能。</span></p>}</section>} </div>
      <footer className="skill-picker-footer"><span>已选 {selectedSkills.length} 个 · {selectedSkills.length ? '点击已选项可移除' : '点击技能添加，预览不算选中'}</span><button type="button" className="btn btn-primary btn-sm" disabled={!selectedSkills.length} onClick={() => { if (selectedSkills.length) close(); }}>完成选择</button></footer>
    </div>, document.body)}
  </div>;
}
