export const VIDEO_REFERENCE_MAX_BYTES = 100 * 1024 * 1024;
export const STUDIO_MEDIA_ACCEPT = 'image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime';

export function firstStudioMedia(files: Iterable<File>): File | undefined {
  return Array.from(files).find(file => /^(image|video)\//.test(file.type));
}

/** Browsers expose different clipboard formats; never interpret pasted text as a remote URL. */
export async function readStudioClipboard(clipboard: Pick<Clipboard, 'read'> | undefined = navigator.clipboard): Promise<File> {
  if (!clipboard?.read) throw new Error('此浏览器不支持直接读取剪贴板。请在创作区按 Ctrl / ⌘ + V，或选择文件。');
  let items: ClipboardItems;
  try { items = await clipboard.read(); }
  catch { throw new Error('无法读取剪贴板。请允许浏览器访问，或在创作区按 Ctrl / ⌘ + V；也可选择文件。'); }
  for (const item of items) {
    const type = item.types.find(value => /^(image|video)\//.test(value));
    if (type) {
      const blob = await item.getType(type);
      const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' } as Record<string, string>)[type] || 'media';
      return new File([blob], `剪贴板-${Date.now()}.${extension}`, { type });
    }
  }
  throw new Error('剪贴板中没有浏览器可读取的图片或视频文件。复制视频链接不会传入视频，请选择本地文件。');
}

/** Decode locally and upload only a still frame; no video-editing API is implied. */
export function extractVideoFirstFrame(file: File, signal?: AbortSignal): Promise<File> {
  if (!file.type.startsWith('video/')) return Promise.reject(new Error('请选择视频文件。'));
  if (!file.size || file.size > VIDEO_REFERENCE_MAX_BYTES) return Promise.reject(new Error('参考视频必须非空且不超过 100 MB。'));
  if (signal?.aborted) return Promise.reject(new Error('视频读取已取消。'));
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.preload = 'auto';
    let finished = false;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); video.onloadeddata = null; video.onerror = null; video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); };
    const fail = (message: string) => { if (finished) return; finished = true; cleanup(); reject(new Error(message)); };
    const abort = () => fail('视频读取已取消。');
    const timer = setTimeout(() => fail('视频首帧读取超时，请换用 MP4 / WebM 或选择一张截图。'), 20000);
    signal?.addEventListener('abort', abort, { once: true });
    video.onerror = () => fail('浏览器无法解码这个视频，请换用 MP4 / WebM 或选择一张截图。');
    video.onloadeddata = () => {
      if (finished) return;
      try {
        if (!video.videoWidth || !video.videoHeight) { fail('视频没有可读取的画面。'); return; }
        const scale = Math.min(1, 2048 / Math.max(video.videoWidth, video.videoHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = canvas.getContext('2d');
        if (!context) { fail('无法提取视频首帧，请选择一张截图。'); return; }
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(blob => {
          if (finished) return;
          if (!blob) { fail('视频首帧转换失败，请选择一张截图。'); return; }
          finished = true; cleanup();
          resolve(new File([blob], `${file.name.replace(/\.[^.]+$/, '')}-首帧.jpg`, { type: 'image/jpeg' }));
        }, 'image/jpeg', .92);
      } catch { fail('视频首帧转换失败，请选择一张截图。'); }
    };
    video.src = url;
    video.load();
  });
}
