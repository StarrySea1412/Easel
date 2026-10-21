import type { AnalysisBinding } from '../lib/analysisBinding';
import { useCallback, useState } from 'react';
import AnalysisMaterialDialog from './AnalysisMaterialDialog';
import { frozenEvidence } from '../lib/analysisVisuals';
import PlatformIcon from './PlatformIcon';
import { IconChart, IconChevron } from './icons';
import '../styles/analysis-composer.css';

const PLATFORM_NAMES: Record<string, string> = { douyin:'抖音', xiaohongshu:'小红书', bilibili:'哔哩哔哩', zhihu:'知乎', kuaishou:'快手', 'wechat-oa':'微信公众号', 'weixin-channels':'视频号' };

export default function AnalysisComposerMaterial({ context, onOpen }: { context: AnalysisBinding; onOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(()=>setOpen(false),[]);
  const works = frozenEvidence(context.markdown, context.contentIds);
  const label = context.kind === 'content-analysis' ? '作品分析材料' : '账号分析材料';
  return <section className="analysis-composer-material" aria-label={label}>
    <div className="analysis-composer-material-heading">
      <span className="analysis-composer-material-icon"><IconChart size={19}/></span>
      <div className="analysis-composer-material-identity"><strong title={context.accountName}>{context.accountName}</strong><span><PlatformIcon platform={context.platform} name={PLATFORM_NAMES[context.platform] || context.platform}/>{PLATFORM_NAMES[context.platform] || context.platform}<i aria-hidden="true">·</i>{context.contentIds.length} 篇作品</span></div>
      <button type="button" className="btn btn-sm" onClick={()=>setOpen(true)} aria-label="查看分析材料">查看材料<IconChevron size={12}/></button>
    </div>
    {works.length > 0 && <p className="analysis-composer-work-preview" title={works.map(work=>work.title).join('；')}>{works[0].title}{works.length > 1 && <span> 等 {works.length} 篇</span>}</p>}
    <div className="analysis-composer-material-footer"><span>{label}</span><time dateTime={context.createdAt} title={new Date(context.createdAt).toLocaleString('zh-CN')}>{new Date(context.createdAt).toLocaleDateString('zh-CN')}</time></div>
    {open && <AnalysisMaterialDialog context={context} onClose={close} onOpenPanel={onOpen}/>}
  </section>;
}
