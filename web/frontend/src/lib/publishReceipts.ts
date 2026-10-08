import type { PublishNotification, PublishOutcome, PublishReceipt, PublishResult } from './api';

const PLATFORM_LABELS: Record<string, string> = {
  xiaohongshu: '小红书', douyin: '抖音', kuaishou: '快手',
  'weixin-channels': '视频号', zhihu: '知乎', bilibili: 'B站', 'wechat-oa': '公众号',
};
const PLATFORM_KEYS = Object.fromEntries(Object.entries(PLATFORM_LABELS).map(([key, label]) => [label, key]));

export const PUBLISH_OUTCOMES: Record<PublishOutcome, { label: string; tone: string; description: string }> = {
  published: { label: '已发布', tone: 'success', description: '平台已确认公开发布。' },
  submitted: { label: '已提交', tone: 'pending', description: '平台已接收内容，公开结果尚待核实。' },
  draft: { label: '已存草稿', tone: 'neutral', description: '内容在平台草稿箱，尚未公开发布。' },
  unverified: { label: '结果待核实', tone: 'warning', description: '请先到平台核对，避免重复发布。' },
  failed: { label: '发布失败', tone: 'error', description: '发布未完成，请查看平台状态和发布记录。' },
};

export function publishPlatformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] || platform;
}

export function isPublishOutcome(value: unknown): value is PublishOutcome {
  return typeof value === 'string' && Object.hasOwn(PUBLISH_OUTCOMES, value);
}

export function isFinalPublishReceipt(receipt: Pick<PublishReceipt, 'outcome'>): boolean {
  return isPublishOutcome(receipt.outcome);
}

export function canVerifyPublishReceipt(receipt: PublishReceipt): boolean {
  return ['xiaohongshu', 'weixin-channels', 'bilibili', 'douyin', 'kuaishou'].includes(receipt.platform)
    && (receipt.outcome === 'submitted' || receipt.outcome === 'unverified')
    && receipt.verification?.state !== 'unsupported';
}

export function isPublishReceipt(value: PublishResult | unknown): value is PublishReceipt {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<PublishReceipt>;
  return typeof item.receiptId === 'string' && /^[0-9a-f]{32}$/.test(item.receiptId)
    && typeof item.platform === 'string' && typeof item.title === 'string'
    && typeof item.state === 'string' && typeof item.message === 'string'
    && typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt))
    && typeof item.updatedAt === 'string' && Number.isFinite(Date.parse(item.updatedAt))
    && (item.outcome === null || isPublishOutcome(item.outcome));
}

export function publishReceiptStatus(receipt: PublishReceipt) {
  if (isPublishOutcome(receipt.outcome)) return PUBLISH_OUTCOMES[receipt.outcome];
  if (receipt.state === 'sms_required') return { label: '需要短信验证', tone: 'warning', description: '请处理本次发布的短信验证。' };
  if (receipt.state === 'verifying') return { label: '正在验证', tone: 'pending', description: '验证码已提交，等待平台验证。' };
  return { label: '发布处理中', tone: 'pending', description: '正在等待平台回执。' };
}

/** Match the backend's public-content allowlist. Creator-console URLs are never public evidence. */
export function safePublishedUrl(platform: string, value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\s\\]/.test(value)
    || [...value].some(character => character.charCodeAt(0) < 32)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    const key = PLATFORM_KEYS[platform] || (platform === '微信视频号' ? 'weixin-channels' : platform);
    const patterns: Record<string, Record<string, RegExp>> = {
      douyin: { 'www.douyin.com': /^\/(?:video|note)\/\d+\/?$/ },
      xiaohongshu: { 'www.xiaohongshu.com': /^\/(?:explore|discovery\/item)\/[0-9a-fA-F]{24}\/?$/ },
      bilibili: { 'www.bilibili.com': /^\/video\/BV[0-9A-Za-z]{10}\/?$/ },
      kuaishou: { 'www.kuaishou.com': /^\/short-video\/[0-9A-Za-z_-]+\/?$/ },
      zhihu: { 'zhuanlan.zhihu.com': /^\/p\/\d+\/?$/, 'www.zhihu.com': /^\/question\/\d+\/answer\/\d+\/?$/ },
    };
    const allowed = key === 'wechat-oa' && url.hostname === 'mp.weixin.qq.com'
      ? /^\/s\/[0-9A-Za-z_-]+$/.test(url.pathname) || (url.pathname === '/s' && ['__biz', 'mid', 'idx'].every(name => Boolean(url.searchParams.get(name))))
      : Boolean(patterns[key]?.[url.hostname]?.test(url.pathname));
    if (!allowed || [...url.searchParams.keys()].some(name => ['access_token', 'authorization', 'password', 'auth', 'token'].includes(name.toLowerCase()))) return null;
    return url.href;
  } catch { return null; }
}

export function receiptPublicUrl(receipt: Pick<PublishReceipt, 'platform' | 'outcome' | 'url'>): string | null {
  return receipt.outcome === 'published' ? safePublishedUrl(receipt.platform, receipt.url) : null;
}

export function publishNotificationLabel(notification?: PublishNotification): string {
  const labels = {
    unconfigured: '邮件未配置或自动通知未开启', queued: '邮件通知排队中',
    sent: '邮件已发送', failed: '邮件发送失败', skipped: '本次未发送邮件',
  };
  return notification && Object.hasOwn(labels, notification.state) ? labels[notification.state] : '邮件通知状态待确认';
}

/** Late GET responses must not replace a newer receipt or roll a finished task back into progress. */
export function mergePublishReceipts(current: PublishReceipt[], incoming: PublishReceipt[]): PublishReceipt[] {
  const byId = new Map(current.map(item => [item.receiptId, item]));
  for (const item of incoming) {
    if (!isPublishReceipt(item)) continue;
    const old = byId.get(item.receiptId);
    if (old && (Date.parse(old.updatedAt) > Date.parse(item.updatedAt)
      || (isFinalPublishReceipt(old) && !isFinalPublishReceipt(item)))) continue;
    byId.set(item.receiptId, item);
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 200);
}
