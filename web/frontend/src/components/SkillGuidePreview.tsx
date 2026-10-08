import { useEffect, useState } from 'react';
import { fetchSkillDetail } from '../lib/api';
import type { SkillDetail } from '../lib/api';
import { displayName } from '../lib/skillDisplayNames';

function GuideList({ title, items, ordered = false }: { title: string; items: string[]; ordered?: boolean }) {
  const List = ordered ? 'ol' : 'ul';
  return <section className="brush-guide-section"><h4>{title}</h4>{items.length
    ? <List>{items.map((item, index) => <li key={index}>{item}</li>)}</List>
    : <p className="brush-guide-muted">原文未说明</p>}</section>;
}

/** The API extracts this guide from the installed SKILL.md; no generated claims. */
export default function SkillGuidePreview({ skillName, onPick }: { skillName: string | null; onPick?: (text: string, skill: string) => void }) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let stale = false;
    setDetail(null);
    setError('');
    if (!skillName) return;
    // A short delay avoids fetching every row as the pointer crosses the list.
    const timer = window.setTimeout(() => {
      fetchSkillDetail(skillName).then((value) => { if (!stale) setDetail(value); })
        .catch((reason) => { if (!stale) setError(reason instanceof Error ? reason.message : '详情读取失败'); });
    }, 140);
    return () => { stale = true; window.clearTimeout(timer); };
  }, [skillName, retry]);

  if (!skillName) return <aside className="brush-guide brush-guide-empty"><strong>先了解，再选用</strong><p>悬停或用 Tab 聚焦技能，查看它能做什么、需要准备什么、会产出什么。</p><span>说明来自本机已安装的 SKILL.md</span></aside>;
  const guide = detail?.guide;
  const needs = guide?.needs;
  const preparation = needs ? [
    ...needs.inputs.map((value) => `准备材料：${value}`),
    ...(needs.api ? [`${needs.api.label}：${needs.api.configured ? '已配置' : '未配置'}`] : []),
    ...needs.media.map((value) => `${value.label}：${value.configured ? '已配置' : '未配置'}`),
    ...(needs.accounts.length ? [`登录账号：${needs.accounts.join('、')}`] : []),
    ...(needs.tools.length ? [`工具依赖：${needs.tools.join('、')}`] : []),
    ...(needs.os.length ? [`适用系统：${needs.os.join('、')}`] : []),
    ...needs.prep,
  ] : [];

  return <aside className="brush-guide" aria-label={`${displayName(skillName)}技能详情`}>
    <header><h3>{displayName(skillName)}</h3><code>{skillName}</code><p>根据本机 SKILL.md 原文整理</p></header>
    {error ? <div className="brush-guide-error" role="alert">{error}<button type="button" className="link-btn" onClick={() => setRetry((value) => value + 1)}>重新读取</button></div>
      : !detail ? <p className="brush-guide-muted" role="status">正在读取技能详情…</p>
      : guide ? <>
        <section className="brush-guide-section"><h4>能做什么</h4><p>{guide.what || '原文未说明'}</p></section>
        <GuideList title="什么时候用" items={guide.whenToUse} />
        <GuideList title="需要准备" items={preparation} />
        <GuideList title="怎么开始" items={guide.howToStart} ordered />
        <GuideList title="会得到什么" items={guide.whatYouGet} />
        {guide.examples.length > 0 && <section className="brush-guide-section"><h4>示例输入</h4>{guide.examples.map((example, index) => onPick ? <button key={index} type="button" className="brush-guide-example" onClick={() => onPick(example, skillName)}>{example}<span>填入创作框 ↗</span></button> : <p className="brush-guide-example" key={index}>{example}</p>)}</section>}
        {guide.steps.length > 0 && <details className="brush-guide-section"><summary>查看原文执行步骤</summary><ol>{guide.steps.map((step, index) => <li key={index}>{step}</li>)}</ol></details>}
        {guide.terms.length > 0 && <details className="brush-guide-section"><summary>术语解释</summary>{guide.terms.map((term) => <p key={term.term}><strong>{term.term}</strong>：{term.explain}</p>)}</details>}
      </> : <p className="brush-guide-muted">暂未提取到导读，请到技能库查看原文。</p>}
  </aside>;
}
