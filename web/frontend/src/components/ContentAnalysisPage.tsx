import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchAccounts, type AccountItem } from '../lib/api';
import PlatformIcon from './PlatformIcon';
import ContentAnalysisWorkbench, { type AnalysisSection } from './ContentAnalysisWorkbench';
import PlatformAnalysisPanel from './PlatformAnalysisPanel';
import XhsInsightsPanel from './XhsInsightsPanel';
import '../styles/content-analysis.css';

const PLATFORMS = [
  { id: 'xiaohongshu', name: '小红书', format: '图文 · 短视频', source: '本人笔记管理页 / 用户导出记录', scope: '逐篇赞、藏、评与标题标签；可导入本人记录，查看建议依据并加入选题。', limit: '关键词结果来自已有标题与标签，不代表完整正文诊断；采集时间不等于发布时间。' },
  { id: 'douyin', name: '抖音', format: '短视频', source: '抖音创作者中心', scope: '账号概览、首页近 7 日指标与本次返回的作品摘要。', limit: '部分作品只有平台统计文案；作品发布时间和观察年龄不完整，不能直接做优劣排名。' },
  { id: 'kuaishou', name: '快手', format: '短视频', source: '快手创作者服务平台', scope: '当前页面概览与部分作品的播放、点赞、评论文案。', limit: '具体统计期间可能未提供，返回列表可能包含不同发布状态，不能当作全部已发布作品。' },
  { id: 'bilibili', name: '哔哩哔哩', format: '视频', source: '哔哩哔哩创作中心', scope: '当前账号指标与部分作品的播放、点赞、评论、收藏、分享。', limit: '作品覆盖可能只有最近一页；首页增量的具体周期需以采集结果为准。' },
  { id: 'weixin-channels', name: '视频号', format: '视频', source: '微信视频号助手', scope: '首页返回的有限指标与可匹配的内容入口。', limit: '逐篇指标和日期支持有限；管理页入口不等于作品原文，暂不生成完整作品比较。' },
  { id: 'zhihu', name: '知乎', format: '文章 · 回答', source: '知乎创作中心', scope: '账号概览与部分文章、回答的阅读和赞同摘要。', limit: '文章与回答应分别观察；完整标题、发布日期和累计范围可能缺失。' },
  { id: 'wechat-oa', name: '公众号', format: '图文', source: '微信公众号后台扫码会话', scope: '已返回文章的阅读、点赞与平台概览；以实际采集字段为准。', limit: 'AppID 配置不等于已登录后台；完读率、阅读时长等官方详细接口尚未接入本页面。' },
];

const validPlatform = (value?: string) => PLATFORMS.some((item) => item.id === value) ? value! : 'xiaohongshu';

export default function ContentAnalysisPage({ initialPlatform, onNavigateAccounts, onNavigateIdeas, autoCollectSignal = 0, onAutoCollectHandled }: {
  initialPlatform?: string; onNavigateAccounts: () => void; onNavigateIdeas: () => void;
  autoCollectSignal?: number; onAutoCollectHandled?: () => void;
}) {
  const [platform, setPlatform] = useState(() => validPlatform(initialPlatform));
  const [section, setSection] = useState<AnalysisSection>('review');
  const [accounts, setAccounts] = useState<AccountItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++request.current;
    setLoading(true); setError('');
    try {
      const result = await fetchAccounts();
      if (sequence !== request.current) return;
      setAccounts(result); setRevision((value) => value + 1);
    } catch (reason) {
      if (sequence === request.current) setError(reason instanceof Error ? reason.message : '暂时无法读取账号状态');
    } finally { if (sequence === request.current) setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); return () => { request.current += 1; }; }, [refresh]);
  useEffect(() => { setPlatform(validPlatform(initialPlatform)); }, [initialPlatform]);
  const selected = PLATFORMS.find((item) => item.id === platform)!;
  const account = accounts.find((item) => item.platform === platform);
  const available = Boolean(account?.supported && account.loggedIn);
  const mappedAccounts = PLATFORMS.filter((item) => item.id !== 'xiaohongshu').map((item) => {
    const value = accounts.find((entry) => entry.platform === item.id);
    return { platform: item.id, name: item.name, loggedIn: Boolean(value?.supported && value.loggedIn), identity: `${item.id}:${revision}` };
  });

  return <div className="content-analysis-page">
    <div className="ca-workspace">
      <header className="ca-heading">
        <div><p className="ca-kicker">CONTENT INSIGHTS / 创作复盘</p><h1>内容分析</h1><p className="ca-subtitle">从作品里找到线索，让下一次创作更有依据。</p></div>
        <div className="ca-heading-actions"><button type="button" className="btn btn-sm" onClick={onNavigateAccounts}>管理账号</button><button type="button" className="btn btn-primary btn-sm" onClick={onNavigateIdeas}>打开选题库 <span aria-hidden="true">↗</span></button></div>
      </header>

      <section className="ca-platform-picker" aria-label="选择分析平台">
        {PLATFORMS.map((item) => <button type="button" key={item.id} className={platform === item.id ? 'ca-platform is-selected' : 'ca-platform'} aria-pressed={platform === item.id} onClick={() => setPlatform(item.id)}>
          <PlatformIcon platform={item.id} name={item.name} /><span>{item.name}</span>
        </button>)}
      </section>

      <div className="ca-context">
        <div className="ca-context-main"><span className="ca-context-format">{selected.format}</span><strong>{selected.name} · 本人内容</strong><span className={`ca-session ${available ? 'is-connected' : ''}`}>{loading ? '读取账号状态…' : error ? '账号状态读取失败' : available ? '已保存登录状态 · 采集时核验' : '需要连接账号'}</span></div>
        <button type="button" className="ca-text-button" disabled={loading} onClick={() => void refresh()}>{loading ? '读取中…' : '刷新账号状态'}</button>
      </div>
      {error && <div className="ca-error" role="alert">{error}。请重试读取账号状态，或前往账号中心检查连接。<button type="button" className="ca-text-button" onClick={() => void refresh()}>重试</button></div>}

      <nav className="ca-view-nav" aria-label="分析视图">
        <button type="button" aria-current={section === 'review' ? 'page' : undefined} onClick={() => setSection('review')}>复盘总览</button>
        <button type="button" aria-current={section === 'works' ? 'page' : undefined} onClick={() => setSection('works')}>作品分析</button>
        <button type="button" aria-current={section === 'themes' ? 'page' : undefined} onClick={() => setSection('themes')}>主题与形式</button>
        <button type="button" aria-current={section === 'experiments' ? 'page' : undefined} onClick={() => setSection('experiments')}>行动与实验</button>
        <button type="button" aria-current={section === 'method' ? 'page' : undefined} onClick={() => setSection('method')}>数据与口径</button>
        <span>仅分析实际返回的数据</span>
      </nav>

      <ContentAnalysisWorkbench key={platform} platform={platform} section={section} onSection={setSection} onNavigateIdeas={onNavigateIdeas} />

      <div hidden={section !== 'review'}>
        <div className="ca-review-layout">
          <section className="ca-review-main" aria-label="内容复盘">
            <div className="ca-section-intro"><p className="ca-kicker">01 / REVIEW</p><h2>平台采集与实时概览</h2><p>{selected.scope}</p></div>
            {loading ? <div className="ca-loading" role="status">正在读取账号连接状态…</div> : error ? <div className="ca-loading">账号状态暂不可用，重试成功后即可查看分析。</div> : <>
              {!available && <div className="ca-connect-callout"><div><strong>连接{selected.name}，开始自己的内容复盘</strong><p>{platform === 'xiaohongshu' ? '连接后采集本人笔记；已有导出文件也可在下方查看导入方式。' : '登录并校验身份后，采集当前账号真实返回的指标与作品。'}</p></div><button type="button" className="btn btn-primary btn-sm" onClick={onNavigateAccounts}>前往账号中心</button></div>}
              {platform === 'xiaohongshu' ? <XhsInsightsPanel key={`xhs-${revision}`} loggedIn={available} onNavigateIdeas={onNavigateIdeas} autoCollectSignal={autoCollectSignal} onAutoCollectHandled={onAutoCollectHandled} /> : <PlatformAnalysisPanel showPlatformPicker={false} key={platform} accounts={mappedAccounts} platform={platform} onPlatformChange={setPlatform} revision={revision} />}
            </>}
          </section>
          <aside className="ca-guide" aria-label="复盘指引">
            <div className="ca-guide-card"><p className="ca-kicker">REVIEW NOTES</p><h2>把数据变成下一步</h2><ol><li><span>01</span><div><strong>确认范围</strong><p>先看来源、时间和作品覆盖，确认正在分析谁的数据。</p></div></li><li><span>02</span><div><strong>回到作品</strong><p>打开作品和原始依据，寻找可复用的主题与值得改进的细节。</p></div></li><li><span>03</span><div><strong>带着问题创作</strong><p>把发现记录成选题，下一篇聚焦一项可验证的改动。</p></div></li></ol></div>
            <div className="ca-scope-card"><h3>本平台的分析边界</h3><p>{selected.limit}</p><button type="button" className="ca-text-button" onClick={() => setSection('method')}>查看完整数据口径 <span aria-hidden="true">→</span></button></div>
          </aside>
        </div>
      </div>

      {section === 'method' && <section className="ca-method" aria-labelledby="ca-method-title">
        <div className="ca-section-intro"><p className="ca-kicker">02 / DATA NOTES</p><h2 id="ca-method-title">看懂数据，也看懂它的边界</h2><p>数值、来源和观察时间一起，才构成可靠的复盘依据。</p></div>
        <dl className="ca-source-list"><div><dt>所选平台</dt><dd><PlatformIcon platform={platform} name={selected.name} />{selected.name}</dd></div><div><dt>读取来源</dt><dd>{selected.source}</dd></div><div><dt>当前能力</dt><dd>{selected.scope}</dd></div><div><dt>使用范围</dt><dd>{selected.limit}</dd></div></dl>
        <details className="ca-method-sources">
          <summary>分析方法与来源 <span>产品参考、官方指标与本地检查的区别</span></summary>
          <p>当前自动诊断采用本地编辑检查：统计字数与段落、识别提问或步骤标记，并引用实际提供的文字作为依据。编辑提醒的阈值不是平台标准；尚未通过真实账号的效果研究验证这些建议。</p>
          <ul>
            <li><a href="https://buffer.com/insights" target="_blank" rel="noreferrer">Buffer Insights ↗</a><span>参考概览、作品下钻、指标解释与下一步行动的组织方式，不能作为建议有效的证明。</span></li>
            <li><a href="https://sproutsocial.com/features/social-media-analytics/" target="_blank" rel="noreferrer">Sprout Social Analytics ↗</a><span>参考分析报告与内容复盘的产品设计，不代表本工具的诊断方法已被其验证。</span></li>
            <li><a href="https://developers.weixin.qq.com/doc/service/guide/product/analysis_data/analysis_data.html" target="_blank" rel="noreferrer">微信官方数据统计接口说明 ↗</a><span>用于核对相应官方接口的指标、权限与更新时间；仅适用于对应接口，不泛化到七个平台或所有微信账号。</span></li>
          </ul>
          <p>AI 深度解释是可选的模型解读，原文引用校验只确认引用来自已有材料，不证明解释正确或能提升表现。实验回收保存真实观测，结论仍需结合样本、统计窗口与其他影响因素判断。</p>
        </details>
        <div className="ca-method-grid">
          <article><span>01</span><h3>缺失与 0 分开</h3><p>未返回、解析失败或没有权限的指标显示为缺失。只有平台明确返回 0，才代表没有观测到该项活动。</p></article>
          <article><span>02</span><h3>先对齐时间，再比较</h3><p>发布一小时与发布一个月的累计点赞不能直接评优劣。没有可靠的发布时间和快照时，保留原始数值，不推算增长趋势。</p></article>
          <article><span>03</span><h3>每个平台各用各的口径</h3><p>播放次数、阅读人数、曝光和触达不是同一个指标。赞、藏、评也不能混为互动率；缺少分母时不计算比率。</p></article>
          <article><span>04</span><h3>返回作品不等于全部作品</h3><p>采集可能只覆盖最近一页。结论适用于实际返回的样本，不能扩展成账号全历史或整个行业的表现。</p></article>
          <article><span>05</span><h3>内容诊断需要内容材料</h3><p>只有标题和标签时只讨论这些材料。没有正文、封面或音视频证据时，不评价文章结构、配色或视频开场。</p></article>
          <article><span>06</span><h3>建议是一项待验证假设</h3><p>高表现作品提供线索，不证明某种写法必然有效。保留作品依据与反例，在下一次创作中验证具体改动。</p></article>
        </div>
        <div className="ca-method-footer"><p>上方工作台保存作品材料与观测记录，支持主题复盘、实验基线和手动回收。跨平台排名、因果归因和没有材料的视觉判断不作为结论。</p><button type="button" className="btn btn-sm" onClick={() => setSection('review')}>回到内容复盘</button></div>
      </section>}
    </div>
  </div>;
}
