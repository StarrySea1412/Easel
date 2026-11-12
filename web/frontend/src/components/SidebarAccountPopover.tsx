import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fetchAccounts, type AccountItem } from '../lib/api';
import { requestWithTimeout } from '../lib/requestTimeout';
import { hydrateAccountIdentities, useAccountIdentities, useAccountChecks } from '../lib/whoami';
import { ACCOUNT_HEALTH_EVENT } from '../lib/accountHealth';
import { socialAccounts, type SocialAccount } from '../lib/socialAccounts';
import { sidebarAccountInventory, snapshotGroupSummary } from '../lib/sidebarAccountInventory';
import PlatformIcon from './PlatformIcon';
import { openSidebarPanel, SIDEBAR_PANEL_EVENT } from '../lib/sidebarPanels';
import { IconAccounts } from './icons';
import '../styles/sidebar-account-popover.css';

type Snapshot = { defaults: AccountItem[]; independent: SocialAccount[] };
const readPrivacy = () => { try { return localStorage.getItem('easel_account_privacy') === '1'; } catch { return false; } };

export default function SidebarAccountPopover({ active, onNavigate }: { active: boolean; onNavigate: (target?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [error, setError] = useState<'login' | 'unavailable' | null>(null);
  const [revision, setRevision] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [hiddenIdentity, setHiddenIdentity] = useState(readPrivacy);
  const identities = useAccountIdentities();
  const checks = useAccountChecks();
  const [position, setPosition] = useState({ left: 64, top: 12, width: 290 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const suppressFocus = useRef(false);
  const panelId = useId();
  const clearHide = () => { clearTimeout(hideTimer.current); };
  const reveal = () => {
    clearHide();
    if (!suppressFocus.current) {
      openSidebarPanel(panelId);
      if (!open) { setSnapshot(undefined); setError(null); setExpanded({}); setHiddenIdentity(readPrivacy()); }
      setOpen(true);
    }
  };
  const close = (restoreFocus = false) => {
    clearHide();
    setOpen(false);
    if (restoreFocus) {
      suppressFocus.current = true;
      trigger.current?.focus({ preventScroll: true });
      suppressFocus.current = false;
    }
  };
  const leave = () => {
    clearHide();
    hideTimer.current = setTimeout(() => {
      if (!panel.current?.contains(document.activeElement) && document.activeElement !== trigger.current) setOpen(false);
    }, 180);
  };

  useEffect(() => () => clearTimeout(hideTimer.current), []);
  useEffect(() => {
    const otherPanel = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== panelId) { clearTimeout(hideTimer.current); setOpen(false); }
    };
    const navigating = () => { clearTimeout(hideTimer.current); setOpen(false); };
    window.addEventListener(SIDEBAR_PANEL_EVENT, otherPanel);
    window.addEventListener('easel:page-navigation', navigating);
    return () => { window.removeEventListener(SIDEBAR_PANEL_EVENT, otherPanel); window.removeEventListener('easel:page-navigation', navigating); };
  }, [panelId]);
  useEffect(() => {
    if (!open) return;
    const update = () => setRevision(value => value + 1);
    const privacy = () => setHiddenIdentity(readPrivacy());
    const timer = window.setInterval(update, 15_000);
    window.addEventListener(ACCOUNT_HEALTH_EVENT, update);
    window.addEventListener('easel:account-privacy', privacy);
    window.addEventListener('storage', privacy);
    return () => { window.clearInterval(timer); window.removeEventListener(ACCOUNT_HEALTH_EVENT, update);
      window.removeEventListener('easel:account-privacy', privacy); window.removeEventListener('storage', privacy); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let stale = false;
    setError(null);
    const cancellation = new AbortController();
    // This endpoint reads local state only. Never run browser-based whoami as a
    // side effect of hovering a navigation item, and never render credentials.
    requestWithTimeout(signal => {
      const combined = AbortSignal.any([signal, cancellation.signal]);
      return Promise.all([fetchAccounts(combined), socialAccounts.list(combined)]);
    }, 10000, '账号信息读取超时，请重试。').then(([accounts, independent]) => {
      if (stale) return;
      if (!Array.isArray(accounts)) throw Error('账号快照格式不正确');
      hydrateAccountIdentities(accounts);
      setSnapshot({ defaults: accounts, independent });
    }).catch(cause => {
      cancellation.abort();
      if (!stale) { setSnapshot(undefined); setError(cause?.code === 'workbench_login_required' ? 'login' : 'unavailable'); }
    });
    return () => { stale = true; cancellation.abort(); };
  }, [open, revision]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = Math.min(328, window.innerWidth - 24);
      const height = panel.current?.getBoundingClientRect().height || 350;
      setPosition({ width, left: Math.max(12, Math.min(anchor.right + 10, window.innerWidth - width - 12)),
        top: Math.max(12, Math.min(anchor.top, window.innerHeight - height - 12)) });
    };
    const scroll = (event: Event) => { if (!panel.current?.contains(event.target as Node)) place(); };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', scroll, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', scroll, true); };
  }, [open, snapshot, error, expanded]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) {
        close(panel.current?.contains(document.activeElement));
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(true); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);

  const groups = snapshot ? sidebarAccountInventory(snapshot.defaults, snapshot.independent, identities, checks, hiddenIdentity) : [];
  const total = groups.reduce((sum, group) => sum + group.accounts.length, 0);
  const online = groups.reduce((sum, group) => sum + group.online, 0);
  const attention = groups.reduce((sum, group) => sum + group.attention, 0);
  const unknown = groups.reduce((sum, group) => sum + group.unknown, 0);
  const busy = groups.reduce((sum, group) => sum + group.busy, 0);
  const navigate = (target?: string) => { close(); onNavigate(target); };
  return <>
    <button ref={trigger} type="button" className={`nav-item sidebar-accounts-trigger${active ? ' active' : ''}`}
      aria-label="账号" title="账号" aria-current={active ? 'page' : undefined} aria-expanded={open} aria-controls={panelId}
      onMouseEnter={reveal} onMouseLeave={leave} onFocus={reveal} onClick={reveal}
      onBlur={event => {
        if (event.relatedTarget && !panel.current?.contains(event.relatedTarget as Node)) close();
      }}
      onKeyDown={event => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault();
          if (!open) reveal();
          else panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
        }
      }}>
      <span className="nav-icon" aria-hidden="true"><IconAccounts size={18} /></span><span className="nav-item-label">账号</span>
    </button>
    {open && createPortal(<div ref={panel} id={panelId} className="sidebar-account-popover" role="region" aria-label="平台账号快照"
      style={position} onMouseEnter={clearHide} onMouseLeave={leave}
      onBlur={event => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node) && event.relatedTarget !== trigger.current) close();
      }}>
      <div className="sidebar-account-heading"><strong>平台账号</strong><button type="button" aria-label="关闭账号预览" onClick={() => close(true)}>×</button></div>
      {!snapshot && !error && <p className="sidebar-account-state" role="status">正在读取本次账号快照…</p>}
      {error && <p className="sidebar-account-state" role="alert">{error === 'login' ? '工作台登录已过期，请重新登录后查看账号。' : '账号信息暂时无法读取，请重试。'}</p>}
      {error === 'unavailable' && <button type="button" className="sidebar-account-open" onClick={() => setRevision(value => value + 1)}>重新读取 <span aria-hidden="true">↻</span></button>}
      {snapshot && <>
        <div className="sidebar-account-summary" aria-live="polite">
          <strong>{groups.length} 个平台 · {total} 个账号</strong>
          {total > 0 && <span>{[`${online} 在线`, attention ? `${attention} 需处理` : '', unknown ? `${unknown} 待确认` : '', busy ? `${busy} 处理中` : ''].filter(Boolean).join(' · ')}</span>}
        </div>
        <div className="sidebar-account-list" role="region" aria-label="按平台分组的账号名单" tabIndex={0}>
          {total === 0 && <p className="sidebar-account-state">尚未添加账号，连接后将在这里显示。</p>}
          {[...groups].sort((a, b) => Number(b.attention + b.unknown > 0) - Number(a.attention + a.unknown > 0)).map(group => {
            const isExpanded = expanded[group.platform] ?? (groups.length === 1 || group.attention + group.unknown > 0);
            const listId = `${panelId}-${group.platform}`;
            return <section className="sidebar-account-group" key={group.platform}>
              <button type="button" className="sidebar-account-group-toggle" aria-expanded={isExpanded} aria-controls={listId}
                onClick={() => setExpanded(value => ({ ...value, [group.platform]: !isExpanded }))}
                onKeyDown={event => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                  event.preventDefault(); setExpanded(value => ({ ...value, [group.platform]: event.key === 'ArrowRight' }));
                } }}>
                <PlatformIcon platform={group.platform} name={group.name} className="sidebar-account-brand" />
                <span className="sidebar-account-group-label"><strong>{group.name}<small>{group.accounts.length} 个账号</small></strong>
                  <span className={group.attention ? 'has-attention' : ''}>{snapshotGroupSummary(group)}</span></span>
                <span className={`sidebar-account-chevron${isExpanded ? ' is-expanded' : ''}`} aria-hidden="true">›</span>
              </button>
              <ul id={listId} hidden={!isExpanded}>
                {group.accounts.map(account => {
                  const time = Number.isFinite(account.checkedAt) ? `上次核验：${new Date(account.checkedAt!).toLocaleString()}` : '尚未在线核验';
                  return <li key={account.key}><button type="button" className={`sidebar-account-row is-${account.state}`}
                    aria-label={`管理${group.name}账号 ${account.name}${account.detail ? ' · ' + account.detail : ''}${account.source === 'default' ? '，默认通道' : ''}，${account.status}`}
                    title={[account.name, account.detail, account.status, time, account.state === 'unknown' ? '尚未确认当前是否在线，不代表已退出' : ''].filter(Boolean).join('；')}
                    onClick={() => navigate(account.target)}>
                    <span className="sidebar-account-identity"><span className="sidebar-account-name">{account.name}</span>
                      {account.detail && <small>{account.detail}</small>}
                      {account.source === 'default' && <small className="sidebar-account-default">默认通道</small>}</span>
                    <span className="sidebar-account-status"><i aria-hidden="true" />{account.status}</span>
                    <span aria-hidden="true">›</span>
                  </button></li>;
                })}
              </ul>
            </section>;
          })}
        </div>
      </>}
      <div className="sidebar-account-footer">{error === 'login' ? <a className="sidebar-account-open" href="/login">重新登录工作台 <span aria-hidden="true">→</span></a> : <>
        <button type="button" className="sidebar-account-add" onClick={() => navigate('create')}>＋ 添加账号</button>
        <button type="button" className="sidebar-account-open" onClick={() => navigate()}>查看全部账号 <span aria-hidden="true">→</span></button>
      </>}</div>
    </div>, document.body)}
  </>;
}
