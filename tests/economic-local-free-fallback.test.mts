/**
 * Private local preview (VITE_PRIVATE_WORKSPACE=1) economic fallbacks: with no
 * Redis seed, GetFredSeries / GetFredSeriesBatch answer from FRED's keyless
 * fredgraph.csv export and GetEconomicStress computes the seeder's composite
 * locally. Without the flag every hosted path stays fail-closed and never
 * touches FRED. Companion to tests/military-flights-local-free-fallback.test.mjs.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { FredSeries, ServerContext } from '../src/generated/server/worldmonitor/economic/v1/service_server';
import {
  __clearLocalFredCacheForTests,
  LOCAL_PREVIEW_USER_AGENT,
  computeStressIndexFromSeries,
  parseFredGraphCsv,
} from '../server/worldmonitor/economic/v1/_local-fred';
import { getFredSeriesBatch } from '../server/worldmonitor/economic/v1/get-fred-series-batch';
import { getFredSeries } from '../server/worldmonitor/economic/v1/get-fred-series';
import { getEconomicStress } from '../server/worldmonitor/economic/v1/get-economic-stress';

const CTX = { request: new Request('http://127.0.0.1:4200/api/economic/v1/get-fred-series-batch') } as ServerContext;
const ENV_KEYS = ['VITE_PRIVATE_WORKSPACE', 'LOCAL_API_MODE', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

const LATEST: Record<string, number> = { T10Y2Y: 0.3, T10Y3M: -0.2, VIXCLS: 18, STLFSI4: -0.8, ICSA: 206000, DGS10: 4.1, UNRATE: 4.2 };

function csv(id: string, latest: number): string {
  return `observation_date,${id}\n2026-08-01,${(latest - 0.1).toFixed(2)}\n2026-08-02,.\n2026-08-03,${latest}\n`;
}

/** Records every fetch; answers fredgraph.csv for `known` series only. */
function installFredFetch(known: Record<string, number>) {
  const calls: Array<{ url: string; userAgent: string | null }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, userAgent: new Headers(init?.headers).get('User-Agent') });
    if (url.startsWith('https://fred.stlouisfed.org/graph/fredgraph.csv?')) {
      const id = new URL(url).searchParams.get('id') ?? '';
      if (known[id] != null) return new Response(csv(id, known[id]!), { status: 200, headers: { 'content-type': 'text/csv' } });
      return new Response('Bad Request', { status: 400 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return calls;
}

function series(id: string, values: number[]): FredSeries {
  return { seriesId: id, title: id, units: '', frequency: '', observations: values.map((value, i) => ({ date: `2026-08-0${i + 1}`, value })) };
}

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  __clearLocalFredCacheForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of savedEnv) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('parseFredGraphCsv', () => {
  it('parses observations and drops FRED missing-value sentinels', () => {
    const parsed = parseFredGraphCsv(csv('DGS10', 4.1), 'DGS10');
    assert.equal(parsed?.seriesId, 'DGS10');
    assert.deepEqual(parsed?.observations, [{ date: '2026-08-01', value: 4 }, { date: '2026-08-03', value: 4.1 }]);
  });

  it('rejects anything that is not a fredgraph export for the requested series', () => {
    assert.equal(parseFredGraphCsv('<html>Bad Request</html>', 'DGS10'), null);
    assert.equal(parseFredGraphCsv(csv('UNRATE', 4.2), 'DGS10'), null);
    assert.equal(parseFredGraphCsv('observation_date,DGS10\n2026-08-01,.\n', 'DGS10'), null);
  });
});

describe('computeStressIndexFromSeries', () => {
  it('reproduces the seeder composite and reports GSCPI as the only permitted missing component', () => {
    const byId = new Map(Object.entries(LATEST).map(([id, v]) => [id, series(id, [v - 1, v])]));
    const result = computeStressIndexFromSeries(byId, '2026-09-11T00:00:00.000Z');
    assert.ok(result && !result.unavailable);
    // Weighted mean over the five available components (weights sum to 0.85).
    const expected = Math.round(((10 * 0.20) + (46.666666 * 0.15) + (4.6153846 * 0.20) + (3.3333333 * 0.20) + (8.125 * 0.10)) / 0.85 * 10) / 10;
    assert.equal(result.compositeScore, expected);
    assert.equal(result.label, 'Low');
    assert.equal(result.seededAt, '2026-09-11T00:00:00.000Z');
    const gscpi = result.components.find((c) => c.id === 'GSCPI');
    assert.deepEqual(gscpi, { id: 'GSCPI', label: 'Supply Chain', rawValue: 0, score: 0, weight: 0.15, missing: true });
    assert.equal(result.components.filter((c) => c.missing).length, 1);
  });

  it('refuses a partial composite when a FRED component is missing', () => {
    const byId = new Map(Object.entries(LATEST).filter(([id]) => id !== 'VIXCLS').map(([id, v]) => [id, series(id, [v])]));
    assert.equal(computeStressIndexFromSeries(byId), null);
  });
});

describe('FRED RPCs private local preview fallback', () => {
  it('GetFredSeriesBatch fills seed misses from fredgraph.csv with the local UA and honours the limit', async () => {
    process.env.VITE_PRIVATE_WORKSPACE = '1';
    const calls = installFredFetch(LATEST);
    const result = await getFredSeriesBatch(CTX, { seriesIds: ['DGS10', 'UNRATE', 'GSCPI'], limit: 1 });
    assert.equal(result.requested, 3);
    assert.equal(result.fetched, 2, 'GSCPI is not on FRED and stays absent');
    assert.deepEqual(result.results['DGS10']?.observations, [{ date: '2026-08-03', value: 4.1 }]);
    assert.equal(result.results['UNRATE']?.seriesId, 'UNRATE');
    assert.ok(calls.every((c) => c.userAgent === LOCAL_PREVIEW_USER_AGENT));
    assert.equal(calls.length, 3);
  });

  it('GetFredSeries answers a single seed miss the same way', async () => {
    process.env.VITE_PRIVATE_WORKSPACE = '1';
    installFredFetch(LATEST);
    const result = await getFredSeries(CTX, { seriesId: 'dgs10', limit: 120 });
    assert.equal(result.series?.seriesId, 'DGS10');
    assert.equal(result.series?.observations.length, 2);
  });

  it('GetEconomicStress computes the composite locally from the fetched components', async () => {
    process.env.VITE_PRIVATE_WORKSPACE = '1';
    const calls = installFredFetch(LATEST);
    const result = await getEconomicStress(CTX, {});
    assert.equal(result.unavailable, false);
    assert.equal(result.label, 'Low');
    assert.equal(result.components.length, 6);
    assert.deepEqual(calls.map((c) => new URL(c.url).searchParams.get('id')).sort(), ['ICSA', 'STLFSI4', 'T10Y2Y', 'T10Y3M', 'VIXCLS']);
  });

  it('GetEconomicStress stays unavailable when a FRED component cannot be fetched', async () => {
    process.env.VITE_PRIVATE_WORKSPACE = '1';
    installFredFetch({ ...LATEST, STLFSI4: undefined as unknown as number });
    const result = await getEconomicStress(CTX, {});
    assert.equal(result.unavailable, true);
  });

  it('hosted paths return the seed-miss responses and never call FRED when the flag is absent', async () => {
    const calls = installFredFetch(LATEST);
    const batch = await getFredSeriesBatch(CTX, { seriesIds: ['DGS10'], limit: 120 });
    assert.deepEqual(batch, { results: {}, fetched: 0, requested: 1 });
    assert.deepEqual(await getFredSeries(CTX, { seriesId: 'DGS10', limit: 120 }), { series: undefined });
    assert.equal((await getEconomicStress(CTX, {})).unavailable, true);
    assert.equal(calls.length, 0);
  });
});
