import { useAccountHealth, useAccountHealthPolling } from '../lib/accountHealth';
import '../styles/account-health.css';

export default function AccountHealthNotice({ onOpen }: { onOpen: (accountId?: string, platform?: string) => void }) {
  useAccountHealthPolling();
  const { snapshot, unavailable } = useAccountHealth();
  if (!snapshot && !unavailable) return null;
  const issues = snapshot?.accounts.filter(row => row.state === 'login_required' || row.state === 'identity_changed'
    || row.state === 'unknown' && !row.checking && !row.busy) || [];
  if (!issues.length && !unavailable && snapshot?.running && !snapshot.scanFailed) return null;
  const lost = issues.filter(row => row.state === 'login_required' || row.state === 'identity_changed');
  const target = lost[0] || issues[0];
  const title = unavailable || !snapshot?.running || snapshot.scanFailed ? '账号巡检暂不可用'
    : lost.length ? `${lost.length} 个账号需重新连接` : `${issues.length} 个账号在线状态待确认`;
  return <aside className="account-health-notice" aria-label="账号连接提醒" role={lost.length ? 'alert' : 'status'}>
    <div><strong>{title}</strong><p>{unavailable ? '状态同步失败，不能据上次结果确认当前在线；请重试。'
      : lost.length ? '平台已确认登录失效或身份变化；相关内容保留，发布前仍会核验。'
        : '后台按账号串行复检，网络失败或过期结果不会继续标为在线。'}</p></div>
    <button className="btn" onClick={() => onOpen(target?.accountId, target?.platform)}>查看账号</button>
  </aside>;
}
