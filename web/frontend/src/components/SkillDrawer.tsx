import { NativeSelect as Select } from './ui/Select';
import { useState, useEffect, useMemo, useRef } from 'react';
import { fetchSkillDetail, executeSkill, saveEnv } from '../lib/api';
import type { SkillDetail } from '../lib/api';
import { renderMarkdown } from '../lib/sanitize';
import { displayName } from '../lib/skillDisplayNames';
import SkillDependencyBadges from './SkillDependencyBadges';

interface SkillDrawerProps {
  skillName: string;
  persona: string;
  onClose: () => void;
  onConfigured: () => void;   // 保存 API 后通知父组件刷新卡片状态
}

export default function SkillDrawer({ skillName, persona, onClose, onConfigured }: SkillDrawerProps) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loadErr, setLoadErr] = useState('');

  // API 配置输入（env -> 明文，只提交非空项）
  const [envInputs, setEnvInputs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');

  // 执行区
  const [input, setInput] = useState('');
  const [result, setResult] = useState('');
  const [running, setRunning] = useState(false);
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
  const resultHtml = useMemo(() => renderMarkdown(result), [result]);

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

  const handleRun = async () => {
    if (!input.trim()) return;
    const seq = ++reqSeq.current;
    setRunning(true);
    setRunErr('');
    setResult('');
    try {
      const res = await executeSkill(skillName, input.trim(), persona || undefined);
      if (seq === reqSeq.current) setResult(res.response);
    } catch (e) {
      if (seq === reqSeq.current) setRunErr(e instanceof Error ? e.message : '执行失败');
    } finally {
      if (seq === reqSeq.current) setRunning(false);
    }
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
          {detail && <SkillDependencyBadges skill={detail} detail={detail} />}
          {loadErr && <div style={{ color: 'var(--red)', fontSize: 14 }}>{loadErr}</div>}

          {/* 新手导读：按 SKILL.md 原文静态整理，不需要先配模型 */}
          {guide && (
            <div className="panel guide-panel">
              <div className="panel-title">🧭 新手导读
                <span style={{ fontWeight: 400, color: 'var(--text-secondary)', fontSize: 12 }}>
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
                  <div className="guide-label">试试这样说（点一下填入运行框）</div>
                  <div className="guide-chips">
                    {guide.examples.map((t) => (
                      <button
                        key={t}
                        type="button"
                        className="guide-chip guide-chip-btn"
                        title="点击填入下方运行框"
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
                <span style={{ fontWeight: 400, color: 'var(--text-secondary)', fontSize: 12 }}>
                  （任选一个服务商填齐即可用）
                </span>
              </div>
              {detail.apiSpec.settings.length > 0 && (
                <div className="provider-block">
                  <div className="provider-head"><strong style={{ fontSize: 13 }}>默认选择与能力</strong></div>
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
                      <strong style={{ fontSize: 13 }}>{prov.name}</strong>
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
                {savedMsg && <span style={{ fontSize: 13, color: savedMsg.includes('✓') ? 'var(--green)' : 'var(--text-secondary)' }}>{savedMsg}</span>}
              </div>
            </div>
          )}

          {/* 执行 */}
          <div className="panel">
            <div className="panel-title">▶ 运行</div>
            {blocked && (
              <div style={{ fontSize: 13, color: 'var(--amber)', marginBottom: 10 }}>
                该 SKILL 需要先配置上面的 API 才能运行。
              </div>
            )}
            <textarea
              ref={inputRef}
              className="field"
              placeholder="输入内容，例如主题 / 素材 / 要求…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              style={{ minHeight: 100 }}
            />
            <div style={{ marginTop: 10 }}>
              <button className="btn btn-primary" onClick={handleRun} disabled={running || !input.trim() || blocked}>
                {running
                  ? <><span className="spinner" style={{ width: 14, height: 14, margin: 0 }} />执行中…</>
                  : '执行'}
              </button>
            </div>
            {runErr && <div style={{ color: 'var(--red)', fontSize: 13, marginTop: 10 }}>{runErr}</div>}
            {resultHtml && (
              <div className="skill-result" dangerouslySetInnerHTML={{ __html: resultHtml }} />
            )}
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
