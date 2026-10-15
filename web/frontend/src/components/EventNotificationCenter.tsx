import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { clearEvents, markEventsRead, readEvents, subscribeEvents, type NoticeTarget } from '../lib/eventNotifications';
import { IconBell } from './settingsIcons';
import '../styles/event-notifications.css';

export default function EventNotificationCenter({ onOpen }: { onOpen: (target: NoticeTarget) => void }) {
  const notices = useSyncExternalStore(subscribeEvents, readEvents);
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const panelId = useId();
  const unread = notices.filter(notice => !notice.read).length;
  const close = () => { setOpen(false); button.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault(); setOpen(false); button.current?.focus();
      }
    };
    const outside = (event: Event) => { if (!host.current?.contains(event.target as Node)) setOpen(false); };
    const navigate = () => setOpen(false);
    document.addEventListener('keydown', dismiss);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    window.addEventListener('easel:page-navigation', navigate);
    return () => {
      document.removeEventListener('keydown', dismiss);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      window.removeEventListener('easel:page-navigation', navigate);
    };
  }, [open]);
  return <div ref={host} className="global-events">
    <button ref={button} type="button" className="global-events-entry" aria-label={`事件通知，${unread} 条未读`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen(!open)}>
      <IconBell size={16} />事件通知{unread > 0 && <b>{unread}</b>}
    </button>
    {open && <section ref={panel} id={panelId} className="global-events-panel" role="dialog" aria-label="全局事件通知" tabIndex={-1}>
      <header><strong>事件通知</strong><button type="button" disabled={!unread} onClick={() => markEventsRead()}>全部已读</button>
        <button type="button" disabled={!notices.length} onClick={clearEvents}>清空</button><button type="button" aria-label="关闭事件通知" onClick={close}>×</button></header>
      <p>本标签页最近 100 条事件，刷新后保留；关闭页面期间的新事件不在此列表中。</p>
      <ol>{notices.map(notice => <li key={notice.id} className={`${notice.tone}${notice.read ? ' is-read' : ''}`}>
        <span className="event-notice-tone" aria-label={notice.tone === 'error' ? '失败' : notice.tone === 'success' ? '完成' : '提示'}>{notice.tone === 'error' ? '!' : notice.tone === 'success' ? '✓' : 'i'}</span>
        <div><strong>{notice.message}</strong><time dateTime={new Date(notice.at).toISOString()}>{new Date(notice.at).toLocaleString('zh-CN', { hour12: false })}</time>
          {(notice.target || notice.action) && <button type="button" aria-label={`查看：${notice.message}`} onClick={() => {
            markEventsRead(notice.id); close();
            if (notice.target) onOpen(notice.target); else notice.action?.run();
          }}>查看</button>}
        </div>{!notice.read && <button type="button" aria-label={`标为已读：${notice.message}`} onClick={() => markEventsRead(notice.id)}>已读</button>}
      </li>)}</ol>{!notices.length && <p role="status">暂无事件。对话、生成和发布的完成或失败会显示在这里。</p>}
    </section>}
  </div>;
}
