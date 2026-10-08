import { useState, useRef, useEffect, useCallback } from 'react';
import {
  createSchedule, executeSkill, runAgent, streamChat,
  fetchAccounts, fetchOutputs, mediaUrl,
} from '../lib/api';
import type { AccountItem, OutputFile, PublishRequest } from '../lib/api';
import type { PublishReceiptsModel } from '../hooks/usePublishReceipts';
import { loadPublishDraft, savePublishDraft } from '../lib/store';
import { renderMarkdown } from '../lib/sanitize';
import { IconPublish, IconCopy, IconCheck, IconCalendar, IconSkills, IconEdit, IconStop, IconTrash } from './icons';
import '../styles/publish.css';
import PlatformIcon from './PlatformIcon';
import { PublishReceiptCard } from './PublishReceiptCenter';

interface PublishPageProps {
  persona: string;
  publishReceipts: PublishReceiptsModel;
}

// 平台列表须与后端 LOGIN_RUNNERS 对齐（有登录/发布链路的才列）
const PLATFORMS: { key: string; label: string; titleLimit?: number; bodyLimit: number; hint: string }[] = [
  { key: 'xiaohongshu', label: '小红书', titleLimit: 20, bodyLimit: 1000, hint: '标题≤20，正文≤1000，重情绪+话题标签' },
  { key: 'douyin', label: '抖音', titleLimit: 55, bodyLimit: 55, hint: '文案≤55，前几字是钩子' },
  { key: 'kuaishou', label: '快手', titleLimit: 30, bodyLimit: 1000, hint: '视频或图片(图文)，标题≤30，需附媒体' },
  { key: 'weixin-channels', label: '视频号', bodyLimit: 1000, hint: '需附视频，短描述+话题标签，微信扫码登录' },
  { key: 'zhihu', label: '知乎', bodyLimit: 5000, hint: '长文/回答，讲清逻辑' },
  { key: 'bilibili', label: 'B站', titleLimit: 80, bodyLimit: 2000, hint: '需附视频，标题≤80、简介≤2000，默认投「知识」分区' },
  { key: 'wechat-oa', label: '公众号', titleLimit: 64, bodyLimit: 20000, hint: '图文文章，正文用 Markdown，首图作封面，发到草稿箱；需先在账号页「登录公众号后台」扫码' },
];
const LABEL2KEY = Object.fromEntries(PLATFORMS.map((p) => [p.label, p.key]));

// 能一键发布的平台（有后端 publisher）
const PUBLISHABLE = new Set(['xiaohongshu', 'douyin', 'kuaishou', 'weixin-channels', 'zhihu', 'bilibili', 'wechat-oa']);
// 必须附带媒体的平台（无媒体发不了）——公众号需要一张封面图，也计入
const MEDIA_REQUIRED = new Set(['xiaohongshu', 'douyin', 'kuaishou', 'weixin-channels', 'bilibili', 'wechat-oa']);
// 只能发视频的平台（抖音/视频号/B站：图文不走此链路，必须视频）
const VIDEO_ONLY = new Set(['douyin', 'weixin-channels', 'bilibili']);
const VIDEO_RE = /\.(mp4|mov|webm|mkv|avi|m4v|flv|ts)$/i;

function parseSections(text: string): Record<string, string> {
  const parts = text.split(/^\s*={2,}\s*(.+?)\s*={2,}\s*$/m);
  const map: Record<string, string> = {};
  for (let i = 1; i < parts.length; i += 2) map[parts[i].trim()] = (parts[i + 1] || '').trim();
  return map;
}

export default function PublishPage({ persona, publishReceipts }: PublishPageProps) {
  const draft0 = loadPublishDraft();
  const [title, setTitle] = useState(draft0.title);
  const [body, setBody] = useState(draft0.body);
  const [platforms, setPlatforms] = useState<string[]>(draft0.platforms);
  const [overrides, setOverrides] = useState<Record<string, string>>(draft0.overrides);
  const [tags, setTags] = useState(draft0.tags || '');
  const [editing, setEditing] = useState<string | null>(null);
  const [copied, setCopied] = useState('');
  const [toast, setToast] = useState('');
  const [adapting, setAdapting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState('');
  const adaptCtl = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // 发布相关
  const [accounts, setAccounts] = useState<AccountItem[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState('');
  const [mediaFiles, setMediaFiles] = useState<OutputFile[]>([]);
  const [mediaLoading, setMediaLoading] = useState(true);
  const [mediaError, setMediaError] = useState('');
  const [selectedMedia, setSelectedMedia] = useState<string[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [blocked, setBlocked] = useState<Record<string, string>>({});
  const publishing = publishReceipts.submitting || publishReceipts.active.some(item => platforms.includes(item.platform));

  // 草稿持久化：任何改动即写 localStorage，切页/刷新回来都在
  useEffect(() => {
    savePublishDraft({ title, body, platforms, overrides, tags });
  }, [title, body, platforms, overrides, tags]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      adaptCtl.current?.abort();
      clearTimeout(toastTimer.current);
      clearTimeout(copyTimer.current);
    };
  }, []);

  // 登录态 + 可选媒体列表
  const loadAssets = useCallback(() => {
    setAccountsLoading(true); setAccountsError(''); setMediaLoading(true); setMediaError('');
    fetchAccounts().then(setAccounts).catch(() => setAccountsError('账号状态加载失败，请重试。')).finally(() => setAccountsLoading(false));
    fetchOutputs().then((roots) => {
      const files: OutputFile[] = [];
      const walk = (n: OutputFile) => {
        if (n.type === 'file') { if (n.kind === 'image' || n.kind === 'video') files.push(n); return; }
        for (const c of n.children || []) walk(c);
      };
      roots.forEach(walk);
      files.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
      setMediaFiles(files);
    }).catch(() => setMediaError('媒体列表加载失败，请重试。')).finally(() => setMediaLoading(false));
  }, []);
  useEffect(() => { loadAssets(); }, [loadAssets]);

  const loginOf = (key: string) => accounts.find((a) => a.platform === key)?.loggedIn ?? false;

  const toggle = (k: string) =>
    setPlatforms((prev) => prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]);
  const showToast = (m: string) => {
    if (!mounted.current) return;
    setToast(m); clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 4000);
  };
  const effective = (k: string) => overrides[k] ?? body;
  const empty = !title.trim() && !body.trim();
  const isVideoPath = (p: string) => /\.(mp4|mov|flv|mkv|avi|webm|m4v|wmv|ts|mpe?g)$/i.test(p);
  const toggleMedia = (path: string) =>
    setSelectedMedia((prev) => {
      if (prev.includes(path)) return prev.filter((x) => x !== path);
      // 通用规则：图片和视频不能同时；视频一次只发一个
      if (isVideoPath(path)) {
        if (prev.length && !prev.every(isVideoPath)) { showToast('图片和视频不能同时发布，请先取消已选图片'); return prev; }
        return [path]; // 视频单选
      }
      if (prev.some(isVideoPath)) { showToast('图片和视频不能同时发布，请先取消已选视频'); return prev; }
      return [...prev, path]; // 图片可多选（图文）
    });

  // A. 智能一稿多改（流式：逐字改写，直接流进每个平台卡片）
  const adapt = () => {
    if (empty || platforms.length === 0 || adapting) return;
    const sel = PLATFORMS.filter((p) => platforms.includes(p.key));
    const prompt =
      `请执行 /skill-content-repurposing：把下面这条内容改编到这些平台：${sel.map((p) => p.label).join('、')}。` +
      `务必参考该 SKILL 的 platform-specs 与改写配方，贴合各平台原生格式、语气与字数。\n` +
      `【硬性要求】输出各平台“可直接复制发布的纯文本正文”，禁止任何 Markdown 语法：不要 **加粗**、# 标题、---、表格、代码块、编号列表符号；` +
      `小红书可用 emoji 和 #话题标签，按平台习惯自然分行即可。\n` +
      `严格只按下面格式输出、每个平台之间用分隔线，不要任何额外说明：\n` +
      sel.map((p) => `===${p.label}===\n<该平台纯文本正文>`).join('\n') +
      `\n\n原始内容：\n标题：${title}\n正文：${body}`;

    setAdapting(true);
    let acc = '';
    const base = { ...overrides };
    adaptCtl.current = streamChat(
      prompt, persona, `adapt-${Date.now()}`,
      (chunk) => {                       // 逐字：实时解析并流进对应平台卡片
        acc += chunk;
        const map = parseSections(acc);
        const next = { ...base };
        for (const [label, text] of Object.entries(map)) {
          const key = LABEL2KEY[label];
          if (key && platforms.includes(key)) next[key] = text;
        }
        setOverrides(next);
      },
      () => {                            // 完成
        const hit = Object.keys(parseSections(acc)).length;
        setAdapting(false);
        showToast(hit ? `已生成 ${hit} 个平台版本` : '未能解析，可重试');
      },
      () => { setAdapting(false); showToast('改写失败，请重试'); },
    );
  };
  const stopAdapt = () => { adaptCtl.current?.abort(); setAdapting(false); };

  const performPrecheck = async () => {
    const prompt =
      `你是社媒发布审核助手。针对下面这条待发内容做两项检查，用简洁中文分点输出：\n` +
      `1. **合规风险**：是否含极限词/医疗功效/敏感或违规表述，列出问题词+替换建议；无则写"未见明显风险"。\n` +
      `2. **标题/钩子**：给标题打 1-10 分，并给 1-2 个更好的备选。\n` +
      `最后一行给「✅可发 / ⚠️建议修改」结论。\n\n待检内容：\n标题：${title}\n正文：${body}`;
    const content = `待发布内容：\n标题：${title}\n正文：${body}`;
    const [general, personaResult] = await Promise.all([
      runAgent(prompt),
      persona ? executeSkill('persona-check', content, persona) : Promise.resolve(null),
    ]);
    return `${general.response}\n\n---\n\n## 人设一致性\n\n${personaResult?.response || '未选择画像，已跳过人设一致性检查。'}`;
  };

  // C. 发布前一键预检
  const check = async () => {
    if (empty) return;
    setChecking(true); setCheckResult('');
    try {
      setCheckResult(await performPrecheck());
    } catch (e) {
      setCheckResult(e instanceof Error ? e.message : '预检失败');
    } finally { setChecking(false); }
  };

  // D. 一键发布（真发布，二次确认）
  const publishAll = async () => {
    if (empty || publishing || checking) return;
    if (accountsLoading || accountsError) { showToast('请先刷新并确认账号状态，再发布。'); return; }
    const targets = PLATFORMS.filter((p) => platforms.includes(p.key) && PUBLISHABLE.has(p.key));
    if (targets.length === 0) {
      showToast('请先选择支持发布的平台。');
      return;
    }
    const errors: Record<string, string> = {};
    const requests: PublishRequest[] = [];
    for (const target of targets) {
      if (!loginOf(target.key)) errors[target.key] = '未登录，请先到账号页登录。';
      else if (MEDIA_REQUIRED.has(target.key) && selectedMedia.length === 0) errors[target.key] = '需附带图片或视频。';
      else if (VIDEO_ONLY.has(target.key) && !selectedMedia.some(path => VIDEO_RE.test(path))) errors[target.key] = `${target.label}需要视频，请从内容库选择。`;
      else requests.push({ platform: target.key, payload: { title, body: effective(target.key), media: [...selectedMedia], tags } });
    }
    setBlocked(errors);
    if (!requests.length) { showToast('请先处理平台卡片中的账号或媒体提示。'); return; }
    setChecking(true);
    try {
      const result = await performPrecheck();
      if (mounted.current) setCheckResult(result);
    } catch (e) {
      if (mounted.current) setCheckResult(`预检失败：${e instanceof Error ? e.message : '未知错误'}\n\n预检仅用于提醒，不会阻止你继续发布。`);
    } finally {
      if (mounted.current) setChecking(false);
    }
    if (!mounted.current) return;
    const okToSend = window.confirm(
      `发布前预检已执行，结果已显示在页面中。人设评分只做提醒，不会阻止发布。\n\n` +
      `即将向这些账号【真实提交内容】：${targets.filter(target => requests.some(request => request.platform === target.key)).map(target => target.label).join('、')}。\n` +
      `平台可能进入审核，公众号保存到草稿箱。结果与可用作品地址会保存在发布回执中。确定继续？`);
    if (!okToSend) return;
    void publishReceipts.submit(requests);
  };

  const copyFor = (key: string) => {
    const text = (title ? title + '\n\n' : '') + effective(key);
    navigator.clipboard?.writeText(text);
    setCopied(key); clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => setCopied(''), 1400);
  };
  const addToCalendar = async (key: string) => {
    if (empty) return;
    const d = new Date();
    await createSchedule({
      title: title.trim() || effective(key).slice(0, 20), date: d.toISOString().slice(0, 10),
      platform: PLATFORMS.find((p) => p.key === key)?.label || '', time: '', status: 'draft', note: effective(key),
    });
    showToast('已存为草稿并加入今天的日历');
  };

  const canPublish = platforms.some((k) => PUBLISHABLE.has(k));

  return (
    <div className="publish-page publish-studio">
      <header className="publish-heading">
        <div><span className="publish-eyebrow">PUBLISH STUDIO</span>
          <h1 className="page-title">让好内容，抵达每个平台</h1>
          <p className="page-subtitle">编辑母版，准备素材，再为不同平台打磨合适的表达。</p>
        </div>
        <span className="publish-save-status"><IconCheck size={14} /> 母版自动保存到本机</span>
      </header>
      <div className="publish-workspace">
      <div className="publish-editor">
        {(accountsError || mediaError) && <div className="notice-error" role="alert">
          {[accountsError, mediaError].filter(Boolean).join(' ')}
          <button className="btn btn-sm" onClick={loadAssets} disabled={accountsLoading || mediaLoading}>重试</button>
        </div>}

        <section className="publish-section">
        <div className="publish-section-heading"><div><span className="publish-step">01</span><h2>内容母版</h2></div><span>所有平台的创作起点</span></div>
        <label className="field-label" htmlFor="publish-title">标题</label>
        <input id="publish-title" className="field" value={title} placeholder="给这篇内容一个清晰的标题"
          onChange={(e) => setTitle(e.target.value)} />
        <label className="field-label publish-body-label" htmlFor="publish-body">正文 <span>{body.length} 字</span></label>
        <textarea id="publish-body" className="field publish-master-body" value={body}
          placeholder="写下你的内容，在平台预览中查看效果；点「一键适配」让 AI 分平台改写…"
          onChange={(e) => setBody(e.target.value)} />

        <label className="field-label" htmlFor="publish-tags">话题标签</label>
        <input id="publish-tags" className="field" value={tags} placeholder="AI,职场,干货"
          onChange={(e) => setTags(e.target.value)} />
        <p className="publish-field-help">用逗号分隔；小红书会通过 # 联想绑定话题。</p>
        </section>

        <section className="publish-section">
        <div className="publish-section-heading"><div><span className="publish-step">02</span><h2>选择平台</h2></div><span>已选 {platforms.length} 个</span></div>
        <div className="publish-platform-list" aria-label="发布平台">
          {PLATFORMS.map((p) => (
            <button key={p.key} className={`publish-platform ${platforms.includes(p.key) ? 'active' : ''}`} aria-pressed={platforms.includes(p.key)}
              onClick={() => toggle(p.key)}><span className="publish-platform-name"><PlatformIcon platform={p.key} name={p.label} className="publish-platform-icon" />{p.label}</span><span className="publish-platform-check">{platforms.includes(p.key) ? <IconCheck size={13} /> : '+'}</span></button>
          ))}
        </div>
        <p className="publish-field-help">勾选后查看专属预览。发布前请在账号页完成登录。</p>
        </section>

        <section className="publish-section">
        <div className="publish-section-heading"><div><span className="publish-step">03</span><h2>媒体素材</h2></div><span>{selectedMedia.length ? `已选 ${selectedMedia.length} 个` : '从内容库选取'}</span></div>
        <div className="publish-media-selection">
          <button className="btn btn-sm" aria-expanded={showPicker} onClick={() => setShowPicker((v) => !v)}>
            <IconSkills size={13} /> {showPicker ? '收起' : '选择媒体'}
          </button>
          {selectedMedia.map((path) => (
            <button key={path} className="media-chip" onClick={() => toggleMedia(path)} title="点击移除" aria-label={`移除素材 ${mediaFiles.find((f) => f.path === path)?.name || path}`}>
              {mediaFiles.find((f) => f.path === path)?.kind === 'image'
                ? <img src={mediaUrl(path)} alt="" /> : <span className="media-vid">🎬</span>}
              <span className="media-x">×</span>
            </button>
          ))}
        </div>
        {showPicker && (
          <div className="media-grid">
            {mediaLoading && <div className="dash-empty">正在加载媒体…</div>}
            {!mediaLoading && mediaError && <div className="dash-empty">媒体列表暂不可用，请重试。</div>}
            {!mediaLoading && !mediaError && mediaFiles.length === 0 && <div className="dash-empty">内容库暂无图片/视频</div>}
            {mediaFiles.slice(0, 40).map((f) => (
              <button key={f.path} aria-pressed={selectedMedia.includes(f.path)} aria-label={`选择素材 ${f.name}`}
                className={`media-cell ${selectedMedia.includes(f.path) ? 'sel' : ''}`}
                onClick={() => toggleMedia(f.path)} title={f.path}>
                {f.kind === 'image'
                  ? <img src={mediaUrl(f.path)} alt={f.name} loading="lazy" />
                  : <span className="media-vid">🎬<br />{f.name.slice(0, 12)}</span>}
                {selectedMedia.includes(f.path) && <span className="media-check">✓</span>}
              </button>
            ))}
          </div>
        )}
        <p className="publish-field-help">图片与视频不可混选。抖音、视频号、B站需要视频；公众号需要封面图。</p>
        </section>

        <section className="publish-action-panel" aria-label="发布操作">
        <div className="publish-section-heading"><div><h2>准备好，就出发</h2></div></div>
        <div className="publish-assist-actions">
          {adapting ? (
            <button className="btn btn-sm" onClick={stopAdapt}><IconStop size={13} /> 停止生成</button>
          ) : (
            <button className="btn btn-sm" disabled={empty || platforms.length === 0} onClick={adapt}>
              <IconSkills size={14} /> 一键适配各平台
            </button>
          )}
          <button className="btn btn-sm" disabled={empty || checking || adapting} onClick={check}>
            <IconCheck size={14} /> {checking ? '预检中…' : '发布前预检'}
          </button>
          <button className="btn btn-sm btn-ghost publish-clear" disabled={empty || adapting}
            onClick={() => { setTitle(''); setBody(''); setTags(''); setOverrides({}); setCheckResult(''); setBlocked({}); showToast('已清空母版，发布回执保留'); }}>
            <IconTrash size={13} /> 清空内容
          </button>
        </div>
        <div className="publish-actions">
          <button className="btn btn-sm" disabled={empty} onClick={() => addToCalendar(platforms[0] || 'xiaohongshu')}>
            <IconCalendar size={14} /> 存入今日日历
          </button>
          <button className="btn btn-sm btn-primary" disabled={empty || publishing || checking || !canPublish}
            title={canPublish ? '真实提交内容到已登录平台' : '请先选择发布平台'}
            onClick={publishAll}>
            <IconPublish size={14} /> {publishing ? '等待发布回执…' : `发布到 ${platforms.length} 个平台`}
          </button>
        </div>
        {adapting && <div className="adapt-hint"><span className="live-pulse" />AI 正在逐字改写各平台版本…可随时停止。</div>}
        <p className="publish-saved-note">发布会先执行预检，再由你确认。仅已登录且媒体齐全的平台可发布；公众号内容进入草稿箱。发布回执会保留平台结果、可用作品地址和邮件通知状态。</p>
        </section>
        {checkResult && (
          <div className="panel" style={{ marginTop: 14 }}>
            <div className="panel-title"><IconCheck size={14} /> 发布前预检</div>
            <div className="skill-body-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(checkResult) }} />
          </div>
        )}
      </div>

      <div className="publish-previews">
        <div className="publish-preview-heading"><div><span className="publish-eyebrow">PLATFORM PREVIEW</span><h2>平台预览 <span>{platforms.length}</span></h2></div><p>独立编辑各平台版本，不影响母版。</p></div>
        <button className="btn btn-sm publish-receipt-entry" onClick={publishReceipts.open}>查看全部发布回执</button>
        {platforms.length === 0 && <div className="dash-empty">选择至少一个平台查看预览</div>}
        {PLATFORMS.filter((p) => platforms.includes(p.key)).map((p) => {
          const text = effective(p.key);
          const over = text.length > p.bodyLimit;
          const titleOver = p.titleLimit != null && title.length > p.titleLimit;
          const isEdit = editing === p.key;
          const receipt = publishReceipts.receipts.find(item => item.platform === p.key);
          const publishable = PUBLISHABLE.has(p.key);
          const logged = loginOf(p.key);
          return (
            <div key={p.key} className={`card pv-card pv-${p.key}`}>
              <div className="pv-head">
                <span className="pv-plat">
                  <PlatformIcon platform={p.key} name={p.label} className="publish-platform-icon" />
                  {p.label}
                  {overrides[p.key] != null && <span className="pv-badge">独立版本</span>}
                  {publishable && (accountsLoading ? <span className="pv-badge">状态加载中…</span> : accountsError ? <span className="pv-badge">状态未知</span> : logged
                    ? <span className="pv-badge pv-badge-ok">已登录</span>
                    : <span className="pv-badge">未登录</span>)}
                </span>
                <span className={`pv-count ${over ? 'over' : ''}`}>{text.length}/{p.bodyLimit}</span>
              </div>
              <div className="pv-body">
                {p.titleLimit != null && (
                  <div className={`pv-title ${titleOver ? 'over' : ''}`}>{title || <span className="pv-ph">标题…</span>}</div>
                )}
                {isEdit
                  ? <textarea className="field" aria-label={`编辑${p.label}正文`} style={{ minHeight: 120 }} value={text} autoFocus
                      onChange={(e) => setOverrides((o) => ({ ...o, [p.key]: e.target.value }))} />
                  : <div className="pv-text">{text || <span className="pv-ph">正文预览…</span>}{adapting && overrides[p.key] != null && <span className="streaming-cursor" />}</div>}
              </div>
              {blocked[p.key] && <div className="pv-pubstate fail" role="alert">{blocked[p.key]}</div>}
              {receipt && <PublishReceiptCard receipt={receipt} onVerify={publishReceipts.open} />}
              <div className="pv-foot">
                <span className="pv-hint">{p.hint}{over ? ' · 已超字数' : ''}</span>
                <div className="pv-card-actions">
                  <button className="pv-copy" onClick={() => setEditing(isEdit ? null : p.key)}>
                    <IconEdit size={13} />{isEdit ? '完成' : '编辑'}
                  </button>
                  <button className="pv-copy" onClick={() => copyFor(p.key)}>
                    {copied === p.key ? <IconCheck size={13} /> : <IconCopy size={13} />}{copied === p.key ? '已复制' : '复制'}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      </div>

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
