import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './load-ts.mjs';
const { providerBrand } = await loadTsModule('../src/lib/providerBrand.ts', import.meta.url);
test('brand matching distinguishes real host, compatible protocol, model identity and unknown providers', () => {
  const row = { slot: 'anthropic', name: 'anthropic', model: 'kimi-k3', baseUrl: 'https://relay.example/v1' };
  assert.equal(providerBrand(row), 'moonshot');
  assert.equal(providerBrand({ ...row, baseUrl: 'https://api.anthropic.com' }), 'claude');
  assert.equal(providerBrand({ ...row, baseUrl: 'https://api.anthropic.com.evil.example', name: 'unknown', model: 'other' }), null);
  assert.equal(providerBrand({ ...row, model: 'glm-5.3-flash' }), 'zhipu');
  assert.equal(providerBrand({ ...row, name: 'unknown', model: 'other', baseUrl: 'invalid draft' }), null);
});
