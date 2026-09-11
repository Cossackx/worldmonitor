/**
 * Private local preview prediction-market source (VITE_PRIVATE_WORKSPACE=1
 * only).
 *
 * Hosted deployments read `prediction:markets-bootstrap:v1`, written by
 * scripts/seed-prediction-markets.mjs on Railway from Polymarket Gamma and
 * Kalshi. The private preview launcher runs no Redis and no seeder, so the
 * Predictions panel reports the upstream as down permanently.
 *
 * When — and only when — the private flag is set, a seed miss falls back to
 * the keyless Polymarket Gamma events endpoint, reduced with the seeder's own
 * rules (open events ≥ $1k volume, the highest-volume active market per
 * event, YES price from `outcomePrices`) and partitioned into the same three
 * disjoint pools by the venue tags in scripts/data/prediction-tags.json.
 * Deliberately narrower than the seeder: no Kalshi leg, no country index, and
 * no title-regex classification — tags alone decide the pool. Cached
 * in-process for the seed cadence. Every gate returns `null` without the
 * flag, so hosted behaviour stays byte-identical. Mirrors the private-preview
 * gates in server/worldmonitor/military/v1/list-military-flights.ts.
 */

import predictionTags from '../../../../scripts/data/prediction-tags.json';

/** Self-identifying UA, the same string the other local-preview fallbacks send. */
export const LOCAL_PREVIEW_USER_AGENT = 'WorldMonitor-local-preview/1.0';

const GAMMA_EVENTS_URL = 'https://gamma-api.polymarket.com/events';
/** Matches the seeder's 30-minute cron interval. */
const BOOTSTRAP_TTL_MS = 30 * 60_000;
const EVENTS_PER_TAG = 50;
const FETCH_TIMEOUT_MS = 10_000;
const FETCH_CONCURRENCY = 3;
/** Seeder threshold: events below this volume are noise. */
const MIN_EVENT_VOLUME = 1000;
const POOL_LIMIT = 100;

export function isPrivateWorkspace(): boolean {
  return process.env.VITE_PRIVATE_WORKSPACE === '1';
}

export interface LocalBootstrapMarket {
  title: string;
  yesPrice: number;
  volume: number;
  url: string;
  endDate?: string;
  source: 'polymarket';
}

export interface LocalBootstrapData {
  geopolitical: LocalBootstrapMarket[];
  tech: LocalBootstrapMarket[];
  finance: LocalBootstrapMarket[];
  fetchedAt: number;
}

export type LocalPool = keyof Omit<LocalBootstrapData, 'fetchedAt'>;

interface GammaMarket {
  question?: string;
  outcomePrices?: string;
  volumeNum?: number | string;
  volume?: number | string;
  closed?: boolean;
  endDate?: string;
}

interface GammaEvent {
  id?: string | number;
  title?: string;
  slug?: string;
  closed?: boolean;
  volume?: number | string;
  endDate?: string;
  tags?: Array<{ slug?: string }>;
  markets?: GammaMarket[];
}

const FETCH_TAGS: readonly string[] = [...new Set([
  ...predictionTags.geopolitical,
  ...predictionTags.tech,
  ...predictionTags.finance,
])];

const CLASSIFY: Record<LocalPool, ReadonlySet<string>> = {
  geopolitical: new Set(predictionTags.classify.geopolitical),
  tech: new Set(predictionTags.classify.tech),
  finance: new Set(predictionTags.classify.finance),
};

/** Seeder precedence: geopolitical, then tech, then finance; default finance. */
export function classifyByTags(tags: readonly string[]): LocalPool {
  const slugs = tags.map((t) => String(t ?? '').trim().toLowerCase());
  for (const pool of ['geopolitical', 'tech', 'finance'] as const) {
    if (slugs.some((slug) => CLASSIFY[pool].has(slug))) return pool;
  }
  return 'finance';
}

/** scripts/_prediction-scoring.mjs#parseYesPrice: first outcome price, in percent. */
export function parseYesPrice(market: GammaMarket): number | null {
  try {
    const prices = JSON.parse(market.outcomePrices || '[]') as unknown[];
    if (Array.isArray(prices) && prices.length >= 1) {
      const p = parseFloat(String(prices[0]));
      if (!Number.isNaN(p) && p >= 0 && p <= 1) return +(p * 100).toFixed(1);
    }
  } catch { /* unreadable → null, never a fabricated default */ }
  return null;
}

function marketVolume(market: GammaMarket): number {
  const value = Number(market.volumeNum ?? market.volume);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function isExpired(endDate: string | undefined, now: number): boolean {
  if (!endDate) return false;
  const ms = Date.parse(endDate);
  return Number.isFinite(ms) && ms < now;
}

/**
 * Reduce raw Gamma events to the bootstrap pools, one entry per event, the
 * seeder's way. Pure so it can be tested without the network.
 */
export function buildLocalBootstrap(events: readonly GammaEvent[], now: number = Date.now()): LocalBootstrapData {
  const pools: LocalBootstrapData = { geopolitical: [], tech: [], finance: [], fetchedAt: now };
  const seen = new Set<string>();
  for (const event of events) {
    const id = String(event?.id ?? '');
    if (!id || event.closed || seen.has(id)) continue;
    seen.add(id);
    const eventVolume = Number(event.volume ?? 0);
    if (!Number.isFinite(eventVolume) || eventVolume < MIN_EVENT_VOLUME) continue;
    const active = (event.markets ?? []).filter((m) => !m.closed && !isExpired(m.endDate, now));
    if (active.length === 0) continue;
    const top = active.reduce((best, m) => (marketVolume(m) > marketVolume(best) ? m : best));
    const yesPrice = parseYesPrice(top);
    if (yesPrice === null) continue;
    const entry: LocalBootstrapMarket = {
      title: top.question || event.title || '',
      yesPrice,
      volume: eventVolume,
      url: `https://polymarket.com/event/${event.slug ?? ''}`,
      ...(top.endDate ?? event.endDate ? { endDate: top.endDate ?? event.endDate } : {}),
      source: 'polymarket',
    };
    if (!entry.title) continue;
    pools[classifyByTags((event.tags ?? []).map((t) => t?.slug ?? ''))].push(entry);
  }
  for (const pool of ['geopolitical', 'tech', 'finance'] as const) {
    pools[pool].sort((a, b) => b.volume - a.volume);
    pools[pool] = pools[pool].slice(0, POOL_LIMIT);
  }
  return pools;
}

let bootstrapCache: { data: LocalBootstrapData; expiresAt: number } | null = null;

export function __clearLocalPolymarketCacheForTests(): void {
  bootstrapCache = null;
}

async function fetchEventsForTag(tag: string, now: Date): Promise<GammaEvent[]> {
  const params = new URLSearchParams({
    tag_slug: tag,
    closed: 'false',
    active: 'true',
    archived: 'false',
    end_date_min: now.toISOString(),
    order: 'volume',
    ascending: 'false',
    limit: String(EVENTS_PER_TAG),
  });
  try {
    const response = await fetch(`${GAMMA_EVENTS_URL}?${params}`, {
      headers: { Accept: 'application/json', 'User-Agent': LOCAL_PREVIEW_USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[local-polymarket] Gamma HTTP ${response.status} for tag ${tag}`);
      return [];
    }
    const data = (await response.json()) as unknown;
    return Array.isArray(data) ? (data as GammaEvent[]) : [];
  } catch (err) {
    console.warn(`[local-polymarket] Gamma fetch failed for tag ${tag}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Private-only bootstrap payload from Gamma. Returns null when the flag is
 * absent or Gamma answered nothing usable (so the caller keeps its hosted
 * "unavailable" response rather than caching an empty pool set).
 */
export async function fetchLocalPolymarketBootstrap(): Promise<LocalBootstrapData | null> {
  if (!isPrivateWorkspace()) return null;
  const nowMs = Date.now();
  if (bootstrapCache && bootstrapCache.expiresAt > nowMs) return bootstrapCache.data;

  const now = new Date(nowMs);
  const events: GammaEvent[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, FETCH_TAGS.length) }, async () => {
    while (next < FETCH_TAGS.length) {
      const tag = FETCH_TAGS[next++]!;
      events.push(...await fetchEventsForTag(tag, now));
    }
  }));

  const data = buildLocalBootstrap(events, nowMs);
  if (data.geopolitical.length + data.tech.length + data.finance.length === 0) return null;
  bootstrapCache = { data, expiresAt: nowMs + BOOTSTRAP_TTL_MS };
  return data;
}
