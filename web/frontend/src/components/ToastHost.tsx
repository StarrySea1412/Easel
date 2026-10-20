import { useEffect, useState } from 'react';
import { TOAST_EVENT, type ToastNotice } from '../lib/toast';
import NotificationIcon from './NotificationIcon';
import '../styles/toast-host.css';

function ToneIcon({ tone }: { tone: ToastNotice['tone'] }) {
  if (tone === 'success') return <NotificationIcon name="check" size={16} />;
  if (tone === 'error') return <NotificationIcon name="triangle-alert" size={16} />;
  return <NotificationIcon name="info" size={16} />;
}

export default function ToastHost() {
  const [notice, setNotice] = useState<(ToastNotice & { id: number }) | null>(null);
  useEffect(() => {
    let id = 0;
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<ToastNotice>).detail;
      if (detail && typeof detail.message === 'string') setNotice({ ...detail, id: ++id });
    };
    window.addEventListener(TOAST_EVENT, receive);
    return () => window.removeEventListener(TOAST_EVENT, receive);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.tone === 'error' ? 7000 : 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  return <div className="toast-host" aria-live="polite" aria-atomic="true">
    {notice && <div key={notice.id} className={`toast-notice ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
      <span className="toast-notice-icon" aria-hidden="true"><ToneIcon tone={notice.tone} /></span>
      <span>{notice.message}</span>{notice.action && <button type="button" className="toast-action" onClick={()=>{notice.action?.run();setNotice(null);}}>{notice.action.label}</button>}<button type="button" className="toast-dismiss" aria-label="关闭提示" onClick={() => setNotice(null)}><NotificationIcon name='x' size={13} /></button>
    </div>}
  </div>;
}
