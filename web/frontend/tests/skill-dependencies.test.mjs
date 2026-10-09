import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './load-ts.mjs';
const { skillDependencies } = await loadTsModule('../src/lib/skillDependencies.ts', import.meta.url);
const skill = name => ({ name, needsApi: false, apiConfigured: false });

test('short drama requires image generation but video and ordinary speech stay optional', () => {
  const dependencies = skillDependencies(skill('short-drama'));
  assert.equal(dependencies.find(row => row.id === 'image').required, true);
  assert.equal(dependencies.find(row => row.id === 'video').required, false);
  assert.equal(dependencies.find(row => row.id === 'speech').required, false);
});
test('local ASR and local image rendering do not require a generation key', () => {
  const asr = skillDependencies(skill('custom'), { body: '运行 asr.py 本地转写' });
  assert.equal(asr[0].id, 'transcribe'); assert.equal(asr[0].required, false);
  assert.deepEqual(skillDependencies(skill('local'), { body: '用 SVG 渲染本地 image 文件和 video 封面' }), []);
});
test('detail dependencies follow real scripts and match their own configured channel', () => {
  const channels = { channels: { image: { rows: [{ result: '已配置', keyMasked: 'abc…' }] }, video: { rows: [{ result: '未配置', keyMasked: '' }] } } };
  const dependencies = skillDependencies(skill('custom'), { body: 'ai_image.py 和 ai_video.py', guide: { needs: {} } }, channels);
  assert.deepEqual(dependencies.map(row => [row.channel, row.configured]), [['image', true], ['video', false]]);
});
