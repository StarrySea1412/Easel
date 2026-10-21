import type { AnalysisBinding } from '../lib/analysisBinding';
import { useCallback, useState } from 'react';
import AnalysisMaterialDialog from './AnalysisMaterialDialog';
import { frozenEvidence } from '../lib/analysisVisuals';
import PlatformIcon from './PlatformIcon';
import { IconChevron } from './icons';
import '../styles/analysis-composer.css';

const PLATFORM_NAMES: Record<string, string> = { douyin:'抖音', xiaohongshu:'小红书', bilibili:'哔哩哔哩', zhihu:'知乎', kuaishou:'快手', 'wechat-oa':'微信公众号', 'weixin-channels':'视频号' };

export default function AnalysisComposerMaterial({ context, onOpen }: { context: AnalysisBinding; onOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(()=>setOpen(false),[]);
  const works = frozenEvidence(context.markdown, context.contentIds);
  const label = context.kind === 'content-analysis' ? '作品分析材料' : '账号分析材料';
  const platformName = PLATFORM_NAMES[context.platform] || context.platform;
  return <section className="analysis-composer-material" aria-label={label}>
    <div className="analysis-composer-material-heading">
      <PlatformIcon platform={context.platform} name={platformName}/>
      <strong className="analysis-composer-material-title" title={context.accountName}>{context.accountName}</strong>
    </div>
    <div className="analysis-composer-material-meta"><span>{platformName}</span><span>{context.contentIds.length} 篇作品</span></div>
    {works.length > 0 && <p className="analysis-composer-work-preview" title={works.map(work=>work.title).join('；')}>{works[0].title}{works.length > 1 && <span> 等 {works.length} 篇</span>}</p>}
    <div className="analysis-composer-material-footer"><time dateTime={context.createdAt} title={new Date(context.createdAt).toLocaleString('zh-CN')}>{new Date(context.createdAt).toLocaleDateString('zh-CN')}</time><button type="button" className="btn btn-sm" onClick={()=>setOpen(true)} aria-label="查看分析材料">查看材料<IconChevron size={12}/></button></div>
    {open && <AnalysisMaterialDialog context={context} onClose={close} onOpenPanel={onOpen}/>}
  </section>;
}
