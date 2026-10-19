import ClawHubDescription from './ClawHubDescription';
import { useEffect, useRef, useState } from 'react';
import { fetchClawHubSkill, searchClawHub } from '../lib/api';
import type { ClawHubDetail, ClawHubSearch, ClawHubSkill } from '../lib/api';
import { IconSearch, IconSkills, IconStar } from './icons';
import { Sk } from './Skeleton';
import { favoriteAsSkill, isSkillFavorite, removeSkillFavorite, toggleSkillFavorite, useSkillFavorites } from '../lib/skillFavorites';
import { clawHubStatItems, formatClawHubStatLine } from '../lib/clawHubStats';
import type { SkillFavorite } from '../lib/skillFavorites';
import { showToast } from '../lib/toast';
import '../styles/clawhub.css';

function officialUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'clawhub.ai' && !url.username && !url.password && !url.port
      ? url.href : undefined;
  } catch { return undefined; }
}

function dateLabel(value: number | null): string {
  if (!value || !Number.isFinite(value)) return '未提供';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未提供' : date.toLocaleDateString('zh-CN');
}

export default function ClawHubPanel() {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<ClawHubSearch | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<ClawHubSkill | null>(null);
  const [detail, setDetail] = useState<ClawHubDetail | null>(null);
  const [detailPending, setDetailPending] = useState(false);
  const [detailError, setDetailError] = useState('');
  const searchRequest = useRef<AbortController | null>(null);
  const detailRequest = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const favorites = useSkillFavorites();
  const detailStats = clawHubStatItems(detail?.skill.stats);

  /** Bookmarks the public metadata only; a failed local save never fakes a saved state. */
  const toggleFavorite = (skill: ClawHubSkill) => {
    const wasFavorite = isSkillFavorite(skill.id);
    if (!toggleSkillFavorite(skill)) {
      showToast(wasFavorite ? '取消收藏未能保存到本机' : '收藏未能保存到本机（浏览器存储不可用）', 'error');
      return;
    }
    showToast(wasFavorite ? `已取消收藏 ${skill.displayName}` : `已收藏 ${skill.displayName}，可在“我的收藏”里找回。`, wasFavorite ? 'info' : 'success');
  };

  const removeFavorite = (item: SkillFavorite) => {
    if (removeSkillFavorite(item.id)) showToast(`已取消收藏 ${item.displayName}`, 'info');
    else showToast('取消收藏未能保存到本机', 'error');
  };

  const favoriteButton = (skill: ClawHubSkill, extraClass = '') => {
    const on = isSkillFavorite(skill.id);
    return <button type="button" className={`btn btn-sm clawhub-fav${on ? ' is-on' : ''}${extraClass}`} aria-pressed={on}
      aria-label={on ? `取消收藏 ${skill.displayName}` : `收藏 ${skill.displayName}`}
      title={on ? '取消收藏' : '收藏（只保存公开信息）'} onClick={() => toggleFavorite(skill)}>
      <IconStar size={14} filled={on} />{on ? '已收藏' : '收藏'}
    </button>;
  };

  useEffect(() => () => {
    searchRequest.current?.abort();
    detailRequest.current?.abort();
  }, []);
  useEffect(() => { if (selected) heading.current?.focus(); }, [selected]);

  const closeDetail = () => {
    detailRequest.current?.abort();
    setSelected(null); setDetail(null); setDetailError(''); setDetailPending(false);
    opener.current?.focus();
  };

  const search = async () => {
    const term = query.trim();
    if (!term) { setError('请输入要查找的技能或用途。'); return; }
    searchRequest.current?.abort();
    detailRequest.current?.abort();
    const request = new AbortController();
    searchRequest.current = request;
    setPending(true); setError(''); setResult(null); setSelected(null); setDetail(null);
    try {
      const response = await searchClawHub(term, request.signal);
      if (!request.signal.aborted) setResult(response);
    } catch (reason) {
      if (!request.signal.aborted) setError(reason instanceof Error ? reason.message : 'ClawHub 暂时无法访问，请重试。');
    } finally {
      if (!request.signal.aborted) setPending(false);
    }
  };

  const openDetail = async (skill: ClawHubSkill, retry = false) => {
    detailRequest.current?.abort();
    const request = new AbortController();
    detailRequest.current = request;
    if (!retry) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelected(skill); setDetail(null); setDetailError(''); setDetailPending(true);
    try {
      const response = await fetchClawHubSkill(skill, request.signal);
      if (!request.signal.aborted) setDetail(response);
    } catch (reason) {
      if (!request.signal.aborted) setDetailError(reason instanceof Error ? reason.message : '技能详情读取失败，请重试。');
    } finally {
      if (!request.signal.aborted) setDetailPending(false);
    }
  };

  return <div className="clawhub-panel">
    <form className="clawhub-search" role="search" aria-label="检索 ClawHub 技能" onSubmit={event => { event.preventDefault(); void search(); }}>
      <label htmlFor="clawhub-query">想找什么技能？</label>
      <div className="clawhub-search-row">
        <input id="clawhub-query" className="field" type="search" maxLength={200} placeholder="例如：内容研究、视频字幕、web search" value={query} onChange={event => setQuery(event.target.value)} />
        <button className="btn" type="submit" disabled={pending || !query.trim()}><IconSearch size={15} />{pending ? '搜索中…' : '搜索 ClawHub'}</button>
      </div>
      <p className="clawhub-note">搜索 ClawHub 的公开技能，查看作者说明后可前往官方页面。收藏只保存公开信息，方便下次找回；本页不会安装或运行技能。</p>
    </form>
    {error && <div className="clawhub-error" role="alert">{error}</div>}
    <div role="status" aria-live="polite" className="clawhub-result-status">
      {pending ? '正在检索 ClawHub…' : result ? `“${result.query}” · 返回 ${result.results.length} 条${result.results.length >= result.limit ? '，可细化关键词继续查找' : ''}${result.cacheHit ? ' · 最近缓存' : ''}` : '输入技能名称或描述用途后开始搜索。'}
    </div>

    {pending && <div className="clawhub-grid clawhub-skeleton-grid" aria-hidden="true">{[0,1,2].map(i=><div key={i} className="card clawhub-card is-skeleton"><Sk w="34%" h={12} style={{ marginBottom: 12 }} /><Sk w="52%" h={15} style={{ marginBottom: 8 }} /><Sk w="30%" h={11} style={{ marginBottom: 12 }} /><Sk w="94%" h={11} style={{ marginBottom: 6 }} /><Sk w="70%" h={11} style={{ marginBottom: 12 }} /><Sk w="40%" h={10} /></div>)}</div>}
{favorites.length > 0 && <section className="clawhub-favorites" aria-label="我的收藏">
      <div className="clawhub-favorites-head">
        <h2><IconStar size={15} filled aria-hidden={true} />我的收藏</h2>
        <span>{favorites.length} 个 · 只保存在本机</span>
      </div>
      <div className="clawhub-grid">
        {favorites.map(item => <article key={item.id} className="card clawhub-card">
          <div className="clawhub-card-source"><IconSkills size={17} /><span>ClawHub · 已收藏</span></div>
          <h2>{item.displayName}</h2>
          <p className="clawhub-owner">{item.ownerHandle ? `${item.ownerHandle}/${item.slug}` : item.slug}</p>
          <p className="clawhub-summary">{item.summary || '暂无摘要，查看详情了解用途。'}</p>
          <p className="clawhub-note">版本 {item.version || '未提供'} · 更新 {dateLabel(item.updatedAt)}</p>
          <div className="clawhub-actions">
            <button type="button" className="btn btn-sm" aria-label={`查看 ${item.displayName} 详情`} aria-expanded={selected?.id === item.id} onClick={() => void openDetail(favoriteAsSkill(item))}>查看详情</button>
            <button type="button" className="btn btn-sm" aria-label={`移除收藏 ${item.displayName}`} onClick={() => removeFavorite(item)}>移除收藏</button>
            {officialUrl(item.canonicalUrl) && <a href={officialUrl(item.canonicalUrl)} target="_blank" rel="noopener noreferrer">官方页面 ↗</a>}
          </div>
        </article>)}
      </div>
    </section>}

    {selected && <section className="clawhub-detail card" aria-labelledby="clawhub-detail-title" aria-busy={detailPending} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); closeDetail(); } }}>
      <div className="clawhub-detail-head">
        <h2 id="clawhub-detail-title" ref={heading} tabIndex={-1}>{selected.displayName}</h2>
        <div className="clawhub-detail-actions">{favoriteButton(selected)}<button type="button" className="btn btn-ghost btn-sm" onClick={closeDetail}>关闭详情</button></div>
      </div>
      {detailPending && <div className="clawhub-detail-skeleton" role="status"><span className="sr-only">正在读取作者说明…</span><Sk w="46%" h={15} style={{ marginBottom: 10 }} /><Sk w="30%" h={11} style={{ marginBottom: 16 }} /><div className="clawhub-skeleton-row"><Sk w={84} h={12} /><Sk w={84} h={12} /><Sk w={84} h={12} /></div><Sk w="100%" h={11} style={{ marginBottom: 8 }} /><Sk w="100%" h={11} style={{ marginBottom: 8 }} /><Sk w="88%" h={11} style={{ marginBottom: 8 }} /><Sk w="62%" h={11} /></div>}
      {detailError && <div role="alert" className="clawhub-error">{detailError} <button type="button" className="btn btn-sm" onClick={() => void openDetail(selected, true)}>重试详情</button></div>}
      {detail && <>
        <dl className="clawhub-metadata">
          <div><dt>作者</dt><dd>{detail.owner.handle || '未提供'}</dd></div>
          <div><dt>版本</dt><dd>{detail.latestVersion?.version || detail.skill.version || '未提供'}</dd></div>
          <div><dt>更新</dt><dd>{dateLabel(detail.skill.updatedAt)}</dd></div>
        </dl>
        {detailStats.length > 0 && <p className="clawhub-stats">{detailStats.map(item => <span key={item.key}>{item.label} {item.text}</span>)}</p>}
        {(detail.moderation?.isMalwareBlocked || detail.moderation?.isSuspicious) && <div className="clawhub-error" role="note">
          {detail.moderation.isMalwareBlocked ? 'ClawHub 标记：已阻止的技能。' : 'ClawHub 标记：该技能存在可疑内容。'} {detail.moderation.summary}
        </div>}
        <h3>作者说明</h3>
        <ClawHubDescription text={detail.skill.description} fallback={detail.skill.summary} />
        {detail.skill.descriptionTruncated && <p className="clawhub-note">说明较长，完整内容请查看官方页面。</p>}
        {detail.latestVersion?.changelog && <details><summary>版本更新说明</summary><div className="clawhub-description">{detail.latestVersion.changelog}</div></details>}
        {detail.skill.topics?.length > 0 && <p className="clawhub-note">标签：{detail.skill.topics.join(' · ')}</p>}
        <p className="clawhub-note">外部技能尚未在 Easel 中验证，同名本地技能不代表同一作者或版本。</p>
        {officialUrl(detail.skill.canonicalUrl) && <a className="btn btn-sm" href={officialUrl(detail.skill.canonicalUrl)} target="_blank" rel="noopener noreferrer">在 ClawHub 查看 ↗</a>}
      </>}
    </section>}

    {result && result.results.length === 0 && <div className="empty-state"><IconSearch size={32} /><p>没有找到匹配技能，试试更短的关键词或英文名称。</p></div>}
    {result && result.results.length > 0 && <div className="clawhub-grid">
      {result.results.map(skill => <article key={skill.id} className="card clawhub-card">
        <div className="clawhub-card-source"><IconSkills size={17} /><span>ClawHub · 外部技能</span></div>
        <h2>{skill.displayName}</h2>
        <p className="clawhub-owner">{skill.ownerHandle ? `${skill.ownerHandle}/${skill.slug}` : skill.slug}</p>
        <p className="clawhub-summary">{skill.summary || '暂无摘要，查看详情了解用途。'}</p>
        {formatClawHubStatLine(skill.stats, ['downloads', 'comments']) && <p className="clawhub-stats is-compact">{formatClawHubStatLine(skill.stats, ['downloads', 'comments'])}</p>}
        <p className="clawhub-note">版本 {skill.version || '未提供'} · 更新 {dateLabel(skill.updatedAt)}</p>
        <div className="clawhub-actions">
          {favoriteButton(skill)}
          <button type="button" className="btn btn-sm" aria-label={`查看 ${skill.displayName} 详情`} aria-expanded={selected?.id === skill.id} onClick={() => void openDetail(skill)}>查看详情</button>
          {officialUrl(skill.canonicalUrl) && <a href={officialUrl(skill.canonicalUrl)} target="_blank" rel="noopener noreferrer">官方页面 ↗</a>}
        </div>
      </article>)}
    </div>}
  </div>;
}
