import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fetchAccounts } from '../lib/api';
import { ACCOUNT_STATE_EVENT, accountConnection, hydrateAccountIdentities, useAccountIdentities, useAccountChecks, type AccountConnection } from '../lib/whoami';
import AccountConnectionDot from './AccountConnectionDot';
import PlatformIcon from './PlatformIcon';
import { openSidebarPanel, SIDEBAR_PANEL_EVENT } from '../lib/sidebarPanels';
import { IconAccounts } from './icons';
import '../styles/sidebar-account-popover.css';

const PLATFORMS = [
  ['xiaohongshu', '小红书'], ['kuaishou', '快手'], ['weixin-channels', '视频号'],
  ['zhihu', '知乎'], ['bilibili', '哔哩哔哩'], ['douyin', '抖音'], ['wechat-oa', '微信公众号'],
] as const;
type Snapshot = { platform: string; name: string; loggedIn: boolean | null; hasLocalSession?: boolean }[];

export default function SidebarAccountPopover({ active, onNavigate }: { active: boolean; onNavigate: () => void }) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
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
      if (!open) { setSnapshot(undefined); setError(false); }
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
    const update = () => setRevision(value => value + 1);
    window.addEventListener(ACCOUNT_STATE_EVENT, update); window.addEventListener('storage', update);
    return () => { window.removeEventListener(ACCOUNT_STATE_EVENT, update); window.removeEventListener('storage', update); };
  }, []);
  useEffect(() => {
    if (!open) return;
    let stale = false;
    setSnapshot(undefined);
    setError(false);
    // This endpoint reads local state only. Never run browser-based whoami as a
    // side effect of hovering a navigation item, and never render credentials.
    fetchAccounts().then(accounts => {
      if (stale) return;
      hydrateAccountIdentities(accounts);
      setSnapshot(PLATFORMS.map(([platform, name]) => {
        const account = accounts.find(item => item.platform === platform);
        return { platform, name, loggedIn: account?.loggedIn ?? null, hasLocalSession: account?.hasLocalSession };
      }));
    }).catch(() => { if (!stale) setError(true); });
    return () => { stale = true; };
  }, [open, revision]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = Math.min(300, window.innerWidth - 24);
      const height = panel.current?.getBoundingClientRect().height || 350;
      setPosition({ width, left: Math.max(12, Math.min(anchor.right + 10, window.innerWidth - width - 12)),
        top: Math.max(12, Math.min(anchor.top, window.innerHeight - height - 12)) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, snapshot, error]);

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

  const connectionOf = (platform: string): AccountConnection => {
    const account = snapshot?.find(row => row.platform === platform);
    return accountConnection(account ? { loggedIn: account.loggedIn === true, hasLocalSession: account.hasLocalSession } : undefined, identities[platform]);
  };
  const connected = snapshot?.filter(account => connectionOf(account.platform) === 'online');
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
      {error && <p className="sidebar-account-state" role="alert">本次快照读取失败，暂不能确认登录状态。</p>}
      {snapshot && <>
        <p className="sidebar-account-summary">{connected?.length ? `${connected.length} 个平台已确认在线` : '尚无可确认的已登录平台'}</p>
        <ul>{snapshot.map(account => <li key={account.platform}>
          <PlatformIcon platform={account.platform} name={account.name} className="sidebar-account-brand" />
          <span className="sidebar-account-name" title={account.name}>{identities[account.platform]?.loggedIn && identities[account.platform]?.name && localStorage.getItem('easel_account_privacy') !== '1' ? identities[account.platform].name : account.name}</span>
          <AccountConnectionDot connection={connectionOf(account.platform)} checking={checks.has(account.platform)} checkedAt={identities[account.platform]?.checkedAt} message={identities[account.platform]?.verificationMessage} />
        </li>)}</ul>
      </>}
      <button type="button" className="sidebar-account-open" onClick={() => { close(); onNavigate(); }}>查看账号 <span aria-hidden="true">→</span></button>
    </div>, document.body)}
  </>;
}
