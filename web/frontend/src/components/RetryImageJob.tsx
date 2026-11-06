import { useEffect, useRef, useState } from 'react';
import type { ChatImageJob } from '../lib/chatArtifacts';
import '../styles/image-job-retry.css';

export default function RetryImageJob({ job, onChanged }: { job: ChatImageJob; onChanged?: () => void }) {
  const [busy, setBusy] = useState(false), [note, setNote] = useState(''), [submitted, setSubmitted] = useState(false);
  const pending = useRef(false), controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  if (job.phase !== 'error' || !job.retryAvailable) return null;
  const retry = async () => {
    if (pending.current || submitted) return;
    pending.current = true; setBusy(true); setNote('');
    const request = new AbortController(); controller.current = request;
    try {
      const base = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
      const response = await fetch(`${base}/api/chat/artifacts/${encodeURIComponent(job.sessionId)}/jobs/${job.jobId}/retry`, { method: 'POST', signal: request.signal });
      const value = await response.json();
      if (!response.ok) throw new Error(typeof value.detail === 'string' ? value.detail : '重试未成功，请稍后核对任务。');
      if (!request.signal.aborted) { setSubmitted(true); setNote('已提交单张重试，成功图片已保留'); onChanged?.(); }
    } catch (error) {
      if (!request.signal.aborted) setNote(error instanceof Error ? error.message : '重试请求未确认，请刷新核对；再次点击不会重复创建。');
    } finally {
      pending.current = false;
      if (!request.signal.aborted) setBusy(false);
    }
  };
  return <div className="image-job-retry"><button type="button" disabled={busy || submitted} onClick={() => void retry()}>{busy ? '正在提交重试…' : submitted ? '已提交重试' : '重试失败图片'}</button><small>仅重试此张，可能产生新的生图费用</small>{note && <p role="status">{note}</p>}</div>;
}
