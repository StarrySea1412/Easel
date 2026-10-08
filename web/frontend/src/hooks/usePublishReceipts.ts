import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchPublishReceipt, fetchPublishReceipts, publishNow, submitPublishSms } from '../lib/api';
import type { PublishReceipt, PublishRequest } from '../lib/api';
import { isFinalPublishReceipt, isPublishReceipt, mergePublishReceipts, publishPlatformLabel } from '../lib/publishReceipts';

export interface PublishSubmissionIssue {
  platform: string;
  title: string;
  message: string;
}

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
  const mounted = useRef(false);
  const current = useRef<PublishReceipt[]>([]);
  const initialized = useRef(false);
  const seenOutcomes = useRef(new Set<string>());
  const submittingRef = useRef(false);
  const smsRequests = useRef(new Set<string>());
  const refreshImpl = useRef<() => Promise<void>>(async () => {});

  const accept = useCallback((incoming: PublishReceipt[], quiet = false) => {
    if (!mounted.current) return;
    const previous = new Map(current.current.map(item => [item.receiptId, item]));
    const merged = mergePublishReceipts(current.current, incoming);
    const mergedById = new Map(merged.map(item => [item.receiptId, item]));
    const nextNotices: string[] = [];
    for (const item of incoming) {
      const latest = mergedById.get(item.receiptId);
      if (!latest || !isFinalPublishReceipt(latest)) continue;
      const key = `${latest.receiptId}:${latest.outcome}`;
      if (seenOutcomes.current.has(key)) continue;
      seenOutcomes.current.add(key);
      const old = previous.get(latest.receiptId);
      if (!quiet || (old && !isFinalPublishReceipt(old))) nextNotices.push(latest.receiptId);
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
    const issue = (request: PublishRequest, message: string) => {
      if (mounted.current) setSubmissionIssues(items => [...items, { platform: request.platform, title: request.payload.title, message }]);
    };
    try {
      for (const request of batch) {
        if (!mounted.current) break;
        if (current.current.some(item => item.platform === request.platform && !isFinalPublishReceipt(item))) {
          issue(request, '该平台已有发布任务，请先查看现有回执。');
          continue;
        }
        try {
          const result = await publishNow(request.platform, request.payload);
          if (!mounted.current) break;
          if (isPublishReceipt(result)) accept([result]);
          else if (typeof result.receiptId === 'string' && /^[0-9a-f]{32}$/.test(result.receiptId)) {
            const receipt = await fetchPublishReceipt(result.receiptId);
            if (!isPublishReceipt(receipt)) throw new Error('服务返回的回执不完整。');
            accept([receipt]);
          } else {
            issue(request, '服务未返回可恢复的发布回执，请先到平台核对结果，避免重复发布。');
          }
        } catch (cause) {
          issue(request, `${cause instanceof Error ? cause.message : '发布请求中断'} 请先查看回执或到平台核对，避免重复发布。`);
        } finally {
          if (mounted.current) {
            setSubmittingPlatforms(items => items.filter(platform => platform !== request.platform));
            void refresh();
          }
        }
      }
    } finally {
      submittingRef.current = false;
      if (mounted.current) { setSubmitting(false); setSubmittingPlatforms([]); void refresh(); }
    }
  }, [accept, refresh]);

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

  return {
    receipts, notices, active, verification, loaded, refreshing, error, isOpen,
    submitting, submittingPlatforms, submissionIssues, refresh, submit, submitSms,
    open, close, dismissNotices, dismissIssues,
    submittingLabel: submittingPlatforms.map(publishPlatformLabel).join('、'),
  };
}

export type PublishReceiptsModel = ReturnType<typeof usePublishReceipts>;
