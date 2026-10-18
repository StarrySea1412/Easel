import { useState, useEffect, useMemo, useRef } from 'react';
import type { ComponentType } from 'react';
import { fetchSkills, fetchSkillMeta, saveSkillMeta, classifySkills } from '../lib/api';
import type { SkillItem, SkillMetaEntry, SkillMetaState, SkillClassifyResult } from '../lib/api';
import SkillDrawer from './SkillDrawer';
import ClawHubPanel from './ClawHubPanel';
import RadioGroup from './ui/RadioGroup';
import SkillDependencyBadges from './SkillDependencyBadges';
import { displayName } from '../lib/skillDisplayNames';
import { showToast } from '../lib/toast';
import { Sk } from './Skeleton';
import {
  IconSearch, IconCompass, IconSkills, IconSend, IconChart, IconLayers,
  IconVideo, IconImage, IconMusic, IconMic, IconText, IconLayout, IconProfile, IconOutputs,
} from './icons';

interface SkillPageProps {
  onOpenChat: (skill: string, input: string) => boolean;
  initialSkill?: string;
}

type IconC = ComponentType<{ size?: number }>;
type LayerMeta = { key: string; label: string; Icon: IconC; color: string };

const LAYERS: LayerMeta[] = [
  { key: 'discover', label: '发现', Icon: IconSearch, color: 'var(--layer-discover)' },
  { key: 'plan', label: '策划', Icon: IconCompass, color: 'var(--layer-plan)' },
  { key: 'produce', label: '制作', Icon: IconSkills, color: 'var(--layer-produce)' },
  { key: 'publish', label: '发布', Icon: IconSend, color: 'var(--layer-publish)' },
  { key: 'attribute', label: '归因', Icon: IconChart, color: 'var(--layer-attribute)' },
  { key: 'general', label: '通用', Icon: IconLayers, color: 'var(--layer-general)' },
];
const LAYER_META: Record<string, LayerMeta> = Object.fromEntries(LAYERS.map((l) => [l.key, l]));
const OTHER: LayerMeta = { key: 'other', label: '其他', Icon: IconLayers, color: 'var(--layer-general)' };

// 按 skill 名关键词映射线性图标（无匹配退回层图标）
function iconFor(name: string, LayerIcon: IconC): IconC {
  const n = name.toLowerCase();
  const map: [RegExp, IconC][] = [
    [/video|clip|reframe|highlight|beat|slideshow|intro|chapter/, IconVideo],
    [/image|img|photo|poster|infographic|comparison|meme|remove-bg|green-screen|enhance/, IconImage],
    [/music|audio|bgm|mix|denoise/, IconMusic],
    [/voice|tts|clone|subtitle/, IconMic],
    [/card|xhs|xiaohongshu|note/, IconLayout],
    [/copy|writ|text|polish|condens|style|format|content/, IconText],
    [/chart|data|report|roi|analy|insight|scor/, IconChart],
    [/publish|upload|wechat|zhihu|bilibili|douyin|kuaishou|channel/, IconSend],
    [/rss|trend|news|discover|ugc|competitor|hot/, IconSearch],
    [/profile|persona|brand|position|audience/, IconProfile],
    [/schedul|calendar|plan|strategy|campaign|matrix/, IconCompass],
    [/asset|template|batch|doc|mindmap|link/, IconOutputs],
  ];
  for (const [re, C] of map) if (re.test(n)) return C;
  return LayerIcon;
}

const LAYER_DESC: Record<string, string> = {
  discover: '发现层技能', plan: '策划层技能', produce: '制作层技能',
  publish: '发布层技能', attribute: '归因层技能', general: '通用技能', other: '技能',
};

export default function SkillPage({ onOpenChat, initialSkill }: SkillPageProps) {
  const [skills, setSkills] = useState<SkillItem[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [source, setSource] = useState<'installed' | 'clawhub'>('installed');
  const [meta, setMeta] = useState<SkillMetaState | null>(null);
  const [classify, setClassify] = useState<{ open: boolean; mode: 'rules' | 'ai'; pending: boolean; error: string; result: SkillClassifyResult | null; applying: boolean }>({ open: false, mode: 'rules', pending: false, error: '', result: null, applying: false });
  const classifyRef = useRef<HTMLElement | null>(null);
  useEffect(() => { if (classify.open) classifyRef.current?.focus(); }, [classify.open]);
  const loadMeta = () => fetchSkillMeta().then(setMeta).catch(() => {});
  const metaFor = (name: string): SkillMetaEntry => (meta?.skills?.[name] || {});
  const labelFor = (name: string) => metaFor(name).displayName || displayName(name);
  const categoryLabel = (id?: string | null) => id ? (meta?.categories.find(c => c.id === id)?.label || '') : '';

  const load = () => {
    setError('');
    return fetchSkills().then(value => { if (!Array.isArray(value)) throw new Error('技能目录格式无效'); setSkills(value); }).catch(reason => {
      setSkills([]);
      const message = '技能库加载失败：' + (reason instanceof Error ? reason.message : '请重试');
      setError(message); showToast(message, 'error');
    });
  };
  useEffect(() => { void load(); void loadMeta(); }, []);
  useEffect(() => { if (initialSkill) { setSource('installed'); setSelected(initialSkill); } }, [initialSkill]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills || [];
    return (skills || []).filter((s) => {
      const entry = meta?.skills?.[s.name];
      const description = entry?.description || s.description || '';
      return s.name.toLowerCase().includes(q) || description.toLowerCase().includes(q) || (entry?.displayName || displayName(s.name)).toLowerCase().includes(q);
    });
  }, [skills, query, meta]);

  const grouped = useMemo(() => {
    const g: Record<string, SkillItem[]> = {};
    for (const s of filtered) {
      const key = LAYER_META[s.layer] ? s.layer : 'other';
      (g[key] ||= []).push(s);
    }
    return g;
  }, [filtered]);

  const orderedLayers = [...LAYERS, OTHER].filter((l) => grouped[l.key]?.length);
  const needApiCount = (skills || []).filter((s) => s.needsApi && !s.apiConfigured).length;

  // 左侧分区侧边栏：锚点跳转 + 滚动跟随高亮（页面自身是滚动容器）。
  const pageRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const [activeSection, setActiveSection] = useState('');
  const layerSignature = orderedLayers.map((layer) => layer.key).join('|');
  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const keys = layerSignature ? layerSignature.split('|') : [];
    const update = () => {
      // 用矩形相对页容器计算，不依赖 offsetParent（布局里可能不是滚动容器）。
      const pageTop = page.getBoundingClientRect().top;
      let current = keys[0] || '';
      for (const key of keys) {
        const node = sectionRefs.current[key];
        if (node && node.getBoundingClientRect().top - pageTop <= 96) current = key;
      }
      setActiveSection(current);
    };
    update();
    page.addEventListener('scroll', update, { passive: true });
    return () => page.removeEventListener('scroll', update);
  }, [layerSignature]);
  const runClassify = async (mode: 'rules' | 'ai') => {
    setClassify(value => ({ ...value, mode, pending: true, error: '' }));
    try {
      const items = (skills || []).map(s => ({ name: s.name, description: metaFor(s.name).description || s.description || '' }));
      const result = await classifySkills(mode, items);
      setClassify(value => ({ ...value, pending: false, result }));
    } catch (cause) {
      setClassify(value => ({ ...value, pending: false, result: null, error: cause instanceof Error ? cause.message : '识别失败' }));
    }
  };
  const applyClassify = async () => {
    const suggestions = classify.result?.suggestions || {};
    const entries = Object.entries(suggestions);
    if (!entries.length) return;
    setClassify(value => ({ ...value, applying: true, error: '' }));
    try {
      for (const [name, suggestion] of entries) {
        const current = metaFor(name);
        const tags = [...new Set([...(current.tags || []), ...suggestion.tags])];
        // 合并而非覆盖：已有分类/标签保留，只补齐缺口。
        await saveSkillMeta(name, { tags, categoryId: current.categoryId || suggestion.categoryId || '' });
      }
      await loadMeta();
      setClassify(value => ({ ...value, applying: false, result: null }));
      showToast(`已应用 ${entries.length} 项标签与分类`, 'success');
    } catch (cause) {
      setClassify(value => ({ ...value, applying: false, error: cause instanceof Error ? cause.message : '应用失败' }));
    }
  };
  /** 打开弹层就直接给出离线识别结果（零成本且确定性），需要时再换 AI。 */
  const openClassify = () => {
    setClassify(value => ({ ...value, open: true, mode: 'rules', error: '', result: null }));
    void runClassify('rules');
  };
  const jumpToSection = (key: string) => {
    const node = sectionRefs.current[key];
    const page = pageRef.current;
    setActiveSection(key);
    if (!node || !page) return;
    // “直接跳转”：即时落到目标位置（平滑动画在嵌入/后台环境会被节流推迟）。
    const target = Math.max(0, Math.min(
      page.scrollTop + node.getBoundingClientRect().top - page.getBoundingClientRect().top - 12,
      page.scrollHeight - page.clientHeight));
    page.scrollTop = target;
  };

  const showSectionNav = source === 'installed' && skills !== null && orderedLayers.length > 0;
  const currentSection = activeSection || orderedLayers[0]?.key || '';
  return (
    <div className="skills-page" ref={pageRef}>
      <div className={`skills-layout${showSectionNav ? '' : ' is-single'}`}>
        {showSectionNav && <nav className="skills-section-nav" aria-label="技能分区导航">
          {orderedLayers.map((layer) => (
            <button key={layer.key} type="button" className={`skills-nav-item${currentSection === layer.key ? ' is-active' : ''}`}
              aria-current={currentSection === layer.key ? 'true' : undefined} onClick={() => jumpToSection(layer.key)}>
              <span className="skills-nav-ic" style={{ color: layer.color }}><layer.Icon size={14} /></span>
              <span>{layer.label}</span>
              <small>{grouped[layer.key].length}</small>
            </button>
          ))}
          <button type="button" className="skills-nav-top" onClick={() => { if (pageRef.current) pageRef.current.scrollTop = 0; setActiveSection(orderedLayers[0]?.key || ''); }}>回到顶部 ↑</button>
        </nav>}
        <div className="skills-main">
      <div className="skills-page-head">
        <h1 className="page-title"><IconSkills size={22} aria-hidden={true} />技能库</h1>
        <p className="page-subtitle">
          {source === 'clawhub' ? '从 OpenClaw 的公开技能目录查找更多能力，按作者和版本查看。' : <>
          共 {skills === null ? '…' : skills.length} 个技能，按流水线层分区浏览。点卡片查看说明，带入对话使用；
          标 <span className="badge badge-warn" style={{ padding: '1px 7px' }}>需 API</span> 的需先配置密钥
          {needApiCount > 0 && `（当前 ${needApiCount} 个待配置）`}。
          </>}
        </p>
        <RadioGroup value={source} onChange={value => { setSource(value); setSelected(null); }} aria-label="技能来源" className="skill-sources"
          options={[{ value: 'installed', label: `已安装${skills ? ` · ${skills.length}` : ''}` }, { value: 'clawhub', label: 'ClawHub' }]} />
        {source === 'installed' && <div className="skill-search">
          <span className="skill-search-ic"><IconSearch size={16} /></span>
          <input
            className="field"
            placeholder="搜索技能名或描述…"
            aria-label="搜索已安装技能"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && <button className="btn btn-ghost btn-sm" onClick={() => setQuery('')}>清除</button>}
        </div>}
        {source === 'installed' && <div className="skill-meta-actions">
          <button type="button" className="btn btn-sm" onClick={openClassify}>自动分类</button>
          <span className="skill-meta-note">离线规则零成本；“用 AI 识别”会调用你配置的默认模型。</span>
        </div>}
      </div>

      {classify.open && <div className="drawer-overlay" onClick={() => setClassify(value => ({ ...value, open: false, result: null, error: '' }))}>
        <section className="skill-classify" role="dialog" aria-modal="true" aria-label="自动标签分类" tabIndex={-1} ref={classifyRef}
          onClick={event => event.stopPropagation()}
          onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setClassify(value => ({ ...value, open: false, result: null, error: '' })); } }}>
        <div className="skill-classify-head"><strong>自动标签分类</strong><span>打开即按离线规则识别；“用 AI 识别”会调用你配置的默认模型。</span><button type="button" className="btn btn-sm" onClick={() => setClassify(value => ({ ...value, open: false, result: null, error: '' }))}>关闭</button></div>
        <p className="skill-classify-note">已安装技能的分区（发现 / 策划 / 制作 …）来自各自 SKILL.md，是固定维度；这里生成的是可编辑的标签与分类建议——应用时只补齐缺口，不会覆盖你已手动设置的分类与标签，也不改动 SKILL.md。</p>
        <div className="skill-classify-actions">
          <button type="button" className="btn btn-sm" disabled={classify.pending || classify.applying} onClick={() => void runClassify('rules')}>重新识别（离线规则）</button>
          <button type="button" className="btn btn-sm" disabled={classify.pending || classify.applying} onClick={() => void runClassify('ai')}>用 AI 识别</button>
          {classify.pending && <span role="status">正在识别…</span>}
        </div>
        {classify.error && <p role="alert" className="task-error">{classify.error}</p>}
        {classify.result && <>
          <ul className="skill-classify-list">
            {Object.entries(classify.result.suggestions).map(([name, suggestion]) => <li key={name}>
              <span className="skill-classify-name">{labelFor(name)}</span>
              <span className="skill-tag is-category">{categoryLabel(suggestion.categoryId) || '未分类'}</span>
              {suggestion.tags.map(tag => <span className="skill-tag" key={tag}>{tag}</span>)}
            </li>)}
          </ul>
          <div className="skill-classify-foot"><span>{Object.keys(classify.result.suggestions).length} 项将写入标签与分类（合并）</span><button type="button" className="btn btn-primary btn-sm" disabled={classify.applying} onClick={() => void applyClassify()}>{classify.applying ? '正在应用…' : '应用'}</button></div>
        </>}
        </section>
      </div>}

      {source === 'clawhub' && <ClawHubPanel />}
      {source === 'installed' && <>
      {error && <div role="alert" style={{ color: 'var(--red)', maxWidth: 1100, margin: '16px auto' }}>{error}<button type="button" className="btn btn-sm" onClick={() => void load()}>重新读取</button></div>}

      <div className="skills-body">
        {skills === null && !error && (
          <section>
            <div className="section-title"><Sk w={90} h={14} /></div>
            <div className="skill-grid">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="card skill-card">
                  <Sk w={38} h={38} r="var(--radius-md)" style={{ marginBottom: 12 }} />
                  <Sk w="55%" h={14} style={{ marginBottom: 8 }} />
                  <Sk w="40%" h={10} style={{ marginBottom: 12 }} />
                  <Sk w="95%" h={11} style={{ marginBottom: 7 }} />
                  <Sk w="70%" h={11} />
                </div>
              ))}
            </div>
          </section>
        )}
        {skills !== null && orderedLayers.length === 0 && !error && (
          <div className="empty-state" style={{ height: 240 }}>
            <div className="empty-icon"><IconSearch size={40} /></div>
            <p>没有匹配「{query}」的技能</p>
          </div>
        )}

        {orderedLayers.map((layer) => (
          <section key={layer.key} ref={(node) => { sectionRefs.current[layer.key] = node; }}>
            <div className="section-title">
              <span className="section-ic" style={{ color: layer.color }}><layer.Icon size={15} /></span>
              {layer.label}
              <span style={{ color: 'var(--text-tertiary)', fontWeight: 500 }}>· {grouped[layer.key].length}</span>
            </div>
            <div className="skill-grid">
              {grouped[layer.key].map((s) => {
                const meta = LAYER_META[s.layer] || OTHER;
                const Icon = iconFor(s.name, meta.Icon);
                const alert = s.needsApi && !s.apiConfigured;
                return (
                  <div
                    key={s.name}
                    className="card card-hover skill-card"
                    role="button"
                    tabIndex={0}
                    style={{ ['--layer-color' as string]: meta.color }}
                    onClick={() => setSelected(s.name)}
                    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(s.name); } }}
                  >
                    {alert && <div className="skill-card-alert" title="需要配置 API key">!</div>}
                    <div className="skill-card-icon" style={{ color: meta.color }}><Icon size={19} /></div>
                    <div className="skill-card-name">{labelFor(s.name)}</div>
                    <div className="skill-card-rawname">{s.name}</div>
                    <div className="skill-card-desc">{metaFor(s.name).description || s.description?.trim() || LAYER_DESC[layer.key]}</div>
                    {(metaFor(s.name).tags?.length || categoryLabel(metaFor(s.name).categoryId)) ? <div className="skill-card-tags">{categoryLabel(metaFor(s.name).categoryId) && <span className="skill-tag is-category">{categoryLabel(metaFor(s.name).categoryId)}</span>}{(metaFor(s.name).tags || []).map(tag => <span className="skill-tag" key={tag}>{tag}</span>)}</div> : null}
                    <div className="skill-card-foot">
                      <SkillDependencyBadges skill={s} />
                      {s.needsApi && (s.apiConfigured
                        ? <span className="badge badge-ok">已配置</span>
                        : <span className="badge badge-warn">需 API</span>)}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      </>}

      {selected && (
        <SkillDrawer
          skillName={selected}
          onOpenChat={onOpenChat}
          onClose={() => setSelected(null)}
          onConfigured={load}
          meta={metaFor(selected)}
          categories={meta?.categories || []}
          onMetaSaved={() => void loadMeta()}
        />
      )}
        </div>
      </div>
    </div>
  );
}
