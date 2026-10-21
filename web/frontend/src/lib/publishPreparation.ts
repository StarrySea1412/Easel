const VIDEO = /\.(mp4|mov|webm|mkv|avi|m4v|flv|ts)$/i;
const VIDEO_ONLY = new Set(['douyin', 'weixin-channels', 'bilibili']);
const MEDIA_REQUIRED = new Set(['xiaohongshu', 'kuaishou']);

/** Same media requirements as the server; text-only Zhihu needs no attachment. */
export function publishMediaIssue(platform: string, media: string[]): { message: string; code: 'media_required' | 'video_required' } | null {
  if (VIDEO_ONLY.has(platform) && !media.some(path => VIDEO.test(path))) {
    return { message: media.length ? '需要视频，当前选择的是图片；请更换为一个视频。' : '缺少视频，请选择一个视频。', code: 'video_required' };
  }
  if (platform === 'wechat-oa' && (!media.length || media.some(path => VIDEO.test(path)))) {
    return { message: '缺少文章封面图，请选择图片，首图将作为封面。', code: 'media_required' };
  }
  if (MEDIA_REQUIRED.has(platform) && !media.length) {
    return { message: '缺少图片或视频，请至少选择一个素材。', code: 'media_required' };
  }
  return null;
}
