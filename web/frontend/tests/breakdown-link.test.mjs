import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './load-ts.mjs';

// 爆款拆解：链接检测与受控读取材料的合并规则。
const { firstUrl, composeLinkedMaterial, LINK_MATERIAL_MARKER } = await loadTsModule('../src/lib/breakdownLink.ts', import.meta.url);

test('the first http link is detected and trailing punctuation is trimmed', () => {
  assert.equal(firstUrl('看看这个 https://www.zhihu.com/question/2095109263622238854，写得如何？'), 'https://www.zhihu.com/question/2095109263622238854');
  assert.equal(firstUrl('https://example.com/a。'), 'https://example.com/a');
  assert.equal(firstUrl('纯正文，没有链接。'), undefined);
  assert.equal(firstUrl(''), undefined);
  assert.equal(firstUrl('ftp://example.com/x'), undefined, 'non-http schemes are ignored');
});

test('linked material keeps the user input and marks the fetched source', () => {
  const composed = composeLinkedMaterial('请拆解这条 https://example.com/x', '标题甲', '第一段。\n第二段。');
  assert.ok(composed.startsWith('请拆解这条 https://example.com/x'));
  assert.match(composed, new RegExp(LINK_MATERIAL_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(composed, /标题：标题甲/);
  assert.match(composed, /第一段。\n第二段。/);
  assert.match(composeLinkedMaterial('x', '', 'y'), /标题：（未取到标题）/);
});
