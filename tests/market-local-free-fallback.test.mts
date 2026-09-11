/**
 * Private local preview (VITE_PRIVATE_WORKSPACE=1) market fallbacks: with no
 * Redis seed, ListMarketQuotes / ListCommodityQuotes answer from the keyless
 * Yahoo spark batch, and request-time Yahoo calls carry the self-identifying
 * local UA. Without the flag every hosted path stays fail-closed and never
 * touches Yahoo. Companion to tests/military-flights-local-free-fallback.test.mjs.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { ServerContext } from '../src/generated/server/worldmonitor/market/v1/service_server';
import { CHROME_UA } from '../server/_shared/constants';
import {
  __clearLocalYahooQuoteCacheForTests,
  LOCAL_PREVIEW_USER_AGENT,
  parseSparkQuote,
  yahooUserAgent,
} from '../server/worldmonitor/market/v1/_local-yahoo-quotes';
import { listMarketQuotes } from '../server/worldmonitor/market/v1/list-market-quotes';
import { listCommodityQuotes } from '../server/worldmonitor/market/v1/list-commodity-quotes';
import { fetchYahooHistoryOutcome } from '../server/worldmonitor/market/v1/analyze-stock';

const CTX = { request: new Request('http://127.0.0.1:4200/api/market/v1/list-market-quotes') } as ServerContext;
const ENV_KEYS = ['VITE_PRIVATE_WORKSPACE', 'LOCAL_API_MODE', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'FINNHUB_API_KEY', 'ALPHA_VANTAGE_API_KEY'] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

function sparkEntry(symbol: string, closes: number[]) {
  return { symbol, timestamp: closes.map((_, i) => 1_789_000_000 + i * 86_400), close: closes, chartPreviousClose: closes[0] };
}

/** Records every fetch; answers the Yahoo spark endpoint for `known` symbols only. */
function installSparkFetch(known: Record<string, number[]>) {
  const calls: Array<{ url: string; userAgent: string | null }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, userAgent: new Headers(init?.headers).get('User-Agent') });
    if (url.startsWith('https://query1.finance.yahoo.com/v8/finance/spark?')) {
      const requested = (new URL(url).searchParams.get('symbols') ?? '').split(',');
      const body: Record<string, unknown> = {};
      for (const symbol of requested) if (known[symbol]) body[symbol] = sparkEntry(symbol, known[symbol]!);
      return Response.json(body);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return calls;
}

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  __clearLocalYahooQuoteCacheForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of savedEnv) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('parseSparkQuote', () => {
  it('derives price, change vs previous close and the sparkline from the close series', () => {
    const quote = parseSparkQuote('AAPL', sparkEntry('AAPL', [100, 102, 104.5]));
    assert.deepEqual(quote, { symbol: 'AAPL', name: 'AAPL', display: 'AAPL', price: 104.5, change: 2.45, sparkline: [100, 102, 104.5] });
  });

  it('skips null closes and returns null for an entry with no usable close', () => {
    assert.equal(parseSparkQuote('X', { close: [null, null] }), null);
    assert.equal(parseSparkQuote('X', undefined), null);
    assert.equal(parseSparkQuote('X', { close: [null, 5] })?.price, 5);
  });
});

describe('ListMarketQuotes private local preview fallback', () => {
  it('answers a seed miss from the keyless Yahoo spark batch, in requested order, with misses reported', async () => {
    process.env.VITE_PRIVATE_WORKSPACE = '1';
    const calls = installSparkFetch({ AAPL: [100, 101], '^GSPC': [5000, 5050] });

    const result = await listMarketQuotes(CTX, { symbols: ['^GSPC', 'AAPL', 'ZZZZ'] });

    assert.deepEqual(result.quotes.map((q) => q.symbol), ['^GSPC', 'AAPL']);
    assert.equal(result.quotes[1]!.price, 101);
    assert.deepEqual(result.unavailableSymbols, [{ symbol: 'ZZZZ', reason: 'MARKET_QUOTE_UNAVAILABLE_REASON_NOT_FOUND' }]);
    assert.equal(result.finnhubSkipped, false);
    assert.ok(result.asOf, 'asOf is stamped for a live local answer');
    const spark = calls.filter((c) => c.url.includes('/v8/finance/spark?'));
    assert.equal(spark.length, 1);
    assert.equal(spark[0]!.userAgent, LOCAL_PREVIEW_USER_AGENT);
  });

  it('serves the second request for the same symbols from the in-process cache', async () => {
    process.env.VITE_PRIVATE_WORKSPACE = '1';
    const calls = installSparkFetch({ AAPL: [100, 101] });
    await listMarketQuotes(CTX, { symbols: ['AAPL'] });
    await listMarketQuotes(CTX, { symbols: ['AAPL'] });
    assert.equal(calls.length, 1);
  });

  it('stays SEED_UNAVAILABLE and never calls Yahoo when the private flag is absent', async () => {
    const calls = installSparkFetch({ AAPL: [100, 101] });
    const result = await listMarketQuotes(CTX, { symbols: ['AAPL'] });
    assert.deepEqual(result.quotes, []);
    assert.deepEqual(result.unavailableSymbols, [{ symbol: 'AAPL', reason: 'MARKET_QUOTE_UNAVAILABLE_REASON_SEED_UNAVAILABLE' }]);
    assert.equal(calls.length, 0);
  });
});

describe('ListCommodityQuotes private local preview fallback', () => {
  it('answers a seed miss with the configured name/display for the requested symbols', async () => {
    process.env.VITE_PRIVATE_WORKSPACE = '1';
    const calls = installSparkFetch({ 'GC=F': [2400, 2410], 'CL=F': [80, 79] });
    const result = await listCommodityQuotes(CTX, { symbols: ['CL=F', 'GC=F', 'NG=F'] });
    // Configured (seed) order, not request order; NG=F absent from Yahoo is simply omitted.
    assert.deepEqual(result.quotes.map((q) => [q.symbol, q.name, q.display]), [['GC=F', 'Gold', 'GOLD'], ['CL=F', 'Crude Oil WTI', 'OIL']]);
    assert.equal(result.quotes[1]!.change, -1.25);
    assert.equal(calls.filter((c) => c.url.includes('/v8/finance/spark?')).length, 1);
  });

  it('returns an empty seed response and never calls Yahoo when the private flag is absent', async () => {
    const calls = installSparkFetch({ 'GC=F': [2400, 2410] });
    assert.deepEqual(await listCommodityQuotes(CTX, { symbols: ['GC=F'] }), { quotes: [] });
    assert.equal(calls.length, 0);
  });
});

describe('request-time Yahoo user agent', () => {
  it('is CHROME_UA on hosted deployments and the local UA only under the private flag', () => {
    assert.equal(yahooUserAgent(), CHROME_UA);
    process.env.VITE_PRIVATE_WORKSPACE = '1';
    assert.equal(yahooUserAgent(), LOCAL_PREVIEW_USER_AGENT);
  });

  it('analyze-stock history fetches carry the selected UA', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('User-Agent') ?? '');
      return new Response('{}', { status: 503 });
    }) as typeof fetch;
    assert.equal((await fetchYahooHistoryOutcome('AAPL')).status, 'unavailable');
    process.env.VITE_PRIVATE_WORKSPACE = '1';
    assert.equal((await fetchYahooHistoryOutcome('AAPL')).status, 'unavailable');
    assert.deepEqual(seen, [CHROME_UA, LOCAL_PREVIEW_USER_AGENT]);
  });
});
