import { useEffect, useState } from 'react';
import { TOAST_EVENT, type ToastNotice } from '../lib/toast';
import { IconCheck, IconInfo } from './icons';
import '../styles/toast-host.css';

function ToneIcon({ tone }: { tone: ToastNotice['tone'] }) {
  if (tone === 'success') return <IconCheck size={14} />;
  if (tone === 'error') return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m10.3 4-8 14a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4m0 3v1" /></svg>;
  return <IconInfo size={14} />;
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
      <span>{notice.message}</span>{notice.action && <button type="button" className="toast-action" onClick={()=>{notice.action?.run();setNotice(null);}}>{notice.action.label}</button>}<button type="button" className="toast-dismiss" aria-label="关闭提示" onClick={() => setNotice(null)}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
    </div>}
  </div>;
}
