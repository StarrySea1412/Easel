import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './load-ts.mjs';

const {
  createConversationBackup, parseConversationBackup, createImportedSessions,
  MAX_BACKUP_BYTES, MAX_BACKUP_SESSIONS, MAX_BACKUP_MESSAGES,
} = await loadTsModule('../src/lib/conversationBackup.ts', import.meta.url);

function session(overrides = {}) {
  return {
    id: 'source-session', title: '保留的对话', created: 1720000000000,
    messages: [{ role: 'user', content: '我的问题' }, { role: 'assistant', content: '已有回答' }],
    ...overrides,
  };
}

function backup(overrides = {}) {
  return {
    format: 'easel-conversation-backup', version: 1, exportedAt: '2026-10-02T04:05:06.000Z',
    sessions: [{ title: 'Portable history', created: 1, messages: [{ role: 'user', content: 'hello' }] }],
    ...overrides,
  };
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test('export/parse/import roundtrip preserves portable text, errors, archive state and creation time', () => {
  const original = session({ archived: true, messages: [
    { role: 'user', content: '问题\n二行' },
    { role: 'assistant', content: '部分答案', thinking: '实际思考', activity: '读取\n核对', error: { message: '连接已中断', code: 'private-code', retryable: true } },
  ] });
  const exported = createConversationBackup([original]);
  const parsed = parseConversationBackup(JSON.stringify(exported));
  assert.deepEqual(parsed, exported);
  const [imported] = createImportedSessions(parsed, [original.id]);
  assert.equal(imported.title, original.title);
  assert.equal(imported.created, original.created);
  assert.equal(imported.archived, true);
  assert.equal(imported.importedFromBackup, true);
  assert.equal(imported.backupIncomplete, false);
  assert.deepEqual(imported.messages[1], { role: 'assistant', content: '部分答案', thinking: '实际思考', activity: '读取\n核对', error: { message: '连接已中断' } });
  assert.notEqual(imported.id, original.id);
  assert.match(imported.id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
});

test('export whitelist excludes identities, secrets, attachments and action identifiers', () => {
  const exported = createConversationBackup([session({
    persona: 'PERSONA_SECRET', sessionKey: 'SESSION_SECRET', pendingTurnId: 'TURN_SECRET',
    messages: [
      { role: 'user', content: '用户可见文本含 token 字样应原样保留', agentContent: 'INTERNAL_SECRET', attachments: [{ path: 'PRIVATE_PATH' }], selectedSkills: ['ACTION_SECRET'], skillRequirements: { ACTION_SECRET: 'REQUIREMENT_SECRET' }, turnId: 'TURN_SECRET' },
      { role: 'assistant', content: '回答', error: { message: '可见错误', code: 'ERROR_SECRET', category: 'authentication', retryable: false } },
    ],
  })]);
  assert.deepEqual(Object.keys(exported.sessions[0]).sort(), ['created', 'incomplete', 'messages', 'title']);
  const serialized = JSON.stringify(exported);
  for (const marker of ['PERSONA_SECRET', 'SESSION_SECRET', 'TURN_SECRET', 'INTERNAL_SECRET', 'PRIVATE_PATH', 'ACTION_SECRET', 'REQUIREMENT_SECRET', 'ERROR_SECRET']) {
    assert.ok(!serialized.includes(marker), marker);
  }
  assert.equal(exported.sessions[0].messages[0].content, '用户可见文本含 token 字样应原样保留');
  const [imported] = createImportedSessions(exported, []);
  for (const field of ['persona', 'sessionKey', 'pendingTurnId']) assert.ok(!(field in imported));
  for (const message of imported.messages) {
    for (const field of ['attachments', 'selectedSkills', 'skillRequirements', 'turnId', 'agentContent']) assert.ok(!(field in message));
  }
});

test('legacy gateway diagnostics export the safe visible explanation, not hidden credential suggestions', () => {
  const raw = 'Error: gateway agent requires credentials before opening a websocket\nUse token TOP_SECRET';
  const exported = createConversationBackup([session({ messages: [{ role: 'assistant', content: raw }] })]);
  assert.equal(exported.sessions[0].messages[0].content, '');
  assert.match(exported.sessions[0].messages[0].error, /认证凭据/);
  assert.ok(!JSON.stringify(exported).includes('TOP_SECRET'));
});

test('live legacy gateway diagnostics receive the same safe replacement as saved messages', () => {
  const exported = createConversationBackup([session({ messages: [{ role: 'user', content: '等待回复' }] })], {
    'source-session': {
      content: 'Error: gateway agent requires credentials before opening a websocket\nUse token LIVE_SECRET',
      thinking: '已收到思考', activity: '正在连接',
    },
  });
  const message = exported.sessions[0].messages[1];
  assert.equal(message.content, '');
  assert.match(message.error, /认证凭据/);
  assert.equal(message.thinking, '已收到思考');
  assert.equal(message.activity, '正在连接');
  assert.equal(exported.sessions[0].incomplete, true);
  assert.ok(!JSON.stringify(exported).includes('LIVE_SECRET'));
});

test('live snapshots preserve every received field and mark the copy incomplete without modifying sources', () => {
  const original = freeze([session({ pendingTurnId: 'turn-live', messages: [{ role: 'user', content: '继续' }] })]);
  const live = freeze({ 'source-session': { content: '回答已接收及待打字机显示', thinking: '真实思考', activity: '执行中的步骤' } });
  const sourceText = JSON.stringify(original), liveText = JSON.stringify(live);
  const exported = createConversationBackup(original, live);
  assert.equal(exported.sessions[0].incomplete, true);
  assert.deepEqual(exported.sessions[0].messages[1], { role: 'assistant', ...live['source-session'] });
  exported.sessions[0].messages[1].content = '修改备份不影响原始流';
  assert.equal(JSON.stringify(original), sourceText);
  assert.equal(JSON.stringify(live), liveText);
});

test('thinking-only and still-empty live snapshots survive as incomplete assistant records', () => {
  for (const thinking of ['只有思考，没有正文', '']) {
    const exported = createConversationBackup([session({ messages: [{ role: 'user', content: '正在等待' }] })], {
      'source-session': { content: '', thinking, activity: '' },
    });
    assert.equal(exported.sessions[0].messages.length, 2);
    assert.equal(exported.sessions[0].messages[1].thinking, thinking);
    assert.equal(exported.sessions[0].incomplete, true);
  }
});

test('a live answer already persisted for the pending turn is not duplicated', () => {
  const live = { 'source-session': { content: '最终答案', thinking: '', activity: '' } };
  const original = session({ pendingTurnId: 'same-turn', messages: [
    { role: 'user', content: '问题' }, { role: 'assistant', content: '最终答案', turnId: 'same-turn' },
  ] });
  assert.equal(createConversationBackup([original], live).sessions[0].messages.length, 2);
  const earlierTurn = { ...original, pendingTurnId: 'new-turn' };
  assert.equal(createConversationBackup([earlierTurn], live).sessions[0].messages.length, 3);
});

test('pending-without-snapshot and re-exported incomplete imports remain marked incomplete', () => {
  const exported = createConversationBackup([session({ pendingTurnId: 'not-reconnected', messages: [{ role: 'user', content: '未收到回复' }] })]);
  assert.equal(exported.sessions[0].incomplete, true);
  assert.equal(exported.sessions[0].messages.length, 1);
  const imported = createImportedSessions(exported, []);
  assert.equal(imported[0].backupIncomplete, true);
  assert.equal(createConversationBackup(imported).sessions[0].incomplete, true);
});

test('empty placeholders are omitted, but all-empty exports and zero-message imports fail explicitly', () => {
  assert.equal(createConversationBackup([session({ messages: [] }), session({ id: 'real' })]).sessions.length, 1);
  assert.throws(() => createConversationBackup([session({ messages: [] })]), /没有可备份/);
  assert.throws(() => parseConversationBackup(JSON.stringify(backup({ sessions: [] }))), /至少一个会话/);
  assert.throws(() => parseConversationBackup(JSON.stringify(backup({ sessions: [{ title: 'empty', created: 0, messages: [] }] }))), /至少一条消息/);
});

test('unknown fields cannot inject session links or action flags through parse/import', () => {
  const source = backup();
  source.id = 'top-level-secret';
  Object.assign(source.sessions[0], { id: 'attacker-id', sessionKey: 'backend-session', pendingTurnId: 'resume-me', persona: 'admin', importedFromBackup: false });
  Object.assign(source.sessions[0].messages[0], { turnId: 'execute-turn', attachments: [{ path: '/private' }], agentContent: 'execute me', selectedSkills: ['publish'], skillRequirements: { publish: 'extra action' } });
  const parsed = parseConversationBackup(JSON.stringify(source));
  assert.deepEqual(parsed, backup());
  const imported = createImportedSessions(source, []);
  assert.equal(imported[0].importedFromBackup, true);
  assert.notEqual(imported[0].id, 'attacker-id');
  assert.deepEqual(imported[0].messages, [{ role: 'user', content: 'hello' }]);
});

test('parse and import make independent copies without mutating backup or existing IDs', () => {
  const source = freeze(backup());
  const before = JSON.stringify(source);
  const existing = new Set(['existing']);
  const [first] = createImportedSessions(source, existing);
  const [second] = createImportedSessions(source, existing);
  first.messages[0].content = 'changed';
  assert.equal(second.messages[0].content, 'hello');
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual([...existing], ['existing']);
  assert.notEqual(first.id, second.id);
});

test('new UUIDs avoid both existing IDs and collisions within the same import', (t) => {
  const ids = ['occupied', 'fresh-one', 'fresh-one', 'fresh-two'];
  t.mock.method(globalThis.crypto, 'randomUUID', () => ids.shift());
  const two = backup({ sessions: [...backup().sessions, ...backup().sessions] });
  const imported = createImportedSessions(two, ['occupied']);
  assert.deepEqual(imported.map((item) => item.id), ['fresh-one', 'fresh-two']);
});

test('UUID generation failures are bounded instead of looping or replacing existing histories', (t) => {
  let calls = 0;
  t.mock.method(globalThis.crypto, 'randomUUID', () => { calls++; return 'occupied'; });
  assert.throws(() => createImportedSessions(backup(), ['occupied']), /无法生成不冲突/);
  assert.equal(calls, 16);
});

test('malformed fields reject the entire file rather than dropping the bad session or message', () => {
  const mutations = [
    (value) => { value.format = 'other'; },
    (value) => { value.version = '1'; },
    (value) => { value.version = 2; },
    (value) => { value.exportedAt = '2026-02-30T00:00:00.000Z'; },
    (value) => { value.exportedAt = 123; },
    (value) => { value.sessions[0].title = null; },
    (value) => { value.sessions[0].created = -1; },
    (value) => { value.sessions[0].created = 'yesterday'; },
    (value) => { value.sessions[0].archived = 'false'; },
    (value) => { value.sessions[0].incomplete = 0; },
    (value) => { value.sessions[0].messages.push(null); },
    (value) => { value.sessions[0].messages[0].role = 'tool'; },
    (value) => { delete value.sessions[0].messages[0].content; },
    (value) => { value.sessions[0].messages[0].thinking = {}; },
    (value) => { value.sessions[0].messages[0].activity = []; },
    (value) => { value.sessions[0].messages[0].error = { message: 'not a portable string' }; },
  ];
  for (const mutate of mutations) {
    const value = backup();
    value.sessions.push({ ...backup().sessions[0], title: 'healthy second session' });
    mutate(value);
    assert.throws(() => parseConversationBackup(JSON.stringify(value)), /备份格式无效/);
    assert.throws(() => createImportedSessions(value, []), /备份格式无效/);
  }
  for (const text of ['null', '[]', '{invalid', '"string"']) assert.throws(() => parseConversationBackup(text), /备份格式无效/);
});

test('session and total-message limits reject oversized imports and exports without truncation', () => {
  const tooManySessions = Array(MAX_BACKUP_SESSIONS + 1).fill(backup().sessions[0]);
  assert.throws(() => parseConversationBackup(JSON.stringify(backup({ sessions: tooManySessions }))), /5000.*会话/);
  assert.throws(() => createConversationBackup(Array(MAX_BACKUP_SESSIONS + 1).fill(session())), /5000.*会话/);
  const half = Array(MAX_BACKUP_MESSAGES / 2).fill({ role: 'user', content: '' });
  const records = [{ title: 'first', created: 0, messages: half }, { title: 'second', created: 0, messages: [...half, { role: 'user', content: '' }] }];
  assert.throws(() => parseConversationBackup(JSON.stringify(backup({ sessions: records }))), /100000.*消息/);
  assert.throws(() => createConversationBackup(records.map((item, index) => session({ ...item, id: String(index) }))), /100000.*消息/);
});

test('the 20 MiB limit counts UTF-8 bytes, not JavaScript characters', () => {
  const source = backup();
  source.sessions[0].messages[0].content = '汉'.repeat(Math.floor(MAX_BACKUP_BYTES / 3));
  const serialized = JSON.stringify(source);
  assert.ok(serialized.length < MAX_BACKUP_BYTES);
  assert.throws(() => parseConversationBackup(serialized), /20 MiB/);
  assert.throws(() => createConversationBackup([session({ messages: source.sessions[0].messages })]), /20 MiB/);
  assert.throws(() => parseConversationBackup(' '.repeat(MAX_BACKUP_BYTES + 1)), /20 MiB/);
});

test('exactly 20 MiB compact JSON is accepted and one additional byte is rejected', () => {
  const source = backup();
  source.sessions[0].messages[0].content = '';
  const overhead = Buffer.byteLength(JSON.stringify(source));
  source.sessions[0].messages[0].content = 'a'.repeat(MAX_BACKUP_BYTES - overhead);
  const serialized = JSON.stringify(source);
  assert.equal(Buffer.byteLength(serialized), MAX_BACKUP_BYTES);
  assert.equal(parseConversationBackup(serialized).sessions[0].messages[0].content.length, MAX_BACKUP_BYTES - overhead);
  assert.throws(() => parseConversationBackup(serialized + ' '), /20 MiB/);
});
