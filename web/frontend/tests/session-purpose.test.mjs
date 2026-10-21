import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './load-ts.mjs';
const { sessionPurpose } = await loadTsModule('../src/lib/sessionPurpose.ts', import.meta.url);
const { createConversationBackup, parseConversationBackup, createImportedSessions } = await loadTsModule('../src/lib/conversationBackup.ts', import.meta.url);
const session = { id: 'purpose', title: '可自由重命名', created: 1, messages: [{ role: 'user', content: '普通提问' }] };

test('purpose uses explicit origin metadata, frozen analysis binding and historical breakdown markers', () => {
  assert.equal(sessionPurpose(session).kind, 'general');
  assert.equal(sessionPurpose({ ...session, title: '生成内容与分析资料' }).kind, 'general');
  assert.equal(sessionPurpose({ ...session, conversationType: 'content-generation' }).kind, 'generation');
  assert.equal(sessionPurpose({ ...session, analysisContext: { kind: 'content-analysis' }, conversationType: 'general' }).detail, '分析资料 · 作品分析');
  assert.equal(sessionPurpose({ ...session, messages: [{ role: 'user', kind: 'breakdown', content: '拆解材料' }] }).kind, 'analysis');
});

test('portable backup round trip preserves type without carrying an executable analysis binding', () => {
  for (const conversationType of ['content-generation', 'account-analysis', 'content-analysis', 'general']) {
    const original = { ...session, conversationType, analysisContext: undefined };
    const parsed = parseConversationBackup(JSON.stringify(createConversationBackup([original])));
    const imported = createImportedSessions(parsed, [session.id])[0];
    assert.equal(imported.conversationType, conversationType);
    assert.equal(imported.analysisContext, undefined);
    assert.equal(imported.importedFromBackup, true);
    assert.equal(sessionPurpose(imported).kind, sessionPurpose(original).kind);
  }
});
