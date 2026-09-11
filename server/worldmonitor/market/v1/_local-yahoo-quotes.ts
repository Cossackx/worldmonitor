/**
 * Private local preview quote source (VITE_PRIVATE_WORKSPACE=1 only).
 *
 * The hosted product answers ListMarketQuotes / ListCommodityQuotes from the
 * Railway seed snapshots in Redis and never fetches quotes at request time
 * beyond the bounded Finnhub/Alpha Vantage gap fetch. The private preview
 * launcher (scripts/local-ais-preview.mjs) runs neither Redis nor the seeders,
 * so every seed read is a miss and the Markets / Metals & Materials / Energy
 * Complex panels sit on "Temporarily unavailable — retrying" forever.
 *
 * When — and only when — the private flag is set, a seed miss falls back to
 * the keyless Yahoo Finance `spark` endpoint (the same upstream the seeders
 * themselves use, batched), cached in-process for the seed cadence so panel
 * refreshes do not fan out to Yahoo. Every gate returns `null` without the
 * flag, so hosted behaviour stays byte-identical. Mirrors the private-preview
 * gates in server/worldmonitor/military/v1/list-military-flights.ts.
 */

import type { MarketQuote } from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { CHROME_UA } from '../../../_shared/constants';

/**
 * Honest self-identifying UA for the private preview's own Yahoo calls, the
 * same string the military-flight local fallback sends. Kept distinct from the
 * shared CHROME_UA on purpose: the local AIS relay's seed loops already use
 * CHROME_UA against Yahoo from this same egress, and Yahoo throttles per
 * UA/IP, so the dashboard's light request-time traffic must not share that
 * budget. Hosted paths never see this string.
 */
export const LOCAL_PREVIEW_USER_AGENT = 'WorldMonitor-local-preview/1.0';

const SPARK_URL = 'https://query1.finance.yahoo.com/v8/finance/spark';
/** Symbols per spark request; Yahoo accepts more, this keeps URLs short. */
const SPARK_CHUNK_SIZE = 20;
/** Matches the 5-minute Railway seed cadence so local quotes age like seeded ones. */
const QUOTE_TTL_MS = 5 * 60_000;
const SPARK_TIMEOUT_MS = 10_000;

export function isPrivateWorkspace(): boolean {
  return process.env.VITE_PRIVATE_WORKSPACE === '1';
}

/**
 * UA for Yahoo Finance fetches made at request time (analyze-stock,
 * backtest). Hosted: the shared CHROME_UA, unchanged. Private preview: the
 * self-identifying local UA (see LOCAL_PREVIEW_USER_AGENT).
 */
export function yahooUserAgent(): string {
  return isPrivateWorkspace() ? LOCAL_PREVIEW_USER_AGENT : CHROME_UA;
}

interface SparkEntry {
  symbol?: string;
  timestamp?: number[];
  close?: Array<number | null>;
  chartPreviousClose?: number | null;
  previousClose?: number | null;
}

const quoteCache = new Map<string, { quote: MarketQuote; expiresAt: number }>();

export function __clearLocalYahooQuoteCacheForTests(): void {
  quoteCache.clear();
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * One spark entry → the seed quote shape. Price is the last finite close,
 * change is against the previous finite close (or Yahoo's previous-close
 * meta when the series has a single point), sparkline is the close series —
 * the same derivation scripts/_seed-utils.mjs#parseYahooChart applies to the
 * chart endpoint. Returns null for an entry with no usable close at all.
 */
export function parseSparkQuote(symbol: string, entry: SparkEntry | null | undefined): MarketQuote | null {
  const closes = (Array.isArray(entry?.close) ? entry.close : [])
    .map(finite)
    .filter((value): value is number => value != null);
  if (closes.length === 0) return null;
  const price = closes[closes.length - 1]!;
  const prevClose = closes.length >= 2
    ? closes[closes.length - 2]!
    : (finite(entry?.chartPreviousClose) ?? finite(entry?.previousClose) ?? price);
  const change = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
  return {
    symbol,
    name: symbol,
    display: symbol,
    price,
    change: +change.toFixed(2),
    sparkline: closes.map((value) => +value.toFixed(4)),
  };
}

/**
 * Resolve quotes for `symbols` through the keyless Yahoo spark endpoint.
 * Returns null when the private flag is absent (hosted: never called into),
 * otherwise a map of the symbols Yahoo answered. Symbols Yahoo does not know
 * are simply absent; a failed chunk is skipped so one bad batch cannot blank
 * the whole panel.
 */
export async function fetchLocalYahooQuotes(symbols: readonly string[]): Promise<Map<string, MarketQuote> | null> {
  if (!isPrivateWorkspace()) return null;
  const now = Date.now();
  const resolved = new Map<string, MarketQuote>();
  const missing: string[] = [];
  for (const symbol of new Set(symbols)) {
    const cached = quoteCache.get(symbol);
    if (cached && cached.expiresAt > now) resolved.set(symbol, cached.quote);
    else missing.push(symbol);
  }

  for (let i = 0; i < missing.length; i += SPARK_CHUNK_SIZE) {
    const chunk = missing.slice(i, i + SPARK_CHUNK_SIZE);
    const params = new URLSearchParams({ symbols: chunk.join(','), range: '1mo', interval: '1d' });
    try {
      const response = await fetch(`${SPARK_URL}?${params}`, {
        headers: { Accept: 'application/json', 'User-Agent': LOCAL_PREVIEW_USER_AGENT },
        signal: AbortSignal.timeout(SPARK_TIMEOUT_MS),
      });
      if (!response.ok) {
        console.warn(`[local-yahoo-quotes] spark HTTP ${response.status} for ${chunk.length} symbols`);
        continue;
      }
      const data = (await response.json()) as Record<string, SparkEntry> | null;
      if (!data || typeof data !== 'object') continue;
      for (const [key, entry] of Object.entries(data)) {
        const symbol = typeof entry?.symbol === 'string' && entry.symbol ? entry.symbol : key;
        const quote = parseSparkQuote(symbol, entry);
        if (!quote) continue;
        quoteCache.set(symbol, { quote, expiresAt: now + QUOTE_TTL_MS });
        resolved.set(symbol, quote);
      }
    } catch (err) {
      console.warn(`[local-yahoo-quotes] spark fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return resolved;
}
