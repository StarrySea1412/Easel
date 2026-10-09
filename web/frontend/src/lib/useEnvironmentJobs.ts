import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchEnvJobs, retryEnvInstall, startEnvInstallBatch } from './api';
import type { EnvInstallResponse, EnvJob } from './api';

export const envJobActive = (job: EnvJob) => job.state === 'running' || job.state === 'queued';

/** Installation ownership stays on the server; this hook only observes it. */
export function useEnvironmentJobs(onSettled: () => void) {
  const [jobs, setJobs] = useState<EnvJob[]>([]);
  const [connectionError, setConnectionError] = useState('');
  const [operationError, setOperationError] = useState('');
  const [blockedReason, setBlockedReason] = useState('');
  const [notice, setNotice] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [reading, setReading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [lastSynced, setLastSynced] = useState<number | null>(null);
  const alive = useRef(false);
  const epoch = useRef(0);
  const revision = useRef(0);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const sending = useRef(false);
  const latest = useRef<EnvJob[]>([]);
  const canSend = useRef(false);
  const settled = useRef(onSettled);
  settled.current = onSettled;

  const readJobs = useCallback((): Promise<boolean> => {
    if (inFlight.current) return inFlight.current;
    const generation = epoch.current;
    const startedAtRevision = revision.current;
    setReading(true);
    const request = (async () => {
      try {
        const data = await fetchEnvJobs();
        if (!alive.current || epoch.current !== generation) return false;
        // A read started before a POST may omit its new jobs. Keep the POST
        // result until the next poll instead of briefly re-enabling install.
        if (revision.current !== startedAtRevision) return true;
        const next = Array.isArray(data.jobs) ? data.jobs : [];
        const recoveringFinished = latest.current.length === 0 && next.some(job => !envJobActive(job));
        const completed = latest.current.some(old => envJobActive(old) &&
          next.some(current => current.jobId === old.jobId && !envJobActive(current)));
        latest.current = next;
        setJobs(next);
        setBlockedReason(data.blockedReason || '');
        setConnectionError('');
        setLoaded(true);
        setLastSynced(Date.now());
        canSend.current = !data.blockedReason;
        if ((completed || recoveringFinished) && !next.some(envJobActive)) settled.current();
        return true;
      } catch (error) {
        if (alive.current && epoch.current === generation) {
          canSend.current = false;
          setConnectionError(error instanceof Error ? error.message : '暂时无法连接工作台');
        }
        return false;
      } finally {
        if (alive.current && epoch.current === generation) setReading(false);
      }
    })();
    inFlight.current = request;
    void request.finally(() => { if (inFlight.current === request) inFlight.current = null; });
    return request;
  }, []);

  useEffect(() => {
    alive.current = true;
    epoch.current += 1;
    let stopped = false;
    let failures = 0;
    let cycle = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const currentCycle = ++cycle;
      if (timer) clearTimeout(timer);
      const ok = await readJobs();
      if (stopped || currentCycle !== cycle) return;
      failures = ok ? 0 : failures + 1;
      const delay = failures ? Math.min(15000, 1500 * 2 ** Math.min(failures, 4)) : latest.current.some(envJobActive) ? 1500 : 5000;
      timer = setTimeout(() => void tick(), delay);
    };
    const reconnect = () => { void tick(); };
    void tick();
    window.addEventListener('online', reconnect);
    return () => {
      stopped = true;
      alive.current = false;
      epoch.current += 1;
      inFlight.current = null;
      canSend.current = false;
      if (timer) clearTimeout(timer);
      window.removeEventListener('online', reconnect);
    };
  }, [readJobs]);

  const submit = useCallback(async (request: () => Promise<EnvInstallResponse>) => {
    if (sending.current || !canSend.current) return;
    sending.current = true;
    setSubmitting(true);
    setOperationError('');
    setNotice('');
    const generation = epoch.current;
    revision.current += 1;
    try {
      const response = await request();
      if (!alive.current || epoch.current !== generation) return;
      revision.current += 1;
      const merged = new Map(latest.current.map(job => [job.jobId, job]));
      response.jobs.forEach(job => merged.set(job.jobId, job));
      latest.current = [...merged.values()];
      setJobs(latest.current);
      setNotice(response.reused ? '已接回现有安装任务，继续查看进度。' : '已加入后台队列，可切换页面，返回后继续查看。');
    } catch (error) {
      if (!alive.current || epoch.current !== generation) return;
      setOperationError(`${error instanceof Error ? error.message : '安装请求未确认'}。正在核对后台任务，请勿重复提交。`);
    } finally {
      sending.current = false;
      if (alive.current && epoch.current === generation) {
        // The initial POST response can be lost even after it was accepted.
        // Always reconcile before allowing another submit; reads never turn a
        // running installation into a failure.
        canSend.current = false;
        if (inFlight.current) await inFlight.current;
        await readJobs();
        if (alive.current && epoch.current === generation) setSubmitting(false);
      }
    }
  }, [readJobs]);

  const install = useCallback((ids: string[]) => submit(() => startEnvInstallBatch(ids)), [submit]);
  const retry = useCallback((jobId: string) => submit(() => retryEnvInstall(jobId)), [submit]);

  return { jobs, connectionError, operationError, blockedReason, notice, loaded, reading,
    submitting, lastSynced, install, retry, reconnect: readJobs };
}
