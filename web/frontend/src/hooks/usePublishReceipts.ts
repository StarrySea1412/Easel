import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchPublishBatch, fetchPublishReceipt, fetchPublishReceipts, publishBatch, submitPublishSms, verifyPublishReceipt, setPublishVerification, reportPublishFailure } from '../lib/api';
import type { PublishBatchStatus, PublishReceipt, PublishRequest } from '../lib/api';
import { isFinalPublishReceipt, isPublishReceipt, mergePublishReceipts, publishPlatformLabel } from '../lib/publishReceipts';
import { markWhoamiUnverified } from '../lib/whoami';

export interface PublishSubmissionIssue {
  platform: string;
  title: string;
  message: string;
}

export interface PublishBatchEntryView {
  platform: string;
  state: string; // accepted | running | finished | rejected
  outcome: string | null;
  message: string;
}

export interface PublishBatchView {
  batchId: string;
  state: string; // running | completed | interrupted
  message: string;
  platforms: PublishBatchEntryView[];
}

const BATCH_POLL_MS = 2500;
const BATCH_MAX_WAIT_MS = 30 * 60 * 1000;

/** Owned by App: changing pages never restarts a POST or loses a running publish task. */
export function usePublishReceipts() {
  const [receipts, setReceipts] = useState<PublishReceipt[]>([]);
  const [noticeIds, setNoticeIds] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submittingPlatforms, setSubmittingPlatforms] = useState<string[]>([]);
  const [submissionIssues, setSubmissionIssues] = useState<PublishSubmissionIssue[]>([]);
  const [batch, setBatch] = useState<PublishBatchView | null>(null);
  const [verificationBusyIds, setVerificationBusyIds] = useState<string[]>([]);
  const mounted = useRef(false);
  const current = useRef<PublishReceipt[]>([]);
  const initialized = useRef(false);
  const seenOutcomes = useRef(new Set<string>());
  const submittingRef = useRef(false);
  const smsRequests = useRef(new Set<string>());
  const verificationRequests = useRef(new Set<string>());
  const refreshImpl = useRef<() => Promise<void>>(async () => {});
  // Last submitted batch: immutable payloads plus the latest per-platform states,
  // used only to offer an explicit retry of clearly failed platforms.
  const batchRef = useRef<{ batchId: string; requests: PublishRequest[]; platforms: PublishBatchEntryView[] } | null>(null);

  const accept = useCallback((incoming: PublishReceipt[], quiet = false) => {
    if (!mounted.current) return;
    const previous = new Map(current.current.map(item => [item.receiptId, item]));
    const merged = mergePublishReceipts(current.current, incoming);
    const mergedById = new Map(merged.map(item => [item.receiptId, item]));
    const nextNotices: string[] = [];
    for (const item of incoming) {
      const latest = mergedById.get(item.receiptId);
      if (!latest || !isFinalPublishReceipt(latest)) continue;
      const loginRequired = latest.platformStatus === 'login_required' || latest.verification?.state === 'login_required';
      const key = `${latest.receiptId}:${latest.outcome}:${loginRequired ? 'login_required' : ''}`;
      if (seenOutcomes.current.has(key)) continue;
      seenOutcomes.current.add(key);
      const old = previous.get(latest.receiptId);
      if (!quiet || (old && !isFinalPublishReceipt(old))) {
        nextNotices.push(latest.receiptId);
        if (loginRequired) markWhoamiUnverified(latest.platform, '平台回执提示登录失效，请重新检查账号；先核对作品结果，避免重复发布。');
        if (latest.outcome === 'failed' || loginRequired) void reportPublishFailure(latest.platform, 'receipt', loginRequired ? 'login_required' : 'publish_failed',
          undefined, performance.now(), latest.receiptId);
      }
    }
    current.current = merged;
    setReceipts(merged);
    if (nextNotices.length) setNoticeIds(ids => [...new Set([...nextNotices, ...ids])].slice(0, 50));
  }, []);

  const refresh = useCallback(() => refreshImpl.current(), []);

  useEffect(() => {
    mounted.current = true;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let inFlight: Promise<void> | null = null;
    let lastListAt = 0;
    let forceList = true;

    const run = (): Promise<void> => {
      if (!alive) return Promise.resolve();
      if (inFlight) return inFlight;
      clearTimeout(timer);
      const listDue = forceList || !initialized.current || Date.now() - lastListAt >= 15000;
      forceList = false;
      controller = new AbortController();
      const signal = controller.signal;
      deadline = setTimeout(() => controller?.abort(), 12000);
      setRefreshing(true);
      inFlight = (async () => {
        try {
          if (listDue) {
            const items = await fetchPublishReceipts(signal);
            if (!alive) return;
            if (signal.aborted) throw new Error('发布回执更新超时，已保留最近状态。');
            if (!Array.isArray(items) || !items.every(isPublishReceipt)) throw new Error('发布回执格式不受支持，请检查服务版本。');
            accept(items, !initialized.current);
            initialized.current = true;
            lastListAt = Date.now();
            setLoaded(true);
          } else {
            const pending = current.current.filter(item => !isFinalPublishReceipt(item));
            const results = await Promise.allSettled(pending.map(item => fetchPublishReceipt(item.receiptId, signal)));
            if (!alive) return;
            if (signal.aborted) throw new Error('发布回执更新超时，已保留最近状态。');
            const fresh = results.flatMap(result => result.status === 'fulfilled' && isPublishReceipt(result.value) ? [result.value] : []);
            accept(fresh);
            if (fresh.length !== pending.length) throw new Error('部分发布回执暂时无法更新，已保留最近状态。');
          }
          if (alive) setError('');
        } catch (cause) {
          if (alive) setError(cause instanceof Error && cause.name !== 'AbortError'
            ? cause.message : '发布回执更新超时，已保留最近状态。');
        } finally {
          clearTimeout(deadline);
          inFlight = null;
          if (alive) {
            setRefreshing(false);
            const active = current.current.some(item => !isFinalPublishReceipt(item));
            timer = setTimeout(() => { void run(); }, forceList ? 0 : active ? 2500 : 15000);
          }
        }
      })();
      return inFlight;
    };

    const requestRefresh = () => { forceList = true; return run(); };
    const wake = () => { void requestRefresh(); };
    refreshImpl.current = requestRefresh;
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    void run();
    return () => {
      alive = false;
      mounted.current = false;
      clearTimeout(timer);
      clearTimeout(deadline);
      controller?.abort();
      refreshImpl.current = async () => {};
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
    };
  }, [accept]);

  const submit = useCallback(async (requests: PublishRequest[]) => {
    if (submittingRef.current || !requests.length || !mounted.current) return;
    // A confirmed batch owns an immutable payload even if the editor changes or unmounts.
    const batch = requests.map(item => ({ ...item, payload: { ...item.payload, media: [...item.payload.media] } }));
    submittingRef.current = true;
    setSubmitting(true);
    setIsOpen(true);
    setSubmissionIssues([]);
    setSubmittingPlatforms(batch.map(item => item.platform));
    setBatch(null);
    const issue = (request: PublishRequest, message: string) => {
      if (mounted.current) setSubmissionIssues(items => [...items, { platform: request.platform, title: request.payload.title, message }]);
    };
    try {
      let result;
      try {
        // One server-held batch: closing the page can no longer drop the
        // remaining confirmed platforms the way the old client loop could.
        result = await publishBatch(batch);
      } catch (cause) {
        // 受理请求整体失败：批次未创建，内容保留；逐平台登记原因便于排查。
        for (const request of batch) {
          if (!mounted.current) break;
          const id = await reportPublishFailure(request.platform, 'submit', 'receipt_missing', cause);
          const message = cause instanceof Error ? cause.message : '发布请求中断';
          issue(request, `${message}${id && !message.includes(id) ? `（错误编号：${id}）` : ''} 内容已保留，请检查后重试。`);
        }
        return;
      }
      if (!mounted.current) return;
      const rejected = Array.isArray(result?.rejected) ? result.rejected : [];
      for (const item of rejected) {
        const request = batch.find(candidate => candidate.platform === item.platform);
        if (request) issue(request, `${item.reason || '该平台未受理。'} 内容已保留，处理后再试。`);
      }
      const accepted = Array.isArray(result?.accepted) ? result.accepted : [];
      if (!accepted.length || !/^[0-9a-f]{32}$/.test(result.batchId || '')) {
        if (rejected.length >= batch.length) return; // 每个平台都已明确拒绝并登记
        // 服务返回不可用：绝不当作成功，也不自动重试。
        for (const request of batch.filter(item => !rejected.some(entry => entry.platform === item.platform))) {
          issue(request, '服务未返回可恢复的发布回执，请先到平台核对结果，避免重复发布。');
        }
        return;
      }
      const platforms: PublishBatchEntryView[] = (result.accepted).map(item => ({
        platform: item.platform, state: 'accepted', outcome: null, message: '',
      }));
      batchRef.current = { batchId: result.batchId, requests: batch, platforms };
      setBatch({ batchId: result.batchId, state: 'running', message: '', platforms });
      void refresh(); // 受理阶段已为每个平台创建回执，先拉一次列表
      const deadline = Date.now() + BATCH_MAX_WAIT_MS;
      while (mounted.current && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, BATCH_POLL_MS));
        if (!mounted.current) return;
        let status: PublishBatchStatus;
        try {
          status = await fetchPublishBatch(result.batchId);
        } catch {
          continue; // 单次查询失败保留当前进度，下一轮继续；批次在服务端继续执行
        }
        if (!status || typeof status.batchId !== 'string' || !Array.isArray(status.platforms)) continue;
        const entries: PublishBatchEntryView[] = status.platforms.map(entry => ({
          platform: entry.platform, state: String(entry.state),
          outcome: entry.outcome ?? null, message: entry.message || '',
        }));
        batchRef.current = { batchId: result.batchId, requests: batch, platforms: entries };
        if (mounted.current) {
          setBatch({ batchId: result.batchId, state: String(status.state), message: status.message || '', platforms: entries });
          setSubmittingPlatforms(entries
            .filter(entry => entry.state === 'accepted' || entry.state === 'running')
            .map(entry => entry.platform));
        }
        if (status.state !== 'running') return;
      }
    } finally {
      submittingRef.current = false;
      if (mounted.current) { setSubmitting(false); setSubmittingPlatforms([]); void refresh(); }
    }
  }, [refresh]);

  /** 只重试明确失败/未受理的平台；绝不重发已成功或结果未核实的平台。 */
  const retryFailed = useCallback(() => {
    const last = batchRef.current;
    if (!last || submittingRef.current || !mounted.current) return;
    const failed = new Set(last.platforms
      .filter(entry => entry.state === 'rejected' || (entry.state === 'finished' && entry.outcome === 'failed'))
      .map(entry => entry.platform));
    const requests = last.requests.filter(item => failed.has(item.platform));
    if (!requests.length) return;
    void submit(requests);
  }, [submit]);

  const submitSms = useCallback(async (receiptId: string, code: string) => {
    const receipt = current.current.find(item => item.receiptId === receiptId);
    if (!receipt || isFinalPublishReceipt(receipt) || receipt.state !== 'sms_required') throw new Error('该验证任务已变化，请刷新发布回执后再操作。');
    if (!/^\d{4,8}$/.test(code)) throw new Error('请输入 4–8 位数字验证码。');
    if (smsRequests.current.has(receiptId)) return;
    smsRequests.current.add(receiptId);
    try {
      await submitPublishSms(receipt.platform, code, receiptId);
      await refresh();
    } finally { smsRequests.current.delete(receiptId); }
  }, [refresh]);

  const verify = useCallback(async (receiptId: string, automatic?: boolean) => {
    if (verificationRequests.current.has(receiptId) || !mounted.current) return;
    verificationRequests.current.add(receiptId);
    setVerificationBusyIds(ids => [...ids, receiptId]);
    try {
      const result = automatic === undefined ? await verifyPublishReceipt(receiptId)
        : await setPublishVerification(receiptId, automatic);
      if (!isPublishReceipt(result)) throw new Error('服务返回的核实状态不完整，请刷新回执。');
      accept([result]);
    } finally {
      verificationRequests.current.delete(receiptId);
      if (mounted.current) setVerificationBusyIds(ids => ids.filter(id => id !== receiptId));
    }
  }, [accept]);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const dismissNotices = useCallback(() => setNoticeIds([]), []);
  const dismissIssues = useCallback(() => setSubmissionIssues([]), []);
  const notices = noticeIds.flatMap(id => {
    const receipt = receipts.find(item => item.receiptId === id);
    return receipt ? [receipt] : [];
  });
  const active = receipts.filter(item => !isFinalPublishReceipt(item));
  const verification = active.filter(item => item.state === 'sms_required');
  const checking = receipts.filter(item => item.verification?.state === 'checking');

  return {
    receipts, notices, active, verification, checking, loaded, refreshing, error, isOpen,
    submitting, submittingPlatforms, submissionIssues, verificationBusyIds, batch, refresh, submit, retryFailed, submitSms, verify,
    open, close, dismissNotices, dismissIssues,
    submittingLabel: submittingPlatforms.map(publishPlatformLabel).join('、'),
  };
}

export type PublishReceiptsModel = ReturnType<typeof usePublishReceipts>;
