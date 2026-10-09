import '../styles/settings.css';
import StorageSettingsCard from './settings/StorageSettingsCard';
import ConversationBackupCard from './settings/ConversationBackupCard';
import EmployeeAppearanceSettings from './settings/EmployeeAppearanceSettings';
import DemoDataSettingsCard from './settings/DemoDataSettingsCard';
import type { ComponentProps, ComponentType } from 'react';
import { ProviderBoard } from './settings/ProviderBoard';
import { ModelConfigPicker } from './settings/ModelConfigPicker';
import ModelHealthPanel from './settings/ModelHealthPanel';
import ChannelNameEditor from './settings/ChannelNameEditor';
import ImageReverseSettings from './settings/ImageReverseSettings';
import Select from './ui/Select';
import type { ProviderBoardOptions } from './settings/ProviderBoard';
import { SettingsField } from './settings/SettingsField';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import EnvBoard from './EnvBoard';
import { Sk as Skeleton, SkeletonCard } from './Skeleton';
import {
  fetchEnvTools,
  fetchModelChannels, runChannelSelftest, saveModelConfig,
  fetchModelPresets, discoverModels,
  fetchImportSources, previewImport, applyImport, discoverImportModels, selectImportModel,
  saveImagegenChannel, fetchImagegenGallery, fetchSkillDetail, saveEnv, testNotifyEmail,
} from '../lib/api';
import type {
  EnvTool, ModelRow, SelftestResult, ModelPreset, DiscoverResult,
  ImportSource, ImportPreview, ImportCandidate,
} from '../lib/api';
import { MODEL_IMPORT_SLOT_OPTIONS, modelImportSlotLabel } from '../lib/modelImports';
import { IconGear, IconSlidersHorizontal, IconPackage, IconEllipsis, IconUpload, IconImage, IconBell, IconSend, IconFilm, IconAudioWaveform } from './settingsIcons';
import { IconText, IconMic, IconMusic } from './icons';

export type SettingsSection = 'general' | 'import' | 'model' | 'env' | 'image' | 'video' | 'notify' | 'employees' | 'more' | `channel:${Chan}`;
type Chan = 'chat' | 'transcribe' | 'speech' | 'image' | 'video' | 'music';

const CHANNELS: { id: Chan; label: string; icon: ComponentType<{ size?: number }> }[] = [
  { id: 'chat', label: '对话与脚本', icon: IconText },
  { id: 'transcribe', label: '语音转写', icon: IconMic },
  { id: 'speech', label: '配音', icon: IconAudioWaveform },
  { id: 'image', label: '生图', icon: IconImage },
  { id: 'video', label: '视频', icon: IconFilm },
  { id: 'music', label: '音乐', icon: IconMusic },
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

function modelConfigLabel(row?: ModelRow) {
  if (!row) return '尚未设置';
  const model = !row.model || PLACEHOLDERS.has(row.model) ? '模型未指定' : row.model;
  return row.name.trim().toLowerCase() === model.toLowerCase() ? model : `${row.name || '未命名供应商'} · ${model}`;
}

const hhmm = (ts: number) => new Date(ts * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

/** 设置（独立页面，非弹窗）：配置导入（CC Switch 一键迁移）· 模型配置 · 环境安装 · 生图工坊通道 · 更多。 */
export default function SettingsPanel({ initialSection = 'general', navigationKey = 0, conversationBackup, demoDataPreference, onOpenOffice }: {
  initialSection?: SettingsSection;
  navigationKey?: number;
  conversationBackup: ComponentProps<typeof ConversationBackupCard>;
  demoDataPreference: ComponentProps<typeof DemoDataSettingsCard>;
  onOpenOffice?: () => void;
}) {
  // 'video' is a direct link into the existing model channel, not a second settings page.
  const [sec, setSec] = useState<SettingsSection>(initialSection.startsWith('channel:') || initialSection === 'video' || initialSection === 'import' ? 'model' : initialSection);
  const [chan, setChan] = useState<Chan>(initialSection.startsWith('channel:') ? initialSection.slice(8) as Chan : initialSection === 'video' ? 'video' : 'chat');
  const [importOpen, setImportOpen] = useState(initialSection === 'import');
  useEffect(() => {
    setSec(initialSection.startsWith('channel:') || initialSection === 'video' || initialSection === 'import' ? 'model' : initialSection);
    if (initialSection.startsWith('channel:')) setChan(initialSection.slice(8) as Chan);
    if (initialSection === 'video') setChan('video');
    if (initialSection === 'import') { setChan('chat'); setImportOpen(true); }
  }, [initialSection, navigationKey]);
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

  const okCount = tools.filter((t) => t.state === 'ok').length;
  const total = tools.length;

  // ── 模型配置（真值只读 + 真自测） ────────────────────────
  const [chatRows, setChatRows] = useState<ModelRow[]>([]);
  const [savedChatRows, setSavedChatRows] = useState<ModelRow[]>([]);
  const [providerDetailsOpen, setProviderDetailsOpen] = useState(false);
  const [visionEditorIndex, setVisionEditorIndex] = useState(0);
  const [transRows, setTransRows] = useState<ModelRow[]>([]);
  const [mediaRows, setMediaRows] = useState<Record<string, ModelRow[]>>({});
  const [modelLoading, setModelLoading] = useState(true);
  const [modelErr, setModelErr] = useState('');
  const [selftest, setSelftest] = useState<{ testedAt: number; byBase: Record<string, SelftestResult> } | null>(null);
  const [testing, setTesting] = useState(false);
  const [selftestNote, setSelftestNote] = useState('');

  // ── 服务商预设与「获取模型」（方案功能 C 第一步） ──────────
  const [saving, setSaving] = useState(false);
  const modelSavePending = useRef(false);
  const [savedNote, setSavedNote] = useState('');
  const [presets, setPresets] = useState<Record<string, ModelPreset[]>>({});
  const [discover, setDiscover] = useState<Record<string, DiscoverResult | 'loading'>>({});
  const discoveryRequests = useRef(new Map<string, symbol>());

  const clearModelDiscovery = useCallback((channel: string, index?: number) => {
    const matches = (key: string) => index === undefined ? key.startsWith(`${channel}:`) : key === `${channel}:${index}`;
    for (const key of discoveryRequests.current.keys()) if (matches(key)) discoveryRequests.current.delete(key);
    setDiscover(current => Object.fromEntries(Object.entries(current).filter(([key]) => !matches(key))));
  }, []);

  useEffect(() => {
    let alive = true;
    fetchModelPresets()
      .then((d) => { if (alive) setPresets(d.presets || {}); })
      .catch(() => { /* 预设拿不到就只剩手动填写，不打断设置页 */ });
    return () => { alive = false; };
  }, []);

  const runDiscover = useCallback(async (ch: string, i: number, row: ModelRow) => {
    const key = `${ch}:${i}`;
    const request = Symbol(key);
    discoveryRequests.current.set(key, request);
    const current = () => mounted.current && discoveryRequests.current.get(key) === request;
    setDiscover((m) => ({ ...m, [key]: 'loading' }));
    try {
      const r = await discoverModels({
        channel: ch,
        slot: row.slot || '',
        baseUrl: row.baseUrl || '',
        apiKey: row.keyNew || '',
        protocol: row.protocol || '',
      });
      if (!current()) return;
      setDiscover((m) => ({ ...m, [key]: r }));
    } catch (e) {
      if (!current()) return;
      setDiscover((m) => ({
        ...m,
        [key]: {
          ok: false, kind: 'client_error', models: [], channel: ch, slot: row.slot || '',
          source: row.baseUrl || '', fetchedAt: Math.floor(Date.now() / 1000), keySource: 'none',
          message: e instanceof Error ? e.message : '获取失败',
        },
      }));
    } finally {
      if (current()) discoveryRequests.current.delete(key);
    }
  }, []);

  // ── 从本机配置导入（方案功能 C 第二步；独立页里为一级分区） ──
  const [impSources, setImpSources] = useState<ImportSource[]>([]);
  const [impSource, setImpSource] = useState('');
  const [impPath, setImpPath] = useState('');
  const [impSlot, setImpSlot] = useState('auto');
  const [impPreview, setImpPreview] = useState<ImportPreview | null>(null);
  const [impPick, setImpPick] = useState('');
  const [impBusy, setImpBusy] = useState<'' | 'preview' | 'apply' | 'discover' | 'model'>('');
  const [impDiscovery, setImpDiscovery] = useState<Record<string, DiscoverResult | 'loading'>>({});
  const [impMsg, setImpMsg] = useState('');
  const [impConfirmed, setImpConfirmed] = useState(false);
  const [impAdvancedOpen, setImpAdvancedOpen] = useState(false);
  const [impSourcesLoading, setImpSourcesLoading] = useState(false);
  const impSourceRequest = useRef(0);
  const impPreviewRequest = useRef(0);
  const impApplying = useRef(false);

  const clearImportPreview = useCallback(() => {
    impPreviewRequest.current += 1;
    setImpPreview(null);
    setImpPick('');
    setImpConfirmed(false);
    setImpMsg('');
    setImpDiscovery({});
    setImpBusy((busy) => busy === 'apply' ? busy : '');
  }, []);

  const openImport = useCallback(async () => {
    const requestId = ++impSourceRequest.current;
    setImpSourcesLoading(true);
    setImpMsg('');
    try {
      const d = await fetchImportSources();
      if (!mounted.current || requestId !== impSourceRequest.current) return;
      setImpSources(d.sources);
      const first = d.sources.find((s) => s.id === 'cc-switch' && s.available)
        || d.sources.find((s) => s.available) || d.sources[0];
      setImpSource((current) => d.sources.some((s) => s.id === current) ? current : first?.id || '');
    } catch (e) {
      if (mounted.current && requestId === impSourceRequest.current) setImpMsg(e instanceof Error ? e.message : '读取来源失败');
    } finally {
      if (mounted.current && requestId === impSourceRequest.current) setImpSourcesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (importOpen) void openImport();
  }, [importOpen, openImport]);

  const loadImportPreview = useCallback(async (source = impSource, path = impPath.trim()) => {
    if (!source) { setImpMsg('先选择一个来源'); return; }
    const requestId = ++impPreviewRequest.current;
    setImpBusy('preview');
    setImpMsg('');
    setImpPreview(null);
    setImpPick('');
    setImpConfirmed(false);
    setImpDiscovery({});
    try {
      const d = await previewImport(source, impSlot, path);
      if (!mounted.current || requestId !== impPreviewRequest.current) return;
      setImpPreview(d);
      if (!d.candidates.length) setImpMsg('这个来源里没有读到可导入的配置');
    } catch (e) {
      if (mounted.current && requestId === impPreviewRequest.current) setImpMsg(e instanceof Error ? e.message : '预览失败');
    } finally {
      if (mounted.current && requestId === impPreviewRequest.current) setImpBusy('');
    }
  }, [impSource, impSlot, impPath]);

  const discoverImportCandidate = useCallback(async (candidate: ImportCandidate) => {
    if (!candidate.previewToken || !impPreview || impBusy || saving) return;
    const requestId = ++impPreviewRequest.current;
    setImpBusy('discover');
    setImpMsg('');
    setImpDiscovery((current) => ({ ...current, [candidate.id]: 'loading' }));
    try {
      const result = await discoverImportModels({ source: impSource, path: impPreview.path, id: candidate.id,
        slot: candidate.targetSlot, previewToken: candidate.previewToken });
      if (!mounted.current || requestId !== impPreviewRequest.current) return;
      setImpDiscovery((current) => ({ ...current, [candidate.id]: result }));
    } catch (error) {
      if (!mounted.current || requestId !== impPreviewRequest.current) return;
      setImpDiscovery((current) => ({ ...current, [candidate.id]: {
        ok: false, models: [], kind: 'client_error', channel: 'chat', slot: candidate.targetSlot,
        source: candidate.baseUrl, fetchedAt: Math.floor(Date.now() / 1000), keySource: 'source',
        message: error instanceof Error ? error.message : '读取失败，请重新预览后重试',
      } }));
    } finally {
      if (mounted.current && requestId === impPreviewRequest.current) setImpBusy('');
    }
  }, [impPreview, impBusy, impSource, saving]);

  const pickImportModel = useCallback(async (candidate: ImportCandidate, model: string) => {
    if (!candidate.previewToken || !impPreview || impBusy || saving || !model) return;
    const requestId = ++impPreviewRequest.current;
    setImpBusy('model');
    setImpConfirmed(false);
    setImpMsg('');
    try {
      const updated = await selectImportModel({ source: impSource, path: impPreview.path, id: candidate.id,
        slot: candidate.targetSlot, previewToken: candidate.previewToken, model });
      if (!mounted.current || requestId !== impPreviewRequest.current) return;
      setImpPreview((current) => current ? { ...current, candidates: current.candidates.map((item) => item.id === candidate.id ? updated : item) } : current);
      setImpPick(candidate.id);
      setImpMsg(`已预览模型 ${updated.model}，请核对下方替换内容并重新确认。尚未保存。`);
    } catch (error) {
      if (mounted.current && requestId === impPreviewRequest.current) setImpMsg(error instanceof Error ? error.message : '更新预览失败，请重试');
    } finally {
      if (mounted.current && requestId === impPreviewRequest.current) setImpBusy('');
    }
  }, [impPreview, impBusy, impSource, saving]);

  const applyImportPick = useCallback(async () => {
    const selected = impPreview?.candidates.find((c) => c.id === impPick && c.compatible);
    if (!selected?.previewToken || !impConfirmed || impBusy || impApplying.current || modelSavePending.current) return;
    impApplying.current = true;
    setImpBusy('apply');
    setImpMsg('');
    try {
      const targetSlot = selected.targetSlot || impSlot;
      const r = await applyImport(impSource, impPick, targetSlot, impPreview?.path || impPath.trim(), selected.previewToken);
      if (!mounted.current) return;
      clearModelDiscovery('chat');
      const previousDefault = savedChatRows.find((row) => row.role === '主');
      const actualDefault = r.channels.chat.rows.find((row) => row.role === '主');
      const identity = (row?: ModelRow) => row ? `${row.slot}:${row.name}:${row.model}:${row.baseUrl}` : '';
      setSavedChatRows(r.channels.chat.rows);
      setImpMsg(`已导入并保存「${r.applied.name}」→ ${modelImportSlotLabel(targetSlot)}。${identity(previousDefault) === identity(actualDefault)
        ? `默认模型未改变：${modelConfigLabel(actualDefault)}` : `已保存默认现为：${modelConfigLabel(actualDefault)}`}。尚未进行真实调用测活。${r.note ? ` ${r.note}` : ''}`);
      setImpPreview(null);
      setImpPick('');
      setImpConfirmed(false);
      const imported = r.channels.chat.rows.find((row) => row.slot === targetSlot);
      if (imported) setChatRows((rows) => rows.some((row) => row.slot === targetSlot)
        ? rows.map((row) => row.slot === targetSlot ? { ...imported, role: row.role } : row) : [...rows, imported]);
    } catch (e) {
      if (mounted.current) {
        setImpMsg(e instanceof Error ? `导入失败：${e.message}` : '导入失败');
        setImpConfirmed(false);
      }
    } finally {
      impApplying.current = false;
      if (mounted.current) setImpBusy('');
    }
  }, [impSource, impPick, impSlot, impPath, impPreview, impConfirmed, impBusy, savedChatRows, clearModelDiscovery]);

  useEffect(() => {
    let alive = true;
    fetchWithRetry(() => fetchModelChannels(), 5, 15000)
      .then((d) => {
        if (!alive) return;
        setChatRows(d.channels.chat.rows || []);
        setSavedChatRows(d.channels.chat.rows || []);
        setProviderDetailsOpen(!(d.channels.chat.rows || []).some((row) => row.keyMasked && row.keyMasked !== '—'));
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
  const [deletedProviders, setDeletedProviders] = useState<string[]>([]);

  const saveCurrent = useCallback(async (channel: Chan = chan) => {
    if (modelSavePending.current || impApplying.current || modelLoading) return;
    const rows = channel === 'chat' ? chatRows : channel === 'transcribe' ? transRows : (mediaRows[channel] || []);
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
        protocol: channel === 'chat' ? r.protocol || r.type : undefined,
      }));
    if (!payload.length) {
      setSavedNote('当前通道没有可保存的配置');
      return;
    }
    modelSavePending.current = true;
    setSaving(true);
    setSavedNote('');
    try {
      const d = await saveModelConfig(channel, payload, channel === 'chat' ? deletedProviders : []);
      if (!mounted.current) return;
      clearModelDiscovery(channel);
      if (channel === 'chat') {
        setChatRows(d.channels.chat.rows || []);
        setSavedChatRows(d.channels.chat.rows || []);
        setDeletedProviders([]);
      }
      else if (channel === 'transcribe') setTransRows(d.channels.transcribe.rows || []);
      else setMediaRows((rows) => ({ ...rows, [channel]: d.channels[channel]?.rows || [] }));
      clearImportPreview();
      setSavedNote(channel === 'chat'
        ? `✓ 已保存默认：${modelConfigLabel(d.channels.chat.rows.find((row) => row.role === '主'))}。请回到对话选择“沿用会话模型”；实际调用以执行回执为准。${d.note ? ` ${d.note}` : ''}`
        : d.note ? `✓ 已保存（${d.note}）` : '✓ 已保存');
      void refreshEnv();
    } catch (e) {
      if (mounted.current) setSavedNote(e instanceof Error ? `保存失败：${e.message}` : '保存失败');
    } finally {
      modelSavePending.current = false;
      if (mounted.current) {
        setSaving(false);
      }
    }
  }, [chan, chatRows, transRows, mediaRows, refreshEnv, clearImportPreview, deletedProviders, modelLoading, clearModelDiscovery]);

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
    setProviderDetailsOpen(true);
    setSavedNote('');
    setChatRows((rs) => [...rs, {
      slot: 'custom', order: 0, name: '', sub: '自定义', type: 'openai',
      model: '', baseUrl: '', keyMasked: '', role: '备', result: '待保存',
    }]);
  };

  const setPrimaryRow = (i: number) => {
    setChatRows((rs) => rs.map((r, j) => (r.slot ? { ...r, role: j === i ? '主' : '备' } : r)));
    setSavedNote('');
  };

  const removeRow = (i: number) => {
    // Removing a row changes the indexes of every later provider card.
    clearModelDiscovery('chat');
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
    channel: Chan,
    setRows: Dispatch<SetStateAction<ModelRow[]>>,
    i: number,
    patch: Partial<ModelRow>,
  ) => {
    if (['slot', 'name', 'baseUrl', 'protocol', 'type', 'keyNew', 'keyNew2'].some(key => key in patch)) clearModelDiscovery(channel, i);
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };

  const updateMediaRow = (ch: string, i: number, patch: Partial<ModelRow>) => {
    if (['slot', 'name', 'baseUrl', 'protocol', 'type', 'keyNew', 'keyNew2'].some(key => key in patch)) clearModelDiscovery(ch, i);
    setMediaRows((m) => ({ ...m, [ch]: (m[ch] || []).map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  };

  const setMediaPrimary = (ch: string, i: number) =>
    setMediaRows((m) => ({ ...m, [ch]: (m[ch] || []).map((r, j) => ({ ...r, role: j === i ? '主' : '备' })) }));

  const mediaOk = (ch: string) => (mediaRows[ch] || []).some((r) => r.result === '已配置');

  const renderBoard = (rows: ModelRow[], ops?: ProviderBoardOptions) => (
    <fieldset className="model-provider-editors" disabled={modelLoading || saving || Boolean(impBusy)}>
      <ProviderBoard rows={rows} ops={ops ? { ...ops, saving, onSave: () => void saveCurrent((ops.channel || chan) as Chan) } : undefined} modelLoading={modelLoading} resultText={resultText} />
    </fieldset>
  );

  const chatOk = savedChatRows.some((r) => r.result.includes('已配置') || r.result.includes('✓'));
  const transOk = transRows.length > 1 && transRows[1].result.includes('已配置');
  const chatDirty = JSON.stringify(chatRows) !== JSON.stringify(savedChatRows) || deletedProviders.length > 0;

  const visionIndex = Math.min(visionEditorIndex, Math.max(0, chatRows.length - 1));
  const reverseSettings = <ImageReverseSettings revision={JSON.stringify(savedChatRows)} dirty={chatDirty} editor={<>
    <fieldset className="reverse-provider-editor" disabled={saving || modelLoading || Boolean(impBusy)}>
      <div className="reverse-provider-toolbar">
        <Select aria-label="编辑视觉供应商" value={chatRows.length ? String(visionIndex) : ''} options={chatRows.map((row, index) => ({ value: String(index), label: row.name || '新供应商' }))} placeholder="选择供应商" onChange={value => setVisionEditorIndex(Number(value))} />
        <button type="button" className="btn btn-sm" disabled={modelLoading || saving} onClick={() => { setVisionEditorIndex(chatRows.length); addProvider(); }}>＋ 添加供应商</button>
      </div>
      {chatRows[visionIndex] && <div key={visionIndex}>{renderBoard([chatRows[visionIndex]], {
        channel: 'chat', onRow: (_, patch) => updateRow('chat', setChatRows, visionIndex, patch),
        onRemove: () => { removeRow(visionIndex); setVisionEditorIndex(0); }, presets: presets.chat,
        discovery: () => discover[`chat:${visionIndex}`], onDiscover: () => void runDiscover('chat', visionIndex, chatRows[visionIndex]),
        onPickPreset: (_, preset) => updateRow('chat', setChatRows, visionIndex, { baseUrl: preset.baseUrl, protocol: preset.protocol, name: preset.id, type: preset.protocol }),
      })}</div>}
      <button type="button" className="btn btn-sm btn-primary" disabled={saving || modelLoading || !chatDirty} onClick={() => void saveCurrent('chat')}>{saving ? '保存中…' : '保存供应商修改'}</button>
      {savedNote && <p role="status">{savedNote}</p>}
    </fieldset>
  </>} />;

  return (
    <div className="page-scroll settings-page">
      <div className="settings-panel page">
        <div className="settings-head">
          <div>
            <h2 className="settings-title">设置</h2>
            <div className="settings-sub">通用设置 · 模型配置 · 环境安装 · 生图通道 · 更多</div>
          </div>
          <div className="settings-actions">
            {sec === 'model' && chan !== 'chat' && (
              <>
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => void saveCurrent()}
                  disabled={saving || Boolean(impBusy)}
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
          {sec === 'employees' && <EmployeeAppearanceSettings
            defaultModelLabel={modelConfigLabel(savedChatRows.find((row) => row.role === '主'))}
            onOpenModels={() => { setSec('model'); setChan('chat'); }} onOpenOffice={onOpenOffice} />}
            {sec === 'model' && (
              <section className="st-sec active">
                  <div className="tabbar" role="tablist" aria-label="模型能力通道">
                  {CHANNELS.map((c) => (
                    <button key={c.id} role="tab" aria-selected={chan === c.id} className={`tab${chan === c.id ? ' active' : ''}`} onClick={() => setChan(c.id)}>
                      <span className="channel-icon" aria-hidden="true"><c.icon size={15} /></span>{c.label}
                    </button>
                  ))}
                </div>
                {savedNote && chan !== 'chat' ? <div role="status" aria-live="polite" className={`save-note${savedNote.startsWith('保存失败') || savedNote.startsWith('没有') ? ' err' : ''}`}>{savedNote}</div> : null}

                {chan === 'chat' && (
                  <section className="st-panel active">
                    <ModelConfigPicker rows={chatRows} disabled={modelLoading || saving || Boolean(impBusy)}
                      savedPrimary={savedChatRows.find((row) => row.role === '主')} saving={saving} dirty={chatDirty}
                      saveNote={savedNote} labelFor={modelConfigLabel} onPrimary={setPrimaryRow} onSave={() => void saveCurrent()}
                      onOpenImport={() => setImportOpen(true)} />
                    <details className="model-settings-details model-inline-import" open={importOpen}
                      onToggle={(event) => setImportOpen(event.currentTarget.open)}>
                      <summary><IconUpload size={14} /> 从 CC Switch / OpenClaw 导入模型</summary>
            <section className="st-sec active">
              <ol className="model-import-steps" aria-label="配置导入步骤">
                <li aria-current={!impPreview ? 'step' : undefined}><strong>1</strong> 选择来源</li>
                <li aria-current={impPreview && !impPick ? 'step' : undefined}><strong>2</strong> 预览模型与覆盖</li>
                <li aria-current={impPick ? 'step' : undefined}><strong>3</strong> 确认写入</li>
              </ol>
              <div className="panel-top">
                <span className="desc">
                  读取本机 CC Switch / OpenClaw 里已配好的模型（密钥脱敏展示），选中一条一键写入 Easel 对话通道。
                </span>
                <button type="button" className="adv-btn" disabled={impSourcesLoading || Boolean(impBusy)} onClick={() => void openImport()}>
                  {impSourcesLoading ? '检测来源…' : '刷新来源'}
                </button>
              </div>
              {impMsg && <div role="status" className="import-msg">{impMsg}</div>}
              {chatDirty && <p className="model-default-pending hint">模型配置有未保存草稿。返回不会丢失；确认导入仅替换目标通道的草稿，其他通道编辑继续保留。</p>}
              <div className="imp-cards">
                {impSourcesLoading && impSources.length === 0 && (
                  <div className="board"><div className="empty"><Skeleton w="70%" h={14} style={{ marginBottom: 10 }} /><Skeleton w="45%" h={12} /></div></div>
                )}
                {impSources.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={impSource === s.id}
                    className={`imp-card${impSource === s.id ? ' on' : ''}${s.available ? '' : ' off'}`}
                    onClick={() => {
                      setImpSource(s.id); setImpPath(''); clearImportPreview(); setImpAdvancedOpen(!s.available);
                      if (s.available) void loadImportPreview(s.id, '');
                      else setImpMsg(`尚未检测到 ${s.label}。请在下方“指定路径或写入通道”填写配置文件路径，再点击预览。`);
                    }}
                    disabled={impBusy === 'apply' || saving}
                  >
                    <span className="imp-name">{s.label}</span>
                    <span className="imp-detail">{s.available ? (s.detail || '本机已检测到') : `不可用：${s.detail}`}</span>
                    <span className={`pill ${s.available ? 'ok' : 'off'}`}><span className="dot" />{s.available ? '已检测到' : '未检测到'}</span>
                    <span className="imp-action">{impSource === s.id && impBusy === 'preview' ? '正在读取模型…'
                      : impSource === s.id && impPreview ? `已读取 ${impPreview.candidates.length} 个模型`
                        : s.available ? '点击读取模型' : '点击指定配置路径'}</span>
                  </button>
                ))}
              </div>
              {impSources.length > 0 && (
                <>
                  <div className="import-row">
                    <details className="model-settings-details import-advanced" open={impAdvancedOpen}
                      onToggle={(event) => setImpAdvancedOpen(event.currentTarget.open)}>
                      <summary>可选：指定路径或写入通道</summary>
                    <Select
                      aria-label="导入目标通道"
                      value={impSlot}
                      disabled={Boolean(impBusy)}
                      onChange={(value) => { setImpSlot(value); clearImportPreview(); }}
                      options={MODEL_IMPORT_SLOT_OPTIONS}
                    />
                    <input
                      className="mock"
                      value={impPath}
                      aria-label="自定义配置路径"
                      placeholder="配置文件或 CC Switch 目录（可留空）"
                      disabled={Boolean(impBusy)}
                      onChange={(e) => { setImpPath(e.target.value); clearImportPreview(); }}
                    />
                    </details>
                    <button className="btn btn-sm btn-primary" onClick={() => void loadImportPreview()} disabled={Boolean(impBusy) || saving}>
                      {impBusy === 'preview' ? '读取中…' : '2. 预览可导入模型'}
                    </button>
                  </div>
                  {impBusy === 'preview' && <SkeletonCard rows={3} />}
                  {impPreview && impPreview.candidates.length > 0 && !impPreview.candidates.some((candidate) => candidate.compatible) && (
                    <p className="hint">没有匹配当前通道的配置。可选择自动匹配协议；Responses 配置当前不支持直接导入，具体原因见各条目。</p>
                  )}
                  {impPreview && impPreview.candidates.length > 0 && (
                    <>
                      <div className="import-list">
                        {impPreview.candidates.map((c) => {
                          const fetched = impDiscovery[c.id];
                          const discoveryReason = !c.compatible ? c.skipReason : !c.baseUrl ? '此来源缺少服务地址，不能仅凭 Key 确定渠道。'
                            : !c.keyPresent ? '此来源未提供 API Key，请先在来源工具补齐，再重新读取。' : '';
                          return <article
                            key={c.id}
                            className={`import-item${c.compatible ? '' : ' off'}${impPick === c.id ? ' on' : ''}`}
                          >
                            <label className="import-choice">
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
                                {c.compatible && `写入 ${modelImportSlotLabel(c.targetSlot || impSlot)} · `}
                                {c.model ? `模型 ${c.model} · ` : ''}密钥 {c.keyMasked || '无'}
                                {!c.compatible && ` · ${c.skipReason}`}
                                {c.note && ` · ${c.note}`}
                              </span>
                              {c.compatible && c.overwrites.length > 0 && (
                                <span className="ii-ov">
                                  将替换：{c.overwrites.map((o) => `${o.field.endsWith('_API_KEY') ? 'API 密钥' : o.field.endsWith('_BASE_URL') ? '服务地址' : o.field.endsWith('_MODEL') ? '模型名称' : '现有配置'}（${o.current} → ${o.incoming}）`).join('；')}
                                </span>
                              )}
                            </span>
                            </label>
                            <div className="import-candidate-actions">
                              <button type="button" className="adv-btn" disabled={Boolean(discoveryReason) || !c.previewToken || Boolean(impBusy) || saving}
                                title="服务端使用此来源的地址、协议和 Key 仅读取模型列表，密钥不发送到前端"
                                onClick={() => void discoverImportCandidate(c)}>
                                {fetched === 'loading' ? '正在获取…' : '获取该渠道模型'}
                              </button>
                              <span className="hint">{discoveryReason || '使用该来源的地址、协议和 Key，只枚举模型，不发起推理。'}</span>
                            </div>
                            {fetched && <div className={`discover-row${fetched !== 'loading' ? fetched.ok ? ' ok' : ' bad' : ''}`} role="status">
                              {fetched === 'loading' ? <><span className="spin" /> 正在读取此来源的模型列表…</> : <>
                                <span>{fetched.message}</span>
                                {fetched.ok && fetched.models.length > 0 ? <span className="dr-pick">
                                  <Select aria-label={`${c.name}渠道可用模型`} value={fetched.models.includes(c.model) ? c.model : ''}
                                    disabled={Boolean(impBusy) || saving} placeholder={`选择获取的模型（${fetched.models.length} 个）`}
                                    options={fetched.models.map((model) => ({ value: model, label: model }))}
                                    onChange={(model) => void pickImportModel(c, model)} />
                                  <span className="dr-src">选择后更新模型与替换预览；确认导入后才保存。</span>
                                </span> : <span className="dr-src">核对来源的地址、协议和 Key 后重新读取；渠道不支持枚举时，仍可导入来源中已填的模型名。</span>}
                              </>}
                            </div>}
                          </article>;
                        })}
                      </div>
                      <label className="import-msg">
                        <input type="checkbox" checked={impConfirmed}
                          disabled={!impPick || Boolean(impBusy)}
                          onChange={(e) => setImpConfirmed(e.target.checked)} />
                        我已核对替换内容，确认保存到所选通道（替换此通道尚未保存的编辑）
                      </label>
                      <div className="import-foot">
                        <button
                          className="btn btn-sm btn-primary"
                          onClick={() => void applyImportPick()}
                          disabled={!impPick || !impConfirmed || Boolean(impBusy) || saving}
                        >
                          {impBusy === 'apply' ? '导入中…' : '3. 确认导入并保存'}
                        </button>
                        <span className="hint">{impPreview.note}</span>
                      </div>
                    </>
                  )}
                  {impPreview && impPreview.errors.length > 0 && (
                    <div className="import-msg">部分条目已跳过：{impPreview.errors.join('；')}</div>
                  )}
                  <div className="foot-note">预览不会写入或调用模型；确认后才保存。导入不等于连接验证，默认模型是否改变以保存回执为准。</div>
                </>
              )}
              <div className="import-foot"><button type="button" className="btn btn-sm" disabled={Boolean(impBusy)}
                onClick={() => setImportOpen(false)}>收起导入</button></div>
            </section>
                    </details>
                    <button type="button" className="adv-btn model-add-provider" disabled={modelLoading || saving || Boolean(impBusy)} onClick={addProvider}>＋ 添加供应商</button>
                    <details className="model-settings-details" open={providerDetailsOpen}
                      onToggle={(event) => setProviderDetailsOpen(event.currentTarget.open)}>
                      <summary>编辑供应商、协议、地址与密钥</summary>
                    <fieldset className="model-provider-editors" disabled={saving || Boolean(impBusy)}>
                    <div className="panel-top">
                      <span className={`pill ${chatOk ? 'ok' : 'off'}`}><span className="dot" />{chatOk ? '已有保存配置' : '未配置'}</span>
                      <span className="desc">密钥留空会保留原值；编辑后需保存。</span>
                      <span className="spacer" />
                    </div>
                    {renderBoard(chatRows, {
                      onRow: (i, p) => updateRow('chat', setChatRows, i, p),
                      onPrimary: setPrimaryRow,
                      onRemove: removeRow,
                      channel: 'chat',
                      health: (i, open) => {
                        const row = chatRows[i];
                        const ref = row.slot === 'custom' ? `${row.name}/${row.model}` : `${row.slot}/${row.model}`;
                        return row.model && row.slot ? <><ChannelNameEditor key={row.slot === 'custom' ? row.name : row.slot} provider={row.slot === 'custom' ? row.name : row.slot}/><details className="provider-health" open={open}><summary>模型可用性</summary><ModelHealthPanel key={ref} targetModelRef={ref} dirty={JSON.stringify(row) !== JSON.stringify(savedChatRows[i])} /></details></> : null;
                      },
                      presets: presets.chat,
                      discovery: (i) => discover[`chat:${i}`],
                      onDiscover: (i) => void runDiscover('chat', i, chatRows[i]),
                      onPickPreset: (i, p) => updateRow('chat', setChatRows, i, {
                        baseUrl: p.baseUrl, protocol: p.protocol,
                        name: p.id, sub: p.note || '预设', type: p.protocol,
                      }),
                    })}
                    <div className="foot-note">“获取模型列表”需要地址与 API Key，仅读取列表，不运行模型。选择结果会填入“模型名称”；列表为空或读取失败时可按服务商文档手动填写。编辑完成后点击上方“保存并使用”。</div>
                    </fieldset>
                    </details>
                    <details className="model-settings-details">
                      <summary>批量检查已保存通道的模型列表</summary>
                      <p className="hint">状态读取不调用模型；文字 / 图片验证会发起真实请求，供应商可能计费。自动检查默认关闭。</p>
                      <button type="button" className="btn btn-sm" onClick={() => void doSelftest('chat')} disabled={testing || saving}>
                        {testing ? '检查中…' : '检查已保存通道的模型列表'}</button>
                      {selftest && <p className="hint">上次模型列表检查 {hhmm(selftest.testedAt)}；接口可达不代表对话已完成。</p>}
                    </details>
                  </section>
                )}

                {chan === 'transcribe' && (
                  <section className="st-panel active">
                    <div className="panel-top">
                      <span className={`pill ${transOk ? 'ok' : 'warn'}`}><span className="dot" />{transOk ? '云端已配置 · 未验证' : (localReady ? '本地组件已就绪' : '需配置或安装')}</span>
                      <span className="desc">优先读取自带字幕，其次云端转写，最后本地兜底</span>
                      <span className="spacer" />
                    </div>
                    {renderBoard([...transRows, localRow], {
                      onRow: (i, p) => updateRow('transcribe', setTransRows, i, p),
                      channel: 'transcribe',
                      onOpenEnvironment: () => setSec('env'),
                      presets: presets.transcribe,
                      discovery: (i) => discover[`transcribe:${i}`],
                      onDiscover: (i) => void runDiscover('transcribe', i, transRows[i]),
                      onPickPreset: (i, p) => updateRow('transcribe', setTransRows, i, {
                        baseUrl: p.baseUrl, protocol: p.protocol, sub: p.note || '预设',
                      }),
                    })}
                    <div className="foot-note">自带字幕无需配置；云端转写需要 API Key，本地兜底组件可在「环境安装」安装。修改后请点击保存。</div>
                  </section>
                )}

                {chan === 'speech' && (
                  <section className="st-panel active">
                    <div className="panel-top">
                      <span className={`pill ${mediaOk('speech') ? 'ok' : 'off'}`}><span className="dot" />{mediaOk('speech') ? '有可用提供商' : '未配置'}</span>
                      <span className="desc">展开提供商可编辑配置；预置项会说明原因</span>
                      <span className="spacer" />
                    </div>
                    {renderBoard(mediaRows.speech || [], { onRow: (i, p) => updateMediaRow('speech', i, p), onPrimary: (i) => setMediaPrimary('speech', i), media: true, channel: 'speech' })}
                    <div className="foot-note">配音脚本按「主」provider 合成；本地 VoxCPM / edge-tts 在视频产线里可直接替代。</div>
                  </section>
                )}

                {chan === 'image' && (
                  <section className="st-panel active">
                    <div className="panel-top">
                      <span className={`pill ${mediaOk('image') ? 'ok' : 'off'}`}><span className="dot" />{mediaOk('image') ? '已配置' : '未配置'}</span>
                      <span className="desc">展开后直接编辑模型、地址和 Key；保存后生效</span>
                      <span className="spacer" />
                    </div>
                    {renderBoard(mediaRows.image || [], {
                      onRow: (i, p) => updateMediaRow('image', i, p),
                      media: true,
                      channel: 'image',
                      presets: presets.image,
                      discovery: (i) => discover[`image:${i}`],
                      onDiscover: (i) => void runDiscover('image', i, (mediaRows.image || [])[i]),
                      onPickPreset: (i, p) => updateMediaRow('image', i, {
                        baseUrl: p.baseUrl, protocol: p.protocol, adv: true,
                      }),
                    })}
                    <div className="foot-note">按 Base URL 自动选同步 / 异步（apimart）模式；模型名留空用服务端默认。预设只提供公开端点，能否枚举模型取决于服务商。</div>
                    {reverseSettings}
                  </section>
                )}

                {chan === 'video' && (
                  <section className="st-panel active">
                    <div className="panel-top">
                      <span className={`pill ${mediaOk('video') ? 'ok' : 'off'}`}><span className="dot" />{mediaOk('video') ? '有可用提供商' : '未配置'}</span>
                      <span className="desc">展开后直接编辑可配置字段；设置默认提供商后请保存</span>
                      <span className="spacer" />
                    </div>
                    {renderBoard(mediaRows.video || [], { onRow: (i, p) => updateMediaRow('video', i, p), onPrimary: (i) => setMediaPrimary('video', i), media: true, channel: 'video' })}
                    <div className="foot-note">脚本按「主」provider 出片；同类多家的自动降级随统一网关接入开放。</div>
                  </section>
                )}

                {chan === 'music' && (
                  <section className="st-panel active">
                    <div className="panel-top">
                      <span className={`pill ${mediaOk('music') ? 'ok' : 'off'}`}><span className="dot" />{mediaOk('music') ? '有可用提供商' : '未配置'}</span>
                      <span className="desc">展开查看可配置字段；设置默认提供商后请保存</span>
                      <span className="spacer" />
                    </div>
                    {renderBoard(mediaRows.music || [], { onRow: (i, p) => updateMediaRow('music', i, p), onPrimary: (i) => setMediaPrimary('music', i), media: true, channel: 'music' })}
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
                {reverseSettings}
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
                  onRefresh={() => void refreshEnv(true)}
                />
              </section>
            )}

            {sec === 'more' && <section className="st-sec active settings-more-cards"><ConversationBackupCard {...conversationBackup} /><StorageSettingsCard /></section>}
          </div>
        </div>

        <div className="settings-foot">
          {sec === 'general' ? '通用设置保存在当前浏览器，同一地址下的其他标签页会同步更新。' : sec === 'model' ? `修改后请点击「${chan === 'chat' ? '保存并使用' : '保存配置'}」。获取模型列表或选择候选不会自动保存。` : '修改后请使用对应的保存按钮；页面会显示保存结果。'}
        </div>
      </div>
    </div>
  );
}
