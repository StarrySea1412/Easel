import { useCallback, useId, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPanel } from '../hooks/useAnchoredPanel';
import { clearEvents, markEventsRead, readEvents, readEventSync, removeEvents, syncEvents, subscribeEvents, type EventNotice, type NoticeTarget } from '../lib/eventNotifications';
import { isLegacyTransientNotice } from '../lib/noticeFormat';
import { showToast } from '../lib/toast';
import InlineInfo from './InlineInfo';
import { IconBell } from './settingsIcons';
import { IconCheck, IconChevron, IconInfo, IconTrash } from './icons';
import '../styles/event-notifications.css';

const toneLabels = { error: '需要留意', success: '已完成', info: '动态' };
const sourceLabel = (notice: EventNotice) => notice.target?.page === 'chat' ? '对话' : notice.target?.page === 'image' ? '生成工坊' : notice.target?.page === 'outputs' ? '内容库' : notice.target?.page === 'publish' ? '发布' : '工作台';
const day = (at: number) => new Date(at).toLocaleDateString('zh-CN');
function dateLabel(at: number) {
  const today = new Date(); const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  return day(at) === day(today.getTime()) ? '今天' : day(at) === day(yesterday.getTime()) ? '昨天' : new Date(at).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}

export default function EventNotificationCenter({ onOpen }: { onOpen: (target: NoticeTarget) => void }) {
  const notices = useSyncExternalStore(subscribeEvents, readEvents);
  const sync = useSyncExternalStore(subscribeEvents, readEventSync);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [confirmClear, setConfirmClear] = useState(false);
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
  const markRead = (id?: string) => { markEventsRead(id); filterButton.current?.focus(); };
  const cleanNoise = async () => {
    const removable = notices.filter(notice => isLegacyTransientNotice(notice.message));
    if (!removable.length) return;
    const done = await removeEvents(removable.map(notice => notice.id));
    showToast(done ? `已清理 ${removable.length} 条提示记录。` : '清理未生效：服务暂不支持或未能确认，记录保持原样。', done ? 'success' : 'error');
    panel.current?.focus();
  };
  return <div className="global-events">
    <button ref={button} type="button" className={'nav-item global-events-entry' + (open ? ' is-open' : '')} title={'事件通知，' + unread + ' 条未读'} aria-label={'事件通知，' + unread + ' 条未读'}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => open ? dismiss() : setOpen(true)}>
      <span className="nav-icon" aria-hidden="true"><IconBell size={19} /></span><span className="nav-item-label">事件通知</span>{unread > 0 && <b className="event-unread-badge">{unread > 99 ? '99+' : unread}</b>}
    </button>
    {open && createPortal(<section ref={panel} id={panelId} className="global-events-panel" style={position} role="dialog" aria-labelledby={panelId + '-title'} tabIndex={-1}>
      <header className="event-panel-header"><div className="event-heading"><span className="event-heading-icon" aria-hidden="true"><IconBell size={18} /></span>
        <div><h2 id={panelId + '-title'}>事件通知</h2><p>对话、生成与发布的最新动态</p></div></div>
        <button className="event-icon-button" type="button" aria-label="关闭事件通知" title="关闭" onClick={close}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
      </header>
      <div className="event-panel-toolbar"><div className="event-filters" role="group" aria-label="筛选事件" aria-live="polite">
        <button ref={filter === 'all' ? filterButton : undefined} type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>全部<span>{notices.length}</span></button>
        <button ref={filter === 'unread' ? filterButton : undefined} type="button" aria-pressed={filter === 'unread'} onClick={() => setFilter('unread')}>未读<span>{unread}</span></button></div>
        <button type="button" className="event-mark-all" disabled={!unread} onClick={() => markRead()}><IconCheck size={14} />全部已读</button>
      </div>
      <div className="event-panel-scroll">
        {visible.length ? <ol className="event-list">{visible.map((notice, index) => <li key={notice.id}>
          {(index === 0 || day(visible[index - 1].at) !== day(notice.at)) && <h3 className="event-date-heading">{dateLabel(notice.at)}</h3>}
          <article className={'event-card ' + notice.tone + (notice.read ? ' is-read' : ' is-unread')}>
            <span className="event-notice-tone" role="img" aria-label={toneLabels[notice.tone]} title={toneLabels[notice.tone]}>{notice.tone === 'success' ? <IconCheck size={16} /> : notice.tone === 'error' ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m10.3 4-8 14a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4m0 3v1" /></svg> : <IconInfo size={16} />}</span>
            <div className="event-card-content"><div className="event-card-meta"><span>{sourceLabel(notice)}</span>
              <time dateTime={new Date(notice.at).toISOString()} title={new Date(notice.at).toLocaleString('zh-CN', { hour12: false })}>{new Date(notice.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</time></div>
              {(notice.target || notice.action) ? <button type="button" className="event-view event-message-link" aria-label={'查看：' + notice.message} onClick={() => {
                  markEventsRead(notice.id); close();
                  if (notice.target) onOpen(notice.target); else notice.action?.run();
                }}><span className="event-card-message">{notice.message}</span><IconChevron size={14} /></button>
                : <p className="event-card-message">{notice.message}</p>}
            </div>
            <div className="event-row-state">
                {!notice.read && <span className="event-unread-dot" title="未读" aria-label="未读" />}
                <button type="button" className="event-icon-button event-mark-one" disabled={notice.read} aria-label={(notice.read ? '已读' : '标为已读') + '：' + notice.message} title={notice.read ? '已读' : '标为已读'} onClick={() => markRead(notice.id)}><IconCheck size={14} /></button>
            </div>
          </article>
        </li>)}</ol> : <div className="event-empty" role="status"><span aria-hidden="true">{filter === 'unread' && notices.length ? <IconCheck size={27} /> : <IconBell size={27} />}</span>
          <h3>{filter === 'unread' && notices.length ? '都看过了' : '暂时没有新动态'}</h3><p>{filter === 'unread' && notices.length ? '所有通知已读，稍后再来看看。' : '对话、生成与发布的完成或失败，都会汇集在这里。'}</p>
          {filter === 'unread' && notices.length > 0 && <button type="button" className="event-view" onClick={() => setFilter('all')}>查看全部事件<IconChevron size={13} /></button>}</div>}
      </div>
      <footer className="event-panel-footer">
        {confirmClear ? <div className="event-clear-confirm"><span>清空本工作台的通知记录？</span><button autoFocus type="button" onClick={() => { setConfirmClear(false); panel.current?.focus(); }}>取消</button>
          <button type="button" className="event-clear-danger" onClick={() => { clearEvents(); setConfirmClear(false); panel.current?.focus(); }}>确认清空</button></div> : <>
          <div className="event-history-note"><span className={'event-sync-dot' + (sync === 'error' ? ' is-error' : '')} aria-hidden="true" /><span>{sync === 'saved' ? '已保存到本机' : sync === 'syncing' ? '正在同步' : sync === 'error' ? '同步失败 · 记录已保留' : '本机记录'}</span><InlineInfo label="通知存储说明" hover>最近1000条保存在本工作台的数据目录，跨标签页和重启保留。页面关闭期间，对话任务的结束事件仍由后端记录；其它仅由页面观察的动态在打开时收录。清空记录会同步到其它标签页，不会停止任务。瞬时确认提示不再进入通知，旧版本留下的这类记录可用“清理提示记录”移除。</InlineInfo>{sync === 'error' && <button type="button" onClick={() => { void syncEvents(); }}>重试同步</button>}</div>
          <div className="event-footer-actions">
            {noise.length > 0 && <button type="button" className="event-clean-noise" title="瞬时确认提示不再进入通知；这些是旧版本留下的记录" onClick={cleanNoise}>清理 {noise.length} 条提示记录</button>}
            <button type="button" className="event-clear" disabled={!notices.length} onClick={() => setConfirmClear(true)}><IconTrash size={13} />清空</button>
          </div></>}
      </footer>
    </section>, document.body)}
  </div>;
}
