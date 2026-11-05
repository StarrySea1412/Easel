import type { ChatImageJob } from '../lib/chatArtifacts';
import '../styles/xhs-card-set.css';

export default function XhsCardSetStatus({jobs}: {jobs: ChatImageJob[]}) {
  const sets = new Map(jobs.filter(job => job.cardSet && job.cardSet.sessionId === job.sessionId && job.cardSet.turnId === job.turnId)
    .map(job => [job.cardSet!.cardSetId, job.cardSet!]));
  return <>{[...sets.values()].map(set => <div key={set.cardSetId} className="xhs-card-set" role="status" aria-label="小红书三图卡组状态">
    <strong>小红书卡组 · 已保存 {set.ready}/3</strong>
    <span>{set.complete && set.qualityState === 'assistant_reviewed' ? '助手审图通过' : '待质量验收'}</span>
    <ol>{[1,2,3].map((index) => {const card=set.cards.find(c=>c.cardIndex===index);
      return <li key={index}><b>{['封面','核心卖点','场景与收尾'][index-1]}</b><span>{card?.ready?'已保存':card?.phase==='queued'?'排队中':card?.phase==='running'?'生成中':'需核对'}</span>{!card?.ready&&card?.error&&<small>{card.error}</small>}</li>;
    })}</ol>
    {!set.complete&&<small>三张图片保存后，还需逐张检查文案、主体、风格和构图。</small>}
  </div>)}</>;
}
