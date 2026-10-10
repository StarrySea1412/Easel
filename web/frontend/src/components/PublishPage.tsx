import { useState, useRef, useEffect, useCallback } from 'react';
import {
  createSchedule, executeSkill, runAgent, streamChat,
  fetchAccounts, fetchOutputs, mediaUrl, accountWhoami,
} from '../lib/api';
import type { AccountItem, OutputFile, PublishRequest } from '../lib/api';
import type { PublishReceiptsModel } from '../hooks/usePublishReceipts';
import { loadPublishDraft, savePublishDraft } from '../lib/store';
import { renderMarkdown } from '../lib/sanitize';
import { publishReceiptStatus } from '../lib/publishReceipts';
import { IconPublish, IconCopy, IconCheck, IconCalendar, IconSkills, IconEdit, IconStop, IconTrash } from './icons';
import '../styles/publish.css';
import PlatformIcon from './PlatformIcon';
import { PublishReceiptCard } from './PublishReceiptCenter';
import PublishSpinner from './PublishSpinner';
import { ACCOUNT_STATE_EVENT, getWhoamiCache, isWhoamiFresh, markWhoamiUnverified, setWhoamiCache } from '../lib/whoami';

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
  const [previewPlatform, setPreviewPlatform] = useState(draft0.platforms[0] || '');
  const [copied, setCopied] = useState('');
  const [toast, setToast] = useState('');
  const [adapting, setAdapting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkStage, setCheckStage] = useState('');
  const checkLock = useRef(false);
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
  const [selectedMedia, setSelectedMedia] = useState<string[]>(draft0.media || []);
  const [showPicker, setShowPicker] = useState(false);
  const [blocked, setBlocked] = useState<Record<string, string>>({});
  const publishing = publishReceipts.submitting || publishReceipts.active.some(item => platforms.includes(item.platform));

  // 草稿持久化：任何改动即写 localStorage，切页/刷新回来都在
  useEffect(() => {
    savePublishDraft({ title, body, platforms, overrides, tags, media: selectedMedia });
  }, [title, body, platforms, overrides, tags, selectedMedia]);

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

  useEffect(() => {
    const sync = () => { void fetchAccounts().then(rows => { if (mounted.current) setAccounts(rows); }).catch(() => { if (mounted.current) setAccountsError('账号状态加载失败，请重试。'); }); };
    const storage = (event: StorageEvent) => { if (event.key === 'easel_whoami') sync(); };
    window.addEventListener(ACCOUNT_STATE_EVENT, sync);
    window.addEventListener('storage', storage);
    return () => { window.removeEventListener(ACCOUNT_STATE_EVENT, sync); window.removeEventListener('storage', storage); };
  }, []);

  const loginOf = (key: string) => accounts.find((a) => a.platform === key)?.loggedIn ?? false;

  const toggle = (k: string) => {
    if (!platforms.includes(k)) setPreviewPlatform(k);
    setPlatforms((prev) => prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]);
    setBlocked({});
  };
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
  const moveMedia = (index: number, direction: number) => setSelectedMedia(prev => {
    const next = [...prev];
    const target = index + direction;
    if (target < 0 || target >= next.length) return prev;
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  });
  const selectedPlatforms = PLATFORMS.filter(p => platforms.includes(p.key));
  const activePreview = platforms.includes(previewPlatform) ? previewPlatform : selectedPlatforms[0]?.key;
  const platformBusy = (key: string) => publishReceipts.submittingPlatforms.includes(key) || publishReceipts.active.some(item => item.platform === key);
  const preparationIssue = (key: string) => {
    if (accountsLoading) return '正在读取账号';
    if (accountsError) return '账号状态未知';
    if (!loginOf(key)) return '未登录，请先到账号页登录。';
    if (MEDIA_REQUIRED.has(key) && selectedMedia.length === 0) return '需附带图片或视频。';
    if (VIDEO_ONLY.has(key) && !selectedMedia.some(path => VIDEO_RE.test(path))) return `${PLATFORMS.find(p => p.key === key)?.label}需要视频，请从内容库选择。`;
    return '';
  };
  const readyCount = selectedPlatforms.filter(p => !preparationIssue(p.key)).length;

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
      `建议必须忠于原文，不得编造收益数字、效率提升、案例或功效承诺。\n` +
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
    if (checkLock.current) return;
    checkLock.current = true;
    setChecking(true); setCheckStage('正在预检内容…'); setCheckResult('');
    try {
      setCheckResult(await performPrecheck());
    } catch (e) {
      setCheckResult(e instanceof Error ? e.message : '预检失败');
    } finally { checkLock.current = false; setChecking(false); setCheckStage(''); }
  };

  // D. 一键发布（真发布，二次确认）
  const publishAll = async () => {
    if (empty || publishing || checking || checkLock.current) return;
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
    checkLock.current = true;
    setChecking(true);
    const confirmed: PublishRequest[] = [];
    const identities: Record<string, string> = {};
    for (const request of requests) {
      const platform = request.platform;
      setCheckStage(`正在检查${PLATFORMS.find(p => p.key === platform)?.label}登录状态…`);
      const before = JSON.stringify(getWhoamiCache()[platform]);
      try {
        const result = await accountWhoami(platform, true);
        if (before !== JSON.stringify(getWhoamiCache()[platform])) throw new Error('账号状态已变化，请重新检查。');
        if (result.verified === false) throw new Error(result.verificationMessage || '本次在线检查未确认登录状态。');
        setWhoamiCache(platform, result);
        identities[platform] = JSON.stringify(getWhoamiCache()[platform]);
        if (result.loggedIn) confirmed.push(request);
        else errors[platform] = '在线检查确认登录已失效，请重新连接。';
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : '登录检查失败，请重试。';
        if (before === JSON.stringify(getWhoamiCache()[platform])) markWhoamiUnverified(platform, message);
        errors[platform] = message;
      }
      if (!mounted.current) { checkLock.current = false; return; }
    }
    setBlocked({ ...errors });
    if (!confirmed.length) {
      checkLock.current = false; setChecking(false); setCheckStage('');
      showToast('登录状态未确认，内容已保留，请检查平台提示后重试。');
      return;
    }
    setCheckStage('正在预检内容…');
    try {
      const result = await performPrecheck();
      if (mounted.current) setCheckResult(result);
    } catch (e) {
      if (mounted.current) setCheckResult(`预检失败：${e instanceof Error ? e.message : '未知错误'}\n\n预检仅用于提醒，不会阻止你继续发布。`);
    } finally {
      if (mounted.current) setChecking(false);
      checkLock.current = false;
      if (mounted.current) setCheckStage('');
    }
    if (!mounted.current) return;
    const okToSend = window.confirm(
      `发布前预检已执行，结果已显示在页面中。人设评分只做提醒，不会阻止发布。\n\n` +
      `即将向这些账号【真实提交内容】：${targets.filter(target => confirmed.some(request => request.platform === target.key)).map(target => target.label).join('、')}。\n` +
      `${Object.keys(errors).length ? '\n本次不会提交：' + targets.filter(target => errors[target.key]).map(target => target.label + '（' + errors[target.key] + '）').join('、') + '。\n' : ''}` +
      `平台可能进入审核，公众号保存到草稿箱。结果与可用作品地址会保存在发布回执中。确定继续？`);
    if (!okToSend) return;
    const unchanged = confirmed.filter(request => {
      const entry = getWhoamiCache()[request.platform];
      return isWhoamiFresh(entry) && entry.loggedIn && identities[request.platform] === JSON.stringify(entry);
    });
    if (unchanged.length !== confirmed.length) { showToast('账号状态已变化，内容已保留，请重新检查后发布。'); return; }
    void publishReceipts.submit(confirmed);
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
        <div><h1 className="page-title">发布中心</h1><p className="page-subtitle">让好内容，抵达每个平台</p></div>
        <div className="publish-heading-actions">
          <span className="publish-save-status"><IconCheck size={14} /> 草稿自动保存</span>
          <button className="btn btn-sm publish-receipt-entry" onClick={publishReceipts.open}>查看全部发布回执</button>
        </div>
      </header>
      {(accountsError || mediaError) && <div className="notice-error publish-load-error" role="alert">
        {[accountsError, mediaError].filter(Boolean).join(' ')}
        <button className="btn btn-sm" onClick={loadAssets} disabled={accountsLoading || mediaLoading}>重试</button>
      </div>}
      <div className="publish-workspace">
        <div className="publish-editor">
          <section className="publish-section publish-content-section">
            <div className="publish-section-heading"><h2>内容</h2><span>通用正文 · 各平台可单独调整</span></div>
            <label className="field-label" htmlFor="publish-title">标题</label>
            <input id="publish-title" className="field publish-title-input" value={title} placeholder="一个清晰、有吸引力的标题"
              onChange={e => setTitle(e.target.value)} />
            <label className="field-label publish-body-label" htmlFor="publish-body">正文 <span>{body.length} 字</span></label>
            <textarea id="publish-body" className="field publish-master-body" value={body}
              placeholder="写下内容，再为不同平台调整表达…" onChange={e => setBody(e.target.value)} />
            <div className="publish-editor-tools">
              {adapting ? <button className="btn btn-sm" onClick={stopAdapt}><IconStop size={13} /> 停止生成</button>
                : <button className="btn btn-sm" disabled={empty || platforms.length === 0 || checking || publishing} onClick={adapt}>
                  <IconSkills size={14} /> 一键适配各平台
                </button>}
              <button className="btn btn-sm btn-ghost" disabled={empty || checking || adapting || publishing} onClick={check}>
                {checking ? <PublishSpinner /> : <IconCheck size={14} />}{checking ? checkStage : '发布前预检'}
              </button>
            </div>
            {adapting && <div className="adapt-hint" role="status"><PublishSpinner />正在生成平台版本，可切换预览查看。</div>}
            <label className="field-label" htmlFor="publish-tags">话题标签 <span className="publish-optional">选填</span></label>
            <input id="publish-tags" className="field" value={tags} placeholder="如 AI,Agent,效率工具" onChange={e => setTags(e.target.value)} />
            <p className="publish-field-help">用逗号分隔，小红书将关联对应话题。</p>
          </section>

          <section className="publish-section publish-media-section">
            <div className="publish-section-heading"><div><h2>配图 / 视频</h2><span className="publish-media-count">{selectedMedia.length ? `${selectedMedia.length} 个素材` : '未选择'}</span></div>
              <button className="btn btn-sm" aria-expanded={showPicker} aria-controls="publish-media-picker" onClick={() => setShowPicker(v => !v)}>
                <IconSkills size={13} />{showPicker ? '收起' : '选择媒体'}
              </button>
            </div>
            {selectedMedia.length ? <div className="publish-media-selection">
              {selectedMedia.map((path, index) => <div className="publish-media-item" key={path}>
                <button className="media-chip" onClick={() => toggleMedia(path)} title="点击移除" aria-label={`移除素材 ${mediaFiles.find(f => f.path === path)?.name || path}`}>
                  {!isVideoPath(path) ? <img src={mediaUrl(path)} alt="" /> : <span className="media-vid">视频</span>}
                  <span className="media-x">×</span><span className="publish-media-order">{index === 0 && !isVideoPath(path) ? '封面' : index + 1}</span>
                </button>
                {selectedMedia.length > 1 && <div className="publish-media-reorder">
                  <button disabled={index === 0} aria-label={`素材 ${index + 1} 向前移动`} onClick={() => moveMedia(index, -1)}>←</button>
                  <button disabled={index === selectedMedia.length - 1} aria-label={`素材 ${index + 1} 向后移动`} onClick={() => moveMedia(index, 1)}>→</button>
                </div>}
              </div>)}
            </div> : <button className="publish-media-empty" onClick={() => setShowPicker(true)}><IconSkills size={22} /><span>从内容库添加素材</span><small>图片可多选，视频一次一个</small></button>}
            {showPicker && <div className="media-grid" id="publish-media-picker" aria-label="内容库素材">
              {mediaLoading && <div className="dash-empty"><PublishSpinner />正在加载媒体…</div>}
              {!mediaLoading && mediaError && <div className="dash-empty">媒体列表暂不可用，请重试。</div>}
              {!mediaLoading && !mediaError && mediaFiles.length === 0 && <div className="dash-empty">内容库暂无图片/视频</div>}
              {mediaFiles.slice(0, 40).map(f => <button key={f.path} aria-pressed={selectedMedia.includes(f.path)} aria-label={`选择素材 ${f.name}`}
                className={`media-cell ${selectedMedia.includes(f.path) ? 'sel' : ''}`} onClick={() => toggleMedia(f.path)} title={f.name}>
                {f.kind === 'image' ? <img src={mediaUrl(f.path)} alt={f.name} loading="lazy" /> : <span className="media-vid">视频<br />{f.name.slice(0, 12)}</span>}
                {selectedMedia.includes(f.path) && <span className="media-check">{selectedMedia.indexOf(f.path) + 1}</span>}
              </button>)}
            </div>}
            <p className="publish-field-help">按选择顺序发布，首图为封面。图片与视频不可混选。</p>
          </section>
          {checkResult && <details className="publish-section publish-check-result">
            <summary><IconCheck size={14} />发布前预检结果<span>展开查看</span></summary>
            <div className="skill-body-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(checkResult) }} />
          </details>}
          <div className="publish-draft-actions">
            <button className="btn btn-sm btn-ghost" disabled={empty} onClick={() => addToCalendar(platforms[0] || 'xiaohongshu')}><IconCalendar size={14} />存入今日日历</button>
            <button className="btn btn-sm btn-ghost publish-clear" disabled={empty || adapting || publishing || checking}
              onClick={() => { setTitle(''); setBody(''); setTags(''); setOverrides({}); setSelectedMedia([]); setCheckResult(''); setBlocked({}); showToast('已清空内容和素材，发布回执保留'); }}>
              <IconTrash size={13} />清空内容
            </button>
          </div>
        </div>

        <aside className="publish-side" aria-label="平台预览与发布">
          <section className="publish-section publish-platform-section">
            <div className="publish-section-heading"><h2>发布到</h2><span>可多选 · 已选 {platforms.length} 个</span></div>
            <div className="publish-platform-list" aria-label="发布平台">
              {PLATFORMS.map(p => <button key={p.key} className={`publish-platform ${platforms.includes(p.key) ? 'active' : ''}${platformBusy(p.key) ? ' is-publishing' : ''}`}
                aria-pressed={platforms.includes(p.key)} onClick={() => toggle(p.key)}>
                <span className="publish-platform-name"><PlatformIcon platform={p.key} name={p.label} className="publish-platform-icon" />{p.label}</span>
                <span className="publish-platform-check">{platformBusy(p.key) ? <PublishSpinner /> : platforms.includes(p.key) ? <IconCheck size={13} /> : '+'}</span>
              </button>)}
            </div>
          </section>

          <section className="publish-previews" aria-label="平台内容预览">
            <div className="publish-preview-heading"><h2>平台预览</h2><span>内容示意，以平台实际展示为准</span></div>
            {platforms.length === 0 ? <div className="publish-preview-empty"><IconPublish size={28} /><p>先选择一个发布平台</p><span>多选后可切换查看各平台版本</span></div> : <>
              <div className="publish-preview-tabs" role="tablist" aria-label="切换平台预览">
                {selectedPlatforms.map((p, index) => <button key={p.key} id={`publish-tab-${p.key}`} role="tab"
                  aria-selected={activePreview === p.key} aria-controls={`publish-preview-${p.key}`} tabIndex={activePreview === p.key ? 0 : -1}
                  onClick={() => setPreviewPlatform(p.key)} onKeyDown={event => {
                    let next = index;
                    if (event.key === 'ArrowRight') next = (index + 1) % selectedPlatforms.length;
                    else if (event.key === 'ArrowLeft') next = (index - 1 + selectedPlatforms.length) % selectedPlatforms.length;
                    else if (event.key === 'Home') next = 0;
                    else if (event.key === 'End') next = selectedPlatforms.length - 1;
                    else return;
                    event.preventDefault();
                    setPreviewPlatform(selectedPlatforms[next].key);
                    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
                  }}>
                  <PlatformIcon platform={p.key} name={p.label} className="publish-platform-icon" />{p.label}
                  {platformBusy(p.key) && <PublishSpinner />}
                </button>)}
              </div>
              {selectedPlatforms.map(p => {
                const text = effective(p.key);
                const over = text.length > p.bodyLimit;
                const titleOver = p.titleLimit != null && title.length > p.titleLimit;
                const isEdit = editing === p.key;
                const receipt = publishReceipts.receipts.find(item => item.platform === p.key);
                const issue = preparationIssue(p.key);
                return <div key={p.key} id={`publish-preview-${p.key}`} role="tabpanel" aria-labelledby={`publish-tab-${p.key}`}
                  hidden={activePreview !== p.key} className={`pv-card pv-${p.key}`} tabIndex={0}>
                  <div className="pv-head"><span className="pv-plat">{overrides[p.key] != null ? '独立版本' : '通用正文'}</span>
                    <span className={`pv-count ${over ? 'over' : ''}`}>{text.length}/{p.bodyLimit} 字</span></div>
                  {selectedMedia.length > 0 && <div className="publish-preview-media">
                    {!isVideoPath(selectedMedia[0]) ? <img src={mediaUrl(selectedMedia[0])} alt={`${p.label}封面预览`} />
                      : <video src={mediaUrl(selectedMedia[0])} controls preload="metadata" aria-label={`${p.label}视频预览`} />}
                    <span>{isVideoPath(selectedMedia[0]) ? '视频' : `${selectedMedia.length} 张图片`}</span>
                  </div>}
                  <div className="pv-body">
                    <div className={`pv-title ${titleOver ? 'over' : ''}`}>{title || <span className="pv-ph">标题预览</span>}</div>
                    {titleOver && <p className="pv-limit-warning">标题超过 {p.titleLimit} 字，请先调整。</p>}
                    {isEdit ? <textarea className="field pv-edit-body" aria-label={`编辑${p.label}正文`} value={text} autoFocus
                      onChange={e => setOverrides(o => ({ ...o, [p.key]: e.target.value }))} />
                      : <div className="pv-text">{text || <span className="pv-ph">正文会显示在这里</span>}{adapting && overrides[p.key] != null && <span className="streaming-cursor" />}</div>}
                    {tags.trim() && <div className="publish-preview-tags">{tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean).map(tag => `#${tag}`).join(' ')}</div>}
                  </div>
                  <div className="pv-foot"><span className="pv-hint">{p.hint}{over ? ' · 正文已超字数' : ''}</span>
                    <div className="pv-card-actions">
                      {overrides[p.key] != null && <button className="pv-copy" disabled={adapting} onClick={() => { setOverrides(o => { const next = { ...o }; delete next[p.key]; return next; }); setEditing(null); }}>使用通用正文</button>}
                      <button className="pv-copy" disabled={adapting} onClick={() => setEditing(isEdit ? null : p.key)}><IconEdit size={13} />{isEdit ? '完成' : '编辑'}</button>
                      <button className="pv-copy" onClick={() => copyFor(p.key)}>{copied === p.key ? <IconCheck size={13} /> : <IconCopy size={13} />}{copied === p.key ? '已复制' : '复制'}</button>
                    </div>
                  </div>
                  {(issue || blocked[p.key]) && <p className="publish-platform-issue" role={blocked[p.key] ? 'alert' : undefined}>{issue || blocked[p.key]}</p>}
                  {receipt && <details className="publish-preview-receipt" open={platformBusy(p.key) || receipt.verification?.state === 'checking'}>
                    <summary><span>最近一次结果</span><span>{publishReceiptStatus(receipt).label}</span></summary>
                    <PublishReceiptCard receipt={receipt} onVerify={publishReceipts.open} onCheck={automatic => publishReceipts.verify(receipt.receiptId, automatic)}
                      checkBusy={publishReceipts.verificationBusyIds.includes(receipt.receiptId)} />
                  </details>}
                </div>;
              })}
            </>}
          </section>

          <section className="publish-action-panel" aria-label="发布操作">
            {selectedPlatforms.length > 0 && <div className="publish-readiness" aria-label="各平台发布准备">
              {selectedPlatforms.map(p => {
                const receipt = publishReceipts.receipts.find(item => item.platform === p.key);
                const busy = platformBusy(p.key);
                return <button key={p.key} className="publish-readiness-row" onClick={() => setPreviewPlatform(p.key)}>
                  <span><PlatformIcon platform={p.key} name={p.label} className="publish-platform-icon" />{p.label}</span>
                  <span className={busy ? 'is-busy' : preparationIssue(p.key) ? 'needs-attention' : 'is-ready'}>
                    {busy && <PublishSpinner />}{busy ? (receipt ? publishReceiptStatus(receipt).label : '正在提交…') : preparationIssue(p.key) ? accountsLoading ? '读取账号中…' : !loginOf(p.key) ? '需登录' : '需补充素材' : p.key === 'wechat-oa' ? '就绪 · 保存草稿' : '已就绪'}
                  </span>
                </button>;
              })}
            </div>}
            <button className="btn btn-primary publish-submit" disabled={empty || publishing || checking || adapting || !canPublish}
              title={canPublish ? '预检后确认本次实际提交的平台' : '请先选择发布平台'} onClick={publishAll}>
              {publishing || checking ? <PublishSpinner /> : <IconPublish size={16} />}
              {checking ? checkStage : publishing ? '正在发布，等待平台回执…' : `发布到 ${platforms.length} 个平台`}
            </button>
            <p className="publish-saved-note">{publishing ? '任务会在后台继续，每个平台单独保存结果。' : selectedPlatforms.length && readyCount < selectedPlatforms.length
              ? `${readyCount} 个平台就绪，请点击上方平台查看待处理项。` : '先预检，再确认提交。公众号保存到草稿箱。'}</p>
          </section>
        </aside>
      </div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
