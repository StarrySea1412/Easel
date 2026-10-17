import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './load-ts.mjs';

const { parseComposerCommand, goalCommand, suggestsCommand } = await loadTsModule('../src/lib/goalCommand.ts', import.meta.url);

test('composer commands keep Codex goal semantics: view, lifecycle verbs and scheduling', () => {
  assert.deepEqual(parseComposerCommand('/goal'), { kind: 'view' });
  assert.deepEqual(parseComposerCommand('/目标'), { kind: 'view' });
  assert.deepEqual(parseComposerCommand('/goal 查看'), { kind: 'view' });
  assert.deepEqual(parseComposerCommand('/goal pause'), { kind: 'lifecycle', action: 'pause' });
  assert.deepEqual(parseComposerCommand('/goal 暂停'), { kind: 'lifecycle', action: 'pause' });
  assert.deepEqual(parseComposerCommand('/目标 继续'), { kind: 'lifecycle', action: 'resume' });
  assert.deepEqual(parseComposerCommand('/goal 恢复'), { kind: 'lifecycle', action: 'resume' });
  assert.deepEqual(parseComposerCommand('/goal clear'), { kind: 'lifecycle', action: 'clear' });
  assert.deepEqual(parseComposerCommand('/goal 取消'), { kind: 'lifecycle', action: 'clear' });
  assert.deepEqual(parseComposerCommand('/goal 完成卡片并交付 HTML'), { kind: 'set', text: '完成卡片并交付 HTML' });
  assert.equal(goalCommand('/goal 完成卡片'), '完成卡片');
  assert.equal(goalCommand('/goal pause'), null);
  assert.deepEqual(parseComposerCommand('/定时 每周一 9 点整理热点'), { kind: 'schedule', text: '每周一 9 点整理热点' });
  assert.deepEqual(parseComposerCommand('/schedule'), { kind: 'schedule', text: '' });
  assert.equal(parseComposerCommand('普通消息'), null);
  assert.equal(parseComposerCommand('/goalx'), null);
  assert.equal(parseComposerCommand('/定时abc'), null);
});

test('slash suggestions only match command prefixes and never swallow ordinary text', () => {
  for (const value of ['/', '/g', '/goal', '/s', '/schedule', '/目', '/目标', '/定', '/定时', '/计', '/计划']) {
    assert.equal(suggestsCommand(value), true, value);
  }
  for (const value of ['', '文本', '/goal pause', '/goal 目标正文', '/x']) {
    assert.equal(suggestsCommand(value), false, value);
  }
});
