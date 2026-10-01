import { useState } from 'react';
import { DEMO_ACCOUNT, DEMO_NOTICE, demoContents, demoThemes, demoTotal, demoTrend, filterDemoContents, type DemoSort } from '../lib/contentAnalysisDemo';
import type { AnalysisSection } from './ContentAnalysisWorkbench';

const number = (value: number) => value.toLocaleString('zh-CN');
const shortDate = (value?: string) => value ? value.slice(5, 10).replace('-', '/') : '未提供';
const sortLabels: Record<DemoSort, string> = { publishedAt: '发布时间', views: '阅读 / 播放', likes: '点赞', collects: '收藏', comments: '评论' };

export default function ContentAnalysisDemo({ section, onSection, onUseMyData }: {
  section: AnalysisSection; onSection: (section: AnalysisSection) => void; onUseMyData: () => void;
}) {
  const [query, setQuery] = useState('');
  const [theme, setTheme] = useState('');
  const [sort, setSort] = useState<DemoSort>('collects');
  const [ascending, setAscending] = useState(false);
  const [comparisonMetric, setComparisonMetric] = useState<'collects' | 'views'>('collects');
  const [checked, setChecked] = useState<string[]>([]);
  const themes = demoThemes(comparisonMetric);
  const rows = filterDemoContents(query, theme, sort, ascending);
  const saves = demoThemes('collects');
  const maxTheme = Math.max(...themes.map(item => item.average));
  const maxTrend = demoTrend.at(-1)!.views;
  const changeSort = (key: DemoSort) => { setAscending(sort === key ? !ascending : false); setSort(key); };
  const columns: Exclude<DemoSort, 'publishedAt'>[] = ['views', 'likes', 'collects', 'comments'];
  const selectTheme = (tag: string) => { setTheme(tag); setQuery(''); onSection('works'); };

  const comparison = <section className="ca-demo-chart" aria-labelledby="ca-theme-chart-title">
    <div className="ca-card-heading"><div><p className="ca-kicker">找方向</p><h3 id="ca-theme-chart-title">哪类内容更值得继续做？</h3></div><label className="ca-demo-metric-label">比较指标<select value={comparisonMetric} onChange={event => setComparisonMetric(event.target.value as 'collects' | 'views')}><option value="collects">平均收藏</option><option value="views">平均阅读 / 播放</option></select></label></div>
    <p className="ca-caption">每篇发布后前 7 天 · 每类 3 篇 · 点击主题查看作品</p>
    <ul className="ca-comparison-bars">{themes.map(item => <li key={item.tag}><button type="button" onClick={() => selectTheme(item.tag)}><span>{item.tag}<small>{item.count} 篇</small></span><span className="ca-comparison-track" aria-hidden="true"><i style={{ width: `${item.average / maxTheme * 100}%` }} /></span><strong>{number(item.average)}<small>次 / 篇</small></strong></button></li>)}</ul>
    <p className="ca-chart-takeaway">{comparisonMetric === 'collects' ? '教程和清单更常被收藏，可以优先尝试延续。' : '这个示例中，教程也获得了更多阅读 / 播放。'} 样本少，下一篇还要继续验证。</p>
  </section>;

  const trend = <section className="ca-demo-chart" aria-labelledby="ca-trend-chart-title">
    <p className="ca-kicker">看变化</p><h3 id="ca-trend-chart-title">作品通常什么时候被看到？</h3><p className="ca-caption">9 篇作品按发布后的天数对齐 · 平均累计阅读 / 播放</p>
    <div className="ca-trend-bars" role="img" aria-label={`虚构趋势：发布第 1 天平均 ${demoTrend[0].views} 次，第 7 天 ${maxTrend} 次阅读或播放`}>{demoTrend.map(point => <div key={point.day}><strong>{number(point.views)}</strong><span className="ca-trend-column" aria-hidden="true"><i style={{ height: `${point.views / maxTrend * 100}%` }} /></span><small>第 {point.day} 天</small></div>)}</div>
    <p className="ca-chart-takeaway">别在刚发出去时就下结论。统一等 7 天，再和以前的作品比较。</p>
    <details className="ca-inline-evidence"><summary>查看趋势数值与说明</summary><p>以下每天数值均为演示构造，展示“按作品发布年龄对齐”的方法，不是账号的日历日流量。</p><div className="ca-table-wrap"><table><caption>演示作品的平均累计指标</caption><thead><tr><th scope="col">发布后</th><th scope="col">平均阅读 / 播放</th><th scope="col">平均收藏</th></tr></thead><tbody>{demoTrend.map(point => <tr key={point.day}><th scope="row">第 {point.day} 天</th><td>{number(point.views)}</td><td>{number(point.collects)}</td></tr>)}</tbody></table></div></details>
  </section>;

  return <section className="ca-demo" aria-label="内容分析演示">
    <div className="ca-demo-banner" role="status"><div><strong>{DEMO_NOTICE}</strong><span>用「{DEMO_ACCOUNT}」的 9 篇小红书作品，走一遍完整复盘。不会保存到你的账号。</span></div><button className="ca-text-button" onClick={onUseMyData}>换成我的数据 →</button></div>
    {section === 'review' && <>
      <section className="ca-verdict" aria-labelledby="ca-verdict-title"><div className="ca-verdict-main"><p className="ca-kicker">先看结论 / 演示</p><h2 id="ca-verdict-title">读者更愿意收藏<br />“能照着做”的内容。</h2><p>这组样例里，教程和清单表现更突出。下一篇可以先延续具体问题，不必急着换赛道。</p><button className="btn btn-primary" onClick={() => onSection('experiments')}>看看下一篇怎么做 →</button></div><div className="ca-verdict-notes"><article><span>表现怎么样</span><strong>教程平均 {number(saves[0].average)} 次收藏</strong><p>日常记录平均 {number(saves[2].average)} 次；比较的是每篇发布后前 7 天。</p></article><article><span>可能的原因</span><strong>读者能带走一套具体方法</strong><p>三篇教程都给了可操作的步骤。这是值得验证的线索，还不能认定是增长原因。</p></article><article><span>下一步做什么</span><strong>先做一篇“三步解决一个问题”</strong><p>保留原来的风格，只把步骤讲清楚；7 天后再看收藏和读者提问。</p></article></div></section>
      <div className="ca-demo-stats" aria-label="演示数据概览"><article><span>分析了多少篇</span><strong>{demoContents.length}<small>篇作品</small></strong><p>3 类主题，各 3 篇</p></article><article><span>被看到多少次</span><strong>{number(demoTotal('views'))}</strong><p>阅读 / 播放次数，可以重复</p></article><article><span>被收藏多少次</span><strong>{number(demoTotal('collects'))}</strong><p>读者想留着以后看</p></article><article><span>收到多少条评论</span><strong>{number(demoTotal('comments'))}</strong><p>看看大家追问了什么</p></article></div>
      <div className="ca-demo-charts">{trend}{comparison}</div>
    </>}
    {section === 'themes' && <><div className="ca-demo-section-heading"><h2>找到你可以继续做的方向</h2><p>先看每篇平均表现，再回到具体内容找线索。不要只比较不同数量作品的总和。</p></div><div className="ca-demo-charts">{comparison}{trend}</div></>}
    {(section === 'review' || section === 'works') && <section className="ca-demo-works" aria-labelledby="ca-demo-table-title"><div className="ca-demo-section-heading"><div><p className="ca-kicker">回到每一篇</p><h2 id="ca-demo-table-title">哪些作品值得再看一眼？</h2><p>点开标题，看数据、原文和下一步建议。</p></div><span className="ca-demo-badge">全部为虚构作品</span></div>
      <div className="ca-demo-table-tools"><label>搜索作品<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜标题、主题或图文 / 视频" /></label><label>主题<select value={theme} onChange={event => setTheme(event.target.value)}><option value="">全部主题</option>{demoThemes('collects').map(item => <option key={item.tag}>{item.tag}</option>)}</select></label><span role="status">{rows.length} / {demoContents.length} 篇</span>{(query || theme) && <button className="ca-text-button" onClick={() => { setQuery(''); setTheme(''); }}>清空筛选</button>}</div>
      <div className="ca-table-wrap"><table className="ca-demo-table"><caption>演示作品数据 · 每篇发布后前 7 天；点击列名切换排序，当前按{sortLabels[sort]}{ascending ? '从低到高' : '从高到低'}</caption><thead><tr><th scope="col">作品 / 展开分析</th><th scope="col" aria-sort={sort === 'publishedAt' ? ascending ? 'ascending' : 'descending' : 'none'}><button onClick={() => changeSort('publishedAt')}>发布日 {sort === 'publishedAt' ? ascending ? '↑' : '↓' : '↕'}</button></th>{columns.map(key => <th key={key} scope="col" aria-sort={sort === key ? ascending ? 'ascending' : 'descending' : 'none'}><button onClick={() => changeSort(key)}>{sortLabels[key]} {sort === key ? ascending ? '↑' : '↓' : '↕'}</button></th>)}</tr></thead><tbody>{rows.map(item => <tr key={item.id}><th scope="row"><details className="ca-demo-work"><summary><span>{item.title}<small>{item.tags[0]} · {item.format}</small></span></summary><div className="ca-demo-work-body"><strong>这篇可以怎么改</strong><p>{item.diagnostics[0].action}</p><details className="ca-inline-evidence"><summary>为什么这样建议？查看原文依据</summary><p>{item.diagnostics[0].observation}</p><blockquote>{item.diagnostics[0].evidence}</blockquote><p>{item.diagnostics[0].limitation}</p></details><span className="ca-demo-badge">虚构材料 · 不会加入真实选题库</span></div></details></th><td>{shortDate(item.publishedAt)}</td>{columns.map(key => <td key={key}>{number(item.metrics[key] || 0)}</td>)}</tr>)}</tbody></table>{!rows.length && <div className="ca-demo-no-results"><strong>没有找到匹配的作品</strong><p>试试“教程”“咖啡”或清空筛选。</p><button className="btn btn-sm" onClick={() => { setQuery(''); setTheme(''); }}>显示全部作品</button></div>}</div>
      <details className="ca-inline-evidence ca-table-explainer"><summary>这些数字是什么意思？</summary><p>阅读 / 播放是被查看的次数；点赞表示喜欢；收藏表示留着以后看；评论是收到的留言条数。这里不把它们相加成一个“总分”。每篇都使用发布后前 7 天的虚构数值，便于演示比较方法。</p></details>
    </section>}
    {section === 'experiments' && <section className="ca-demo-plan"><div><p className="ca-kicker">下一篇，只试一件事 / 演示</p><h2>把“生活随拍”变成<br />“可照着做的三步教程”</h2><p>示例选题：<strong>用一张白纸，拍出好看的咖啡照片</strong></p><p>暂时保留拍摄风格和发布时间，只让步骤更明确。这样，回头复盘时更容易知道自己改了什么。</p><button className="btn btn-primary" onClick={onUseMyData}>用我的作品制定计划 →</button></div><div className="ca-plan-checklist"><h3>跟着这 3 步试一次</h3>{[
      ['prepare', '先把做法写清楚', '用三张图分别展示白纸摆放、光线方向和拍摄结果。'],
      ['observe', '发布后先留足观察时间', '第 7 天记录收藏、阅读和评论，别把第一小时的数据拿来比较。'],
      ['review', '看看能不能再做一篇', '对比同样发布 7 天的作品，读一读评论；表现更好也要再验证。'],
    ].map(([id, title, text]) => <label key={id}><input type="checkbox" checked={checked.includes(id)} onChange={event => setChecked(values => event.target.checked ? [...values, id] : values.filter(value => value !== id))} /><span><strong>{title}</strong><small>{text}</small></span></label>)}<p role="status">体验进度 {checked.length} / 3 · 仅在当前演示中勾选，不保存实验</p></div></section>}
    {section === 'method' && <section className="ca-demo-method"><h2>看得懂，也查得到</h2><p>这是一份用于体验界面的完整虚构样例，没有读取或推断你的账号表现。</p>{[
      ['演示数据从哪里来？', '账号名称、9 篇作品、文字和所有指标都由演示样例构造。演示组件没有采集、导入、保存或发布动作。切换“我的数据”后，才会读取你实际保存的记录。'],
      ['为什么要比较前 7 天？', '发布一个月的作品通常比刚发一天的作品积累更多阅读。演示把每篇作品的观察窗口统一为发布后前 7 天，而不是把作品年龄不同的累计值直接比较。'],
      ['“平均收藏”怎么算？', '同一主题三篇作品的收藏总数，除以三。它说明这个小样本里的情况，不代表整个平台或所有读者。'],
      ['建议一定有效吗？', '不一定。原文与数据只提供值得试的线索，不能证明因果。建议一次只改一件事，留下修改前后的记录，再观察更多作品。'],
    ].map(([title, text]) => <details key={title}><summary>{title}</summary><p>{text}</p></details>)}<button className="btn btn-primary" onClick={onUseMyData}>开始分析我的数据 →</button></section>}
  </section>;
}
