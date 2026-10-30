import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const require = createRequire(new URL('../package.json', import.meta.url));
const ts = require('typescript');
const source = readFileSync(new URL('../src/lib/chatQuestionStatus.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source.replace('export function', 'function') + '\nshouldKeepChatQuestion;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
});
const shouldKeepChatQuestion = runInNewContext(outputText, {});

test('question cards survive missing and nonterminal status checks', () => {
  for (const status of [undefined, '', 'pending', 'unknown', 'permission_error', 'future-status']) {
    assert.equal(shouldKeepChatQuestion(status), true, String(status));
  }
});

test('only authoritative terminal question states hide a replayed card', () => {
  for (const status of ['answered', 'resolved', 'expired', 'cancelled', 'canceled', 'not_found']) {
    assert.equal(shouldKeepChatQuestion(status), false, status);
  }
});
