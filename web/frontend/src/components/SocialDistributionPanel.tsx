import { useCallback, useEffect, useRef, useState } from 'react';
import { accountState, socialAccounts, socialPlatforms, socialAccountReady, socialAccountStatus } from '../lib/socialAccounts';
import type { AccountPayload, AccountTarget, DistributionBatch, DistributionJob, SocialAccount, PublishAccountFocus } from '../lib/socialAccounts';
import type { OutputFile } from '../lib/api';
import { PUBLISH_OUTCOMES, publishPlatformLabel } from '../lib/publishReceipts';
import PlatformIcon from './PlatformIcon';
import { IconCheck, IconChevron, IconRefresh } from './icons';
import '../styles/social-accounts.css';

const DRAFT = 'easel_social_distribution_v1';
const PENDING = 'easel_social_distribution_pending_v1';
const CONTENT_CACHE = 'easel_social_distribution_content_v1';
type Pending = { requestKey: string; requests: AccountTarget[] };
export type PublishStep = 'content' | 'targets' | 'review' | 'results';
interface DistributionProps {
  accountFocus?:PublishAccountFocus; onOpenAccounts?:(accountId?:string)=>void;
  seed: AccountPayload; files: OutputFile[]; step?: PublishStep;
  onStepChange?: (step: PublishStep) => void;
  onSelectionChange?: (count: number, locked: boolean) => void;
}
function read<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback; } catch { return fallback; }
}
function key() {
  return crypto.randomUUID().replaceAll('-', '');
}
const describe = (job: DistributionJob) => job.state === 'finished'
  ? job.outcome ? PUBLISH_OUTCOMES[job.outcome]?.label || '待核实' : '待核实'
  : job.state === 'running' ? '执行中' : '排队中';

export function DistributionEditor({ seed, files, step, onStepChange, onSelectionChange, accountFocus, onOpenAccounts }: DistributionProps) {
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [drafts, setDrafts] = useState<Record<string, AccountPayload>>(() => read(DRAFT, {}));
  const [batches, setBatches] = useState<DistributionBatch[]>([]);
  const [pending, setPending] = useState<Pending | null>(() => read(PENDING, null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [editorId, setEditorId] = useState('');
  const [deferredAccount, setDeferredAccount] = useState('');
  const cachedDrafts = useRef<Record<string, AccountPayload>>({ ...read<Record<string, AccountPayload>>(CONTENT_CACHE, {}), ...drafts });
  const alive = useRef(true);
  const requestBusy = useRef(false);
  const focused = useRef(0);
  const [accountsLoaded,setAccountsLoaded]=useState(false);
  const refreshBusy = useRef(false);
  const refresh = useCallback(async () => {
    if (refreshBusy.current) return;
    refreshBusy.current = true;
    try {
      const [rows, history] = await Promise.all([socialAccounts.list(), socialAccounts.batches()]);
      if (!Array.isArray(rows) || !Array.isArray(history)) throw new Error('多账号接口格式不正确，请检查服务版本。');
      if (alive.current) { setAccounts(rows); setBatches(history); setAccountsLoaded(true); }
    } finally { refreshBusy.current = false; }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh().catch(cause => { if (alive.current) setError(cause instanceof Error ? cause.message : '读取分发任务失败'); });
    const timer = setInterval(() => { void refresh().catch(cause => { if (alive.current) setError(cause instanceof Error ? cause.message : '任务状态暂不可用'); }); }, 4000);
    return () => { alive.current = false; clearInterval(timer); };
  }, [refresh]);
  useEffect(() => {
    try {
      cachedDrafts.current = { ...cachedDrafts.current, ...drafts };
      localStorage.setItem(DRAFT, JSON.stringify(drafts));
      localStorage.setItem(CONTENT_CACHE, JSON.stringify(cachedDrafts.current));
    }
    catch { setError('草稿无法保存在此浏览器，关闭页面前请保留内容。'); }
  }, [drafts]);
  useEffect(() => {
    const restored = accounts.filter(a => drafts[a.accountId] || pending?.requests.some(r => r.accountId === a.accountId)).map(a => a.platform);
    setPlatforms(old => [...new Set([...old, ...restored])]);
  }, [accounts, drafts, pending]);
  useEffect(()=>{
    if(!accountFocus||!accountsLoaded||focused.current===accountFocus.nonce)return;
    focused.current=accountFocus.nonce;
    setDeferredAccount('');
    if(pending||busy){setNotice('有待查询的确认稿，先核对本次受理结果，再选择其他账号。');onStepChange?.('results');return;}
    const account=accounts.find(row=>row.accountId===accountFocus.accountId&&row.platform===accountFocus.platform);
    if(!account){setError('指定发布账号不存在或平台不匹配，请回账号中心重新选择。');return;}
    setPlatforms(old=>[...new Set([...old,account.platform])]);onStepChange?.('targets');
    if(!socialAccountReady(account)){setNotice('已定位此账号；请先连接并在线核验，现有草稿保留。');return;}
    if(step&&!drafts[account.accountId]&&!cachedDrafts.current[account.accountId]&&!seed.title.trim()){
      setDeferredAccount(account.accountId);onStepChange?.('content');
      setNotice(`已定位 ${account.label}；先准备通用稿，进入选择账号时带入，随后仍需逐账号确认。`);return;
    }
    setDrafts(old=>old[account.accountId]?old:{...old,[account.accountId]:structuredClone(cachedDrafts.current[account.accountId]||seed)});
    setEditorId(account.accountId);setNotice(`已定位 ${account.label}；请检查内容并逐账号确认发布。`);
  },[accountFocus,accountsLoaded,accounts,pending,busy,onStepChange,seed,step,drafts]);
  useEffect(()=>{
    if(!deferredAccount||step!=='targets'||!seed.title.trim()||pending||busy)return;
    const account=accounts.find(row=>row.accountId===deferredAccount);
    if(!account||!socialAccountReady(account)){setNotice('目标账号状态已变化，请在线核验后重新选择。');setDeferredAccount('');return;}
    setDrafts(old=>old[account.accountId]?old:{...old,[account.accountId]:structuredClone(cachedDrafts.current[account.accountId]||seed)});
    setEditorId(account.accountId);setDeferredAccount('');
    setNotice(`已带入 ${account.label}；请核对这份账号内容，再确认发布。`);
  },[deferredAccount,step,seed,pending,busy,accounts]);
  const update = (id: string, value: Partial<AccountPayload>) => setDrafts(old => ({ ...old, [id]: { ...old[id], ...value } }));
  const toggle = (id: string) => setDrafts(old => {
    const next = { ...old };
    if (next[id]) delete next[id];
    else next[id] = structuredClone(cachedDrafts.current[id] || seed);
    return next;
  });
  const togglePlatform = (platform: string) => {
    if (platforms.includes(platform)) {
      setPlatforms(old => old.filter(value => value !== platform));
      setDrafts(old => Object.fromEntries(Object.entries(old).filter(([id]) => accounts.find(a => a.accountId === id)?.platform !== platform)));
    } else setPlatforms(old => [...old, platform]);
  };
  const submit = async (retry?: DistributionJob) => {
    if (requestBusy.current) return;
    let envelope = pending;
    if (!envelope) {
      const requests = retry ? [{ accountId: retry.accountId, payload: { ...structuredClone(retry.payload), ...(retry.mediaHashes ? {mediaHashes:retry.mediaHashes} : {}) } }]
        : Object.entries(drafts).map(([accountId, payload]) => ({ accountId, payload: structuredClone(payload) }));
      if (!requests.length) { setError('请选择目标账号并检查每份内容。'); return; }
      if (requests.some(row => !row.payload.title.trim() || (!row.payload.media.length && accounts.find(a => a.accountId === row.accountId)?.platform !== 'zhihu'))) { setError('请补齐各账号标题和平台要求的图片或视频。知乎支持纯文字。'); return; }
      if (requests.some(row => !accounts.some(a => a.accountId === row.accountId && socialAccountReady(a)))) {
        setError('目标账号需先在账号中心完成在线核验，且不能被其他任务占用。'); return;
      }
      const description = requests.map(row => {
        const account = accounts.find(a => a.accountId === row.accountId)!;
        return `${publishPlatformLabel(account.platform)} / ${account.label}：${row.payload.title}（${row.payload.media.length} 个素材，${account.platform === 'wechat-oa' ? '仅创建草稿' : '公开发布'}）`;
      }).join('\n');
      if (!window.confirm(`确认向以下平台账号提交？请核对每份正文、话题与素材。\n${description}\n每个账号使用当前确认稿；结果未知时不会自动重发。`)) return;
      envelope = { requestKey: key(), requests };
      // Persist BEFORE the network call. A lost response reuses the same key
      // and frozen payload instead of accidentally submitting a new batch.
      try { localStorage.setItem(PENDING, JSON.stringify(envelope)); }
      catch { setError('本次确认稿无法持久保存，尚未提交；请允许本地存储后重试。'); return; }
      setPending(envelope);
    }
    requestBusy.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await socialAccounts.submit(envelope.requestKey, envelope.requests);
      if (!result.batchId) throw new Error('未收到有效批次编号，请查询本次受理结果。');
      localStorage.removeItem(PENDING);
      if (alive.current) {
        setPending(null);
        setNotice('已开始处理所选账号。你可以切换页面，稍后在发布记录中查看结果。');
        setBatches(old => [result, ...old.filter(row => row.batchId !== result.batchId)]);
        onStepChange?.('results');
      }
      await refresh();
    } catch (cause) {
      const status = (cause as Error & { status?: number }).status;
      // 5xx/network loss can occur after admission. Only a definite rejection
      // permits editing the request; retain the key for every unknown result.
      if (status && [400, 404, 409, 422].includes(status)) {
        localStorage.removeItem(PENDING);
        if (alive.current) setPending(null);
      }
      if (alive.current) setError(cause instanceof Error ? cause.message : '受理结果未知，请查询同一请求。');
    } finally { requestBusy.current = false; if (alive.current) setBusy(false); }
  };
  const selected = Object.entries(drafts);
  const activeEditor = drafts[editorId] ? editorId : selected[0]?.[0];
  const targetPlatforms = new Set(selected.map(([id]) => accounts.find(a => a.accountId === id)?.platform));
  const locked = busy || !!pending;
  useEffect(() => { onSelectionChange?.(selected.length, locked); }, [selected.length, locked, onSelectionChange]);
  return <div className="distribution-workspace">
    <div hidden={!!step && step !== 'targets'}>
    <div className="distribution-intro"><p>先选平台，再选择这些平台下要发布的账号。每个账号的内容都可以单独调整。</p><button className="account-text-button" disabled={busy} onClick={() => { setError(''); void refresh().catch(cause => setError(String(cause.message || cause))); }}><IconRefresh size={13}/>刷新账号与批次</button></div>
    <div className="distribution-section-heading"><h3>选择发布平台</h3><p>可以同时选择多个平台。</p></div>
    <div className="distribution-platforms" role="group" aria-label="选择发布平台">
      {socialPlatforms.map(item => {
        const available = accounts.filter(a => a.platform === item.value);
        const count = available.filter(a => drafts[a.accountId]).length;
        return <button className="distribution-platform" data-platform={item.value} key={item.value} disabled={locked} aria-pressed={platforms.includes(item.value)} onClick={() => togglePlatform(item.value)}>
          <PlatformIcon platform={item.value} name={publishPlatformLabel(item.value)}/><strong>{publishPlatformLabel(item.value)}</strong><small>{count ? `已选 ${count} 个账号` : available.length ? `${available.length} 个账号` : '还未添加账号'}</small><span className="distribution-selection-mark" aria-hidden="true">{platforms.includes(item.value) && <IconCheck size={12}/>}</span>
        </button>;
      })}
    </div>
    {platforms.length > 0 ? <div className="distribution-account-groups">
      <div className="distribution-section-heading"><h3>选择对应账号</h3><p>一个平台可以选多个账号；未登录的账号需要先连接。</p></div>
      {socialPlatforms.filter(item => platforms.includes(item.value)).map(item => {
        const rows = accounts.filter(a => a.platform === item.value);
        const usable = rows.filter(a => socialAccountReady(a));
        const allSelected = usable.length > 0 && usable.every(a => drafts[a.accountId]);
        return <section key={item.value} className="distribution-account-group" aria-label={`${publishPlatformLabel(item.value)}的发布账号`}>
          <div className="distribution-group-heading"><span><PlatformIcon platform={item.value} name={publishPlatformLabel(item.value)}/><strong>{publishPlatformLabel(item.value)}</strong><small>已选 {rows.filter(a => drafts[a.accountId]).length} / {rows.length}</small></span><button className="account-text-button" disabled={locked || !usable.length} onClick={() => setDrafts(old => {const next = {...old}; for(const a of usable) { if(allSelected) delete next[a.accountId]; else if(!next[a.accountId]) next[a.accountId] = structuredClone(cachedDrafts.current[a.accountId] || seed); } return next;})}>{allSelected ? '取消全选' : '全选可用账号'}</button></div>
          <div className="distribution-account-options">{rows.map(account => {
            const chosen = !!drafts[account.accountId];
            const usable = socialAccountReady(account);
            return <div key={account.accountId}><label className={`distribution-account-option${chosen ? ' is-selected' : ''}${!usable ? ' is-unavailable' : ''}`}>
              <input type="checkbox" data-account-id={account.accountId} aria-label={`${publishPlatformLabel(account.platform)} / ${account.label}`} checked={chosen} disabled={locked || (!usable && !chosen)} onChange={() => {toggle(account.accountId); if(!chosen) setEditorId(account.accountId);}}/>
              <span className="distribution-account-avatar">{(account.name || account.label).slice(0,1)}</span><span className="distribution-account-name"><strong>{account.label}</strong><small>{account.name || '昵称待核验'}</small></span><span className={`distribution-account-status${usable ? ' is-ready' : ''}`}>{usable ? account.platform === 'wechat-oa' ? '可存草稿' : '可发布' : account.busy ? '处理中' : accountState[socialAccountStatus(account)] || '待核验'}</span>
            </label>{onOpenAccounts&&<button className="account-text-button" onClick={()=>onOpenAccounts(account.accountId)}>管理 {account.label}</button>}</div>;
          })}</div>
          {!rows.length && <p className="distribution-empty">这个平台还没有独立账号，请先在账号中心添加并连接。{onOpenAccounts&&<button className="btn btn-sm" onClick={()=>onOpenAccounts()}>添加账号</button>}</p>}
          {item.value === 'wechat-oa' && <p className="distribution-platform-note">公众号内容会保存到草稿箱，不会自动公开。</p>}
        </section>;
      })}
    </div> : <div className="distribution-start-hint"><IconChevron size={15}/><span>点选上方平台，就能看到该平台下的账号。</span></div>}
    </div>
    <div hidden={!!step && step !== 'review'}>
    {selected.length > 0 && <section className="distribution-content" aria-label="各账号发布内容">
      <div className="distribution-section-heading"><h3>确认发布内容</h3><p>点选账号切换编辑，修改只影响当前账号。</p></div>
      <div className="distribution-editor-tabs" role="tablist" aria-label="选择要编辑的账号">
        {selected.map(([id]) => {const account = accounts.find(a => a.accountId === id); return <button key={id} id={`distribution-tab-${id}`} role="tab" aria-selected={activeEditor === id} aria-controls={`distribution-editor-${id}`} tabIndex={activeEditor === id ? 0 : -1} onClick={() => setEditorId(id)} onKeyDown={event => {
          const index = selected.findIndex(([key]) => key === id);
          const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
          if(!direction && !['Home','End'].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? selected.length - 1 : (index + direction + selected.length) % selected.length;
          setEditorId(selected[next][0]); document.getElementById(`distribution-tab-${selected[next][0]}`)?.focus();
        }}><PlatformIcon platform={account?.platform || ''} name={publishPlatformLabel(account?.platform || '')}/>{account?.label || '账号待加载'}</button>;})}
      </div>
    {selected.map(([id, draft]) => {
      const account = accounts.find(a => a.accountId === id);
      const choices = [...new Set([...draft.media, ...files.slice(0, 40).map(f => f.path)])];
      return <div id={`distribution-editor-${id}`} key={id} role="tabpanel" aria-labelledby={`distribution-tab-${id}`} hidden={activeEditor !== id}><fieldset className="social-editor distribution-editor" disabled={locked}>
        <legend>{publishPlatformLabel(account?.platform || '')} / {account?.label || id} · 发布内容</legend>
        <div className="distribution-editor-heading"><p>{account?.platform === 'wechat-oa' ? '准备封面和正文，保存到公众号草稿箱。' : account?.platform === 'zhihu' ? '支持纯文字文章，请将内容写入正文。' : account?.platform === 'kuaishou' ? '选择一张图片或一个视频。' : ['bilibili', 'douyin', 'weixin-channels'].includes(account?.platform || '') ? '请选择一个视频。' : '可选择多张图片，或一个视频。'}</p><button className="account-text-button" onClick={() => update(id, { ...seed, media: [...seed.media] })}>使用准备好的通用稿</button></div>
        <label>标题<input className="field" value={draft.title} onChange={e => update(id, { title: e.target.value })} /></label>
        <label>正文<textarea className="field" value={draft.body} onChange={e => update(id, { body: e.target.value })} /></label>
        <label>话题<input className="field" value={draft.tags || ''} onChange={e => update(id, { tags: e.target.value })} /></label>
        <div className="distribution-media-heading"><strong>图片与视频 <span>{draft.media.length}</span></strong><small>首张图作为封面，图片与视频不能混选。</small></div>
        <div className="distribution-media-choices">{choices.map(path => <label className="distribution-media-choice" key={path}>
          <input type="checkbox" checked={draft.media.includes(path)} onChange={() => update(id, { media: draft.media.includes(path) ? draft.media.filter(p => p !== path) : [...draft.media, path] })} />
          {' '}{files.find(f => f.path === path)?.name || path}
        </label>)}</div>
        {!choices.length && <p>请返回“准备内容”选择素材，再将通用稿用于此账号。</p>}
      </fieldset></div>;
    })}
    </section>}
    {step && selected.length > 0 && <section className="distribution-confirmation" aria-label="本次发布清单"><h3>本次发布清单</h3><p>请逐个核对目标账号。公众号仅存草稿，其余账号将公开发布。</p>{selected.map(([id, draft]) => {
      const account = accounts.find(a => a.accountId === id);
      return <article key={id}><div><PlatformIcon platform={account?.platform || ''} name={publishPlatformLabel(account?.platform || '')}/><strong>{publishPlatformLabel(account?.platform || '')} / {account?.label || '账号待加载'}</strong><span>{account?.platform === 'wechat-oa' ? '保存到草稿箱' : '公开发布'}</span></div><p>{draft.title || '尚未填写标题'}</p><small>平台身份：{account?.name || '待核验'} · {draft.media.length} 个素材 · {draft.body.length} 字正文</small><button type="button" className="account-text-button" onClick={() => { setEditorId(id); document.getElementById(`distribution-tab-${id}`)?.focus(); }}>检查这份内容</button></article>;
    })}</section>}
    {pending && <p className="distribution-pending" role="status">上次提交的结果还未确认。内容已暂时锁定，请先查询结果，避免重复发布。</p>}
    <div className="distribution-submit"><div><strong>{selected.length ? `已选择 ${targetPlatforms.size} 个平台 · ${selected.length} 个账号` : '还未选择发布账号'}</strong><p>{selected.length ? selected.map(([id]) => {const a=accounts.find(a=>a.accountId===id);return `${publishPlatformLabel(a?.platform || '')} / ${a?.label || '账号待加载'}`;}).join('、') : '选好平台和账号后，在这里确认发布。'}</p></div><button className="btn btn-primary" disabled={busy || (!pending && !selected.length)} onClick={() => void submit()}>{busy ? '正在提交…' : pending ? '查询本次受理结果' : `确认发布到 ${selected.length} 个账号`}</button></div>
    </div>
    {pending && step && step !== 'review' && <p className="distribution-pending" role="status">上次受理结果待确认，请返回“确认发布”查询同一请求。<button className="account-text-button" onClick={() => onStepChange?.('review')}>查询受理结果</button></p>}
    {error && <p className="notice-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <section hidden={!!step && step !== 'results'} className="distribution-history" aria-label="多账号分发批次"><div className="distribution-history-heading"><h3>发布记录</h3><button className="account-text-button" disabled={busy} onClick={() => { void refresh().catch(cause => setError(cause.message || '读取结果失败')); }}><IconRefresh size={13}/>刷新发布结果</button></div>
      {batches.map(batch => <article key={batch.batchId} className="social-batch">
        <div className="distribution-batch-heading"><h3>{batch.state === 'finished' ? '本次发布已结束' : '正在发布'}</h3><small>{new Date(batch.createdAt).toLocaleString('zh-CN')}</small></div>
        {batch.jobs.map(job => <div key={job.jobId} className="social-job">
          <div className="distribution-job-heading"><span><PlatformIcon platform={job.platform} name={publishPlatformLabel(job.platform)}/><strong>{publishPlatformLabel(job.platform)} / {job.accountLabel}</strong></span><span className={`account-state-pill is-${job.outcome === 'failed' ? 'error' : job.outcome === 'published' ? 'ready' : 'unverified'}`}>{describe(job)}</span></div><p>{job.payload.title}</p><p>{job.message}</p>
          <details><summary>查看账号与回执编号</summary><small>平台账号 {job.externalAccountId} · 回执 {job.receiptId} · 批次 {batch.batchId}</small></details>
          {job.outcome === 'failed' && <div><button className="btn btn-sm" disabled={busy || !!pending} onClick={() => void submit(job)}>仅重试 {job.accountLabel} 的原确认稿</button></div>}
          {job.outcome === 'unverified' && <p>结果尚未确认，请先到这个账号的作品列表查看，避免重复发布。</p>}
        </div>)}
      </article>)}
      {!batches.length && <p className="distribution-empty">还没有发布记录。发布后，每个账号的结果都会保存在这里。</p>}
    </section>
  </div>;
}

export default function SocialDistributionPanel(props: DistributionProps) {
  const [open, setOpen] = useState(true);
  if (props.step) return <section className="social-panel distribution-panel distribution-wizard" aria-label="按账号发布"><DistributionEditor {...props}/></section>;
  return <section className="social-panel distribution-panel" aria-label="同平台多账号分发">
    <button className="social-panel-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
      <strong>选择平台与发布账号</strong><span>{open ? '收起' : '按平台选择账号'}</span>
    </button>
    {open && <DistributionEditor {...props} />}
  </section>;
}
