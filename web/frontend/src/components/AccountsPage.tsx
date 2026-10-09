import { useState, useEffect, useCallback, useRef } from 'react';
import {
  fetchAccounts, startLogin, loginStatus, mediaUrl,
  accountWhoami, logoutAccount, submitLoginSms,
  saveCredentials, getCredentials, startMpLogin, mpLoginStatus,
} from '../lib/api';
import type { AccountItem, AccountWhoami, LoginStatus } from '../lib/api';
import { ACCOUNT_STATE_EVENT, getWhoamiCache, setWhoamiCache, verifyStale } from '../lib/whoami';
import { useModalFocus } from '../hooks/useModalFocus';
import { OTHER_ANALYSIS_PLATFORMS } from './PlatformAnalysisPanel';
import PlatformIcon from './PlatformIcon';
import { IconAccounts, IconEye, IconEyeOff, IconRefresh } from './icons';
import '../styles/accounts.css';

type QRState = {
  platform: string;
  name: string;
  flow: 'account' | 'mp';
  visibleBrowser: boolean;
  state: string;       // starting | qr_ready | success | expired | error | unknown
  message: string;
  qr: string;          // outputs 相对路径
  qrTs?: number;       // 二维码文件 mtime，作 img 缓存键：码刷新一次就变，避免看到过期旧码
  qrKind?: 'qr' | 'page';
  qrWidth?: number;
  qrHeight?: number;
};

const STATE_LABEL: Record<string, string> = {
  starting: '启动中…',
  qr_ready: '请扫码',
  scanned: '扫码成功',
  sms_required: '需短信验证',
  verifying: '验证中…',
  success: '登录成功 ✅',
  expired: '二维码已过期',
  error: '登录出错',
  unknown: '等待中…',
};
const isLoginTerminal = (state: string) => ['success', 'expired', 'error'].includes(state);

/** 头像：有 URL 就显示图（加载失败退回首字），否则显示昵称/平台名首字。 */
function Avatar({ url, name }: { url?: string; name: string }) {
  const [broken, setBroken] = useState(false);
  const initial = (name || '?').trim().charAt(0);
  if (url && !broken) {
    return <img className="account-avatar" src={url} alt={name}
      referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
  }
  return <div className="account-avatar account-avatar-fallback">{initial}</div>;
}

/** A full login-page screenshot needs its own readable view, rather than a QR label. */
function LoginImage({ login, nonce }: { login: QRState; nonce: number }) {
  const [expanded, setExpanded] = useState(false);
  const [broken, setBroken] = useState(false);
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const src = `${mediaUrl(login.qr)}?v=${login.qrTs || nonce}`;
  const width = login.qrWidth || naturalSize.width;
  const height = login.qrHeight || naturalSize.height;
  // Older servers have no kind metadata. Dimensions affect layout only: they do
  // not prove that a square image actually contains a QR code.
  const page = login.qrKind === 'page' || (!login.qrKind && (!width || !height || width / height < .8 || width / height > 1.2));
  const label = login.qrKind === 'qr' ? '登录二维码' : login.qrKind === 'page' ? '官方登录页面预览' : '登录图像';

  useEffect(() => { setBroken(false); }, [src]);

  return (
    <div className={`account-login-image ${page ? 'account-login-image-page' : 'account-login-image-code'}`}>
      <p className="account-login-image-hint">
        {login.qrKind === 'qr' ? '用手机 App 扫描下方二维码，并在手机上确认登录。'
          : login.qrKind === 'page' ? (login.visibleBrowser
            ? '这是官方登录页面预览。可放大查看；请在已打开的本机平台窗口完成登录或安全验证。'
            : '这是官方登录页面预览，可放大检查。如页面未出现二维码，请重新连接。')
            : '请确认图片中的登录内容；页面截图可放大查看。'}
      </p>
      {broken ? <p className="account-login-image-error" role="alert">登录图片加载失败。请重新连接，或打开原图检查。</p> : (
        <div className={`account-login-image-viewport${expanded ? ' is-expanded' : ''}`}
          tabIndex={expanded || page ? 0 : undefined} role="region" aria-label={`${label}${expanded ? '，可滚动查看' : ''}`}>
          <img className="account-login-image-content" src={src} alt={label}
            style={expanded ? { width: page ? Math.max(width || 1200, 960) : 480, maxWidth: 'none' } : undefined}
            onLoad={(event) => {
              const image = event.currentTarget;
              setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight });
              setBroken(false);
            }} onError={() => setBroken(true)} />
        </div>
      )}
      <div className="account-login-image-tools">
        <button type="button" className="btn btn-sm" aria-pressed={expanded} disabled={broken}
          onClick={() => setExpanded((value) => !value)}>{expanded ? '恢复大小' : '放大查看'}</button>
        <a className="btn btn-sm" href={src} target="_blank" rel="noopener noreferrer">打开原图</a>
      </div>
      {expanded && <p className="account-login-image-hint">可滚动查看完整图片，按 Tab 切换操作，按 Esc 关闭登录窗口。</p>}
    </div>
  );
}

export default function AccountsPage({ onNavigateAnalysis, onAnalysisLogin }: { onNavigateAnalysis: (platform: string) => void; onAnalysisLogin: () => void }) {
  const [accounts, setAccounts] = useState<AccountItem[]>([]);
  const [err, setErr] = useState('');
  const [qr, setQr] = useState<QRState | null>(null);
  const [qrNonce, setQrNonce] = useState(0);   // 每次登录 +1，稳定缓存 key，避免每次轮询 img 闪烁
  const [terminalMsg, setTerminalMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [logoutBusy, setLogoutBusy] = useState('');
  const [managedPlatform, setManagedPlatform] = useState<string | null>(null);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [logoutMessage, setLogoutMessage] = useState('');
  const [verification, setVerification] = useState<Record<string, { state: 'checking' | 'success' | 'expired' | 'error'; message: string }>>({});
  const [hideIdentity, setHideIdentity] = useState(() => { try { return localStorage.getItem('easel_account_privacy') === '1'; } catch { return false; } });
  const accountDialog = useRef<HTMLDialogElement>(null);
  const identityEpoch = useRef<Record<string, number>>({});
  const [filter, setFilter] = useState<'all' | 'connected' | 'attention'>('all');
  const [loaded, setLoaded] = useState(false);
  const [smsCode, setSmsCode] = useState('');
  const [smsBusy, setSmsBusy] = useState(false);
  const [smsErr, setSmsErr] = useState('');
  // whoami 结果缓存到 localStorage：打开页面秒显示昵称/头像，不必每次都起浏览器校验
  const [whoami, setWhoami] = useState<Record<string, AccountWhoami | 'loading'>>(() => getWhoamiCache());
  // 凭证式登录（微信公众号 AppID/AppSecret）
  const [cred, setCred] = useState<{ platform: string; name: string } | null>(null);
  const [credForm, setCredForm] = useState({ appId: '', appSecret: '', author: '' });
  const [credBusy, setCredBusy] = useState(false);
  const [credMsg, setCredMsg] = useState('');
  const [credErr, setCredErr] = useState('');
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loginAttemptRef = useRef(0);
  const aliveRef = useRef(true);
  const qrPlatformRef = useRef('');   // 当前登录中的平台，供 submitSms 稳定引用

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);
  useEffect(() => {
    const sync = (event: Event) => {
      if (!(event instanceof window.CustomEvent)) return;
      const { platform, entry } = event.detail || {};
      if (typeof platform !== 'string') return;
      setWhoami(value => { const next = { ...value }; if (entry) next[platform] = entry; else delete next[platform]; return next; });
    };
    const storage = (event: StorageEvent) => { if (event.key === 'easel_whoami') setWhoami(getWhoamiCache()); };
    window.addEventListener(ACCOUNT_STATE_EVENT, sync); window.addEventListener('storage', storage);
    return () => { window.removeEventListener(ACCOUNT_STATE_EVENT, sync); window.removeEventListener('storage', storage); };
  }, []);

  // 真校验某平台登录态 + 拉昵称/头像（后端起浏览器，数秒）；手动「校验账号」或登录成功后调
  const runWhoami = useCallback(async (platform: string) => {
    const epoch = (identityEpoch.current[platform] || 0) + 1;
    identityEpoch.current[platform] = epoch;
    setWhoami((w) => ({ ...w, [platform]: 'loading' }));
    setVerification(value => ({ ...value, [platform]: { state: 'checking', message: '正在在线检查登录状态，请稍候…' } }));
    try {
      const r = await accountWhoami(platform);
      if (!aliveRef.current || epoch !== (identityEpoch.current[platform] || 0)) return null;
      if (r.verified === false) {
        setWhoami((w) => { const next = { ...w }; delete next[platform]; return next; });
        setVerification(value => ({ ...value, [platform]: { state: 'error', message: r.verificationMessage || '本次检查未能确认登录状态，保留上次状态，请稍后重试。' } }));
        return null;
      }
      setWhoami((w) => ({ ...w, [platform]: r })); setWhoamiCache(platform, r);
      setAccounts(rows => rows.map(row => row.platform === platform ? { ...row, loggedIn: r.loggedIn } : row));
      setVerification(value => ({ ...value, [platform]: { state: r.loggedIn ? 'success' : 'expired', message: r.loggedIn ? '检查完成：当前登录状态有效。' : '检查完成：未登录或登录已失效，请重新连接。' } }));
      return r;
    } catch (cause) {
      if (aliveRef.current && epoch === (identityEpoch.current[platform] || 0)) {
        setWhoami((w) => { const n = { ...w }; delete n[platform]; return n; });
        setVerification(value => ({ ...value, [platform]: { state: 'error', message: `检查失败：${cause instanceof Error ? cause.message : '请稍后重试'}。尚未确认登录是否有效。` } }));
      }
      return null;
    }
  }, []);

  // 打开页面：拉「快」状态（读 status.json，不起浏览器），随后后台自愈——对缓存缺失/过期的
  // 浏览器平台逐个真校验（whoami），结果到了刷新 UI，并令陈旧的假阴性缓存被真值覆盖。
  const load = useCallback(() => {
    setErr('');
    fetchAccounts()
      .then((list) => {
        if (!aliveRef.current) return;
        setAccounts(list);
        const cached = getWhoamiCache();
        list.forEach(account => {
          if (account.loggedIn && cached[account.platform]?.loggedIn === false) setWhoamiCache(account.platform, null);
        });
        setLoaded(true);
        const targets = list
          .filter((a) => a.supported && a.backend !== 'biliup')
          .map((a) => a.platform);
        verifyStale(targets, {
          alive: () => aliveRef.current,
          onUpdate: (platform, r) => {
            setWhoami((w) => ({ ...w, [platform]: r }));
          },
        });
      })
      .catch(() => setErr('加载账号状态失败'));
  }, []);

  useEffect(() => { load(); }, [load]);

  // 切回本标签页 / 窗口重新获得焦点时自动重拉账号态——登录/退出后即使漏了一次刷新，切回来也是最新的，
  // 用户无需手动刷新页面。（登录中弹着二维码时不打扰，避免打断轮询。）
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible' && !qrPlatformRef.current) load(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);

  const stopPoll = useCallback(() => {
    loginAttemptRef.current++;
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
  }, []);

  useEffect(() => () => stopPoll(), [stopPoll]);

  const closeQr = useCallback(() => {
    stopPoll();
    qrPlatformRef.current = '';
    setQr(null);
    setBusy('');
    setSmsCode(''); setSmsErr(''); setSmsBusy(false);
    load();
  }, [stopPoll, load]);
  const qrModalRef = useModalFocus(qr !== null, closeQr);

  const submitSms = useCallback(async () => {
    const code = smsCode.replace(/\D/g, '');
    if (code.length < 4) { setSmsErr('请输入手机收到的验证码'); return; }
    const attempt = loginAttemptRef.current;
    const current = () => aliveRef.current && attempt === loginAttemptRef.current;
    setSmsBusy(true); setSmsErr('');
    try {
      await submitLoginSms(qrPlatformRef.current, code);
      if (!current()) return;
      setSmsCode('');
      // 乐观切到「验证中」转圈：后端读走码→verifying；成功→success，失败→退回 sms_required 带错误
      setQr((prev) => prev && ({ ...prev, state: 'verifying', message: '正在验证验证码…' }));
      // 不停轮询：runner 读走验证码填码提交后，state 会转 success / 或退回 sms_required 重试
    } catch (e) {
      if (current()) setSmsErr(e instanceof Error ? e.message : '提交验证码失败');
    } finally {
      if (current()) setSmsBusy(false);
    }
  }, [smsCode]);

  // 凭证式（公众号）：打开 AppID/AppSecret 表单
  const openCred = useCallback((a: AccountItem) => {
    setCred({ platform: a.platform, name: a.name });
    setCredForm({ appId: '', appSecret: '', author: '' });
    setCredMsg(''); setCredErr('');
    getCredentials(a.platform)
      .then((c) => { if (aliveRef.current && c.configured) setCredMsg(`已配置：AppID ${c.appIdMasked}`); })
      .catch(() => { /* 未配置，忽略 */ });
  }, []);

  const closeCred = useCallback(() => { setCred(null); setCredBusy(false); load(); }, [load]);

  const submitCred = useCallback(async () => {
    if (!cred) return;
    const appId = credForm.appId.trim();
    const appSecret = credForm.appSecret.trim();
    if (!appId || !appSecret) { setCredErr('AppID 和 AppSecret 都要填'); return; }
    setCredBusy(true); setCredErr(''); setCredMsg('');
    try {
      const r = await saveCredentials(cred.platform, { appId, appSecret, name: cred.name, author: credForm.author.trim() });
      if (r.ok) {
        runWhoami(cred.platform);
        closeCred();
      } else {
        setCredErr(r.message || '验证未通过');
      }
    } catch (e) {
      setCredErr(e instanceof Error ? e.message : '保存失败');
    } finally {
      setCredBusy(false);
    }
  }, [cred, credForm, runWhoami, closeCred]);

  // One attempt owns its initial response, serial polling, and success callback.
  // Closing or retrying invalidates every in-flight response from the old attempt.
  const handleLogin = useCallback(async (a: AccountItem, mp = false, visibleBrowser = false, restart = false) => {
    if (!a.supported) return;
    if (!mp && a.backend === 'wechat-oa') { openCred(a); return; }
    stopPoll();
    const attempt = loginAttemptRef.current;
    const current = () => aliveRef.current && attempt === loginAttemptRef.current;
    identityEpoch.current[a.platform] = (identityEpoch.current[a.platform] || 0) + 1;
    setVerification(value => { const next = { ...value }; delete next[a.platform]; return next; });
    setErr('');
    setTerminalMsg('');
    setBusy(a.platform + (mp ? ':mp' : ''));
    setSmsCode(''); setSmsErr(''); setSmsBusy(false);
    qrPlatformRef.current = a.platform;
    setQrNonce((n) => n + 1);
    setQr({ platform: a.platform, name: a.name + (mp ? ' · 后台取数' : ''),
      flow: mp ? 'mp' : 'account', visibleBrowser, state: 'starting', message: '', qr: '' });

    const applyStatus = async (s: Pick<LoginStatus, 'state' | 'message' | 'qr' | 'qrTs' | 'qrKind' | 'qrWidth' | 'qrHeight' | 'visibleBrowser'>) => {
      if (!current()) return;
      setQr((prev) => prev && ({ ...prev, state: s.state, message: s.message, qr: s.qr, qrTs: s.qrTs,
        qrKind: s.qrKind, qrWidth: s.qrWidth, qrHeight: s.qrHeight,
        visibleBrowser: s.visibleBrowser ?? prev.visibleBrowser }));
      if (s.state !== 'success') return;
      setAccounts((list) => list.map((x) => x.platform === a.platform ? { ...x, loggedIn: true, hasLocalSession: true } : x));
      setWhoamiCache(a.platform, { loggedIn: true, name: '', avatar: '' });
      setVerification(value => ({ ...value, [a.platform]: { state: 'checking', message: '登录成功，正在读取账号身份…' } }));
      const identity = await runWhoami(a.platform);
      if (!current()) return;
      if (mp) load();
      else if (a.platform === 'xiaohongshu' && identity?.loggedIn) onAnalysisLogin();
    };
    let failures = 0;
    const poll = async () => {
      if (!current()) return;
      pollRef.current = null;
      try {
        const s = await (mp ? mpLoginStatus(a.platform) : loginStatus(a.platform));
        if (!current()) return;
        failures = 0;
        await applyStatus(s);
        if (isLoginTerminal(s.state)) return;
      } catch {
        if (!current()) return;
        if (++failures >= 3) {
          setQr((prev) => prev && ({ ...prev, state: 'error', qr: '',
            message: '暂时无法读取登录进度，请确认工作台服务仍在运行后重试。' }));
          return;
        }
      }
      if (current()) pollRef.current = setTimeout(poll, 2000);
    };
    try {
      const res = await (mp ? startMpLogin(a.platform, { restart }) : startLogin(a.platform, visibleBrowser, { restart }));
      if (!current()) return;
      if (res.mode === 'terminal' || res.mode === 'credentials') {
        qrPlatformRef.current = '';
        setQr(null);
        if (res.mode === 'terminal') setTerminalMsg(res.message || '请在终端登录');
        else openCred(a);
        return;
      }
      await applyStatus({ state: res.state || 'starting', message: res.message || '', qr: res.qr || '',
        visibleBrowser: res.visibleBrowser,
        qrKind: res.qrKind, qrWidth: res.qrWidth, qrHeight: res.qrHeight,
        qrTs: 'qrTs' in res ? res.qrTs : undefined });
      if (current() && !isLoginTerminal(res.state || 'starting')) pollRef.current = setTimeout(poll, 2000);
    } catch (e) {
      if (current()) setQr((prev) => prev && ({ ...prev, state: 'error', qr: '',
        message: e instanceof Error ? e.message : '启动登录失败，请稍后重试。' }));
    } finally {
      if (current()) setBusy('');
    }
  }, [stopPoll, runWhoami, openCred, onAnalysisLogin, load]);

  const handleLogout = useCallback(async (a: AccountItem) => {
    identityEpoch.current[a.platform] = (identityEpoch.current[a.platform] || 0) + 1;
    setWhoamiCache(a.platform, null);
    setErr(''); setLogoutMessage('');
    setLogoutBusy(a.platform);
    try {
      await logoutAccount(a.platform);
      // 内存态立即翻未登录（同登录路径），不等 load() 回来
      setAccounts((list) => list.map((x) => x.platform === a.platform ? { ...x, loggedIn: false, hasLocalSession: false, lastStateAt: null } : x));
      setWhoami((w) => { const n = { ...w }; delete n[a.platform]; return n; });
      setWhoamiCache(a.platform, null);
      setLogoutMessage(`已退出 ${a.name}，此平台的本地登录态已清理。已保存的作品和分析记录仍保留。`);
      setManagedPlatform(null); setConfirmLogout(false);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '退出登录失败');
    } finally {
      setLogoutBusy('');
    }
  }, [load]);

  useEffect(() => {
    const dialog = accountDialog.current;
    if (!dialog) return;
    if (managedPlatform && !dialog.open) dialog.showModal();
    else if (!managedPlatform && dialog.open) dialog.close();
  }, [managedPlatform]);

  const togglePrivacy = () => {
    setHideIdentity((value) => {
      try { localStorage.setItem('easel_account_privacy', value ? '0' : '1'); } catch { /* optional */ }
      return !value;
    });
  };

  // 卡片真实登录态：whoami 权威（已返回则以它为准，自愈假阳性），否则用后端 last-known。
  // 公众号(wechat-oa)例外：后端查 mp 会话即真值(快且权威)，直接用它，避免浏览器里过期的 whoami 缓存把已登录盖成未登录。
  const effLoggedIn = (a: AccountItem): boolean => {
    if (a.backend === 'wechat-oa') return a.loggedIn;
    const w = whoami[a.platform];
    if (w && w !== 'loading') return w.loggedIn;
    return a.loggedIn;
  };

  const badge = (a: AccountItem) => {
    if (!a.supported) return <span className="badge">暂不可连接</span>;
    if (whoami[a.platform] === 'loading') return <span className="badge">校验中…</span>;
    if (effLoggedIn(a)) return <span className="badge badge-ok">已连接</span>;
    return <span className="badge">未连接</span>;
  };

  const connectedCount = accounts.filter((account) => account.supported && effLoggedIn(account)).length;
  const supportedCount = accounts.filter((account) => account.supported).length;
  const visibleAccounts = accounts.filter((account) => filter === 'all'
    || (filter === 'connected' ? account.supported && effLoggedIn(account) : account.supported && !effLoggedIn(account)));
  const openAnalysis = onNavigateAnalysis;
  const managedAccount = accounts.find((account) => account.platform === managedPlatform);
  const managedInfo = managedPlatform ? whoami[managedPlatform] : null;
  const qrAccount = qr ? accounts.find((account) => account.platform === qr.platform) : undefined;

  return (
    <div className="accounts-page accounts-center">
      <div className="accounts-heading">
        <div><p className="accounts-eyebrow">创作渠道</p><h1><IconAccounts size={24} aria-hidden={true} style={{ verticalAlign: '-4px', marginRight: 8, color: 'var(--accent-start)' }} />账号中心</h1>
          <p className="accounts-intro">连接发布平台，管理登录状态，了解自己的内容表现。</p></div>
        <div className="account-heading-actions"><button className="btn btn-sm" aria-pressed={hideIdentity} onClick={togglePrivacy}>{hideIdentity ? <IconEye size={15} /> : <IconEyeOff size={15} />}{hideIdentity ? '显示账号身份' : '隐藏账号身份'}</button><button className="btn btn-sm" onClick={load}><IconRefresh size={15} />刷新状态</button></div>
      </div>
      <div className="accounts-summary" aria-live="polite">
        <span className="accounts-summary-dot" aria-hidden={true} />
        <strong>{loaded ? `${connectedCount} / ${supportedCount} 个平台已连接` : err ? '连接状态暂不可用' : '正在读取连接状态…'}</strong>
        <span>每个平台使用一个当前登录账号</span>
      </div>
      {err && <div className="notice-error" role="alert">{err}</div>}
      {logoutMessage && <div className="accounts-message" role="status">{logoutMessage}</div>}
      {terminalMsg && <div className="accounts-message" role="status">{terminalMsg}</div>}
      <div className="accounts-protection"><div><strong>登录凭据留在本机</strong><p>连接状态用于创作与发布；Cookie 和授权码不会在账号卡片中显示。共享屏幕时可隐藏昵称与头像。</p></div><span>可单独管理与退出</span></div>

      <section id="accounts-connections" aria-label="账号连接">
        <div className="accounts-section-heading"><div><h2>连接你的平台</h2><p>选择平台完成登录，之后可直接用于创作发布。</p></div>
          <div className="accounts-filters" role="group" aria-label="连接状态筛选">
            {([{ key: 'all', text: '全部' }, { key: 'connected', text: '已连接' }, { key: 'attention', text: '待连接' }] as const).map((item) =>
              <button type="button" key={item.key} aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>{item.text}</button>)}
          </div>
        </div>
        {!loaded && !err && <p className="accounts-empty" role="status">正在读取平台…</p>}
        {loaded && !visibleAccounts.length && <p className="accounts-empty">{filter === 'connected' ? '还没有已连接的平台。切换到「全部」，选择一个平台开始。' : filter === 'attention' ? '当前没有等待连接的平台。' : '暂未获取到可用平台，请刷新状态。'}</p>}
        <div className="accounts-grid">
          {visibleAccounts.map((a) => {
            const w = whoami[a.platform];
            const info = w && w !== 'loading' ? w : null;
            const logged = effLoggedIn(a);
            const pending = busy === a.platform || busy === a.platform + ':mp';
            return <article key={a.platform} className={`card account-card${!a.supported ? ' account-unavailable' : ''}`}>
              <div className="account-card-head"><div className="account-platform"><span className="account-platform-mark"><PlatformIcon platform={a.platform} name={a.name} /></span><h3>{a.name}</h3></div>{badge(a)}</div>
              <div className="account-identity">
                {logged ? <><Avatar url={hideIdentity ? undefined : info?.avatar} name={hideIdentity ? a.name : info?.name || a.name} /><div><strong className="account-nick">{hideIdentity ? '账号身份已隐藏' : info?.name || '已连接的账号'}</strong><p>{w === 'loading' ? '正在核实账号身份' : info ? '当前登录账号' : '身份信息待校验'}</p></div></>
                  : <p className="account-connection-copy">{a.supported ? '连接后，在这里查看当前账号与登录状态。' : '此平台暂不可用，请先使用其他平台。'}</p>}
              </div>
              <p className="account-login-method">{a.backend === 'wechat-oa' ? '使用微信扫码连接公众号' : a.backend === 'biliup' ? '按登录引导完成账号连接' : '使用手机 App 扫码连接'}</p>
              <div className="account-actions">
                <button className={`btn btn-block ${a.supported && !logged ? 'btn-primary' : ''}`} disabled={!a.supported || pending || w === 'loading'}
                  onClick={() => logged ? void runWhoami(a.platform) : void handleLogin(a, a.backend === 'wechat-oa')}>
                  {pending ? '正在启动…' : w === 'loading' ? '正在检查…' : logged ? '检查登录状态' : a.supported ? '连接账号' : '暂不可连接'}
                </button>
                {verification[a.platform] && <p className={`account-check-result is-${verification[a.platform].state}`} role={verification[a.platform].state === 'error' ? 'alert' : 'status'}>{verification[a.platform].message}</p>}
                {a.platform === 'xiaohongshu' && !logged && <button type="button" className="btn btn-block account-browser-login"
                  disabled={!a.supported || pending || w === 'loading'} onClick={() => void handleLogin(a, false, true, true)}>
                  在浏览器中登录
                </button>}
                <div className="account-secondary-actions">
                  {logged && (a.platform === 'xiaohongshu' || OTHER_ANALYSIS_PLATFORMS.has(a.platform)) && <button type="button" onClick={() => openAnalysis(a.platform)}>查看内容分析 <span aria-hidden={true}>→</span></button>}
                  {a.supported && logged && <button type="button" disabled={logoutBusy === a.platform} onClick={() => { setManagedPlatform(a.platform); setConfirmLogout(false); }}>管理账号</button>}
                </div>
              </div>
            </article>;
          })}
        </div>
        <details className="accounts-help"><summary>连接遇到问题？</summary>
          <p>二维码未出现或已过期时，请关闭登录窗口后重试。平台可能要求短信验证，请按登录窗口中的提示完成。</p>
          <p>更换网络、代理或服务器环境可能触发平台验证。优先在稳定的正常网络中重新连接；具体失败原因以平台返回结果为准。</p>
          <p>「检查登录状态」会在线确认本机保存的登录是否仍有效，并显示结果；不会重新登录或发布内容。当前每个平台仅保留一个登录会话。</p>
          {accounts.some((account) => account.backend === 'wechat-oa') && <p>公众号默认通过扫码连接。需要使用官方接口发布时，可单独<button type="button" className="account-help-link" onClick={() => { const account = accounts.find((item) => item.backend === 'wechat-oa'); if (account) openCred(account); }}>配置公众号发布凭证</button>。</p>}
        </details>
      </section>

      <dialog ref={accountDialog} className="account-management-dialog" aria-labelledby="account-management-title"
        onCancel={(event) => { if (logoutBusy) event.preventDefault(); else { setManagedPlatform(null); setConfirmLogout(false); } }}>
        {managedAccount && <>
          <div className="account-management-heading"><PlatformIcon platform={managedAccount.platform} name={managedAccount.name} /><div><p>ACCOUNT MANAGEMENT</p><h2 id="account-management-title">管理 {managedAccount.name}</h2></div></div>
          <dl className="account-management-facts">
            <div><dt>当前账号</dt><dd>{hideIdentity ? '身份已隐藏' : managedInfo && managedInfo !== 'loading' && managedInfo.name || '尚未核实昵称'}</dd></div>
            <div><dt>连接状态</dt><dd>{effLoggedIn(managedAccount) ? '已连接（可重新校验）' : '未连接或已失效'}</dd></div>
            <div><dt>本地登录资料</dt><dd>{managedAccount.hasLocalSession == null ? '状态未上报' : managedAccount.hasLocalSession ? '存在，可主动清理' : '未检测到'}</dd></div>
            <div><dt>凭据保存方式</dt><dd>{managedAccount.credentialStorage ? {browser_profile:'本机浏览器会话目录',cookie_file:'本机 Cookie 文件',app_credentials:'本机应用凭据配置'}[managedAccount.credentialStorage] : '接口未上报'}</dd></div><div><dt>最近状态记录</dt><dd>{managedAccount.lastStateAt ? new Date(managedAccount.lastStateAt * 1000).toLocaleString() : '尚无记录'}<small>状态记录时间不等于刚刚在线验证。</small></dd></div>
          </dl>
          <div className="account-management-note"><strong>你可以控制本机登录态</strong><p>退出会清理此平台在 Easel 中保存的会话、扫码缓存及相关发布凭据。已保存的作品与分析记录保留，其他平台不受影响。</p><p>这不会退出你手机或其他设备上的账号，也不等同于撤销平台侧全部授权。请保护本机系统账户，不要分享应用数据目录。</p></div>
          {confirmLogout && <div className="account-logout-confirm" role="alert"><strong>{effLoggedIn(managedAccount) ? '确认退出' : '确认清除连接记录'} {managedAccount.name}？</strong><p>正在进行的登录会被停止；再次发布前需要重新登录。</p></div>}
          {verification[managedAccount.platform] && <p className={`account-check-result is-${verification[managedAccount.platform].state}`} role={verification[managedAccount.platform].state === 'error' ? 'alert' : 'status'}>{verification[managedAccount.platform].message}</p>}
          {err && <p className="notice-error" role="alert">{err}</p>}
          <div className="account-management-buttons">
            <button className="btn" disabled={!!logoutBusy} onClick={() => { setManagedPlatform(null); setConfirmLogout(false); }}>关闭</button>
            {!confirmLogout && (managedAccount.hasLocalSession || effLoggedIn(managedAccount)) && <button className="btn" disabled={!!logoutBusy || managedInfo === 'loading'} onClick={() => void runWhoami(managedAccount.platform)}>{managedInfo === 'loading' ? '正在检查…' : '检查登录状态'}</button>}
            {(managedAccount.hasLocalSession || effLoggedIn(managedAccount)) && <button className="btn account-logout-button" disabled={!!logoutBusy} onClick={() => confirmLogout ? void handleLogout(managedAccount) : setConfirmLogout(true)}>{logoutBusy ? '正在清理…' : effLoggedIn(managedAccount) ? confirmLogout ? '确认退出并清理登录态' : '退出此账号' : confirmLogout ? '确认清除连接记录' : '清除连接记录'}</button>}
          </div>
        </>}
      </dialog>

      {qr && (
        <div className="overlay" onClick={closeQr}>
          <div className="modal account-login-modal" ref={qrModalRef} role="dialog" aria-modal="true"
            aria-labelledby="account-login-title" tabIndex={-1}
            onClick={(e) => e.stopPropagation()}>
            <h3 id="account-login-title" style={{ margin: '0 0 4px' }}>登录 {qr.name}</h3>
            <div style={{ fontSize: 13, marginBottom: 14,
              color: qr.state === 'success' ? 'var(--green)'
                : ['error', 'expired'].includes(qr.state) ? 'var(--red)' : 'var(--text-secondary)' }}>
              {STATE_LABEL[qr.state] || qr.state}{qr.message && !['error', 'expired', 'sms_required'].includes(qr.state) ? ` — ${qr.message}` : ''}
            </div>
            {qr.state === 'sms_required' ? (
              <div style={{ padding: '6px 4px 2px' }}>
                <div style={{ fontSize: 13, marginBottom: 10,
                  color: /错误|过期|失败|重新|未找到|未完成|不正确|失效/.test(qr.message || '')
                    ? 'var(--red)' : 'var(--text-secondary)' }}>
                  {qr.message || '平台风控要求短信验证，验证码已发到你手机，请输入：'}
                </div>
                <input
                  value={smsCode}
                  onChange={(e) => setSmsCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitSms(); }}
                  placeholder="短信验证码" inputMode="numeric" autoFocus
                  style={{ width: '100%', boxSizing: 'border-box', textAlign: 'center',
                    letterSpacing: 6, fontSize: 20, padding: '10px 12px',
                    border: '1px solid var(--border)', borderRadius: 8 }} />
                {smsErr && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 6 }}>{smsErr}</div>}
                <button className="btn btn-primary btn-block" style={{ marginTop: 12 }}
                  disabled={smsBusy} onClick={submitSms}>
                  {smsBusy ? '提交中…' : '提交验证码'}
                </button>
              </div>
            ) : qr.qr && (qr.state === 'qr_ready' || (qr.state === 'verifying' && qr.qrKind === 'page')) ? (
              <LoginImage key={`${qr.platform}:${qrNonce}:${qr.qr}`} login={qr} nonce={qrNonce} />
            ) : qr.state === 'scanned' ? (
              <div className="loading" style={{ padding: 40 }}><div className="spinner" />扫码成功，正在跳转验证…（首次可能等十几秒）</div>
            ) : qr.state === 'verifying' ? (
              <div className="loading" style={{ padding: 40 }}><div className="spinner" />{qr.visibleBrowser ? '请在工作台所在电脑的小红书窗口完成登录或安全验证。' : '正在验证验证码，登录中…'}</div>
            ) : qr.state === 'success' ? (
              <div style={{ padding: '20px 8px' }}>
                <div style={{ fontSize: 44 }}>✅</div>
                {qr.platform === 'xiaohongshu' && (
                  <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 8 }}>
                    登录成功！正在为你自动抓取本人笔记数据…<br />关闭此窗后，进入「内容分析」查看进度。
                  </p>
                )}
              </div>
            ) : ['error', 'expired'].includes(qr.state) ? (
              <div className="account-login-error" role="alert">
                <p>{qr.message || (qr.state === 'expired' ? '二维码已过期，请重新获取。' : '登录未完成，请稍后重试。')}</p>
                <p>已停止检查登录进度，不会自动重试。</p>
              </div>
            ) : (
              <div className="loading" style={{ padding: 40 }}><div className="spinner" />{qr.visibleBrowser ? '正在打开本机浏览器，准备登录…' : '准备二维码…'}</div>
            )}
            <div className="account-login-actions">
              <button className="btn" onClick={closeQr}>{qr.state === 'success' ? '完成' : '关闭'}</button>
              {qrAccount && (['error', 'expired', 'qr_ready'].includes(qr.state) || (qr.state === 'verifying' && qr.qrKind === 'page')) && <button className="btn btn-primary"
                disabled={!!busy} onClick={() => void handleLogin(qrAccount, qr.flow === 'mp', qr.visibleBrowser, true)}>重新连接</button>}
              {qrAccount?.platform === 'xiaohongshu' && !qr.visibleBrowser
                && (['error', 'expired', 'qr_ready'].includes(qr.state) || (qr.state === 'verifying' && qr.qrKind === 'page')) &&
                <button className="btn" disabled={!!busy} onClick={() => void handleLogin(qrAccount, false, true, true)}>在浏览器中登录</button>}
            </div>
          </div>
        </div>
      )}

      {cred && (
        <div className="overlay" onClick={closeCred}>
          <div className="modal" style={{ width: 420, maxWidth: '100%' }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 4px' }}>配置 {cred.name}</h3>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 14, lineHeight: 1.6 }}>
              公众号用官方接口发布，需填开发者凭证（公众平台 → 设置与开发 → 开发接口管理）。<br />
              需把本服务器出口 IP 加入公众号「IP 白名单」，否则报 40164。文章发到<b>草稿箱</b>，群发请到 mp 后台确认。
            </div>
            {credMsg && <div style={{ fontSize: 12.5, color: 'var(--green)', marginBottom: 10 }}>{credMsg}</div>}
            <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>AppID</label>
            <input value={credForm.appId} autoFocus
              onChange={(e) => setCredForm((f) => ({ ...f, appId: e.target.value.trim() }))}
              placeholder="wx..." style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px',
                margin: '4px 0 12px', border: '1px solid var(--border)', borderRadius: 8, fontSize: 14 }} />
            <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>AppSecret</label>
            <input value={credForm.appSecret} type="password"
              onChange={(e) => setCredForm((f) => ({ ...f, appSecret: e.target.value.trim() }))}
              placeholder="开发者密钥（不会回显）" style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px',
                margin: '4px 0 12px', border: '1px solid var(--border)', borderRadius: 8, fontSize: 14 }} />
            <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>默认作者（可选）</label>
            <input value={credForm.author}
              onChange={(e) => setCredForm((f) => ({ ...f, author: e.target.value }))}
              placeholder="文章署名" style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px',
                margin: '4px 0 4px', border: '1px solid var(--border)', borderRadius: 8, fontSize: 14 }} />
            {credErr && <div style={{ color: 'var(--red)', fontSize: 12.5, marginTop: 8 }}>{credErr}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button className="btn btn-primary" style={{ flex: 1 }} disabled={credBusy} onClick={submitCred}>
                {credBusy ? '验证中…' : '保存并验证'}
              </button>
              <button className="btn" onClick={closeCred}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
