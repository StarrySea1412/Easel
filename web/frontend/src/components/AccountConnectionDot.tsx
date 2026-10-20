import { useEffect, useId, useRef, useState } from 'react';
import { type AccountConnection } from '../lib/whoami';
import '../styles/account-connection-dot.css';

type Props = { connection: AccountConnection; checking?: boolean; checkedAt?: number; message?: string };

export default function AccountConnectionDot({ connection, checking, checkedAt, message }: Props) {
  const pending = checking || connection === 'unknown';
  const state = pending ? 'checking' : connection;
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const visible = !dismissed && (open || hovered || focused);
  const root = useRef<HTMLSpanElement>(null);
  const detailId = useId();
  useEffect(() => {
    if (!visible) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) { setOpen(false); setDismissed(true); } };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [visible]);
  const label = checking ? '正在检测' : connection === 'online' ? '已连接'
    : connection === 'login_required' || connection === 'not_connected' ? '未登录' : '正在确认连接';
  const time = checkedAt ? `上次核验：${new Date(checkedAt).toLocaleString()}` : '尚未在线核验';
  const explanation = connection === 'unknown' && !checking ? '尚未确认当前是否在线，不代表未登录' : '';
  const reason = message && !['未登录', '登录状态有效'].includes(message) ? message : checkedAt ? '上次结果已过期，等待重新确认' : '';
  const detail = [label, explanation, time, connection === 'unknown' && !checking ? reason : ''].filter(Boolean).join('；');
  return <span ref={root} className={`account-connection-dot is-${state}${visible ? ' is-open' : ''}`}
    onMouseEnter={() => { setHovered(true); setDismissed(false); }} onMouseLeave={() => setHovered(false)}>
    <button type="button" aria-label={detail} title={detail} aria-expanded={visible} aria-describedby={visible ? detailId : undefined}
      onFocus={() => { setFocused(true); setDismissed(false); }} onBlur={() => setFocused(false)}
      onClick={() => { setOpen(!open); setDismissed(open); }} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); setDismissed(true); } }}>
      <span className="account-connection-dot-mark" aria-hidden="true" />
    </button>
    {visible && <span id={detailId} role="tooltip" className="account-connection-dot-detail">{detail}</span>}
  </span>;
}
