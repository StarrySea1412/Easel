import { useEffect, useMemo, useState } from 'react';
import { renderMarkdown } from '../lib/sanitize';
import { externalizeMediaLinks, linkifyOutputs } from '../lib/linkifyOutputs';

/** Verify local delivery targets against this running instance, including old replies. */
export default function OutputMessageContent({ content, inert = false, streaming = false }: { content: string; inert?: boolean; streaming?: boolean }) {
  const [revision, setRevision] = useState(0);
  const [checks, setChecks] = useState<{ html: string; revision: number; values: Record<string, string> }>({ html: '', revision: -1, values: {} });
  const source = useMemo(() => externalizeMediaLinks(renderMarkdown(linkifyOutputs(content), { allowMedia: !inert })), [content, inert]);
  const links = useMemo(() => {
    const template = document.createElement('template'); template.innerHTML = source;
    const paths: Record<string, string | null> = {};
    for (const anchor of template.content.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      const href = anchor.getAttribute('href')!;
      try {
        const url = new URL(href, window.location.href);
        if (url.origin !== window.location.origin) continue;
        const marker = '/api/media/';
        if (url.hash.startsWith('#/outputs/')) paths[href] = decodeURIComponent(url.hash.slice('#/outputs/'.length));
        else if (url.pathname.includes(marker)) paths[href] = decodeURIComponent(url.pathname.slice(url.pathname.indexOf(marker) + marker.length));
        else if (!href.startsWith('#')) paths[href] = null;
      } catch { paths[href] = null; }
    }
    return paths;
  }, [source]);
  useEffect(() => {
    if (inert || streaming) return;
    const controller = new AbortController();
    const base = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
    const entries = Object.entries(links);
    void Promise.all(entries.map(async ([href, path], index) => {
      if (!path) return [href, '文件未保存到当前内容库'] as const;
      if (index >= 40) return [href, '文件过多，请在内容库核对'] as const;
      try {
        const response = await fetch(`${base}/api/output-status?path=${encodeURIComponent(path)}`, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) return [href, '暂时无法核验文件'] as const;
        const status = await response.json();
        return [href, status.exists === true ? '' : '当前数据目录未找到文件'] as const;
      } catch { return [href, '暂时无法核验文件'] as const; }
    })).then(values => { if (!controller.signal.aborted) setChecks({ html: source, revision, values: Object.fromEntries(values) }); });
    return () => controller.abort();
  }, [source, links, inert, revision, streaming]);
  const rendered = useMemo(() => {
    if (inert) return { html: source, warnings: [] as string[] };
    const template = document.createElement('template'); template.innerHTML = source;
    const warnings = new Set<string>();
    if (/\]\((?:<?sandbox:|<?file:|<?[A-Za-z]:[\\/]|<?\/mnt\/data\/)/i.test(content)
        && template.content.querySelector('a:not([href])')) warnings.add('回复中的本地路径未保存到当前内容库');
    for (const anchor of template.content.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      const href = anchor.getAttribute('href')!;
      if (!(href in links)) continue;
      const state = !streaming && checks.html === source && checks.revision === revision ? checks.values[href] : undefined;
      if (state === '') continue;
      anchor.removeAttribute('href'); anchor.removeAttribute('target');
      anchor.setAttribute('aria-disabled', 'true'); anchor.setAttribute('title', state || '正在核验文件');
      anchor.style.color = 'var(--text-secondary)';
      anchor.style.textDecoration = 'none';
      anchor.style.cursor = 'not-allowed';
      if (state) warnings.add(state);
    }
    return { html: template.innerHTML, warnings: [...warnings] };
  }, [source, links, checks, revision, inert, content, streaming]);
  return <><div dangerouslySetInnerHTML={{ __html: rendered.html }} />{rendered.warnings.length > 0 && <p role="status" style={{ fontSize: 'calc(13px * var(--easel-font-scale, 1))', color: 'var(--amber)' }}>{rendered.warnings.join('；')}。请让 Agent 实际保存产物后再交付。 <button type="button" className="link-btn" onClick={() => setRevision(value => value + 1)}>重新检查文件</button></p>}</>;
}
