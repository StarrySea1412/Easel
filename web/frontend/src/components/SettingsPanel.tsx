import '../styles/settings.css';
import StorageSettingsCard from './settings/StorageSettingsCard';
import ConversationBackupCard from './settings/ConversationBackupCard';
import EmployeeAppearanceSettings from './settings/EmployeeAppearanceSettings';
import DemoDataSettingsCard from './settings/DemoDataSettingsCard';
import type { ComponentProps } from 'react';
import { ProviderBoard } from './settings/ProviderBoard';
import { ModelConfigPicker } from './settings/ModelConfigPicker';
import Select from './ui/Select';
import type { ProviderBoardOptions } from './settings/ProviderBoard';
import { SettingsField } from './settings/SettingsField';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import EnvBoard from './EnvBoard';
import type { JobView } from './EnvBoard';
import { Sk as Skeleton, SkeletonCard } from './Skeleton';
import {
  fetchEnvTools, startEnvInstall, fetchEnvJob,
  fetchModelChannels, runChannelSelftest, saveModelConfig,
  fetchModelPresets, discoverModels,
  fetchImportSources, previewImport, applyImport,
  saveImagegenChannel, fetchImagegenGallery, fetchSkillDetail, saveEnv, testNotifyEmail,
} from '../lib/api';
import type {
  EnvTool, ModelRow, SelftestResult, ModelPreset, DiscoverResult,
  ImportSource, ImportPreview,
} from '../lib/api';
import { IconGear, IconSlidersHorizontal, IconPackage, IconEllipsis, IconUpload, IconImage, IconBell, IconSend } from './settingsIcons';

export type SettingsSection = 'general' | 'import' | 'model' | 'env' | 'image' | 'video' | 'notify' | 'employees' | 'more';
type Chan = 'chat' | 'transcribe' | 'speech' | 'image' | 'video' | 'music';

const CHANNELS: { id: Chan; label: string }[] = [
  { id: 'chat', label: '对话与脚本' },
  { id: 'transcribe', label: '语音转写' },
  { id: 'speech', label: '配音' },
  { id: 'image', label: '生图' },
  { id: 'video', label: '视频' },
  { id: 'music', label: '音乐' },
];

/** 后台繁忙（整机高负载）时的抗抖动取数：单次超时即重试，撑过多秒级接口延迟。 */
async function fetchWithRetry<T>(fn: () => Promise<T>, tries = 4, timeoutMs = 18000): Promise<T> {
  let lastErr: unknown = new Error('取数失败');
  for (let i = 0; i < tries; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('请求超时')), timeoutMs);
        fn().then(
          (v) => { clearTimeout(timer); resolve(v); },
          (e) => { clearTimeout(timer); reject(e); },
        );
      });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** 后端放在 model/baseUrl 里的展示占位串——提交前要清掉，它们不是真实配置值。 */
const PLACEHOLDERS = new Set(['—', '官方', '（未配置）', '本机', '内建默认']);

const hhmm = (ts: number) => new Date(ts * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

/** 设置（独立页面，非弹窗）：配置导入（CC Switch 一键迁移）· 模型配置 · 环境安装 · 生图工坊通道 · 更多。 */
export default function SettingsPanel({ initialSection = 'general', navigationKey = 0, conversationBackup, demoDataPreference }: {
  initialSection?: SettingsSection;
  navigationKey?: number;
  conversationBackup: ComponentProps<typeof ConversationBackupCard>;
  demoDataPreference: ComponentProps<typeof DemoDataSettingsCard>;
}) {
  // 'video' is a direct link into the existing model channel, not a second settings page.
  const [sec, setSec] = useState<SettingsSection>(initialSection === 'video' ? 'model' : initialSection);
  const [chan, setChan] = useState<Chan>(initialSection === 'video' ? 'video' : 'chat');
  useEffect(() => { setSec(initialSection === 'video' ? 'model' : initialSection); if (initialSection === 'video') setChan('video'); }, [initialSection, navigationKey]);
  const mounted = useRef(false);
  const jobCleanups = useRef(new Set<() => void>());
  useEffect(() => {
    mounted.current = true;
    const cleanups = jobCleanups.current;
    return () => {
      mounted.current = false;
      cleanups.forEach((cleanup) => cleanup());
      cleanups.clear();
    };
  }, []);

  // ── 环境安装（引擎真实数据） ──────────────────────────────
  const [tools, setTools] = useState<EnvTool[]>([]);
  const [python, setPython] = useState('');
  const [envLoading, setEnvLoading] = useState(true);
  const [envError, setEnvError] = useState('');
  const [jobs, setJobs] = useState<Record<string, JobView>>({});
  const runningRef = useRef(false);

  const refreshEnv = useCallback(async (force = false) => {
    setEnvLoading(true);
    setEnvError('');
    try {
      const d = await fetchWithRetry(() => fetchEnvTools(force));
      if (!mounted.current) return;
      setTools(d.tools || []);
      setPython(d.python || '');
    } catch (e) {
      if (mounted.current) setEnvError(e instanceof Error ? `环境体检失败：${e.message}` : '环境体检失败');
    } finally {
      if (mounted.current) setEnvLoading(false);
    }
  }, []);

  useEffect(() => { void refreshEnv(); }, [refreshEnv]);

  const batchMode = useRef(false);

  // 装完统一收尾：刷新体检（期间卡片显示「校验中」），然后清掉成功的 job 记录、保留失败（带原因）
  const settleJobs = useCallback(async () => {
    await refreshEnv(true);
    if (!mounted.current) return;
    setJobs((j) => {
      const n: Record<string, JobView> = {};
      Object.entries(j).forEach(([k, v]) => { if (v.state === 'fail') n[k] = v; });
      return n;
    });
  }, [refreshEnv]);

  const pollJob = useCallback((id: string, jobId: string) => new Promise<void>((resolve) => {
    let fails = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      jobCleanups.current.delete(stop);
      resolve();
    };
    jobCleanups.current.add(stop);
    const poll = async () => {
      try {
        const st = await fetchEnvJob(jobId);
        if (stopped || !mounted.current) return;
        fails = 0;
        const last = (st.lines || [])[st.lines.length - 1] || '';
        setJobs((j) => ({
          ...j,
          [id]: { state: st.state, line: last.trim().slice(0, 140), detail: st.result?.detail || null },
        }));
        if (st.state !== 'running') { stop(); return; }
      } catch (e) {
        if (stopped || !mounted.current) return;
        fails += 1;
        if (fails >= 3) {
          setJobs((j) => ({ ...j, [id]: { state: 'fail', line: '', detail: `无法读取安装结果：${e instanceof Error ? e.message : '连接失败'}。请刷新环境状态核对。` } }));
          stop();
          return;
        }
      }
      timer = setTimeout(() => void poll(), 1500);
    };
    timer = setTimeout(() => void poll(), 1500);
  }), []);

  const installOne = useCallback(async (id: string) => {
    setJobs((j) => ({ ...j, [id]: { state: 'running', line: '启动中…' } }));
    try {
      const { jobId } = await startEnvInstall(id);
      if (!mounted.current) return;
      await pollJob(id, jobId);
    } catch (e) {
      if (mounted.current) setJobs((j) => ({ ...j, [id]: { state: 'fail', line: '', detail: e instanceof Error ? e.message : '启动失败' } }));
    }
    if (!mounted.current) return;
    if (!batchMode.current) await settleJobs();   // 单卡装完立即收尾刷新
  }, [pollJob, settleJobs]);

  const installMany = useCallback(async (ids: string[]) => {
    runningRef.current = true;
    batchMode.current = true;
    setJobs((j) => {
      const n = { ...j };
      ids.forEach((id) => { n[id] = { state: 'running', line: '排队中…' }; });
      return n;
    });
    for (const id of ids) {
      if (!mounted.current) break;
      // eslint-disable-next-line no-await-in-loop
      await installOne(id);
    }
    batchMode.current = false;
    runningRef.current = false;
    if (mounted.current) await settleJobs();
  }, [installOne, settleJobs]);

  const anyRunning = runningRef.current || Object.values(jobs).some((j) => j.state === 'running');
  const okCount = tools.filter((t) => t.state === 'ok').length;
  const total = tools.length;

  // ── 模型配置（真值只读 + 真自测） ────────────────────────
  const [chatRows, setChatRows] = useState<ModelRow[]>([]);
  const [transRows, setTransRows] = useState<ModelRow[]>([]);
  const [mediaRows, setMediaRows] = useState<Record<string, ModelRow[]>>({});
  const [modelLoading, setModelLoading] = useState(true);
  const [modelErr, setModelErr] = useState('');
  const [selftest, setSelftest] = useState<{ testedAt: number; byBase: Record<string, SelftestResult> } | null>(null);
  const [testing, setTesting] = useState(false);
  const [selftestNote, setSelftestNote] = useState('');

  // ── 服务商预设与「获取模型」（方案功能 C 第一步） ──────────
  const [presets, setPresets] = useState<Record<string, ModelPreset[]>>({});
  const [discover, setDiscover] = useState<Record<string, DiscoverResult | 'loading'>>({});
  const [discovering, setDiscovering] = useState('');

  useEffect(() => {
    let alive = true;
    fetchModelPresets()
      .then((d) => { if (alive) setPresets(d.presets || {}); })
      .catch(() => { /* 预设拿不到就只剩手动填写，不打断设置页 */ });
    return () => { alive = false; };
  }, []);

  const runDiscover = useCallback(async (ch: string, i: number, row: ModelRow) => {
    const key = `${ch}:${i}`;
    setDiscovering(key);
    setDiscover((m) => ({ ...m, [key]: 'loading' }));
    try {
      const r = await discoverModels({
        channel: ch,
        slot: row.slot || '',
        baseUrl: row.baseUrl || '',
        apiKey: row.keyNew || '',
        protocol: row.protocol || '',
      });
      if (!mounted.current) return;
      setDiscover((m) => ({ ...m, [key]: r }));
    } catch (e) {
      if (!mounted.current) return;
      setDiscover((m) => ({
        ...m,
        [key]: {
          ok: false, kind: 'client_error', models: [], channel: ch, slot: row.slot || '',
          source: row.baseUrl || '', fetchedAt: Math.floor(Date.now() / 1000), keySource: 'none',
          message: e instanceof Error ? e.message : '获取失败',
        },
      }));
    } finally {
      if (mounted.current) setDiscovering('');
    }
  }, []);

  // ── 从本机配置导入（方案功能 C 第二步；独立页里为一级分区） ──
  const [impSources, setImpSources] = useState<ImportSource[]>([]);
  const [impSource, setImpSource] = useState('');
  const [impPath, setImpPath] = useState('');
  const [impSlot, setImpSlot] = useState('openai');
  const [impPreview, setImpPreview] = useState<ImportPreview | null>(null);
  const [impPick, setImpPick] = useState('');
  const [impBusy, setImpBusy] = useState<'' | 'preview' | 'apply'>('');
  const [impMsg, setImpMsg] = useState('');
  const [impConfirmed, setImpConfirmed] = useState(false);

  const clearImportPreview = useCallback(() => {
    setImpPreview(null);
    setImpPick('');
    setImpConfirmed(false);
    setImpMsg('');
  }, []);

  const openImport = useCallback(async () => {
    if (impSources.length) return;
    try {
      const d = await fetchImportSources();
      if (!mounted.current) return;
      setImpSources(d.sources);
      const first = d.sources.find((s) => s.available) || d.sources[0];
      if (first) setImpSource(first.id);
    } catch (e) {
      if (mounted.current) setImpMsg(e instanceof Error ? e.message : '读取来源失败');
    }
  }, [impSources.length]);

  const loadImportPreview = useCallback(async () => {
    if (!impSource) { setImpMsg('先选择一个来源'); return; }
    setImpBusy('preview');
    setImpMsg('');
    setImpPreview(null);
    setImpPick('');
    setImpConfirmed(false);
    try {
      const d = await previewImport(impSource, impSlot, impPath.trim());
      if (!mounted.current) return;
      setImpPreview(d);
      if (!d.candidates.length) setImpMsg('这个来源里没有读到可导入的配置');
    } catch (e) {
      if (mounted.current) setImpMsg(e instanceof Error ? e.message : '预览失败');
    } finally {
      if (mounted.current) setImpBusy('');
    }
  }, [impSource, impSlot, impPath]);

  const applyImportPick = useCallback(async () => {
    const selected = impPreview?.candidates.find((c) => c.id === impPick && c.compatible);
    if (!selected?.previewToken || !impConfirmed || impBusy) return;
    setImpBusy('apply');
    setImpMsg('');
    try {
      const r = await applyImport(impSource, impPick, impSlot, impPath.trim(), selected.previewToken);
      if (!mounted.current) return;
      setImpMsg(`✓ 已导入「${r.applied.name}」→ ${impSlot}${r.note ? `（${r.note}）` : ''}`);
      setImpPreview(null);
      setImpPick('');
      setImpConfirmed(false);
      try {
        const d = await fetchModelChannels();
        if (!mounted.current) return;
        const imported = d.channels.chat.rows.find((row) => row.slot === impSlot);
        if (imported) setChatRows((rows) => rows.some((row) => row.slot === impSlot)
          ? rows.map((row) => row.slot === impSlot ? { ...imported, role: row.role } : row) : [...rows, imported]);
      } catch {
        if (mounted.current) setImpMsg('✓ 配置已导入，但刷新失败；请重新打开设置核对。');
      }
    } catch (e) {
      if (mounted.current) setImpMsg(e instanceof Error ? `导入失败：${e.message}` : '导入失败');
    } finally {
      if (mounted.current) setImpBusy('');
    }
  }, [impSource, impPick, impSlot, impPath, impPreview, impConfirmed, impBusy]);

  useEffect(() => {
    let alive = true;
    fetchWithRetry(() => fetchModelChannels(), 5, 15000)
      .then((d) => {
        if (!alive) return;
        setChatRows(d.channels.chat.rows || []);
        setTransRows(d.channels.transcribe.rows || []);
        setMediaRows({
          image: d.channels.image?.rows || [],
          video: d.channels.video?.rows || [],
          music: d.channels.music?.rows || [],
          speech: d.channels.speech?.rows || [],
        });
        setModelErr('');
      })
      .catch((e) => { if (alive) setModelErr(e instanceof Error ? e.message : '模型配置读取失败'); })
      .finally(() => { if (alive) setModelLoading(false); });
    return () => { alive = false; };
  }, []);

  const doSelftest = useCallback(async (channel: string) => {
    setTesting(true);
    setSelftestNote('');
    try {
      const r = await runChannelSelftest(channel);
      if (!mounted.current) return;
      const byBase: Record<string, SelftestResult> = {};
      r.results.forEach((x) => { byBase[x.baseUrl] = x; });
      setSelftest({ testedAt: r.testedAt, byBase });
      if (!r.results.length) setSelftestNote('没有可自测的通道（未配置 key）');
      void refreshEnv();
    } catch (e) {
      if (mounted.current) setSelftestNote(e instanceof Error ? `自测失败：${e.message}` : '自测失败');
    } finally {
      if (mounted.current) setTesting(false);
    }
  }, [refreshEnv]);

  // ── 模型配置可编辑（v2）：保存到 .env / openclaw ──────────
  const [saving, setSaving] = useState(false);
  const [modelImportBusy, setModelImportBusy] = useState(false);
  const [savedNote, setSavedNote] = useState('');
  const [deletedProviders, setDeletedProviders] = useState<string[]>([]);

  const saveCurrent = useCallback(async () => {
    const rows = chan === 'chat' ? chatRows : chan === 'transcribe' ? transRows : (mediaRows[chan] || []);
    const payload = rows
      .filter((r) => r.slot)
      .map((r) => ({
        slot: r.slot as string,
        name: r.slot === 'custom' ? r.name.trim().toLowerCase() : '',
        // 后端在这些字段里塞的是展示占位（'官方'/'（未配置）'/'本机'/'—'），不是真值：
        // 原样回传会被后端的 Base URL 校验打成 400，导致该行永远保存不了。
        model: PLACEHOLDERS.has(r.model) ? '' : r.model,
        baseUrl: PLACEHOLDERS.has(r.baseUrl) ? '' : r.baseUrl,
        key: r.keyNew || '',
        key2: r.keyNew2 || '',
        primary: r.role === '主',
        protocol: chan === 'chat' ? r.protocol || r.type : undefined,
      }));
    if (!payload.length) {
      setSavedNote('当前通道没有可保存的配置');
      return;
    }
    setSaving(true);
    setSavedNote('');
    try {
      const d = await saveModelConfig(chan, payload, chan === 'chat' ? deletedProviders : []);
      if (!mounted.current) return;
      if (chan === 'chat') {
        setChatRows(d.channels.chat.rows || []);
        setDeletedProviders([]);
      }
      else if (chan === 'transcribe') setTransRows(d.channels.transcribe.rows || []);
      else setMediaRows((rows) => ({ ...rows, [chan]: d.channels[chan]?.rows || [] }));
      clearImportPreview();
      setSavedNote(d.note ? `✓ 已保存（${d.note}）` : '✓ 已保存');
      void refreshEnv();
    } catch (e) {
      if (mounted.current) setSavedNote(e instanceof Error ? `保存失败：${e.message}` : '保存失败');
    } finally {
      if (mounted.current) {
        setSaving(false);
        setTimeout(() => { if (mounted.current) setSavedNote(''); }, 6000);
      }
    }
  }, [chan, chatRows, transRows, mediaRows, refreshEnv, clearImportPreview, deletedProviders]);

  // ── 通知中心（邮箱通知可视化配置 + 测试发送） ──────────────
  const [ntf, setNtf] = useState({ email: '', host: '', port: '465', user: '', pass: '', onDone: false });
  const [ntfLoading, setNtfLoading] = useState(true);
  const [ntfSaved, setNtfSaved] = useState('');
  const [ntfTesting, setNtfTesting] = useState(false);
  const [ntfTestMsg, setNtfTestMsg] = useState('');
  useEffect(() => {
    let alive = true;
    fetchWithRetry(() => fetchSkillDetail('skill-email-notify'), 3, 12000)
      .then((d) => {
        if (!alive) return;
        const vals: Record<string, string> = {};
        (d.apiSpec?.providers || []).forEach((p) =>
          p.keys.forEach((k) => { if (k.env) vals[k.env] = k.masked || ''; }));
        setNtf({
          email: vals.EASEL_NOTIFY_EMAIL || '',
          host: vals.EASEL_NOTIFY_SMTP_HOST || '',
          port: vals.EASEL_NOTIFY_SMTP_PORT || '465',
          user: vals.EASEL_NOTIFY_SMTP_USER || '',
          pass: '',
          onDone: vals.EASEL_NOTIFY_ON_DONE === '1',
        });
      })
      .catch((e: unknown) => { if (alive) setNtfSaved(`读取通知配置失败：${e instanceof Error ? e.message : '请稍后重试'}`); })
      .finally(() => { if (alive) setNtfLoading(false); });
    return () => { alive = false; };
  }, []);
  const saveNotify = useCallback(async () => {
    setNtfSaved('');
    try {
      await saveEnv({
        EASEL_NOTIFY_EMAIL: ntf.email.trim(),
        EASEL_NOTIFY_SMTP_HOST: ntf.host.trim(),
        EASEL_NOTIFY_SMTP_PORT: ntf.port.trim() || '465',
        EASEL_NOTIFY_SMTP_USER: ntf.user.trim(),
        ...(ntf.pass.trim() ? { EASEL_NOTIFY_SMTP_PASS: ntf.pass.trim() } : {}),
        EASEL_NOTIFY_ON_DONE: ntf.onDone ? '1' : '0',
      });
      if (!mounted.current) return;
      setNtfSaved(ntf.onDone ? '✓ 已保存并开启自动邮件通知；具体发送结果可在发布回执中查看' : '✓ 已保存；自动邮件通知已关闭');
    } catch (e) {
      if (mounted.current) setNtfSaved(e instanceof Error ? `保存失败：${e.message}` : '保存失败');
    }
  }, [ntf]);
  const testNotify = useCallback(async () => {
    setNtfTesting(true); setNtfTestMsg('');
    try {
      const r = await testNotifyEmail();
      if (!mounted.current) return;
      setNtfTestMsg(r.ok ? `✅ ${r.detail}（收件人 ${r.to.join('、')}）` : `❌ ${r.detail}`);
    } catch (e) {
      if (mounted.current) setNtfTestMsg(`❌ ${e instanceof Error ? e.message : '发送失败'}`);
    } finally { if (mounted.current) setNtfTesting(false); }
  }, []);

  // ── 生图通道（工作台生图工坊用；IMG_*，OpenAI 协议） ──────
  const [imgBase, setImgBase] = useState('');
  const [imgBaseSaved, setImgBaseSaved] = useState('');
  const [imgKey, setImgKey] = useState('');
  const [imgKeyMasked, setImgKeyMasked] = useState('');
  const [imgModel, setImgModel] = useState('');
  const [imgLoading, setImgLoading] = useState(true);
  const [imgLoadError, setImgLoadError] = useState('');
  const [imgSaved, setImgSaved] = useState('');
  const [imgSaving, setImgSaving] = useState(false);
  const imgSavePending = useRef(false);
  const imgBaseChanged = imgBase.trim() !== imgBaseSaved.trim();
  useEffect(() => {
    let alive = true;
    fetchImagegenGallery().then(({ channel }) => {
      if (!alive) return;
      setImgBase(channel.baseUrl);
      setImgBaseSaved(channel.baseUrl);
      setImgKeyMasked(channel.keyMasked);
      setImgModel(channel.model);
    }).catch((e: unknown) => {
      if (alive) setImgLoadError(`生图配置读取失败：${e instanceof Error ? e.message : '请重新打开设置'}`);
    }).finally(() => { if (alive) setImgLoading(false); });
    return () => { alive = false; };
  }, []);
  const saveImgChannel = useCallback(async () => {
    if (imgSavePending.current) return;
    setImgSaved('');
    if (imgBaseChanged && !imgKey.trim()) {
      setImgSaved('Base URL 已更改，请重新填写对应服务商的 API Key');
      return;
    }
    imgSavePending.current = true;
    setImgSaving(true);
    try {
      await saveImagegenChannel(imgBase.trim(), imgKey.trim());
      if (!mounted.current) return;
      setImgBaseSaved(imgBase.trim());
      if (imgKey.trim()) {
        setImgKey('');
        setImgKeyMasked('已保存');
      }
      setImgSaved('✓ 已保存；可到生图工坊尝试生图，尚未验证服务可用性');
    } catch (e) {
      if (mounted.current) setImgSaved(e instanceof Error ? `保存失败：${e.message}` : '保存失败');
    } finally {
      imgSavePending.current = false;
      if (mounted.current) setImgSaving(false);
    }
  }, [imgBase, imgBaseChanged, imgKey]);

  // Esc 不再关闭：设置已是独立页面，Esc 留给页面内控件


  // 本地兜底 whisper：从环境工具状态推出来（fw + 模型都在才算就绪）
  const fw = tools.find((t) => t.id === 'fw');
  const modelTool = tools.find((t) => t.id === 'model');
  const localReady = fw?.state === 'ok' && modelTool?.state === 'ok';
  const localRow: ModelRow = {
    order: 2, name: 'local-whisper', sub: '本机兜底 · 免 key', type: 'local',
    model: 'faster-whisper', baseUrl: '本机', keyMasked: '—', role: '备',
    result: localReady ? '✓ 已就绪' : (tools.length ? '未装（去环境安装）' : '检测中…'),
  };

  const resultText = (row: ModelRow): { text: string; cls: string } => {
    const st = row.baseUrl && row.baseUrl !== '—' ? selftest?.byBase[row.baseUrl] : undefined;
    if (st) return st.ok ? { text: `✓ ${st.ms}ms`, cls: 'good' } : { text: `✗ ${(st.detail || '失败').slice(0, 42)}`, cls: 'bad' };
    if (row.result.includes('已就绪') || row.result.includes('已配置')) return { text: row.result, cls: 'good' };
    if (row.result.includes('缺') || row.result.includes('未装')) return { text: row.result, cls: 'warn-text' };
    return { text: row.result, cls: '' };
  };

  const addProvider = () => {
    setChatRows((rs) => [...rs, {
      slot: 'custom', order: 0, name: '', sub: '自定义', type: 'openai',
      model: '', baseUrl: '', keyMasked: '', role: '备', result: '待保存',
    }]);
  };

  const setPrimaryRow = (i: number) => {
    setChatRows((rs) => rs.map((r, j) => (r.slot ? { ...r, role: j === i ? '主' : '备' } : r)));
    setSavedNote('已选择主模型，点击「保存配置」生效。');
  };

  const removeRow = (i: number) => {
    const removed = chatRows[i];
    if (removed?.deletable && removed.name) setDeletedProviders((names) => [...new Set([...names, removed.name])]);
    setChatRows((rs) => {
      const gone = rs[i];
      const left = rs.filter((_, j) => j !== i);
      if (gone && gone.role === '主') {
        const first = left.findIndex((r) => r.slot);
        if (first >= 0) left[first] = { ...left[first], role: '主' };
      }
      return left;
    });
  };

  const updateRow = (
    setRows: Dispatch<SetStateAction<ModelRow[]>>,
    i: number,
    patch: Partial<ModelRow>,
  ) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const updateMediaRow = (ch: string, i: number, patch: Partial<ModelRow>) =>
    setMediaRows((m) => ({ ...m, [ch]: (m[ch] || []).map((r, j) => (j === i ? { ...r, ...patch } : r)) }));

  const setMediaPrimary = (ch: string, i: number) =>
    setMediaRows((m) => ({ ...m, [ch]: (m[ch] || []).map((r, j) => ({ ...r, role: j === i ? '主' : '备' })) }));

  const mediaOk = (ch: string) => (mediaRows[ch] || []).some((r) => r.result === '已配置');

  const renderBoard = (rows: ModelRow[], ops?: ProviderBoardOptions) => (
    <ProviderBoard rows={rows} ops={ops} modelLoading={modelLoading} resultText={resultText} />
  );

  const chatOk = chatRows.some((r) => r.role === '主' && (r.result.includes('已配置') || r.result.includes('✓')))
    || chatRows.some((r) => r.result.includes('已配置'));
  const chatLive = chatOk && !!selftest && Object.values(selftest.byBase).some((r) => r.ok);
  const transOk = transRows.length > 1 && transRows[1].result.includes('已配置');

  return (
    <div className="page-scroll settings-page">
      <div className="settings-panel page">
        <div className="settings-head">
          <div>
            <h2 className="settings-title">设置</h2>
            <div className="settings-sub">通用设置 · 模型配置 · 环境安装 · 生图通道 · 更多</div>
          </div>
          <div className="settings-actions">
            {sec === 'model' && (
              <>
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => void saveCurrent()}
                  disabled={saving || Boolean(impBusy) || modelImportBusy}
                >
                  {saving ? '保存中…' : '保存配置'}
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => void doSelftest(chan)}
                  disabled={testing}
                >
                  {testing ? '自测中…' : '自测本通道'}
                </button>
              </>
            )}
          </div>
        </div>

        <div className="settings-body">
          <nav className="settings-nav">
            <button aria-current={sec === 'general' ? 'page' : undefined} className={`snav${sec === 'general' ? ' active' : ''}`} onClick={() => setSec('general')}>
              <IconGear size={16} />通用设置<small>演示数据开关</small>
            </button>
            <button aria-current={sec === 'import' ? 'page' : undefined} className={`snav${sec === 'import' ? ' active' : ''}`} onClick={() => { setSec('import'); void openImport(); }}>
              <IconUpload size={16} />配置导入<small>CC Switch 一键迁移</small>
            </button>
            <button aria-current={sec === 'model' ? 'page' : undefined} className={`snav${sec === 'model' ? ' active' : ''}`} onClick={() => setSec('model')}>
              <IconSlidersHorizontal size={16} />模型配置<small>六个通道</small>
            </button>
            <button aria-current={sec === 'env' ? 'page' : undefined} className={`snav${sec === 'env' ? ' active' : ''}`} onClick={() => setSec('env')}>
              <IconPackage size={16} />环境安装<small>{total ? (okCount === total ? '全就绪' : `${okCount}/${total}`) : '…'}</small>
            </button>
            <button aria-current={sec === 'image' ? 'page' : undefined} className={`snav${sec === 'image' ? ' active' : ''}`} onClick={() => setSec('image')}>
              <IconImage size={16} />生图通道<small>工作台直出</small>
            </button>
            <button aria-current={sec === 'notify' ? 'page' : undefined} className={`snav${sec === 'notify' ? ' active' : ''}`} onClick={() => setSec('notify')}>
              <IconBell size={16} />通知中心<small>{ntf.email && ntf.host ? '已配置' : ntfLoading ? '检测中…' : '邮箱推送'}</small>
            </button>
            <button aria-current={sec === 'employees' ? 'page' : undefined} className={`snav${sec === 'employees' ? ' active' : ''}`} onClick={() => setSec('employees')}>
              <IconSlidersHorizontal size={16} />员工角色卡<small>办公室展示形象</small>
            </button>
            <button aria-current={sec === 'more' ? 'page' : undefined} className={`snav${sec === 'more' ? ' active' : ''}`} onClick={() => setSec('more')}>
              <IconEllipsis size={16} />更多设置<small>保存位置与备份</small>
            </button>
          </nav>

          <div className="settings-main">
          {sec === 'general' && <DemoDataSettingsCard {...demoDataPreference} />}
          {sec === 'employees' && <EmployeeAppearanceSettings />}
          {/* ── 配置导入：CC Switch / OpenClaw 一键迁移（一级分区） ── */}
          {sec === 'import' && (
            <section className="st-sec active">
              <div className="panel-top">
                <span className="desc">
                  读取本机 CC Switch / OpenClaw 里已配好的模型（密钥脱敏展示），选中一条一键写入 Easel 对话通道。
                </span>
              </div>
              <div className="imp-cards">
                {impSources.length === 0 && (
                  <div className="board"><div className="empty"><Skeleton w="70%" h={14} style={{ marginBottom: 10 }} /><Skeleton w="45%" h={12} /></div></div>
                )}
                {impSources.map((s) => (
                  <button
                    key={s.id}
                    className={`imp-card${impSource === s.id ? ' on' : ''}${s.available ? '' : ' off'}`}
                    onClick={() => { setImpSource(s.id); clearImportPreview(); }}
                    disabled={Boolean(impBusy)}
                  >
                    <span className="imp-name">{s.label}</span>
                    <span className="imp-detail">{s.available ? (s.detail || '本机已检测到') : `不可用：${s.detail}`}</span>
                    <span className={`pill ${s.available ? 'ok' : 'off'}`}><span className="dot" />{s.available ? '可导入' : '未检测到'}</span>
                  </button>
                ))}
              </div>
              {impSources.length > 0 && (
                <>
                  <div className="import-row">
                    <Select
                      aria-label="导入目标槽位"
                      value={impSlot}
                      disabled={Boolean(impBusy)}
                      onChange={(value) => { setImpSlot(value); clearImportPreview(); }}
                      options={[
                        { value: 'openai', label: '写入：OpenAI 兼容槽位（OPENAI_*）' },
                        { value: 'relay', label: '写入：Anthropic 兼容中转（EASEL_LLM_*）' },
                        { value: 'anthropic', label: '写入：Anthropic 槽位（ANTHROPIC_*）' },
                      ]}
                    />
                    <input
                      className="mock"
                      value={impPath}
                      placeholder="自定义配置路径（可留空）"
                      disabled={Boolean(impBusy)}
                      onChange={(e) => { setImpPath(e.target.value); clearImportPreview(); }}
                    />
                    <button className="btn btn-sm btn-primary" onClick={() => void loadImportPreview()} disabled={Boolean(impBusy) || saving}>
                      {impBusy === 'preview' ? '读取中…' : '读取候选'}
                    </button>
                  </div>
                  {impMsg && <div className="import-msg">{impMsg}</div>}
                  {impBusy === 'preview' && <SkeletonCard rows={3} />}
                  {impPreview && impPreview.candidates.length > 0 && (
                    <>
                      <div className="import-list">
                        {impPreview.candidates.map((c) => (
                          <label
                            key={c.id}
                            className={`import-item${c.compatible ? '' : ' off'}${impPick === c.id ? ' on' : ''}`}
                          >
                            <input
                              type="radio"
                              name="imp-pick"
                              disabled={!c.compatible || Boolean(impBusy)}
                              checked={impPick === c.id}
                              onChange={() => { setImpPick(c.id); setImpConfirmed(false); }}
                            />
                            <span className="ii-main">
                              <span className="ii-name">
                                {c.name}
                                <span className="badge">{c.protocol}</span>
                                {c.appType && <span className="ii-app">{c.appType}</span>}
                              </span>
                              <span className="ii-base">{c.baseUrl || '（无地址）'}</span>
                              <span className="ii-meta">
                                {c.model ? `模型 ${c.model} · ` : ''}密钥 {c.keyMasked || '无'}
                                {!c.compatible && ` · ${c.skipReason}`}
                                {c.note && ` · ${c.note}`}
                              </span>
                              {c.compatible && c.overwrites.length > 0 && (
                                <span className="ii-ov">
                                  将覆盖：{c.overwrites.map((o) => `${o.field}（${o.current} → ${o.incoming}）`).join('；')}
                                </span>
                              )}
                            </span>
                          </label>
                        ))}
                      </div>
                      <label className="import-msg">
                        <input type="checkbox" checked={impConfirmed}
                          disabled={!impPick || Boolean(impBusy)}
                          onChange={(e) => setImpConfirmed(e.target.checked)} />
                        我已核对覆盖内容，确认立即写入所选槽位（替换此槽位尚未保存的编辑）
                      </label>
                      <div className="import-foot">
                        <button
                          className="btn btn-sm btn-primary"
                          onClick={() => void applyImportPick()}
                          disabled={!impPick || !impConfirmed || Boolean(impBusy) || saving}
                        >
                          {impBusy === 'apply' ? '导入中…' : '⚡ 一键导入'}
                        </button>
                        <span className="hint">{impPreview.note}</span>
                      </div>
                    </>
                  )}
                  {impPreview && impPreview.errors.length > 0 && (
                    <div className="import-msg">部分条目已跳过：{impPreview.errors.join('；')}</div>
                  )}
                  <div className="foot-note">导入后可在「模型配置 → 对话与脚本」里核对主备顺序；导入会同步写入 .env 与 OpenClaw 配置，失败自动回滚。</div>
                </>
              )}
            </section>
          )}

            {sec === 'model' && (
              <section className="st-sec active">
                  <div className="tabbar" role="tablist" aria-label="模型能力通道">
                  {CHANNELS.map((c) => (
                    <button key={c.id} role="tab" aria-selected={chan === c.id} className={`tab${chan === c.id ? ' active' : ''}`} onClick={() => setChan(c.id)}>
                      <span className="cdot" />{c.label}
                    </button>
                  ))}
                </div>
                {savedNote ? <div role="status" aria-live="polite" className={`save-note${savedNote.startsWith('保存失败') || savedNote.startsWith('没有') ? ' err' : ''}`}>{savedNote}</div> : null}

                {chan === 'chat' && (
                  <section className="st-panel active">
                    <ModelConfigPicker rows={chatRows} disabled={modelLoading || saving || Boolean(impBusy)}
                      onPrimary={setPrimaryRow} onBusyChange={setModelImportBusy}
                      onApplied={(imported) => {
                        if (!mounted.current) return;
                        setChatRows((rows) => rows.some((row) => row.slot === imported.slot)
                          ? rows.map((row) => row.slot === imported.slot ? { ...imported, role: row.role } : row) : [...rows, imported]);
                        clearImportPreview();
                        setSelftest(null);
                      }}
                      onOpenImport={() => { setSec('import'); void openImport(); }} />
                    <div className="panel-top">
                      <span className={`pill ${chatOk ? 'ok' : 'off'}`}><span className="dot" />{chatLive ? '主通道在线' : chatOk ? '主通道已配置' : '未配置'}</span>
                      <span className="desc">经本地网关路由（主备自动降级）</span>
                      {selftest && <span className="desc">上次自测 {hhmm(selftest.testedAt)}</span>}
                      <span className="spacer" />
                    </div>
                    {renderBoard(chatRows, {
                      onRow: (i, p) => updateRow(setChatRows, i, p),
                      onPrimary: setPrimaryRow,
                      onRemove: removeRow,
                      channel: 'chat',
                      presets: presets.chat,
                      discovery: (i) => discover[`chat:${i}`],
                      onDiscover: (i) => void runDiscover('chat', i, chatRows[i]),
                      busyKey: discovering,
                      onPickPreset: (i, p) => updateRow(setChatRows, i, {
                        baseUrl: p.baseUrl, protocol: p.protocol,
                        name: p.id, sub: p.note || '预设', type: p.protocol,
                      }),
                    })}
                    <div className="add-row" onClick={addProvider}>＋ 添加供应商（填名称 / 模型 / Base URL / Key；点「设为主」切换生效通道）</div>
                    <div className="import-block">
                      <button className="adv-btn" onClick={() => { setSec('import'); void openImport(); }}>
                        ⬇ 从本机配置导入（CC Switch / OpenClaw）→ 去「配置导入」页
                      </button>
                    </div>
                    <div className="foot-note">改完点右上角「保存配置」（key 留空=不改）；预设只填公开端点，模型列表现场向服务商查询，不做猜测。</div>
                  </section>
                )}

                {chan === 'transcribe' && (
                  <section className="st-panel active">
                    <div className="panel-top">
                      <span className={`pill ${transOk ? 'ok' : 'warn'}`}><span className="dot" />{transOk ? '主通道在线' : (localReady ? '本地兜底生效' : '备用待安装')}</span>
                      <span className="desc">三级链：自带字幕 → API → 本地兜底</span>
                      <span className="spacer" />
                    </div>
                    {renderBoard([...transRows, localRow], {
                      onRow: (i, p) => updateRow(setTransRows, i, p),
                      channel: 'transcribe',
                      presets: presets.transcribe,
                      discovery: (i) => discover[`transcribe:${i}`],
                      onDiscover: (i) => void runDiscover('transcribe', i, transRows[i]),
                      busyKey: discovering,
                      onPickPreset: (i, p) => updateRow(setTransRows, i, {
                        baseUrl: p.baseUrl, protocol: p.protocol, sub: p.note || '预设',
                      }),
                    })}
                    <div className="foot-note">有字幕不下模型；API 通道缺 key 自动落到本地 whisper（本地组件在「环境安装」页装）。保存即写入 .env 生效。</div>
                  </section>
                )}

                {chan === 'speech' && (
                  <section className="st-panel active">
                    <div className="panel-top">
                      <span className={`pill ${mediaOk('speech') ? 'ok' : 'off'}`}><span className="dot" />{mediaOk('speech') ? '有可用提供商' : '未配置'}</span>
                      <span className="desc">只填 Key 即用（地址/模型内建）；「主/备」= 默认</span>
                      <span className="spacer" />
                    </div>
                    {renderBoard(mediaRows.speech || [], { onRow: (i, p) => updateMediaRow('speech', i, p), onPrimary: (i) => setMediaPrimary('speech', i), media: true })}
                    <div className="foot-note">配音脚本按「主」provider 合成；本地 VoxCPM / edge-tts 在视频产线里可直接替代。</div>
                  </section>
                )}

                {chan === 'image' && (
                  <section className="st-panel active">
                    <div className="panel-top">
                      <span className={`pill ${mediaOk('image') ? 'ok' : 'off'}`}><span className="dot" />{mediaOk('image') ? '已配置' : '未配置'}</span>
                      <span className="desc">只填 Key 即用（地址/模型内建，点「高级」可覆盖）</span>
                      <span className="spacer" />
                    </div>
                    {renderBoard(mediaRows.image || [], {
                      onRow: (i, p) => updateMediaRow('image', i, p),
                      media: true,
                      channel: 'image',
                      presets: presets.image,
                      discovery: (i) => discover[`image:${i}`],
                      onDiscover: (i) => void runDiscover('image', i, (mediaRows.image || [])[i]),
                      busyKey: discovering,
                      onPickPreset: (i, p) => updateMediaRow('image', i, {
                        baseUrl: p.baseUrl, protocol: p.protocol, adv: true,
                      }),
                    })}
                    <div className="foot-note">按 Base URL 自动选同步 / 异步（apimart）模式；模型名留空用服务端默认。预设只提供公开端点，能否枚举模型取决于服务商。</div>
                  </section>
                )}

                {chan === 'video' && (
                  <section className="st-panel active">
                    <div className="panel-top">
                      <span className={`pill ${mediaOk('video') ? 'ok' : 'off'}`}><span className="dot" />{mediaOk('video') ? '有可用提供商' : '未配置'}</span>
                      <span className="desc">只填 Key 即用（地址/模型内建，点「高级」可覆盖）；「主/备」= 默认</span>
                      <span className="spacer" />
                    </div>
                    {renderBoard(mediaRows.video || [], { onRow: (i, p) => updateMediaRow('video', i, p), onPrimary: (i) => setMediaPrimary('video', i), media: true })}
                    <div className="foot-note">脚本按「主」provider 出片；同类多家的自动降级随统一网关接入开放。</div>
                  </section>
                )}

                {chan === 'music' && (
                  <section className="st-panel active">
                    <div className="panel-top">
                      <span className={`pill ${mediaOk('music') ? 'ok' : 'off'}`}><span className="dot" />{mediaOk('music') ? '有可用提供商' : '未配置'}</span>
                      <span className="desc">只填 Key 即用；「主/备」= 默认</span>
                      <span className="spacer" />
                    </div>
                    {renderBoard(mediaRows.music || [], { onRow: (i, p) => updateMediaRow('music', i, p), onPrimary: (i) => setMediaPrimary('music', i), media: true })}
                  </section>
                )}

                {modelErr && <div className="env-error">{modelErr}</div>}
                {selftestNote && <div className="foot-note">{selftestNote}</div>}
                {selftest && !selftestNote && <div className="foot-note">自测仅验证模型 API 连通性（GET /models 并计时）；对话执行还需本地 OpenClaw 网关在线，两者不代表同一件事。</div>}
              </section>
            )}

            {/* ── 生图通道：工作台「生图工坊」直出图的专用 OpenAI 协议通道 ── */}
            {sec === 'image' && (
              <section className="st-sec active">
                <div className="panel-top">
                  <span className={`pill ${!imgBaseChanged && imgBaseSaved && imgKeyMasked ? 'ok' : 'off'}`}><span className="dot" />{imgLoading ? '读取中…' : imgLoadError ? '读取失败' : imgBaseChanged || imgKey ? '尚未保存' : imgBaseSaved && imgKeyMasked ? '已配置 · 未验证' : '未配置'}</span>
                  <span className="desc">OpenAI 协议（/v1/images/generations）；聚合站出图可能需要 1-8 分钟</span>
                  <span className="spacer" />
                </div>
                {imgLoadError && <div className="env-error" role="alert">{imgLoadError}</div>}
                <div className="board img-chan">
                  <SettingsField label="Base URL" horizontal>
                    <input
                      className="mock"
                      value={imgBase}
                      aria-label="生图 Base URL"
                      disabled={imgLoading || imgSaving}
                      placeholder="https://api.example.com/v1"
                      onChange={(e) => setImgBase(e.target.value)}
                    />
                  </SettingsField>
                  <SettingsField label="API Key" horizontal>
                    <input
                      className="mock"
                      type="password"
                      value={imgKey}
                      aria-label="生图 API Key"
                      disabled={imgLoading || imgSaving}
                      placeholder={imgBaseChanged ? 'Base URL 已更改，请填写新服务商的 Key' : imgKeyMasked || '粘贴生图服务的 Key（QQ/聚合站的专属 Key，不是聊天 Key）'}
                      onChange={(e) => setImgKey(e.target.value)}
                    />
                  </SettingsField>
                  <SettingsField label="模型" horizontal>
                    <span className="cell-text">{imgLoading ? '读取中…' : imgModel || '未读取到模型配置'}</span>
                  </SettingsField>
                  {imgSaved && <div className={`save-note${imgSaved.startsWith('保存失败') ? ' err' : ''}`}>{imgSaved}</div>}
                  <div className="img-chan-foot">
                    <button className="btn btn-sm btn-primary" onClick={() => void saveImgChannel()} disabled={imgSaving || imgLoading || Boolean(imgLoadError) || !imgBase.trim() || (!imgKey.trim() && (!imgKeyMasked || imgBaseChanged))}>
                      {imgSaving ? '保存中…' : '保存生图通道'}
                    </button>
                    <span className="hint">已有 Key 时留空会保留原值；保存后到「生图工坊」直接出图。</span>
                  </div>
                </div>
                <div className="foot-note">与「模型配置 → 生图」的技能通道共享 IMG_* 配置：这里改了，技能生图也用同一通道。</div>
              </section>
            )}

            {/* ── 通知中心：生成/发布完成后邮箱推送（可视化配置 + 测试发送） ── */}
            {sec === 'notify' && (
              <section className="st-sec active">
                <div className="panel-top">
                  <span className={`pill ${ntf.email && ntf.host ? 'ok' : 'off'}`}><span className="dot" />{ntf.email && ntf.host ? '已配置' : '未配置'}</span>
                  <span className="desc">开启后自动发送任务结果；平台发布结果与邮件发送状态会分别显示在发布回执中</span>
                  <span className="spacer" />
                </div>
                {ntfLoading ? (
                  <div className="board img-chan"><SkeletonCard rows={3} title={false} /></div>
                ) : (
                  <div className="board img-chan">
                    <SettingsField label="收件人" horizontal>
                      <input className="mock" value={ntf.email} placeholder="you@qq.com（多个用逗号分隔）"
                        onChange={(e) => setNtf((f) => ({ ...f, email: e.target.value }))} />
                    </SettingsField>
                    <SettingsField label="SMTP 主机" horizontal>
                      <input className="mock" value={ntf.host} placeholder="smtp.qq.com / smtp.163.com / smtp.exmail.qq.com"
                        onChange={(e) => setNtf((f) => ({ ...f, host: e.target.value }))} />
                    </SettingsField>
                    <SettingsField label="端口" horizontal>
                      <input className="mock" style={{ maxWidth: 120 }} value={ntf.port} placeholder="465"
                        onChange={(e) => setNtf((f) => ({ ...f, port: e.target.value }))} />
                      <span className="hint">465=SSL（默认）；587=STARTTLS</span>
                    </SettingsField>
                    <SettingsField label="认证账号" horizontal>
                      <input className="mock" value={ntf.user} placeholder="缺省=首个收件人"
                        onChange={(e) => setNtf((f) => ({ ...f, user: e.target.value }))} />
                    </SettingsField>
                    <SettingsField label="授权码" horizontal>
                      <input className="mock" type="password" value={ntf.pass} placeholder="留空=不修改已保存的密码（QQ/163 用授权码，不是登录密码）"
                        onChange={(e) => setNtf((f) => ({ ...f, pass: e.target.value }))} />
                    </SettingsField>
                    <SettingsField label="自动通知" horizontal>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13 }}>
                        <input type="checkbox" checked={ntf.onDone}
                          onChange={(e) => setNtf((f) => ({ ...f, onDone: e.target.checked }))} />
                        任务完成自动发邮件（关闭则只在 Agent 主动通知时发）
                      </label>
                    </SettingsField>
                    {ntfSaved && <div className={`save-note${ntfSaved.startsWith('保存失败') ? ' err' : ''}`}>{ntfSaved}</div>}
                    <div className="img-chan-foot">
                      <button className="btn btn-sm btn-primary" onClick={() => void saveNotify()}
                        disabled={!ntf.email.trim() || !ntf.host.trim()}>保存通知配置</button>
                      <button className="btn btn-sm" onClick={() => void testNotify()} disabled={ntfTesting || !ntf.email.trim() || !ntf.host.trim()}>
                        <IconSend size={13} /> {ntfTesting ? '发送中…' : '用已保存配置发测试邮件'}
                      </button>
                      {ntfTestMsg && <span className="hint" style={{ color: ntfTestMsg.startsWith('✅') ? 'var(--green, #1a9e5c)' : 'var(--red)' }}>{ntfTestMsg}</span>}
                    </div>
                    <p className="hint">修改配置后请先保存。测试邮件使用已保存的收件人和 SMTP 配置。</p>
                  </div>
                )}
                <div className="foot-note">Agent 也会收到 notify_email 工具：让它「完成后发我邮箱」即可主动推送；配置与本页共享。IM 群机器人推送见技能 skill-publish-notify。</div>
              </section>
            )}

            {sec === 'env' && (
              <section className="st-sec active">
                <EnvBoard
                  tools={tools}
                  python={python}
                  loading={envLoading}
                  error={envError}
                  jobs={jobs}
                  anyRunning={anyRunning}
                  onRefresh={() => void refreshEnv(true)}
                  onInstall={installOne}
                  onInstallMany={installMany}
                />
              </section>
            )}

            {sec === 'more' && <section className="st-sec active"><ConversationBackupCard {...conversationBackup} /><StorageSettingsCard /></section>}
          </div>
        </div>

        <div className="settings-foot">
          {sec === 'general' ? '通用设置保存在当前浏览器，同一地址下的其他标签页会同步更新。' : 'ⓘ 环境安装在后台执行，装完自动回写状态；模型配置保存写入 .env（对话经本地网关路由，主备自动降级）。'}
        </div>
      </div>
    </div>
  );
}
