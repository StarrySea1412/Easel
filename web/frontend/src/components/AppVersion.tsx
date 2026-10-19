import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import '../styles/app-version.css';

declare const __EASEL_UI_VERSION__: string;
declare const __EASEL_UI_BUILT_AT__: string;

interface VersionInfo {
  version: string;
  revision: string | null;
  build: string;
  development: boolean;
}

function decodeVersion(value: unknown): VersionInfo {
  if (!value || typeof value !== 'object') throw new Error('Invalid version response');
  const info = value as Record<string, unknown>;
  if (typeof info.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(info.version) || info.version.length > 40
    || (info.revision !== null && (typeof info.revision !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(info.revision)))
    || typeof info.build !== 'string' || !/^(?:[0-9a-f]{12}|development)$/i.test(info.build)
    || typeof info.development !== 'boolean') throw new Error('Invalid version response');
  return info as unknown as VersionInfo;
}

export default function AppVersion() {
  const uiVersion = typeof __EASEL_UI_VERSION__ === 'string' ? __EASEL_UI_VERSION__ : null;
  const uiBuiltAt = typeof __EASEL_UI_BUILT_AT__ === 'string' ? __EASEL_UI_BUILT_AT__ : null;
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 60, width: 220 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = (restore = false) => {
    setOpen(false);
    if (restore) trigger.current?.focus({ preventScroll: true });
  };

  useEffect(() => {
    let active = true;
    let sequence = 0;
    let controller: AbortController | undefined;
    const refresh = async () => {
      const request = ++sequence;
      controller?.abort();
      controller = new AbortController();
      const requestController = controller;
      const timeout = window.setTimeout(() => requestController.abort(), 10000);
      try {
        const base = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
        const response = await fetch(`${base}/api/version`, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Version unavailable');
        const next = decodeVersion(await response.json());
        if (active && request === sequence) setInfo(next);
      } catch {
        if (active && request === sequence) setInfo(null);
      } finally {
        window.clearTimeout(timeout);
        if (active && request === sequence) setLoading(false);
      }
    };
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    void refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => {
      active = false;
      controller?.abort();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(220, window.innerWidth - 24);
      const height = panel.current?.getBoundingClientRect().height || 132;
      setPosition({
        left: Math.max(12, Math.min(rect.right + 10, window.innerWidth - width - 12)),
        top: Math.max(12, Math.min(rect.bottom - height, window.innerHeight - height - 12)),
        width,
      });
    };
    place();
    panel.current?.focus({ preventScroll: true });
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  const label = info ? `v${info.version}` : loading ? '版本…' : '版本未知';
  const mismatched = Boolean(uiVersion && info && uiVersion !== info.version);
  return <>
    <button ref={trigger} type="button" className="app-version-trigger" aria-label={info ? `Easel ${label}，构建 ${info.build}，查看版本详情` : `${label}，查看版本详情`} title={info ? `Easel ${label} · ${info.development ? '开发环境' : info.build}` : label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(value => !value)} onKeyDown={event => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); }
        if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(true); }
      }}><span>{label}</span>{mismatched ? <small>版本不一致</small> : info?.development && <small>开发版</small>}</button>
    {open && createPortal(<div ref={panel} id={id} className="app-version-details" role="dialog" aria-label="Easel 版本" tabIndex={-1} style={position}
      onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node) && event.relatedTarget !== trigger.current) close(); }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); } }}>
      <div className="app-version-heading"><strong>Easel</strong><button type="button" aria-label="关闭版本详情" title="关闭" onClick={() => close(true)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>
      {info ? <dl><div><dt>后端版本</dt><dd>{label}</dd></div><div><dt>部署构建</dt><dd>{info.build === 'development' ? '未编号' : <code title={info.revision || undefined}>{info.build}</code>}</dd></div>{info.development && <div><dt>环境</dt><dd>开发版</dd></div>}{uiVersion&&<div><dt>界面版本</dt><dd>v{uiVersion}</dd></div>}{uiBuiltAt&&<div><dt>界面构建</dt><dd>{new Date(uiBuiltAt).toLocaleString('zh-CN',{hour12:false})}</dd></div>}</dl> : <p>{loading ? '正在读取版本…' : '暂时无法读取版本'}</p>}
      {mismatched&&<p className="app-version-mismatch" role="status">界面与后端版本不同，请确认部署版本并刷新页面。</p>}
    </div>, document.body)}
  </>;
}
