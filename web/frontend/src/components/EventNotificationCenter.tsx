import { useCallback, useId, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPanel } from '../hooks/useAnchoredPanel';
import { clearEvents, markEventsRead, readEvents, readEventSync, removeEvents, syncEvents, subscribeEvents, type EventNotice, type NoticeTarget } from '../lib/eventNotifications';
import { isLegacyTransientNotice } from '../lib/noticeFormat';
import { showToast } from '../lib/toast';
import InlineInfo from './InlineInfo';
import NotificationIcon from './NotificationIcon';
import { IconChevron } from './icons';
import '../styles/event-notifications.css';

const toneLabels = { error: '需要留意', success: '已完成', info: '动态' };
const sourceLabel = (notice: EventNotice) => notice.target?.page === 'chat' ? '对话' : notice.target?.page === 'image' ? '生成工坊' : notice.target?.page === 'outputs' ? '内容库' : notice.target?.page === 'publish' ? '发布' : '工作台';
const day = (at: number) => new Date(at).toLocaleDateString('zh-CN');
function dateLabel(at: number) {
  const today = new Date(); const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  return day(at) === day(today.getTime()) ? '今天' : day(at) === day(yesterday.getTime()) ? '昨天' : new Date(at).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}

export default function EventNotificationCenter({ onOpen, onNoticeAcknowledged }: { onOpen: (target: NoticeTarget) => void | boolean | Promise<void | boolean>; onNoticeAcknowledged?: (sessionId: string) => void }) {
  const notices = useSyncExternalStore(subscribeEvents, readEvents);
  const sync = useSyncExternalStore(subscribeEvents, readEventSync);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [confirmClear, setConfirmClear] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const opening = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const filterButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const panelId = useId();
  const unread = notices.filter(notice => !notice.read).length;
  const visible = filter === 'unread' ? notices.filter(notice => !notice.read) : notices;
  const noise = notices.filter(notice => isLegacyTransientNotice(notice.message));
  const dismiss = useCallback(() => { setOpen(false); setConfirmClear(false); }, []);
  const close = () => { dismiss(); button.current?.focus(); };
  const position = useAnchoredPanel(open, dismiss, button, panel, 'beside', 440);
  const markRead = (id?: string) => {
    // “标为已读/全部已读”同时把对应会话的终态角标记为已读（侧边栏红/绿点随之清除）。
    const acknowledged = id ? notices.filter(notice => notice.id === id) : notices.filter(notice => !notice.read);
    markEventsRead(id);
    if (onNoticeAcknowledged) {
      const seen = new Set<string>();
      for (const notice of acknowledged) {
        const sessionId = notice.target?.page === 'chat' ? notice.target.sessionId : undefined;
        if (sessionId && !seen.has(sessionId)) { seen.add(sessionId); onNoticeAcknowledged(sessionId); }
      }
    }
    filterButton.current?.focus();
  };
  const cleanNoise = async () => {
    const removable = notices.filter(notice => isLegacyTransientNotice(notice.message));
    if (!removable.length) return;
    const done = await removeEvents(removable.map(notice => notice.id));
    showToast(done ? `已清理 ${removable.length} 条提示记录。` : '清理未生效：服务暂不支持或未能确认，记录保持原样。', done ? 'success' : 'error');
    panel.current?.focus();
  };
  const openNotice = async (notice: EventNotice) => {
    if (opening.current) return;
    opening.current = true; setOpeningId(notice.id);
    try {
      if (notice.target && await onOpen(notice.target) === false) return;
      if (!notice.target) notice.action?.run();
      markEventsRead(notice.id);
      if (notice.target?.page === 'chat') onNoticeAcknowledged?.(notice.target.sessionId);
      close();
    } catch {
      showToast('暂时无法打开，请重试', 'error');
    } finally { opening.current = false; setOpeningId(null); }
  };
  return <div className="global-events">
    <button ref={button} id={panelId + '-trigger'} type="button" className={'nav-item global-events-entry' + (open ? ' is-open' : '')} title={'事件通知，' + unread + ' 条未读'} aria-label={'事件通知，' + unread + ' 条未读'}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => open ? dismiss() : setOpen(true)}>
      <span className="nav-icon" aria-hidden="true"><NotificationIcon name='bell' size={19} /></span><span className="nav-item-label">事件通知</span>{unread > 0 && <b className="event-unread-badge">{unread > 99 ? '99+' : unread}</b>}
    </button>
    {open && createPortal(<section ref={panel} id={panelId} className="global-events-panel" style={position} role="dialog" aria-labelledby={panelId + '-title'} tabIndex={-1}>
      <header className="event-panel-header"><div className="event-heading"><span className="event-heading-icon" aria-hidden="true"><NotificationIcon name='bell' size={18} /></span>
        <div><h2 id={panelId + '-title'}>事件通知</h2><p>对话、生成与发布的最新动态</p></div></div>
        <button className="event-icon-button" type="button" aria-label="关闭事件通知" title="关闭" onClick={close}><NotificationIcon name='x' size={17} /></button>
      </header>
      <div className="event-panel-toolbar"><div className="event-filters" role="group" aria-label="筛选事件" aria-live="polite">
        <button ref={filter === 'all' ? filterButton : undefined} type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>全部<span>{notices.length}</span></button>
        <button ref={filter === 'unread' ? filterButton : undefined} type="button" aria-pressed={filter === 'unread'} onClick={() => setFilter('unread')}>未读<span>{unread}</span></button></div>
        <button type="button" className="event-mark-all" disabled={!unread} onClick={() => markRead()}><NotificationIcon name='check' size={14} />全部已读</button>
      </div>
      <div className="event-panel-scroll">
        {visible.length ? <ol className="event-list">{visible.map((notice, index) => <li key={notice.id}>
          {(index === 0 || day(visible[index - 1].at) !== day(notice.at)) && <h3 className="event-date-heading">{dateLabel(notice.at)}</h3>}
          <article className={'event-card ' + notice.tone + (notice.read ? ' is-read' : ' is-unread')}>
            <span className="event-notice-tone" role="img" aria-label={toneLabels[notice.tone]} title={toneLabels[notice.tone]}>{notice.tone === 'success' ? <NotificationIcon name='check' size={16} /> : notice.tone === 'error' ? <NotificationIcon name='triangle-alert' size={16} /> : <NotificationIcon name='info' size={16} />}</span>
            <div className="event-card-content"><div className="event-card-meta"><span>{sourceLabel(notice)}</span>
              <time dateTime={new Date(notice.at).toISOString()} title={new Date(notice.at).toLocaleString('zh-CN', { hour12: false })}>{new Date(notice.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</time></div>
              {(notice.target || notice.action) ? <button type="button" className="event-view event-message-link" aria-label={'查看：' + notice.message} disabled={openingId !== null} aria-busy={openingId === notice.id} onClick={() => { void openNotice(notice); }}><span className="event-card-message">{notice.message}</span></button>
                : <p className="event-card-message">{notice.message}</p>}
            </div>
            <div className="event-row-state">
                {/* 读态点与勾共用同一槽位：未读实心点、已读弱化点恒可见；未读行 hover/聚焦时点让位给勾，无布局跳动。 */}
                <span className={'event-read-state ' + (notice.read ? 'is-read' : 'is-unread')} role="img" aria-label={notice.read ? '已读' : '未读'} title={notice.read ? '已读' : '未读'} />
                {!notice.read && <button type="button" className="event-icon-button event-mark-one" aria-label={'标为已读：' + notice.message} title="标为已读" onClick={() => markRead(notice.id)}><NotificationIcon name='check' size={14} /></button>}
            </div>
          </article>
        </li>)}</ol> : <div className="event-empty" role="status"><span aria-hidden="true">{filter === 'unread' && notices.length ? <NotificationIcon name='check' size={27} /> : <NotificationIcon name='bell' size={27} />}</span>
          <h3>{filter === 'unread' && notices.length ? '都看过了' : '暂时没有新动态'}</h3><p>{filter === 'unread' && notices.length ? '所有通知已读，稍后再来看看。' : '对话、生成与发布的完成或失败，都会汇集在这里。'}</p>
          {filter === 'unread' && notices.length > 0 && <button type="button" className="event-view" onClick={() => setFilter('all')}>查看全部事件<IconChevron size={13} /></button>}</div>}
      </div>
      <footer className="event-panel-footer">
        {confirmClear ? <div className="event-clear-confirm"><span>清空本工作台的通知记录？</span><button autoFocus type="button" onClick={() => { setConfirmClear(false); panel.current?.focus(); }}>取消</button>
          <button type="button" className="event-clear-danger" onClick={() => { clearEvents(); setConfirmClear(false); panel.current?.focus(); }}>确认清空</button></div> : <>
          <div className="event-history-note"><span className={'event-sync-dot' + (sync === 'error' ? ' is-error' : '')} aria-hidden="true" /><span>{sync === 'saved' ? '已同步' : sync === 'syncing' ? '正在同步' : sync === 'error' ? '同步失败 · 记录已保留' : '本地记录'}</span><InlineInfo label="通知存储说明" hover>最近1000条保存在工作台服务器，登录同一工作台的不同浏览器可同步。点击对话通知会从服务器读取原对话；暂时不可读时保留通知供重试。页面关闭期间，对话任务的结束事件仍由后端记录。清空记录不会停止任务。</InlineInfo>{sync === 'error' && <button type="button" onClick={() => { void syncEvents(); }}>重试同步</button>}</div>
          <div className="event-footer-actions">
            {noise.length > 0 && <button type="button" className="event-clean-noise" title="瞬时确认提示不再进入通知；这些是旧版本留下的记录" onClick={cleanNoise}>清理 {noise.length} 条提示记录</button>}
            <button type="button" className="event-clear" disabled={!notices.length} onClick={() => setConfirmClear(true)}><NotificationIcon name='trash' size={13} />清空</button>
          </div></>}
      </footer>
    </section>, document.body)}
  </div>;
}
