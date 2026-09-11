/**
 * Private local preview (VITE_PRIVATE_WORKSPACE=1) prediction fallback: with
 * no Redis seed, ListPredictionMarkets answers from keyless Polymarket Gamma
 * events reduced with the seeder's rules. Without the flag the hosted path
 * stays fail-closed and never touches Gamma. Companion to
 * tests/military-flights-local-free-fallback.test.mjs.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { ServerContext } from '../src/generated/server/worldmonitor/prediction/v1/service_server';
import {
  __clearLocalPolymarketCacheForTests,
  LOCAL_PREVIEW_USER_AGENT,
  buildLocalBootstrap,
  classifyByTags,
} from '../server/worldmonitor/prediction/v1/_local-polymarket';
import { listPredictionMarkets } from '../server/worldmonitor/prediction/v1/list-prediction-markets';

const CTX = { request: new Request('http://127.0.0.1:4200/api/prediction/v1/list-prediction-markets') } as ServerContext;
const ENV_KEYS = ['VITE_PRIVATE_WORKSPACE', 'LOCAL_API_MODE', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const NOW = Date.parse('2026-09-11T12:00:00Z');
const FUTURE = '2027-01-01T00:00:00Z';

function market(question: string, yes: number, volume: number, extra: Record<string, unknown> = {}) {
  return { question, outcomePrices: JSON.stringify([String(yes), String(1 - yes)]), volumeNum: volume, endDate: FUTURE, ...extra };
}

const EVENTS = [
  { id: 1, title: 'Ceasefire in Ukraine by 2027?', slug: 'ukraine-ceasefire', volume: 250000, tags: [{ slug: 'ukraine' }, { slug: 'politics' }],
    markets: [market('Ceasefire by June?', 0.2, 50000), market('Ceasefire by December?', 0.62, 120000), market('Closed market', 0.9, 999999, { closed: true })] },
  { id: 2, title: 'GPT-6 released in 2026?', slug: 'gpt-6', volume: 80000, tags: [{ slug: 'ai' }, { slug: 'business' }], markets: [market('GPT-6 in 2026?', 0.35, 80000)] },
  { id: 3, title: 'Fed cuts in October?', slug: 'fed-october', volume: 3_000_000, tags: [{ slug: 'fed' }], markets: [market('Fed cuts in October?', 0.55, 3_000_000)] },
  { id: 4, title: 'Untagged market', slug: 'untagged', volume: 5000, tags: [], markets: [market('Untagged?', 0.5, 5000)] },
  { id: 5, title: 'Tiny market', slug: 'tiny', volume: 200, tags: [{ slug: 'ukraine' }], markets: [market('Tiny?', 0.5, 200)] },
  { id: 6, title: 'Closed event', slug: 'closed', closed: true, volume: 90000, tags: [{ slug: 'ukraine' }], markets: [market('Closed?', 0.5, 90000)] },
  { id: 7, title: 'Expired only', slug: 'expired', volume: 90000, tags: [{ slug: 'ukraine' }], markets: [market('Expired?', 0.5, 90000, { endDate: '2026-01-01T00:00:00Z' })] },
  { id: 8, title: 'Unpriced', slug: 'unpriced', volume: 90000, tags: [{ slug: 'ukraine' }], markets: [{ question: 'No prices?', volumeNum: 90000, endDate: FUTURE }] },
  { id: 1, title: 'Duplicate of event 1 from another tag', slug: 'dup', volume: 999999, tags: [{ slug: 'ai' }], markets: [market('Dup?', 0.5, 999999)] },
];

/** Records every fetch; answers Gamma /events with the fixture for every tag. */
function installGammaFetch() {
  const calls: Array<{ url: string; userAgent: string | null }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, userAgent: new Headers(init?.headers).get('User-Agent') });
    if (url.startsWith('https://gamma-api.polymarket.com/events?')) return Response.json(EVENTS);
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return calls;
}

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  __clearLocalPolymarketCacheForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of savedEnv) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('classifyByTags', () => {
  it('applies the seeder precedence geopolitical > tech > finance with finance as the default', () => {
    assert.equal(classifyByTags(['crypto', 'ukraine']), 'geopolitical');
    assert.equal(classifyByTags(['crypto', 'business']), 'tech');
    assert.equal(classifyByTags(['fed']), 'finance');
    assert.equal(classifyByTags(['politics']), 'finance', '`politics` is deliberately not a geo tag');
    assert.equal(classifyByTags([]), 'finance');
  });
});

describe('buildLocalBootstrap', () => {
  it('reduces Gamma events with the seeder rules into disjoint pools', () => {
    const pools = buildLocalBootstrap(EVENTS, NOW);
    assert.deepEqual(pools.geopolitical.map((m) => m.title), ['Ceasefire by December?'], 'top ACTIVE market by volume wins; closed/expired/unpriced/tiny/duplicate events drop');
    assert.deepEqual(pools.geopolitical[0], {
      title: 'Ceasefire by December?', yesPrice: 62, volume: 250000, url: 'https://polymarket.com/event/ukraine-ceasefire', endDate: FUTURE, source: 'polymarket',
    });
    assert.deepEqual(pools.tech.map((m) => m.title), ['GPT-6 in 2026?']);
    assert.deepEqual(pools.finance.map((m) => m.title), ['Fed cuts in October?', 'Untagged?'], 'volume-sorted, untagged defaults to finance');
    assert.equal(pools.fetchedAt, NOW);
  });
});

describe('ListPredictionMarkets private local preview fallback', () => {
  it('answers a seed miss from Gamma for the dashboard category and caches the payload', async () => {
    process.env.VITE_PRIVATE_WORKSPACE = '1';
    const calls = installGammaFetch();
    const result = await listPredictionMarkets(CTX, { category: 'politics', query: '', pageSize: 50, cursor: '' });
    assert.equal(result.dataAvailable, true);
    assert.deepEqual(result.markets.map((m) => m.title), ['Ceasefire by December?']);
    assert.equal(result.markets[0]!.yesPrice, 0.62);
    assert.equal(result.markets[0]!.source, 'MARKET_SOURCE_POLYMARKET');
    assert.equal(result.markets[0]!.url, 'https://polymarket.com/event/ukraine-ceasefire');
    assert.ok(result.fetchedAt > 0);
    assert.ok(calls.length > 0 && calls.every((c) => c.userAgent === LOCAL_PREVIEW_USER_AGENT));

    const before = calls.length;
    const all = await listPredictionMarkets(CTX, { category: '', query: '', pageSize: 50, cursor: '' });
    assert.equal(calls.length, before, 'second call is served from the in-process cache');
    assert.equal(all.markets.length, 4, 'no category unions the three pools');
  });

  it('stays unavailable and never calls Gamma when the private flag is absent', async () => {
    const calls = installGammaFetch();
    const result = await listPredictionMarkets(CTX, { category: 'politics', query: '', pageSize: 50, cursor: '' });
    assert.deepEqual(result, { markets: [], pagination: undefined, fetchedAt: 0, dataAvailable: false });
    assert.equal(calls.length, 0);
  });
});
