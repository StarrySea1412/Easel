import { NativeSelect as Select } from './ui/Select';
import AppSelect from './ui/Select';
import { useState, useEffect, useMemo, useRef } from 'react';
import { fetchSkillDetail, saveEnv, saveSkillMeta, createSkillCategory } from '../lib/api';
import type { SkillDetail, SkillCategory, SkillMetaEntry } from '../lib/api';
import { renderMarkdown } from '../lib/sanitize';
import { displayName } from '../lib/skillDisplayNames';
import SkillDependencyBadges from './SkillDependencyBadges';

interface SkillDrawerProps {
  skillName: string;
  onOpenChat: (skill: string, input: string) => boolean;
  onClose: () => void;
  onConfigured: () => void;   // 保存 API 后通知父组件刷新卡片状态
  meta?: SkillMetaEntry;      // 分类与标签（覆盖层）
  categories?: SkillCategory[];
  onMetaSaved?: () => void;   // 保存后通知父组件刷新
}

export default function SkillDrawer({ skillName, onOpenChat, onClose, onConfigured, meta, categories = [], onMetaSaved }: SkillDrawerProps) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loadErr, setLoadErr] = useState('');

  // API 配置输入（env -> 明文，只提交非空项）
  const [envInputs, setEnvInputs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');

  // Prepare a conversation draft; only the composer may send it.
  // 分类与标签编辑（写覆盖层，不动第三方 SKILL.md 本体）
  const [catSel, setCatSel] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [displayInput, setDisplayInput] = useState('');
  const [descInput, setDescInput] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [metaSaving, setMetaSaving] = useState(false);
  const [metaMsg, setMetaMsg] = useState('');
  // 值依赖：meta 对象每次渲染都是新引用，先取成字符串再进依赖，避免覆盖正在输入的内容。
  const metaCategoryId = meta?.categoryId || '';
  const metaTagsText = (meta?.tags || []).join('、');
  const metaDisplayName = meta?.displayName || '';
  const metaDescription = meta?.description || '';
  useEffect(() => {
    setCatSel(metaCategoryId);
    setTagsText(metaTagsText);
    setDisplayInput(metaDisplayName);
    setDescInput(metaDescription);
    setMetaMsg('');
  }, [skillName, metaCategoryId, metaTagsText, metaDisplayName, metaDescription]);
  const parseTags = () => tagsText.split(/[、,，]/).map(tag => tag.trim()).filter(Boolean).slice(0, 8);
  const createCategory = async () => {
    const label = newCategory.trim();
    if (!label) return;
    try {
      const created = await createSkillCategory(label);
      setNewCategory('');
      setCatSel(created.id);
      setMetaMsg('分类已创建并选用，点“保存”后生效');
      onMetaSaved?.();
    } catch (cause) {
      setMetaMsg(cause instanceof Error ? cause.message : '分类创建失败');
    }
  };
  const saveMeta = async () => {
    setMetaSaving(true); setMetaMsg('');
    try {
      await saveSkillMeta(skillName, { tags: parseTags(), categoryId: catSel || '', displayName: displayInput, description: descInput });
      setMetaMsg('已保存，卡片与搜索会使用这里的覆盖内容');
      onMetaSaved?.();
    } catch (cause) {
      setMetaMsg(cause instanceof Error ? cause.message : '保存失败');
    } finally { setMetaSaving(false); }
  };

  const [input, setInput] = useState('');
  const [runErr, setRunErr] = useState('');
  const reqSeq = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const loadDetail = () => {
    let ignore = false;
    fetchSkillDetail(skillName)
      .then((d) => { if (!ignore) { setDetail(d); setLoadErr(''); } })
      .catch(() => { if (!ignore) setLoadErr('加载 SKILL 详情失败'); });
    return () => { ignore = true; };
  };

  useEffect(loadDetail, [skillName]);

  const bodyHtml = useMemo(() => renderMarkdown(detail?.body || ''), [detail?.body]);

  // 新手导读：media（如 AI 生图）与 api 标签重复时只留 api 那条（后者带配置入口）
  const guide = detail?.guide;
  const guideMedia = guide
    ? guide.needs.media.filter((m) => !(guide.needs.api && guide.needs.api.label.includes(m.label.replace(/^AI\s*/, ''))))
    : [];
  const hasNeeds = !!guide && (
    guide.needs.inputs.length > 0 || !!guide.needs.api || guideMedia.length > 0
    || guide.needs.accounts.length > 0 || guide.needs.tools.length > 0
    || guide.needs.os.length > 0 || guide.needs.prep.length > 0
  );

  const handleSaveEnv = async () => {
    const updates = Object.fromEntries(
      Object.entries(envInputs).filter(([, v]) => v.trim() !== '')
    );
    if (Object.keys(updates).length === 0) { setSavedMsg('没有填写新值'); return; }
    setSaving(true);
    setSavedMsg('');
    try {
      await saveEnv(updates);
      setEnvInputs({});
      const seq = ++reqSeq.current;
      const fresh = await fetchSkillDetail(skillName);
      if (seq === reqSeq.current) setDetail(fresh);
      setSavedMsg('已保存 ✓');
      onConfigured();
      setTimeout(() => setSavedMsg(''), 2500);
    } catch (e) {
      setSavedMsg(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleOpenChat = () => {
    if (onOpenChat(skillName, input.trim())) onClose();
    else setRunErr('未能保存对话草稿，请保留当前输入后重试。');
  };

  const blocked = detail?.needsApi && !detail.apiConfigured;

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <div className="skill-detail-title">{displayName(skillName)}</div>
              <div className="skill-detail-rawname">{skillName}</div>
              <div className="skill-detail-meta">
                {detail?.layer && <span className="badge badge-accent">{{discover:'发现',plan:'策划',produce:'制作',publish:'发布',attribute:'归因',general:'通用'}[detail.layer] || detail.layer}</span>}
                {detail?.needsApi && (
                  detail.apiConfigured
                    ? <span className="badge badge-ok">✓ 已配置</span>
                    : <span className="badge badge-warn">需配置 API</span>
                )}
              </div>
            </div>
            <button className="icon-btn" onClick={onClose} title="关闭">×</button>
          </div>
        </div>

        <div className="drawer-body">
          <section className="drawer-meta-edit" aria-label="分类与标签">
            <div className="panel-title">分类与标签</div>
            <label>分类
              <AppSelect aria-label="技能分类" value={catSel} options={[{ value: '', label: '未分类' }, ...categories.map(c => ({ value: c.id, label: c.label + (c.preset ? '（预设）' : '') }))]} onChange={setCatSel} placeholder="未分类" />
            </label>
            <div className="drawer-meta-new"><input aria-label="新建分类名称" value={newCategory} maxLength={20} placeholder="新建分类，例如：我的专栏" onChange={e => setNewCategory(e.target.value)} /><button type="button" className="btn btn-sm" disabled={!newCategory.trim()} onClick={() => void createCategory()}>新建并选用</button></div>
            <label>标签<input aria-label="技能标签" value={tagsText} maxLength={200} placeholder="用、分隔，最多 8 个，例如：小红书、文案" onChange={e => setTagsText(e.target.value)} /></label>
            <label>显示名（覆盖卡片标题）<input aria-label="技能显示名" value={displayInput} maxLength={60} placeholder={displayName(skillName)} onChange={e => setDisplayInput(e.target.value)} /></label>
            <label>描述（覆盖卡片与搜索）<textarea aria-label="技能描述" value={descInput} maxLength={300} rows={2} placeholder="留空则使用 SKILL.md 原文描述" onChange={e => setDescInput(e.target.value)} /></label>
            <div className="drawer-meta-actions"><button type="button" className="btn btn-primary btn-sm" disabled={metaSaving} onClick={() => void saveMeta()}>{metaSaving ? '保存中…' : '保存'}</button>{metaMsg && <span role="status">{metaMsg}</span>}</div>
          </section>
          {detail && <SkillDependencyBadges skill={detail} detail={detail} />}
          {loadErr && <div style={{ color: 'var(--red)', fontSize: 'calc(14px * var(--easel-font-scale, 1))' }}>{loadErr}</div>}

          {/* 新手导读：按 SKILL.md 原文静态整理，不需要先配模型 */}
          {guide && (
            <div className="panel guide-panel">
              <div className="panel-title">🧭 新手导读
                <span style={{ fontWeight: 400, color: 'var(--text-secondary)', fontSize: 'calc(12px * var(--easel-font-scale, 1))' }}>
                  （按原文整理，原文没写的会标明）
                </span>
              </div>

              <div className="guide-block">
                <div className="guide-label">能做什么</div>
                {guide.what
                  ? <div className="guide-text">{guide.what}</div>
                  : <div className="guide-missing">原文未说明</div>}
              </div>

              <div className="guide-block">
                <div className="guide-label">适合谁 · 什么时候用</div>
                {guide.whenToUse.length > 0 ? (
                  <div className="guide-chips">
                    {guide.whenToUse.map((t) => <span key={t} className="guide-chip">{t}</span>)}
                  </div>
                ) : <div className="guide-missing">原文未说明</div>}
              </div>

              <div className="guide-block">
                <div className="guide-label">需要什么</div>
                {hasNeeds ? (
                  <ul className="guide-list">
                    {guide.needs.inputs.length > 0 && (
                      <li>要准备：{guide.needs.inputs.join('、')}。</li>
                    )}
                    {guide.needs.api && (
                      <li>
                        要配「{guide.needs.api.label}」的 API Key：
                        {guide.needs.api.configured
                          ? <span className="badge badge-ok guide-badge">已配置</span>
                          : <span className="badge badge-warn guide-badge">未配置</span>}
                        <span className="guide-sub">费用以所选服务商为准</span>
                      </li>
                    )}
                    {guideMedia.map((m) => (
                      <li key={m.label}>
                        {m.label}：
                        {m.configured
                          ? <span className="badge badge-ok guide-badge">已配置</span>
                          : <span className="badge badge-warn guide-badge">未配置</span>}
                        {!m.configured && <span className="guide-sub">去「设置 → 生图」配置</span>}
                      </li>
                    ))}
                    {guide.needs.accounts.length > 0 && (
                      <li>要登录：{guide.needs.accounts.join(' / ')} 平台账号。</li>
                    )}
                    {guide.needs.tools.length > 0 && (
                      <li>额外工具：{guide.needs.tools.join('、')}。</li>
                    )}
                    {guide.needs.os.length > 0 && (
                      <li>系统限制：仅 {guide.needs.os.join(' / ')}。</li>
                    )}
                    {guide.needs.prep.map((t) => <li key={t}>{t}</li>)}
                  </ul>
                ) : <div className="guide-missing">原文未说明</div>}
              </div>

              <div className="guide-block">
                <div className="guide-label">怎么开始</div>
                <ol className="guide-list">
                  {guide.howToStart.map((t, i) => <li key={i}>{t}</li>)}
                </ol>
              </div>

              <div className="guide-block">
                <div className="guide-label">会得到什么</div>
                {guide.whatYouGet.length > 0 ? (
                  <ul className="guide-list">
                    {guide.whatYouGet.map((t) => <li key={t}>{t}</li>)}
                  </ul>
                ) : <div className="guide-missing">原文未说明</div>}
              </div>

              {guide.examples.length > 0 && (
                <div className="guide-block">
                      <div className="guide-label">试试这样说（点一下填入下方）</div>
                  <div className="guide-chips">
                    {guide.examples.map((t) => (
                      <button
                        key={t}
                        type="button"
                        className="guide-chip guide-chip-btn"
                        title="点击填入下方需求框"
                        onClick={() => { setInput(t); inputRef.current?.focus(); }}
                      >{t}</button>
                    ))}
                  </div>
                </div>
              )}

              {guide.steps.length > 0 && (
                <details className="guide-more">
                  <summary>它内部怎么做（摘自原文）</summary>
                  <ol className="guide-list">
                    {guide.steps.map((t, i) => <li key={i}>{t}</li>)}
                  </ol>
                </details>
              )}

              {guide.terms.length > 0 && (
                <div className="guide-terms">
                  {guide.terms.map((t) => (
                    <div key={t.term}><strong>{t.term}</strong>：{t.explain}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* API 配置 */}
          {detail?.needsApi && detail.apiSpec && (
            <div className="panel">
              <div className="panel-title">🔑 {detail.apiSpec.label} · API 配置
                <span style={{ fontWeight: 400, color: 'var(--text-secondary)', fontSize: 'calc(12px * var(--easel-font-scale, 1))' }}>
                  （任选一个服务商填齐即可用）
                </span>
              </div>
              {detail.apiSpec.settings.length > 0 && (
                <div className="provider-block">
                  <div className="provider-head"><strong style={{ fontSize: 'calc(13px * var(--easel-font-scale, 1))' }}>默认选择与能力</strong></div>
                  {detail.apiSpec.settings.map((k) => (
                    <div key={k.env}>
                      <label className="field-label">
                        {k.label} · 可选
                        {k.configured && <span style={{ color: 'var(--green)', marginLeft: 6 }}>
                          已配置{k.masked ? `：${k.masked}` : ''}
                        </span>}
                      </label>
                      {k.choices.length > 0 ? (
                        <Select
                          className="field"
                          value={envInputs[k.env] ?? ''}
                          onChange={(e) => setEnvInputs((p) => ({ ...p, [k.env]: e.target.value }))}
                        >
                          <option value="">{k.configured ? `当前：${k.masked}` : `请选择 ${k.env}`}</option>
                          {k.choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
                        </Select>
                      ) : (
                        <input
                          className="field"
                          type={k.secret ? 'password' : 'text'}
                          placeholder={k.configured ? '留空则保持不变，输入以覆盖' : `请输入 ${k.env}`}
                          value={envInputs[k.env] || ''}
                          onChange={(e) => setEnvInputs((p) => ({ ...p, [k.env]: e.target.value }))}
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}
              {detail.apiSpec.providers.map((prov) => {
                const provOk = prov.keys.filter(k => k.required).every(k => k.configured);
                return (
                  <div key={prov.id} className={`provider-block ${provOk ? 'configured' : ''}`}>
                    <div className="provider-head">
                      <strong style={{ fontSize: 'calc(13px * var(--easel-font-scale, 1))' }}>{prov.name}</strong>
                      {provOk
                        ? <span className="badge badge-ok">✓ 就绪</span>
                        : <span className="badge">未配置</span>}
                    </div>
                    {prov.keys.map((k) => (
                      <div key={k.env}>
                        <label className="field-label">
                          {k.label}{k.required ? '' : ' · 可选'}
                          {k.configured && <span style={{ color: 'var(--green)', marginLeft: 6 }}>
                            已配置{k.secret && k.masked ? `（${k.masked}）` : k.masked ? `：${k.masked}` : ''}
                          </span>}
                        </label>
                        {k.choices.length > 0 ? (
                          <Select className="field" value={envInputs[k.env] ?? ''}
                            onChange={(e) => setEnvInputs((p) => ({ ...p, [k.env]: e.target.value }))}>
                            <option value="">{k.configured ? `当前：${k.masked}` : `请选择 ${k.env}`}</option>
                            {k.choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
                          </Select>
                        ) : (
                          <input
                            className="field"
                            type={k.secret ? 'password' : 'text'}
                            placeholder={k.configured ? '留空则保持不变，输入以覆盖' : `请输入 ${k.env}`}
                            value={envInputs[k.env] || ''}
                            onChange={(e) => setEnvInputs((p) => ({ ...p, [k.env]: e.target.value }))}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                );
              })}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
                <button className="btn btn-primary btn-sm" onClick={handleSaveEnv} disabled={saving}>
                  {saving ? '保存中…' : '保存到 .env'}
                </button>
                {savedMsg && <span style={{ fontSize: 'calc(13px * var(--easel-font-scale, 1))', color: savedMsg.includes('✓') ? 'var(--green)' : 'var(--text-secondary)' }}>{savedMsg}</span>}
              </div>
            </div>
          )}

          {/* 进入对话 */}
          <div className="panel">
            <div className="panel-title">在对话中使用</div>
            <p style={{ fontSize: 'calc(13px * var(--easel-font-scale, 1))', color: 'var(--text-secondary)' }}>带上技能与需求进入新对话，确认后再发送。</p>
            {blocked && (
              <div style={{ fontSize: 'calc(13px * var(--easel-font-scale, 1))', color: 'var(--amber)', marginBottom: 10 }}>
                当前配置不完整，可先进入对话；调用前请补齐对应渠道配置。
              </div>
            )}
            <textarea
              ref={inputRef}
          aria-label="带入对话的输入"
              className="field"
              placeholder="输入内容，例如主题 / 素材 / 要求…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              style={{ minHeight: 100 }}
            />
            <div style={{ marginTop: 10 }}>
              <button className="btn btn-primary" onClick={handleOpenChat}>
                进入对话
              </button>
            </div>
            {runErr && <div style={{ color: 'var(--red)', fontSize: 'calc(13px * var(--easel-font-scale, 1))', marginTop: 10 }}>{runErr}</div>}
          </div>

          {/* 原文入口：默认折叠，保留完整 SKILL.md 与运行命令 */}
          <details className="panel guide-raw">
            <summary className="panel-title">📖 原始 SKILL.md 全文（完整步骤与命令）</summary>
            {detail
              ? <div className="skill-body-md" style={{ marginTop: 10 }} dangerouslySetInnerHTML={{ __html: bodyHtml }} />
              : !loadErr && <div className="loading"><div className="spinner" />加载中…</div>}
          </details>
        </div>
      </div>
    </div>
  );
}
