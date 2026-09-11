import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

const saved = new Map(['LLM_FREE_ONLY', 'OPENROUTER_API_KEY', 'OPENROUTER_FREE_PRIMARY_MODEL'].map((k) => [k, process.env[k]]));
afterEach(() => { for (const [k, v] of saved) { if (v == null) delete process.env[k]; else process.env[k] = v; } });

async function load() {
  // Fresh module per test so env-driven constants are re-evaluated.
  const mod = await import(`../server/_shared/llm.ts?t=${Date.now()}-${Math.random()}`);
  return mod as typeof import('../server/_shared/llm.ts');
}

test('LLM_FREE_ONLY=1 keeps the paid openrouter rung off the paid default model', async () => {
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  process.env.LLM_FREE_ONLY = '1';
  const { getProviderCredentials } = await load();
  const creds = getProviderCredentials('openrouter');
  assert.ok(creds);
  assert.match(creds!.model, /:free$/, `expected a free model, got ${creds!.model}`);
  const pinned = getProviderCredentials('openrouter', { model: 'some/explicit:free' });
  assert.equal(pinned!.model, 'some/explicit:free', 'explicit overrides still win');
});

test('without LLM_FREE_ONLY the openrouter rung keeps its paid default (hosted behaviour)', async () => {
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  delete process.env.LLM_FREE_ONLY;
  const { getProviderCredentials } = await load();
  const creds = getProviderCredentials('openrouter');
  assert.ok(creds);
  assert.doesNotMatch(creds!.model, /:free$/);
});
