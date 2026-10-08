import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './load-ts.mjs';

const { isFinalPublishReceipt, isPublishReceipt, mergePublishReceipts, publishNotificationLabel, publishReceiptStatus, receiptPublicUrl, safePublishedUrl } = await loadTsModule('../src/lib/publishReceipts.ts');
const first = {
  receiptId: 'a'.repeat(32), platform: 'zhihu', title: '可核验的发布结果',
  createdAt: '2026-10-08T01:00:00.000Z', updatedAt: '2026-10-08T01:00:00.000Z',
  state: 'starting', outcome: null, message: '处理中', url: '', notification: { state: 'unconfigured' },
};

test('old success flags, queued tasks and progress do not count as published', () => {
  const legacy = { ...first, ok: true, state: 'success', url: 'https://zhuanlan.zhihu.com/p/12345' };
  assert.equal(isFinalPublishReceipt(legacy), false);
  assert.equal(publishReceiptStatus(legacy).label, '发布处理中');
  assert.equal(receiptPublicUrl(legacy), null);
  assert.equal(publishReceiptStatus({ ...first, state: 'sms_required' }).label, '需要短信验证');
  assert.equal(publishReceiptStatus({ ...first, state: 'verifying' }).label, '正在验证');
});

for (const [outcome, label] of [['published', '已发布'], ['submitted', '已提交'], ['draft', '已存草稿'], ['unverified', '结果待核实'], ['failed', '发布失败']]) {
  test(`${outcome} has its own result and cannot borrow the meaning of ok=true`, () => {
    const receipt = { ...first, outcome, state: 'finished', ok: true, url: 'https://zhuanlan.zhihu.com/p/12345' };
    assert.equal(isFinalPublishReceipt(receipt), true);
    assert.equal(publishReceiptStatus(receipt).label, label);
    assert.equal(receiptPublicUrl(receipt), outcome === 'published' ? receipt.url : null);
  });
}

const publicUrls = [
  ['xiaohongshu', 'https://www.xiaohongshu.com/explore/abcdef0123456789abcdef01?xsec_token=public-share'],
  ['douyin', 'https://www.douyin.com/video/123456789'],
  ['douyin', 'https://www.douyin.com/note/123456789/'],
  ['bilibili', 'https://www.bilibili.com/video/BV1xx411c7mD/'],
  ['kuaishou', 'https://www.kuaishou.com/short-video/abc_123-xyz'],
  ['zhihu', 'https://www.zhihu.com/question/123/answer/456'],
  ['zhihu', 'https://zhuanlan.zhihu.com/p/12345'],
  ['wechat-oa', 'https://mp.weixin.qq.com/s/abc_DEF-123'],
  ['wechat-oa', 'https://mp.weixin.qq.com/s?__biz=abc&mid=123&idx=1&sn=public-signature'],
  ['B站', 'https://www.bilibili.com/video/BV1xx411c7mD/'],
];
for (const [platform, url] of publicUrls) test(`known public content address stays clickable: ${platform} ${url}`, () => {
  assert.equal(safePublishedUrl(platform, url), url);
});

const invalidUrls = [
  ['zhihu', 'javascript:alert(1)'], ['zhihu', 'http://zhuanlan.zhihu.com/p/123'],
  ['zhihu', 'https://zhuanlan.zhihu.com.evil.test/p/123'], ['zhihu', 'https://evil.test/zhuanlan.zhihu.com/p/123'],
  ['zhihu', 'https://user:password@zhuanlan.zhihu.com/p/123'], ['zhihu', 'https://zhuanlan.zhihu.com:444/p/123'],
  ['zhihu', 'https://zhuanlan.zhihu.com/p/123?token=secret'], ['zhihu', 'https://zhuanlan.zhihu.com/p/123?Authorization=secret'],
  ['zhihu', 'https://zhuanlan.zhihu.com/p/123?password=secret'], ['zhihu', 'https://zhuanlan.zhihu.com/p/123?access_token=secret'],
  ['zhihu', 'https://zhuanlan.zhihu.com/p/123\n'], ['zhihu', 'https://zhuanlan.zhihu.com\\@evil.test/p/123'],
  ['zhihu', 'https://www.zhihu.com/creator'], ['douyin', 'https://creator.douyin.com/creator-micro/content/manage'],
  ['wechat-oa', 'https://mp.weixin.qq.com/cgi-bin/appmsg?action=list'], ['wechat-oa', 'https://mp.weixin.qq.com/s?__biz=abc'],
  ['douyin', 'https://zhuanlan.zhihu.com/p/123'], ['weixin-channels', 'https://channels.weixin.qq.com/platform/post/list'],
  ['unknown', 'https://example.com/a'], ['zhihu', null], ['zhihu', ''],
];
for (const [platform, url] of invalidUrls) test(`unverified or unsafe address stays non-clickable: ${String(url)}`, () => {
  assert.equal(safePublishedUrl(platform, url), null);
});

test('receipt identity and timestamps must be usable before recovery accepts a record', () => {
  assert.equal(isPublishReceipt(first), true);
  for (const change of [{ receiptId: '../other-task' }, { updatedAt: 'bad date' }, { outcome: 'success' }, { title: null }, { state: undefined }]) {
    assert.equal(isPublishReceipt({ ...first, ...change }), false);
  }
});

test('late progress and old readbacks cannot overwrite a newer final result', () => {
  const completed = { ...first, state: 'finished', outcome: 'published', updatedAt: '2026-10-08T01:01:00.000Z' };
  const notification = { ...completed, updatedAt: '2026-10-08T01:01:01.000Z', notification: { state: 'failed', message: 'SMTP rejected' } };
  const refreshed = mergePublishReceipts([completed], [first, notification]);
  assert.deepEqual(refreshed, [notification]);
  assert.deepEqual(mergePublishReceipts(refreshed, [{ ...first, updatedAt: '2026-10-08T01:02:00.000Z' }]), refreshed);
  assert.equal(refreshed[0].outcome, 'published');
  assert.equal(publishNotificationLabel(refreshed[0].notification), '邮件发送失败');
});

test('missing and queued mail configuration never changes the platform result', () => {
  assert.match(publishNotificationLabel({ state: 'unconfigured' }), /未配置/);
  assert.equal(publishNotificationLabel({ state: 'queued' }), '邮件通知排队中');
  assert.equal(publishNotificationLabel({ state: 'sent' }), '邮件已发送');
  assert.equal(publishNotificationLabel({ state: 'skipped' }), '本次未发送邮件');
  assert.equal(publishNotificationLabel(), '邮件通知状态待确认');
});
