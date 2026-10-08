import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = { location: { pathname: '/' } };
const {
  requirementsForSelection, readSkillRequirements, writeSkillRequirements,
  MAX_SKILL_REQUIREMENT_LENGTH, MAX_SKILL_REQUIREMENTS_TOTAL, MAX_SKILL_REQUIREMENTS_COUNT,
} = await loadTsModule('../src/lib/selectedSkills.ts', import.meta.url);
const { streamChat } = await loadTsModule('../src/lib/api.ts', import.meta.url);

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const result = {
    values, writes: [], failing: false,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { if (this.failing) throw new Error('quota'); this.writes.push(key); values.set(key, value); },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: result });
  return result;
}

test('requirements retain only explicit matching valid skills, without inherited or special-key confusion', () => {
  const notes = Object.create({ inherited: '不得继承' });
  Object.assign(notes, { 'card-quote': '  保留换行\n具体材料  ', 'custom.skill': '支持已安装自定义名称', other: '未选择', blank: '  ', bad: 10, '../path': '非法' });
  Object.defineProperty(notes, '__proto__', { enumerable: true, value: '合法同名目录也按普通键处理' });
  const snapshot = requirementsForSelection(notes, ['card-quote', 'custom.skill', 'inherited', '__proto__', 'blank', 'bad', '../path']);
  assert.deepEqual(Object.keys(snapshot), ['card-quote', 'custom.skill', '__proto__']);
  assert.equal(snapshot['card-quote'], '保留换行\n具体材料');
  assert.equal(Object.getPrototypeOf(snapshot), Object.prototype);
  assert.equal(Object.hasOwn(snapshot, '__proto__'), true);
  notes['card-quote'] = '改动源对象';
  assert.equal(snapshot['card-quote'], '保留换行\n具体材料');
  for (const invalid of [null, [], 'text', 1]) assert.deepEqual(requirementsForSelection(invalid, ['card-quote']), {});
});

test('saved requirement bounds agree with request limits for individual, combined and maximum-count values', () => {
  assert.equal(requirementsForSelection({ a: '字'.repeat(MAX_SKILL_REQUIREMENT_LENGTH) }, ['a']).a.length, 2000);
  assert.deepEqual(requirementsForSelection({ a: '字'.repeat(MAX_SKILL_REQUIREMENT_LENGTH + 1) }, ['a']), {});
  const large = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`skill-${index}`, '字'.repeat(2000)]));
  const combined = requirementsForSelection(large, Object.keys(large));
  assert.equal(Object.values(combined).reduce((sum, value) => sum + value.length, 0), MAX_SKILL_REQUIREMENTS_TOTAL);
  const many = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`skill-${index}`, '要求']));
  assert.equal(Object.keys(requirementsForSelection(many, Object.keys(many))).length, MAX_SKILL_REQUIREMENTS_COUNT);
});

test('conversation preferences survive reload independently and corrupt reads never write replacements', () => {
  const saved = storage({
    'easel:selected-skills:a': '["card-quote"]', 'easel:selected-skills:b': '["card-quote"]',
    'easel:skill-requirements:a': '{"card-quote":"会话一要求"}',
    'easel:skill-requirements:b': '{"card-quote":"会话二要求"}',
    'easel:skill-requirements:broken': '{keep broken original',
  });
  assert.deepEqual(readSkillRequirements('a'), { 'card-quote': '会话一要求' });
  assert.deepEqual(readSkillRequirements('b'), { 'card-quote': '会话二要求' });
  assert.deepEqual(readSkillRequirements('broken', ['card-quote']), {});
  assert.deepEqual(saved.writes, []);
  assert.equal(saved.values.get('easel:skill-requirements:broken'), '{keep broken original');
  assert.equal(writeSkillRequirements('a', {}), true);
  assert.deepEqual(readSkillRequirements('a'), {});
  assert.deepEqual(readSkillRequirements('b'), { 'card-quote': '会话二要求' });
  saved.failing = true;
  assert.equal(writeSkillRequirements('b', { 'card-quote': '失败的新要求' }), false);
  assert.deepEqual(readSkillRequirements('b'), { 'card-quote': '会话二要求' });
});

test('the actual stream API serializes selected skill requirements as structured request fields', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push([url, options]);
    return new Response('event: done\ndata: {"sessionKey":"fixture"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const send = (requirements) => new Promise((resolve, reject) => streamChat(
    '用户原始正文', undefined, 'session-a', () => {}, resolve, reject,
    undefined, undefined, undefined, 'turn-a', false, undefined, [], undefined, undefined,
    ['card-quote'], requirements,
  ));
  assert.equal(await send({ 'card-quote': '只用于后续这次发送' }), 'fixture');
  const [url, options] = requests[0];
  assert.equal(url, '/api/chat/stream');
  assert.equal(options.method, 'POST');
  assert.deepEqual(JSON.parse(options.body), {
    message: '用户原始正文', sessionId: 'session-a', turnId: 'turn-a', attachments: [],
    selectedSkills: ['card-quote'], skillRequirements: { 'card-quote': '只用于后续这次发送' },
  });
  await send(undefined);
  assert.deepEqual(JSON.parse(requests[1][1].body).skillRequirements, {}, 'a cleared note is an explicit empty snapshot');
});
