import { useSyncExternalStore } from 'react';
import { workbenchAccess } from '../lib/workbenchAccess';
import '../styles/workbench-login-notice.css';

export default function WorkbenchLoginNotice() {
  const expired = useSyncExternalStore(workbenchAccess.subscribe, workbenchAccess.snapshot);
  if (!expired) return null;
  return <aside className="workbench-login-notice" role="alert" aria-label="工作台需要重新登录">
    <div><strong>工作台登录已过期</strong><p>请重新登录后继续使用。</p></div>
    <a className="btn btn-primary btn-sm" href="/login">重新登录工作台</a>
  </aside>;
}
