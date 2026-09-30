import { safeWorkspaceOutputHref, type WorkspaceOutput } from './workspaceOutputData';

export const OFFICE_TEXT_PREVIEW_LIMIT = 64 * 1024;
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'srt', 'vtt']);
const TEXT_MIMES = new Set(['text/plain', 'text/markdown', 'text/x-markdown', 'text/vtt', 'application/x-subrip']);

export function canPreviewOfficeText(item: WorkspaceOutput): boolean {
  return item.kind === 'text' && TEXT_EXTENSIONS.has(item.path.split('.').at(-1)?.toLowerCase() || '');
}

export interface OfficeTextPreviewResult { text: string; bytesRead: number; truncated: boolean }

/** Read only a verified media link. The byte cap applies before decoding and
 * the body is never passed to an HTML/Markdown renderer or response.text().
 */
export async function readOfficeTextPreview(item: WorkspaceOutput, signal: AbortSignal): Promise<OfficeTextPreviewResult> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const href = safeWorkspaceOutputHref(item.path, item.href);
  if (!href || !canPreviewOfficeText(item)) throw new Error('此文件不支持安全文本预览，请下载原文件查看。');
  const url = new URL(href, window.location.href);
  if (url.origin !== window.location.origin) throw new Error('文件来源无法确认，请刷新产出清单。');
  url.searchParams.set('v', item.modifiedAt);
  url.searchParams.set('size', String(item.size));
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 12_000);
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const fetching = fetch(url.href, { signal: controller.signal, cache: 'no-store',
      mode: 'same-origin', credentials: 'same-origin', redirect: 'error' }).then(value => {
      if (controller.signal.aborted) {
        void value.body?.cancel().catch(() => {});
        throw new DOMException('Aborted', 'AbortError');
      }
      return value;
    });
    response = await Promise.race([fetching, aborted]);
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!response.ok) throw new Error(`文本读取失败（HTTP ${response.status}），请刷新清单或重试。`);
    if (response.redirected || (response.url && new URL(response.url).origin !== window.location.origin)) {
      throw new Error('文本来源发生跳转，未显示文件内容。');
    }
    const contentType = response.headers.get('content-type') || '';
    const mime = contentType.split(';')[0].trim().toLowerCase();
    const charset = /;\s*charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1]?.toLowerCase();
    if (!TEXT_MIMES.has(mime) || (charset && !['utf-8', 'utf8', 'us-ascii'].includes(charset))) {
      throw new Error('文件类型或编码不支持安全文本预览；仅支持 UTF-8 文本，不预览 HTML 或二进制文件。');
    }
    if (!response.body) throw new Error('浏览器未提供可限量读取的数据流，请下载原文件查看。');
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '', bytesRead = 0, truncated = false;
    while (bytesRead < OFFICE_TEXT_PREVIEW_LIMIT) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (chunk.done) { text += decoder.decode(); break; }
      const accepted = chunk.value.subarray(0, OFFICE_TEXT_PREVIEW_LIMIT - bytesRead);
      bytesRead += accepted.byteLength;
      text += decoder.decode(accepted, { stream: true });
      if (bytesRead === OFFICE_TEXT_PREVIEW_LIMIT) {
        // Do not read another byte merely to distinguish an exact-size file.
        // A UTF-8 character cut by the cap remains buffered and is omitted.
        truncated = true;
        break;
      }
    }
    for (const character of text) {
      const code = character.charCodeAt(0);
      if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
        throw new Error('文件包含非文本数据，未显示预览，请下载原文件查看。');
      }
    }
    if (/^\s*(?:<!doctype\s+html\b|<html(?:\s|>)|<svg(?:\s|>))/i.test(text)) {
      throw new Error('检测到 HTML 或 SVG 文档，未显示内嵌预览，请下载原文件查看。');
    }
    return { text, bytesRead, truncated };
  } catch (cause) {
    if (timedOut) throw new Error('文本预览读取超时，请重试。');
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (cause instanceof TypeError) throw new Error('文本无法读取或不是有效的 UTF-8 编码，请下载原文件查看。');
    throw cause;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', rejectAbort);
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    } else if (response?.body) void response.body.cancel().catch(() => {});
  }
}
