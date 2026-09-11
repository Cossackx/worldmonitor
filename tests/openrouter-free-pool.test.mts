import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  __resetFreePoolForTests,
  getOpenRouterFreePool,
  isFreeModelCooling,
  isFreePoolEnabled,
  orderFreePool,
  recordFreeModelFailure,
  recordFreeModelSuccess,
  selectFreeChatModels,
} from '../server/_shared/openrouter-free-pool';

const originalFetch = globalThis.fetch;
const savedEnv = new Map(['LLM_FREE_POOL', 'OPENROUTER_API_KEY', 'LLM_FREE_MODEL_POOL', 'OPENROUTER_FREE_PRIMARY_MODEL', 'OPENROUTER_FREE_BACKUP_MODEL'].map((k) => [k, process.env[k]]));

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of savedEnv) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  __resetFreePoolForTests();
});

const catalogue = [
  { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', context_length: 1_000_000, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  { id: 'google/gemma-4-31b-it:free', context_length: 262_144, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['image', 'text', 'video'], output_modalities: ['text'] } },
  { id: 'google/lyria-3-pro-preview', context_length: 1_048_576, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text', 'audio'] } },
  { id: 'nvidia/nemotron-3.5-content-safety:free', context_length: 128_000, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  { id: 'openrouter/free', context_length: 200_000, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  { id: 'openai/gpt-4o', context_length: 128_000, pricing: { prompt: '0.0000025', completion: '0.00001' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  { id: 'liquid/lfm-2.5-2.6b:free', context_length: 65_536, pricing: { prompt: 0, completion: 0 }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
];

test('selects only text chat models that are actually free, largest context first', () => {
  assert.deepEqual(selectFreeChatModels(catalogue), [
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'google/gemma-4-31b-it:free',
    'liquid/lfm-2.5-2.6b:free',
  ]);
});

test('orders preferred models first without duplicates', () => {
  assert.deepEqual(orderFreePool(['a:free', 'b:free', 'c:free'], ['b:free', undefined, 'z:free', 'b:free']), ['b:free', 'z:free', 'a:free', 'c:free']);
});

test('pool is disabled without the flag and the key', () => {
  delete process.env.LLM_FREE_POOL; delete process.env.OPENROUTER_API_KEY;
  assert.equal(isFreePoolEnabled(), false);
  process.env.LLM_FREE_POOL = '1';
  assert.equal(isFreePoolEnabled(), false);
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  assert.equal(isFreePoolEnabled(), true);
});

test('discovers the pool from /models, caches it, and honours the configured legs first', async () => {
  process.env.LLM_FREE_POOL = '1'; process.env.OPENROUTER_API_KEY = 'sk-or-test';
  process.env.OPENROUTER_FREE_PRIMARY_MODEL = 'google/gemma-4-31b-it:free';
  process.env.OPENROUTER_FREE_BACKUP_MODEL = 'liquid/lfm-2.5-2.6b:free';
  delete process.env.LLM_FREE_MODEL_POOL;
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; return Response.json({ data: catalogue }); }) as typeof fetch;
  const first = await getOpenRouterFreePool('override/model:free');
  assert.deepEqual(first, ['override/model:free', 'google/gemma-4-31b-it:free', 'liquid/lfm-2.5-2.6b:free', 'nvidia/nemotron-3-ultra-550b-a55b:free']);
  await getOpenRouterFreePool();
  assert.equal(calls, 1, 'catalogue is cached per process');
});

test('an explicit LLM_FREE_MODEL_POOL replaces discovery', async () => {
  process.env.LLM_FREE_POOL = '1'; process.env.OPENROUTER_API_KEY = 'sk-or-test';
  process.env.LLM_FREE_MODEL_POOL = 'x/one:free, y/two:free';
  delete process.env.OPENROUTER_FREE_PRIMARY_MODEL; delete process.env.OPENROUTER_FREE_BACKUP_MODEL;
  globalThis.fetch = (async () => { throw new Error('must not be called'); }) as typeof fetch;
  assert.deepEqual(await getOpenRouterFreePool(), ['x/one:free', 'y/two:free']);
});

test('discovery failure degrades to the configured legs instead of throwing', async () => {
  process.env.LLM_FREE_POOL = '1'; process.env.OPENROUTER_API_KEY = 'sk-or-test';
  process.env.OPENROUTER_FREE_PRIMARY_MODEL = 'p:free'; process.env.OPENROUTER_FREE_BACKUP_MODEL = 'b:free';
  delete process.env.LLM_FREE_MODEL_POOL;
  globalThis.fetch = (async () => new Response('nope', { status: 503 })) as typeof fetch;
  assert.deepEqual(await getOpenRouterFreePool(), ['p:free', 'b:free']);
});

test('rate limits, outages and delistings cool a model down for different spans; success clears it', () => {
  const t0 = 1_000_000;
  recordFreeModelFailure('m:free', 429, t0);
  assert.equal(isFreeModelCooling('m:free', t0 + 60_000), true);
  assert.equal(isFreeModelCooling('m:free', t0 + 91_000), false);
  recordFreeModelFailure('m:free', 503, t0);
  assert.equal(isFreeModelCooling('m:free', t0 + 31_000), false);
  recordFreeModelFailure('m:free', 404, t0);
  assert.equal(isFreeModelCooling('m:free', t0 + 60 * 60_000), true);
  recordFreeModelSuccess('m:free');
  assert.equal(isFreeModelCooling('m:free', t0), false);
  recordFreeModelFailure('m:free', 401, t0);
  assert.equal(isFreeModelCooling('m:free', t0 + 1), false, 'credential errors are not model cooldowns');
});
