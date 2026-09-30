import { useEffect, useRef, useState } from 'react';
import '../styles/skill-audit.css';

type Critique = { text: string; model: string; at: string | number };
type AuditRecord = {
  sessionId: string;
  turnId: string;
  started: string | number;
  status: string;
  invocation: { skill: string; status: string; evidence: { summary: string }[] }[];
  quality: {
    status: string;
    checks: { name: string; status: string; detail: string }[];
    artifacts: { path: string; kind: string }[];
    rubric: unknown[];
  };
  critique?: Critique;
};

const STATUS: Record<string, string> = {
  executed: '有执行证据', attempted: '已尝试调用', loaded: '已加载说明', not_observed: '未观察到调用证据',
  running: '进行中', completed: '已结束', finished: '已结束', error: '异常', failed: '未通过',
  passed: '通过', pass: '通过', fail: '未通过', skipped: '未检查', unknown: '待核实',
  pending: '待检查', cancelled: '已停止', interrupted: '已中断', unavailable: '不可用',
  stopped: '已停止', issues_found: '发现技术问题', needs_review: '待人工验收', unverified: '未验证',
};
function label(status: string) { return STATUS[status] || status || '待核实'; }
function timeLabel(value: string | number) {
  const time = new Date(typeof value === 'number' ? value * 1000 : value);
  return Number.isNaN(time.getTime()) ? '时间未记录' : time.toLocaleString('zh-CN', { hour12: false });
}
function apiBase() { return window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, ''); }
async function readResponse(response: Response) {
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Skill 核验请求失败');
  return result;
}

export default function SkillAuditPanel({ sessionId, refreshKey, isStreaming = false, embedded = false }: {
  sessionId: string; refreshKey?: number; isStreaming?: boolean; embedded?: boolean;
}) {
  // Keying the inner panel also isolates in-flight reviews and expanded rows on session changes.
  return <SessionAuditPanel key={sessionId} sessionId={sessionId} refreshKey={refreshKey} isStreaming={isStreaming} embedded={embedded} />;
}

function SessionAuditPanel({ sessionId, refreshKey, isStreaming, embedded }: {
  sessionId: string; refreshKey?: number; isStreaming: boolean; embedded: boolean;
}) {
  const [expanded, setOpen] = useState(false);
  const open = embedded || expanded;
  const [records, setRecords] = useState<AuditRecord[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({});
  const [critiques, setCritiques] = useState<Record<string, Critique>>({});
  const reviewController = useRef<AbortController | null>(null);
  useEffect(() => () => { reviewController.current?.abort(); }, []);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    fetch(`${apiBase()}/api/skill-audits?${new URLSearchParams({ sessionId })}`, {
      cache: 'no-store', signal: controller.signal,
    }).then(readResponse).then((result: { records: AuditRecord[] }) => {
      if (!Array.isArray(result.records)) throw new Error('Skill 核验记录格式不正确');
      if (!controller.signal.aborted) setRecords(result.records.filter((record) => record.sessionId === sessionId));
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '核验记录读取失败');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [sessionId, open, refreshKey, isStreaming, revision]);

  async function review(turnId: string) {
    if (reviewController.current) return;
    const controller = new AbortController();
    reviewController.current = controller;
    setReviewing(turnId);
    setReviewErrors((current) => ({ ...current, [turnId]: '' }));
    try {
      const result = await fetch(`${apiBase()}/api/skill-audits/critique`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, turnId }), signal: controller.signal,
      }).then(readResponse) as Critique;
      if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('评审未返回有效内容，请重试');
      if (!controller.signal.aborted) {
        setCritiques((current) => ({ ...current, [turnId]: result }));
        setRevision((current) => current + 1);
      }
    } catch (failure: unknown) {
      if (!controller.signal.aborted) setReviewErrors((current) => ({ ...current,
        [turnId]: failure instanceof Error ? failure.message : '效果评审失败，请重试',
      }));
    } finally {
      if (!controller.signal.aborted) setReviewing(null);
      if (reviewController.current === controller) reviewController.current = null;
    }
  }

  return <section className={`skill-audit-panel${open ? ' is-open' : ''}`} style={embedded ? { margin: 0 } : undefined} aria-label="Skill 核验与效果评估">
    {!embedded && <button type="button" className="skill-audit-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <span aria-hidden="true">◎</span><span>Skill 核验与效果评估</span><span aria-hidden="true">{open ? '⌃' : '⌄'}</span>
    </button>}
    {open && <div className="skill-audit-body" style={embedded ? { maxHeight: 'none', overflow: 'visible', paddingTop: 14 } : undefined}>
      <div className="skill-audit-toolbar">
        <p className="skill-audit-note">调用证据、技术检查与 AI 效果评审分别记录，互不代表通过。</p>
        <button type="button" className="btn btn-sm" disabled={loading} onClick={() => setRevision((value) => value + 1)}>{loading ? '读取中…' : '刷新核验'}</button>
      </div>
      {error && <p className="skill-audit-error" role="alert">{error}{records ? '；下方保留上次读取结果。' : ''}</p>}
      {isStreaming && <p className="skill-audit-note">对话进行中，证据尚可能不完整；本轮结束后自动刷新。</p>}
      {loading && !records && <p className="skill-audit-note" role="status">正在读取核验记录…</p>}
      {records?.length === 0 && <p className="skill-audit-empty">本会话暂无核验记录。没有记录不代表 Skill 未执行，也不能据此判断效果通过。</p>}
      {records?.map((record) => {
        const critique = critiques[record.turnId] || record.critique;
        return <details className="skill-audit-turn" key={record.turnId}>
          <summary><span>{timeLabel(record.started)}</span><span>{label(record.status)}</span><span>查看本轮核验</span></summary>
          <p className="skill-audit-note">轮次：{record.turnId}</p>
          <h3>调用证据</h3>
          {!record.invocation?.length && <p className="skill-audit-note">没有可用调用证据，执行情况待核实。</p>}
          {record.invocation?.map((item, index) => <div className="skill-audit-item" key={`${item.skill}-${index}`}>
            <div className="skill-audit-item-heading"><strong>{item.skill}</strong><span>{label(item.status)}</span></div>
            {item.evidence?.length ? <ul>{item.evidence.map((evidence, i) => <li key={i}>{evidence.summary}</li>)}</ul>
              : <p className="skill-audit-note">未提供证据详情，不能据此断言未执行。</p>}
          </div>)}
          <h3>技术检查</h3>
          <p className="skill-audit-note">检查状态：{label(record.quality?.status)}。技术检查仅反映已检查项目，不代表内容质量达标。</p>
          {!record.quality?.checks?.length && <p className="skill-audit-note">暂无技术检查结果。</p>}
          {record.quality?.checks?.map((check, index) => <div className="skill-audit-item" key={`${check.name}-${index}`}>
            <div className="skill-audit-item-heading"><strong>{check.name}</strong><span>{label(check.status)}</span></div>
            <p>{check.detail}</p>
          </div>)}
          {!!record.quality?.artifacts?.length && <><h4>已记录产物</h4><ul>{record.quality.artifacts.map((artifact, index) => <li key={index}><code>{artifact.path}</code> <span>（{artifact.kind}）</span></li>)}</ul></>}
          <h3>AI 效果评审</h3>
          <p className="skill-audit-note">按需调用模型评估，会产生模型用量。评审是辅助意见，不能替代实际验收。</p>
          <button type="button" className="btn btn-sm" disabled={isStreaming || reviewing !== null || ['running', 'pending'].includes(record.status)} onClick={() => void review(record.turnId)}>
            {reviewing === record.turnId ? '正在评审…' : critique ? '重新评估效果' : '评估效果'}
          </button>
          {reviewErrors[record.turnId] && <p className="skill-audit-error" role="alert">{reviewErrors[record.turnId]}</p>}
          {critique ? <div className="skill-audit-critique"><p>{critique.text}</p><small>{critique.model || '模型未记录'} · {timeLabel(critique.at)}</small></div>
            : <p className="skill-audit-note">尚未进行 AI 效果评审。</p>}
        </details>;
      })}
    </div>}
  </section>;
}
