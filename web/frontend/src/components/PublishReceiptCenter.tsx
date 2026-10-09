import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { PublishReceipt } from '../lib/api';
import type { PublishReceiptsModel } from '../hooks/usePublishReceipts';
import { useModalFocus } from '../hooks/useModalFocus';
import { canVerifyPublishReceipt, isFinalPublishReceipt, publishNotificationLabel, publishPlatformLabel, publishReceiptStatus, receiptPublicUrl } from '../lib/publishReceipts';
import { IconHistory, IconRefresh } from './icons';
import PlatformIcon from './PlatformIcon';
import PublishSpinner from './PublishSpinner';
import '../styles/publish-receipts.css';
import { showToast } from '../lib/toast';

export function PublishReceiptCard({ receipt, onConfigure, onVerify, onCheck, checkBusy = false, children }: {
  receipt: PublishReceipt;
  onConfigure?: () => void;
  onVerify?: () => void;
  onCheck?: (automatic?: boolean) => Promise<void>;
  checkBusy?: boolean;
  children?: ReactNode;
}) {
  const status = publishReceiptStatus(receipt);
  const url = receiptPublicUrl(receipt);
  const final = isFinalPublishReceipt(receipt);
  const label = publishPlatformLabel(receipt.platform);
  const previewId = receipt.contentId || receipt.evidence?.previewContentId;
  const preview = receipt.platform === 'xiaohongshu' && typeof previewId === 'string' && /^[0-9a-f]{24}$/.test(previewId)
    ? `https://www.xiaohongshu.com/explore/${previewId}` : null;
  return <article className={`publish-receipt tone-${status.tone}`} data-receipt-id={receipt.receiptId}>
    <div className="publish-receipt-heading">
      <span className="publish-receipt-platform"><PlatformIcon platform={receipt.platform} name={label} />{label}</span>
      <span className="publish-receipt-status">{(!final && receipt.state !== 'sms_required' || receipt.verification?.state === 'checking') && <PublishSpinner />}{status.label}</span>
    </div>
    <h3>{receipt.title || '未命名内容'}</h3>
    <time dateTime={receipt.createdAt}>{new Date(receipt.createdAt).toLocaleString('zh-CN')}</time>
    <p>{status.description}</p>
    {receipt.message && receipt.message !== status.description && <p className="publish-receipt-message">{receipt.message}</p>}
    {receipt.storageWarning && <p className="notice-error" role="alert">{receipt.storageWarning}</p>}
    {url ? <a className="publish-receipt-link" href={url} target="_blank" rel="noopener noreferrer">查看已发布作品 ↗</a>
      : receipt.outcome === 'published' && <p className="publish-receipt-message">平台未返回可验证的公开作品地址，请到平台核对。</p>}
    {receipt.platform === 'xiaohongshu' && <div className="publish-receipt-preview-links">
      {!url && preview && <a href={preview} target="_blank" rel="noopener noreferrer">预览笔记 ↗</a>}
      <a href="https://creator.xiaohongshu.com/new/note-manager" target="_blank" rel="noopener noreferrer">打开作品管理 ↗</a>
    </div>}
    {!url && preview && <p className="publish-receipt-message">预览不代表已确认公开；平台可能要求在 App 中查看。请按标题核对内容。</p>}
    {receipt.contentId && final && <p className="publish-receipt-content-id">作品编号：{receipt.contentId}</p>}
    {receipt.state === 'sms_required' && !final && onVerify && <button className="btn btn-sm" onClick={onVerify}>处理短信验证</button>}
    {canVerifyPublishReceipt(receipt) && onCheck && <PublishVerificationControls receipt={receipt} onCheck={onCheck} busy={checkBusy} />}
    {children}
    {final && <div className="publish-receipt-notification">
      <span className={receipt.notification?.state === 'failed' ? 'publish-receipt-mail-error' : ''}>{publishNotificationLabel(receipt.notification)}</span>
      {receipt.notification?.message && <span>{receipt.notification.message}</span>}
      {onConfigure && (!receipt.notification || ['unconfigured', 'failed', 'skipped'].includes(receipt.notification.state))
        && <button className="publish-receipt-text-button" onClick={onConfigure}>通知设置</button>}
    </div>}
  </article>;
}

function PublishVerificationControls({ receipt, onCheck, busy }: {
  receipt: PublishReceipt;
  onCheck: (automatic?: boolean) => Promise<void>;
  busy: boolean;
}) {
  const [error, setError] = useState('');
  const verification = receipt.verification;
  const checking = verification?.state === 'checking';
  const nextTime = verification?.nextCheckAt && Number.isFinite(Date.parse(verification.nextCheckAt))
    ? new Date(verification.nextCheckAt).toLocaleString('zh-CN') : '';
  const check = async (automatic?: boolean) => {
    setError('');
    try { await onCheck(automatic); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '核实请求未完成，请稍后重试。'); }
  };
  return <div className="publish-receipt-verification">
    <p role="status">{verification?.message || '可以核实本次发布结果，只查询已有内容。'}</p>
    {verification?.automatic && nextTime && <p className="publish-receipt-message">下次自动核实：{nextTime}</p>}
    <div className="publish-receipt-verification-actions">
      <button className="btn btn-sm" disabled={busy || checking} onClick={() => { void check(); }}>
        {(checking || busy) && <PublishSpinner />}
        {checking ? '正在核实…' : busy ? '处理中…' : '核实发布结果'}
      </button>
      {verification?.automatic
        ? <button className="publish-receipt-text-button" disabled={busy} onClick={() => { void check(false); }}>暂停自动核实</button>
        : verification && !['exhausted', 'unsupported'].includes(verification.state)
          && <button className="publish-receipt-text-button" disabled={busy || checking} onClick={() => { void check(true); }}>开启自动核实</button>}
    </div>
    {error && <p className="notice-error" role="alert">{error}</p>}
  </div>;
}

function PublishSmsForm({ receipt, onSubmit }: { receipt: PublishReceipt; onSubmit: PublishReceiptsModel['submitSms'] }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const alive = useRef(true);
  const fieldId = useId();
  const busyRef = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const submit = async () => {
    if (busyRef.current) return;
    if (!/^\d{4,8}$/.test(code)) { setError('请输入 4–8 位数字验证码。'); return; }
    busyRef.current = true;
    setBusy(true); setError(''); setNote('');
    try {
      await onSubmit(receipt.receiptId, code);
      if (alive.current) { setCode(''); setNote('验证码已提交，等待平台验证。'); }
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : '验证码提交失败，请重试。');
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return <form className="publish-receipt-sms" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <label htmlFor={fieldId}>{publishPlatformLabel(receipt.platform)}本次发布验证码</label>
    <div>
      <input id={fieldId} className="field" inputMode="numeric" autoComplete="one-time-code" maxLength={8}
        value={code} onChange={event => { setCode(event.target.value.replace(/\D/g, '').slice(0, 8)); setError(''); }}
        placeholder="手机收到的验证码" disabled={busy} aria-describedby={`${fieldId}-note`} />
      <button className="btn btn-sm btn-primary" type="submit" disabled={busy}>{busy ? '提交中…' : '提交验证码'}</button>
    </div>
    <p id={`${fieldId}-note`} role={error ? 'alert' : 'status'}>{error || note || '验证码只用于这条发布任务。'}</p>
  </form>;
}

export default function PublishReceiptCenter({ model, onConfigure, onOpenPublish, showEntry = true }: {
  model: PublishReceiptsModel;
  onConfigure: () => void;
  onOpenPublish: () => void;
  showEntry?: boolean;
}) {
  const titleId = useId();
  const dialogId = useId();
  const modalRef = useModalFocus(model.isOpen, model.close);
  const latest = model.notices[0];
  const latestUrl = latest ? receiptPublicUrl(latest) : null;
  const ordered = [...model.active, ...model.receipts.filter(isFinalPublishReceipt)];
  const count = model.verification.length || model.notices.length || model.active.length || model.checking.length;
  const configure = () => { model.close(); onConfigure(); };
  const seenNotices = useRef(new Set<string>());
  useEffect(() => {
    if (showEntry) return;
    for (const receipt of model.notices) {
      const key = `${receipt.receiptId}:${receipt.outcome}`;
      if (seenNotices.current.has(key)) continue;
      seenNotices.current.add(key);
      showToast(`${publishPlatformLabel(receipt.platform)} · ${publishReceiptStatus(receipt).label}`, receipt.outcome === 'failed' ? 'error' : 'info', { label: '查看回执', run: model.open });
    }
  }, [model.notices, model.open, showEntry]);
  return <>
    {showEntry && <div className="publish-receipts-bar" aria-label="发布回执与提醒">
      <button type="button" className="publish-receipts-entry" onClick={model.open}
        aria-expanded={model.isOpen} aria-controls={model.isOpen ? dialogId : undefined}>
        <IconHistory size={16} />发布回执{count > 0 && <span className="publish-receipts-count">{count}</span>}
      </button>
      <div className="publish-receipts-summary" role="status" aria-live="polite" aria-atomic="true">
        {model.verification.length ? <><span>{model.verification.length} 项发布等待短信验证</span><button className="publish-receipt-text-button" onClick={model.open}>处理验证</button></>
          : latest ? <><span>{publishPlatformLabel(latest.platform)} · {publishReceiptStatus(latest).label} · {latest.title || '未命名内容'}</span>
            {latestUrl && <a href={latestUrl} target="_blank" rel="noopener noreferrer">查看作品 ↗</a>}
            <button className="publish-receipt-text-button" onClick={model.dismissNotices} aria-label="收起本次发布结果提醒">收起提醒</button></>
          : model.submissionIssues.length ? <><span>有 {model.submissionIssues.length} 项发布请求需要核对</span><button className="publish-receipt-text-button" onClick={model.open}>查看</button></>
          : model.submitting ? <span>正在提交：{model.submittingLabel || '发布内容'}</span>
          : model.active.length ? <span>{model.active.length} 项发布处理中，可切换页面</span>
          : model.checking.length ? <span>{model.checking.length} 项发布正在核实平台结果</span>
          : model.error ? <><span>回执暂时无法更新</span><button className="publish-receipt-text-button" onClick={model.open}>查看详情</button></>
          : <span className="publish-receipts-idle">结果与作品地址保存在这里</span>}
      </div>
    </div>}
    {model.isOpen && <div className="overlay publish-receipts-overlay" onClick={event => { if (event.target === event.currentTarget) model.close(); }}>
      <div className="modal publish-receipts-modal" id={dialogId} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={modalRef}>
        <div className="publish-receipts-modal-heading">
          <div><h2 id={titleId}>发布回执</h2><p>切换页面或刷新后，可继续查看当前工作台的记录。</p></div>
          <button className="btn btn-sm" onClick={model.close} aria-label="关闭发布回执">关闭</button>
        </div>
        <div className="publish-receipts-actions">
          <button className="btn btn-sm" onClick={() => void model.refresh()} disabled={model.refreshing}><IconRefresh size={13} />{model.refreshing ? '更新中…' : '刷新回执'}</button>
          {model.notices.length > 0 && <button className="btn btn-sm" onClick={model.dismissNotices}>全部标为已读</button>}
          <button className="btn btn-sm" onClick={configure}>通知设置</button>
        </div>
        <div className="publish-receipts-list">
          {model.error && <div className="notice-error" role="alert">{model.error} 已显示的状态可能不是最新结果；恢复连接后会继续更新。</div>}
          {model.submitting && <p className="publish-receipts-progress publish-progress-line" role="status"><PublishSpinner /><span>正在向 {model.submittingLabel} 发布，等待平台处理。任务会继续执行，可切换页面。</span></p>}
          {model.submissionIssues.length > 0 && <div className="publish-receipts-issues" role="alert">
            <h3>发布请求需要核对</h3>
            {model.submissionIssues.map((issue, index) => <p key={`${issue.platform}-${index}`}><strong>{publishPlatformLabel(issue.platform)} · {issue.title || '未命名内容'}</strong><br />{issue.message}</p>)}
            <button className="btn btn-sm" onClick={model.dismissIssues}>收起提示</button>
          </div>}
          {!model.loaded && !model.error && <p className="dash-empty">正在读取发布回执…</p>}
          {model.loaded && ordered.length === 0 && <p className="dash-empty">还没有发布回执。确认发布后，平台结果和可用的作品地址会保存在这里。</p>}
          {ordered.map(receipt => <PublishReceiptCard key={receipt.receiptId} receipt={receipt} onConfigure={configure}
            onCheck={automatic => model.verify(receipt.receiptId, automatic)} checkBusy={model.verificationBusyIds.includes(receipt.receiptId)}>
            {!isFinalPublishReceipt(receipt) && receipt.state === 'sms_required' && <PublishSmsForm receipt={receipt} onSubmit={model.submitSms} />}
          </PublishReceiptCard>)}
        </div>
        <div className="publish-receipts-footer"><p>支持的平台会在服务运行时自动核实审核结果，最多 24 小时、12 次，可暂停或手动核实。草稿不会自动发布；邮件结果单独显示。</p>
          <button className="btn btn-sm" onClick={() => { model.close(); onOpenPublish(); }}>前往发布中心</button></div>
      </div>
    </div>}
  </>;
}
