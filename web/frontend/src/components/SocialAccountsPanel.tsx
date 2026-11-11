import { useCallback, useEffect, useRef, useState } from 'react';
import { mediaUrl } from '../lib/api';
import { accountState, socialAccounts, socialPlatforms } from '../lib/socialAccounts';
import Select from './ui/Select';
import PlatformIcon from './PlatformIcon';
import { IconChevron, IconClock, IconPlus, IconRefresh, IconSearch, IconUserPlus } from './icons';
import type { AccountLogin, LoginEvent, SocialAccount } from '../lib/socialAccounts';
import { publishPlatformLabel } from '../lib/publishReceipts';
import type { AccountItem } from '../lib/api';
import { defaultAccountInventory } from '../lib/accountInventory';
import { useAccountChecks, useAccountIdentities } from '../lib/whoami';
import '../styles/social-accounts.css';

export function LoginHistory({ events }: { events: LoginEvent[] }) {
  const actions: Record<string, string> = { create: '建立账号', login: '登录', poll: '登录进度',
    check: '在线核验', cancel: '取消登录', logout: '退出', interrupted: '操作中断', publish_check: '分发前核验' };
  return events.length ? <ol className="social-history" aria-label="登录记录">
    {events.map(event => <li key={event.id}>
      <time dateTime={event.at}>{new Date(event.at).toLocaleString('zh-CN')}</time>
      <strong>{event.platform ? `${publishPlatformLabel(event.platform)} · ` : ''}{actions[event.action] || event.action}</strong>
      <span>{event.message}</span>
      {event.attemptId && <details><summary>查看尝试编号</summary><small>{event.attemptId}</small></details>}
    </li>)}
  </ol> : <p>暂无记录。记录从本版本开始保存，每个账号最多保留最近 200 条。</p>;
}

function ConnectionImage({ login, label }: { login: AccountLogin; label: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [login.qr, login.attemptId]);
  if (!login.qr) return null;
  const kind = login.qrKind === 'page' ? '官方登录页面预览' : login.qrKind === 'qr' ? '登录二维码' : '登录图像';
  return <div className="account-connection-image">
    {broken ? <p role="alert">登录图像加载失败，请重新连接或打开原图检查。</p> : <img src={mediaUrl(login.qr)} alt={`${label} ${kind}`} onError={() => setBroken(true)}/>}
    <a href={mediaUrl(login.qr)} target="_blank" rel="noopener noreferrer">打开{kind} ↗</a>
    {login.qrKind === 'page' && <small>这是页面截图；请按官方页面提示完成登录。</small>}
  </div>;
}

type Props = {
  hideIdentity?: boolean;
  defaultAccounts?: AccountItem[];
  defaultsLoaded?: boolean;
  defaultLoadError?: string;
  onManageDefault?: (platform: string) => void;
  onRefreshDefaults?: () => Promise<void>;
};

function AccountManager({ hideIdentity, defaultAccounts = [], defaultsLoaded = true, defaultLoadError, onManageDefault, onRefreshDefaults }: Props) {
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [label, setLabel] = useState('');
  const [platform, setPlatform] = useState('xiaohongshu');
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [logins, setLogins] = useState<Record<string, AccountLogin>>({});
  const [historyId, setHistoryId] = useState('');
  const [events, setEvents] = useState<LoginEvent[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [platformFilter, setPlatformFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const createInput = useRef<HTMLInputElement>(null);
  const inspector = useRef<HTMLElement>(null);
  const lastAccountButton = useRef<HTMLButtonElement | null>(null);
  const alive = useRef(true);
  const operation = useRef(false);
  const historySeq = useRef(0);
  const identities = useAccountIdentities();
  const checks = useAccountChecks();
  const defaults = defaultAccountInventory(defaultAccounts, identities);
  const refresh = useCallback(async () => {
    const rows = await socialAccounts.list();
    if (!Array.isArray(rows)) throw new Error('账号列表格式不正确，请检查服务版本。');
    if (alive.current) { setAccounts(rows); setLoaded(true); }
    return rows;
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh().catch(cause => { if (alive.current) setError(String(cause.message || cause)); });
    return () => { alive.current = false; };
  }, [refresh]);
  useEffect(() => {
    if (!accounts.some(a => a.status === 'connecting')) return;
    let stopped = false;
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        for (const account of accounts.filter(a => a.status === 'connecting')) {
          const login = await socialAccounts.progress(account.accountId);
          if (!stopped) setLogins(old => ({ ...old, [account.accountId]: login }));
        }
        if (!stopped) await refresh();
      } catch (cause) { if (!stopped) setError(cause instanceof Error ? cause.message : '登录进度读取失败'); }
      finally { running = false; }
    };
    const timer = setInterval(() => { void tick(); }, 2500);
    return () => { stopped = true; clearInterval(timer); };
  }, [accounts, refresh]);
  useEffect(() => { if (creating) createInput.current?.focus(); }, [creating]);
  useEffect(() => {
    if (historyId && window.matchMedia?.('(max-width: 760px)').matches) {
      inspector.current?.focus({ preventScroll: true });
      inspector.current?.scrollIntoView({ block: 'start' });
    }
  }, [historyId]);
  const history = async (id: string) => {
    const seq = ++historySeq.current;
    setHistoryId(id); setEvents([]); setHistoryBusy(true); setError('');
    try {
      const isDefault = id === 'default' || id.startsWith('default:');
      const rows = isDefault ? await socialAccounts.defaults() : await socialAccounts.history(id);
      const filtered = id.startsWith('default:') ? rows.filter(row => row.platform === id.slice(8)) : rows;
      if (alive.current && seq === historySeq.current) setEvents(filtered);
    } catch (cause) { if (alive.current && seq === historySeq.current) setError(cause instanceof Error ? cause.message : '记录读取失败'); }
    finally { if (alive.current && seq === historySeq.current) setHistoryBusy(false); }
  };
  const run = async (key: string, call: () => Promise<unknown>) => {
    if (operation.current) return;
    operation.current = true; setBusy(key); setError('');
    try {
      await call(); await refresh();
      if (historyId) await history(historyId);
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '操作未完成'); }
    finally { operation.current = false; if (alive.current) setBusy(''); }
  };
  const selected = accounts.find(a => a.accountId === historyId);
  const selectedDefault = defaults.find(a => `default:${a.platform}` === historyId);
  const isDefaultHistory = historyId === 'default' || historyId.startsWith('default:');
  const selectedLogin = selected ? logins[selected.accountId] : undefined;
  const visible = accounts.filter(a => (platformFilter === 'all' || a.platform === platformFilter)
    && (statusFilter === 'all' || (statusFilter === 'ready' ? a.status === 'ready' && !a.busy : a.status !== 'ready' || a.busy))
    && `${a.label} ${hideIdentity ? '' : a.name} ${publishPlatformLabel(a.platform)}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const readyCount = accounts.filter(a => a.status === 'ready' && !a.busy).length;
  const visibleDefaults = defaults.filter(a => (platformFilter === 'all' || a.platform === platformFilter)
    && statusFilter !== 'ready' && (statusFilter !== 'attention' || a.connection !== 'online')
    && `${hideIdentity ? '' : a.name} 默认账号 ${publishPlatformLabel(a.platform)}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const totalCount = accounts.length + defaults.length;
  const visibleCount = visible.length + visibleDefaults.length;
  const inventoryLoaded = loaded && defaultsLoaded;
  const defaultState = (platform: string, connection: string) => checks.has(platform) ? '正在检测'
    : connection === 'online' ? '已确认在线' : connection === 'unknown' ? '状态待确认' : '需重新登录';
  return <div className="account-workspace">
    <div className="account-workspace-top">
      <div className="account-workspace-copy"><span className="account-workspace-kicker">一个工作台，每一个创作身份</span><h2>让账号各就各位。</h2><p>跨平台连接，同平台分开管理。每次分发，都知道发给谁。</p></div>
      <div className="account-metrics" aria-label="账号总览">
        <div><span>全部账号</span><strong>{inventoryLoaded ? totalCount : '—'}</strong><small>{defaults.length} 默认 · {accounts.length} 独立</small></div>
        <div><span><i className="account-status-dot" />可分发</span><strong>{loaded ? readyCount : '—'}</strong><small>已核验且空闲的独立账号</small></div>
        <div><span>待处理</span><strong>{inventoryLoaded ? accounts.length - readyCount + defaults.filter(a => a.connection !== 'online').length : '—'}</strong><small>需连接或确认状态</small></div>
      </div>
    </div>
    <div className="account-platform-rail" role="group" aria-label="按平台筛选账号">
      <button className="account-platform-tile" aria-pressed={platformFilter === 'all'} onClick={() => setPlatformFilter('all')}><span className="account-all-platforms"><IconUserPlus size={22}/></span><span>全部平台<small>{inventoryLoaded ? totalCount : '—'} 个账号</small></span></button>
      {socialPlatforms.map(item => <button key={item.value} className="account-platform-tile" aria-pressed={platformFilter === item.value} onClick={() => setPlatformFilter(item.value)}>
        <PlatformIcon platform={item.value} name={publishPlatformLabel(item.value)} /><span>{publishPlatformLabel(item.value)}<small>{inventoryLoaded ? accounts.filter(a => a.platform === item.value).length + defaults.filter(a => a.platform === item.value).length : '—'} 个账号</small></span>
      </button>)}
    </div>
    <div className="account-inventory-heading"><div><h2>账号名单 <span>{visibleCount}</span></h2><p>默认账号与独立账号均在此展示；选择账号查看来源、状态与管理入口。</p></div><button className="btn btn-primary" aria-expanded={creating} onClick={() => setCreating(!creating)}><IconPlus size={16}/>{creating ? '收起新增' : '新增独立账号'}</button></div>
    {creating && <form className="account-create-form" aria-label="新增独立账号" onSubmit={event => { event.preventDefault(); void run('create', async () => {
      const added = await socialAccounts.create(label, platform); setLabel(''); setCreating(false); setPlatformFilter('all'); setStatusFilter('all'); setSearch(''); await history(added.accountId);
    }); }}>
      <div className="account-create-copy"><IconPlus size={20}/><div><strong>添加一个创作身份</strong><p>先选择平台和备注，再连接对应的平台账号。</p></div></div>
      <label>发布平台<Select value={platform} options={socialPlatforms} onChange={setPlatform} aria-label="新增账号的平台" /></label>
      <label>账号备注<input ref={createInput} className="field" maxLength={40} value={label} onChange={e => setLabel(e.target.value)} placeholder="例如：品牌号 / 主理人号" /></label>
      <button className="btn btn-primary" disabled={!!busy || !label.trim()}>创建账号</button>
      <button type="button" className="btn" onClick={() => setCreating(false)}>取消</button>
    </form>}
    {error && <p className="notice-error" role="alert">{error}</p>}
    <div className={`account-management-layout${historyId ? ' has-selection' : ''}`}>
      <section className="account-inventory" aria-label="账号名单">
        <div className="account-inventory-tools"><label className="account-search"><IconSearch size={16}/><input aria-label="搜索账号" placeholder="搜索账号或平台…" value={search} onChange={event => setSearch(event.target.value)} /></label>
          <Select aria-label="筛选账号状态" value={statusFilter} onChange={setStatusFilter} options={[{value:'all',label:'全部状态'},{value:'ready',label:'可分发'},{value:'attention',label:'待处理'}]} />
          <button className="account-icon-button" title="刷新账号状态" aria-label="刷新账号状态" disabled={!!busy} onClick={() => void run('refresh', async () => { await onRefreshDefaults?.(); })}><IconRefresh size={16}/></button>
        </div>
        <div className="account-list-labels" aria-hidden="true"><span>账号 / 平台</span><span>连接状态</span><span>最近核验</span><span/></div>
        <div className="account-roster" role="list" aria-label="平台账号">
          {visibleDefaults.map(account => <div className={`account-roster-item${historyId === `default:${account.platform}` ? ' is-selected' : ''}`} role="listitem" key={`default:${account.platform}`}>
            <button className="account-roster-button" aria-label={`查看默认账号 ${publishPlatformLabel(account.platform)}`} aria-pressed={historyId === `default:${account.platform}`} onClick={event => { lastAccountButton.current = event.currentTarget; void history(`default:${account.platform}`); }}>
              <span className="account-roster-identity"><span className={`account-monogram platform-${account.platform}`}>{(hideIdentity ? publishPlatformLabel(account.platform) : account.name || publishPlatformLabel(account.platform)).slice(0,1)}<PlatformIcon platform={account.platform} name={publishPlatformLabel(account.platform)}/></span><span><strong>{hideIdentity ? '账号身份已隐藏' : account.name || '已保存的账号'}</strong><small>{publishPlatformLabel(account.platform)} · 默认账号</small></span></span>
              <span className={`account-state-pill is-${account.connection === 'online' ? 'ready' : account.connection}`}><i/>{defaultState(account.platform, account.connection)}</span>
              <span className="account-roster-date">{account.checkedAt ? new Date(account.checkedAt).toLocaleDateString('zh-CN', {month:'2-digit',day:'2-digit'}) : '尚未核验'}<small>{account.checkedAt ? '上次在线核验' : '昵称仅为保存资料'}</small></span><IconChevron size={15}/>
            </button>
          </div>)}
          {visible.map(account => <div className={`account-roster-item${historyId === account.accountId ? ' is-selected' : ''}`} role="listitem" key={account.accountId}>
            <button className="account-roster-button" aria-label={`管理 ${publishPlatformLabel(account.platform)} / ${account.label}`} aria-pressed={historyId === account.accountId} onClick={event => { lastAccountButton.current = event.currentTarget; void history(account.accountId); }}>
              <span className="account-roster-identity"><span className={`account-monogram platform-${account.platform}`}>{(hideIdentity ? account.label : account.name || account.label).slice(0,1)}<PlatformIcon platform={account.platform} name={publishPlatformLabel(account.platform)}/></span><span><strong>{account.label}</strong><small>{publishPlatformLabel(account.platform)} · 独立账号{!hideIdentity && account.name ? ` · ${account.name}` : ''}</small></span></span>
              <span className={`account-state-pill is-${account.status}`}><i/>{account.busy && account.status === 'ready' ? '任务执行中' : accountState[account.status] || account.status}</span>
              <span className="account-roster-date">{account.checkedAt ? new Date(account.checkedAt).toLocaleDateString('zh-CN', {month:'2-digit',day:'2-digit'}) : '尚未核验'}<small>{account.checkedAt ? new Date(account.checkedAt).toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'}) : '连接后核验身份'}</small></span>
              <IconChevron size={15}/>
            </button>
          </div>)}
          {!inventoryLoaded && !error && !defaultLoadError && <div className="account-list-empty" role="status"><IconRefresh size={24}/><h3>正在读取你的账号</h3><p>连接状态与登录活动将显示在这里。</p></div>}
          {defaultLoadError && <p className="account-context-note" role="alert">默认账号读取失败，当前名单可能不完整；请刷新重试。</p>}
          {inventoryLoaded && !visibleCount && <div className="account-list-empty"><IconUserPlus size={32}/><h3>{totalCount ? '没有匹配的账号' : '你的下一位创作分身，从这里开始'}</h3><p>{totalCount ? '试试其他平台、状态或关键词。' : '添加平台账号，为每个身份保留独立的登录资料。'}</p><button className="btn" onClick={() => totalCount ? (setPlatformFilter('all'), setStatusFilter('all'), setSearch('')) : setCreating(true)}>{totalCount ? '清除筛选' : '添加第一个账号'}</button></div>}
        </div>
        <div className="account-list-footer"><span>{visibleCount} / {inventoryLoaded ? totalCount : '—'} 个账号</span><span>{defaults.length} 默认 · {accounts.length} 独立</span></div>
      </section>
      <aside ref={inspector} tabIndex={-1} className="account-inspector" aria-label="账号详情与登录活动">
        <div className="account-inspector-title"><span><IconClock size={16}/> {selected || selectedDefault ? '账号详情' : isDefaultHistory ? '默认通道活动' : '连接与活动'}</span>{historyId && <button className="account-text-button" onClick={() => { historySeq.current++; setHistoryId(''); lastAccountButton.current?.focus(); }}>收起记录</button>}</div>
        {selectedDefault && <>
          <div className="account-selected-identity"><PlatformIcon platform={selectedDefault.platform} name={publishPlatformLabel(selectedDefault.platform)}/><div><h3>{hideIdentity ? '账号身份已隐藏' : selectedDefault.name || '已保存的账号'}</h3><p>{publishPlatformLabel(selectedDefault.platform)} · 默认账号</p></div></div>
          <span className={`account-state-pill is-${selectedDefault.connection === 'online' ? 'ready' : selectedDefault.connection}`}><i/>{defaultState(selectedDefault.platform, selectedDefault.connection)}</span>
          <p className="account-context-note">这是原有默认发布通道的账号，与侧栏平台快照同源。保存的昵称不代表当前在线；默认账号不计入独立账号可分发数量。</p>
          {onManageDefault && <div className="account-inspector-actions"><button className="btn btn-primary" onClick={() => onManageDefault(selectedDefault.platform)}>管理默认账号</button></div>}
        </>}
        {selected && <>
          <div className="account-selected-identity"><PlatformIcon platform={selected.platform} name={publishPlatformLabel(selected.platform)}/><div><h3>{selected.label}</h3><p>{publishPlatformLabel(selected.platform)} · {hideIdentity ? '账号身份已隐藏' : selected.name || '昵称待核验'}</p></div></div>
          <span className={`account-state-pill is-${selected.status}`}><i/>{accountState[selected.status] || selected.status}</span>
          <div className="account-inspector-actions">
            <button className="btn btn-primary" disabled={!!busy || selected.busy} onClick={() => void run(selected.accountId, async () => { const login = await socialAccounts.login(selected.accountId); if (alive.current) setLogins(old => ({...old,[selected.accountId]:login})); })}>{selected.status === 'logged_out' ? '连接账号' : '重新连接'}</button>
            <button className="btn" disabled={!!busy || selected.busy} onClick={() => void run(selected.accountId, () => socialAccounts.check(selected.accountId))}>在线核验</button>
            {selected.status === 'connecting' && <button className="btn" disabled={!!busy} onClick={() => void run(selected.accountId, () => socialAccounts.cancel(selected.accountId, selected.attemptId))}>取消本次登录</button>}
          </div>
          {selected.status === 'connecting' && selectedLogin?.attemptId === selected.attemptId && <div className="social-qr account-inspector-qr"><p>{accountState[selectedLogin.state] || selectedLogin.message || '登录进行中'}</p><ConnectionImage login={selectedLogin} label={selected.label}/>
            {selectedLogin.state === 'sms_required' && selected.platform === 'douyin' && <form onSubmit={event => { event.preventDefault(); void run(selected.accountId, async () => { await socialAccounts.sms(selected.accountId, selected.attemptId, codes[selected.accountId] || ''); setCodes(old => ({...old,[selected.accountId]:''})); }); }}><label>本次登录验证码<input className="field" inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={codes[selected.accountId] || ''} onChange={e => setCodes(old => ({...old,[selected.accountId]:e.target.value.replace(/\D/g,'')}))}/></label><button className="btn" disabled={!!busy}>提交登录验证码</button></form>}<small>仅用于本次连接；请按官方页面提示完成额外验证。</small></div>}
          <details className="account-identity-details"><summary>账号身份与资料</summary><dl><dt>本地账号编号</dt><dd>{selected.accountId}</dd><dt>平台账号编号</dt><dd>{hideIdentity ? '身份已隐藏' : selected.externalAccountId || '等待在线核验'}</dd><dt>上次在线核验</dt><dd>{selected.checkedAt ? new Date(selected.checkedAt).toLocaleString('zh-CN') : '尚无成功记录'}</dd></dl><button className="account-text-button is-danger" disabled={!!busy || selected.busy} onClick={() => { if(window.confirm(`退出「${selected.label}」？只清理该账号登录资料，身份和历史保留。`)) void run(selected.accountId,()=>socialAccounts.logout(selected.accountId)); }}>退出账号</button></details>
          {selected.platform === 'wechat-oa' && <p className="account-context-note">公众号仅创建草稿，不自动公开。</p>}
        </>}
        {historyId ? <section aria-label="账号登录历史" className="account-activity"><div className="account-activity-heading"><h3>{isDefaultHistory ? '默认账号' : '最近'} · 登录记录</h3><button className="account-text-button" onClick={() => void history(historyId)}>刷新记录</button></div>{historyBusy ? <p role="status">正在读取登录记录…</p> : <LoginHistory events={events}/>}</section> : <div className="account-inspector-empty"><div className="account-activity-art"><IconClock size={26}/><span/><span/></div><h3>每一次连接，都有迹可循。</h3><p>从左侧选择一个账号，查看登录、核验和退出记录。</p><span>按账号记录 · 刷新后保留</span></div>}
        <div className="account-inspector-foot"><button className="account-text-button" onClick={() => void history('default')}>默认账号登录记录 <IconChevron size={12}/></button><p>记录操作时间和结果，不记录密码、Cookie 或验证码。默认账号的早期记录无法补录。</p></div>
      </aside>
    </div>
    <div className="account-workspace-foot"><span><i className="account-status-dot"/> 登录凭据留在本机</span><p>扫码完成后在线核验身份，即可在发布中心按账号分发。</p></div>
  </div>;
}

export default function SocialAccountsPanel(props: Props) {
  return <section className="account-command-center" aria-label="多账号与登录记录"><AccountManager {...props}/></section>;
}
