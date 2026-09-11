/**
 * Private local preview FRED source (VITE_PRIVATE_WORKSPACE=1 only).
 *
 * Hosted deployments read `economic:fred:v1:<SERIES>:0` and
 * `economic:stress-index:v1`, both written by scripts/seed-economy.mjs on
 * Railway through the keyed FRED API. The private preview launcher runs no
 * Redis and no seeder, so the Macro Stress panel reports "Upstream API
 * unavailable" and "Stress index data unavailable" permanently.
 *
 * When — and only when — the private flag is set, a seed miss falls back to
 * FRED's keyless `fredgraph.csv` export (the same observations the API serves,
 * minus series metadata, which the panel does not display) and the stress
 * composite is computed locally with the seeder's own component formula.
 * Every gate returns `null` without the flag, so hosted behaviour stays
 * byte-identical. Mirrors the private-preview gates in
 * server/worldmonitor/military/v1/list-military-flights.ts.
 */

import type {
  EconomicStressComponent,
  FredSeries,
  GetEconomicStressResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

/** Self-identifying UA, the same string the other local-preview fallbacks send. */
export const LOCAL_PREVIEW_USER_AGENT = 'WorldMonitor-local-preview/1.0';

const FREDGRAPH_URL = 'https://fred.stlouisfed.org/graph/fredgraph.csv';
/** Matches the seeder's 6h stress cadence; FRED series update at most daily. */
const SERIES_TTL_MS = 6 * 60 * 60_000;
/** Enough history for the 120-observation default limit on a daily series. */
const LOOKBACK_DAYS = 3 * 365;
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_CONCURRENCY = 4;

export function isPrivateWorkspace(): boolean {
  return process.env.VITE_PRIVATE_WORKSPACE === '1';
}

const seriesCache = new Map<string, { series: FredSeries | null; expiresAt: number }>();

export function __clearLocalFredCacheForTests(): void {
  seriesCache.clear();
}

/**
 * Parse one fredgraph.csv export (`observation_date,<ID>` header, one
 * `YYYY-MM-DD,value` row per observation). FRED marks missing observations
 * with `.` or an empty cell; those rows are dropped, as the API seeder drops
 * them. Returns null for anything that is not a FRED CSV for `seriesId`.
 */
export function parseFredGraphCsv(text: string, seriesId: string): FredSeries | null {
  const lines = text.split(/\r?\n/);
  const header = (lines[0] ?? '').trim().split(',');
  if (header.length < 2 || header[0] !== 'observation_date' || header[1]?.toUpperCase() !== seriesId) return null;
  const observations: FredSeries['observations'] = [];
  for (const line of lines.slice(1)) {
    const [date = '', raw = ''] = line.trim().split(',');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const value = raw === '' || raw === '.' ? NaN : Number(raw);
    if (!Number.isFinite(value)) continue;
    observations.push({ date, value });
  }
  if (observations.length === 0) return null;
  return { seriesId, title: seriesId, units: '', frequency: '', observations };
}

async function fetchOneSeries(seriesId: string, now: number): Promise<FredSeries | null> {
  const cached = seriesCache.get(seriesId);
  if (cached && cached.expiresAt > now) return cached.series;
  const start = new Date(now - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  let series: FredSeries | null = null;
  try {
    const params = new URLSearchParams({ id: seriesId, cosd: start });
    const response = await fetch(`${FREDGRAPH_URL}?${params}`, {
      headers: { Accept: 'text/csv', 'User-Agent': LOCAL_PREVIEW_USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.ok) series = parseFredGraphCsv(await response.text(), seriesId);
    else console.warn(`[local-fred] fredgraph HTTP ${response.status} for ${seriesId}`);
  } catch (err) {
    console.warn(`[local-fred] fredgraph fetch failed for ${seriesId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // A miss is cached too: GSCPI (NY Fed) and any renamed series are not on
  // FRED, and re-asking every refresh would only spend the request budget.
  seriesCache.set(seriesId, { series, expiresAt: now + SERIES_TTL_MS });
  return series;
}

/**
 * Resolve `seriesIds` through the keyless fredgraph export. Returns null when
 * the private flag is absent, otherwise a map of the series FRED answered.
 */
export async function fetchLocalFredSeries(seriesIds: readonly string[]): Promise<Map<string, FredSeries> | null> {
  if (!isPrivateWorkspace()) return null;
  const now = Date.now();
  const ids = [...new Set(seriesIds.map((id) => id.trim().toUpperCase()).filter(Boolean))];
  const resolved = new Map<string, FredSeries>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, ids.length) }, async () => {
    while (next < ids.length) {
      const id = ids[next++]!;
      const series = await fetchOneSeries(id, now);
      if (series) resolved.set(id, series);
    }
  }));
  return resolved;
}

// ---------------------------------------------------------------------------
// Stress index — component formula copied from scripts/_fred-seeder.mjs
// (STRESS_COMPONENTS / stressLabel / computeStressIndex). Kept in sync by
// hand: the seeder module pulls in the Railway seed utilities and cannot be
// imported from a request handler.
// ---------------------------------------------------------------------------

function clamp(v: number): number {
  return Math.min(100, Math.max(0, v));
}

export const STRESS_COMPONENTS: ReadonlyArray<{
  id: string;
  label: string;
  weight: number;
  score: (v: number) => number;
}> = [
  { id: 'T10Y2Y', label: 'Yield Curve', weight: 0.20, score: (v) => clamp((0.5 - v) / (0.5 - (-1.5)) * 100) },
  { id: 'T10Y3M', label: 'Bank Spread', weight: 0.15, score: (v) => clamp((0.5 - v) / (0.5 - (-1.0)) * 100) },
  { id: 'VIXCLS', label: 'Volatility', weight: 0.20, score: (v) => clamp((v - 15) / (80 - 15) * 100) },
  { id: 'STLFSI4', label: 'Financial Stress', weight: 0.20, score: (v) => clamp((v - (-1)) / (5 - (-1)) * 100) },
  { id: 'GSCPI', label: 'Supply Chain', weight: 0.15, score: (v) => clamp((v - (-2)) / (4 - (-2)) * 100) },
  { id: 'ICSA', label: 'Job Claims', weight: 0.10, score: (v) => clamp((v - 180000) / (500000 - 180000) * 100) },
];

/** Series the local composite needs from FRED (GSCPI is NY Fed, not FRED). */
export const STRESS_FRED_SERIES = STRESS_COMPONENTS.map((c) => c.id).filter((id) => id !== 'GSCPI');

function stressLabel(score: number): string {
  if (score < 20) return 'Low';
  if (score < 40) return 'Moderate';
  if (score < 60) return 'Elevated';
  if (score < 80) return 'Severe';
  return 'Critical';
}

/**
 * The seeder's composite over already-fetched series. Same refusal rule: any
 * FRED component missing → null (no partial composite is published); GSCPI
 * alone may be missing and is reported as such with `missing: true`, which is
 * exactly how the seeder publishes it when ais-relay lags.
 */
export function computeStressIndexFromSeries(
  seriesById: ReadonlyMap<string, FredSeries>,
  seededAt: string = new Date().toISOString(),
): GetEconomicStressResponse | null {
  const components: EconomicStressComponent[] = [];
  let weightedSum = 0;
  let totalWeight = 0;

  for (const comp of STRESS_COMPONENTS) {
    const obs = seriesById.get(comp.id)?.observations ?? [];
    let rawValue: number | null = null;
    for (let j = obs.length - 1; j >= 0; j--) {
      const v = obs[j]?.value;
      if (typeof v === 'number' && Number.isFinite(v)) { rawValue = v; break; }
    }
    if (rawValue === null) {
      if (comp.id !== 'GSCPI') return null;
      components.push({ id: comp.id, label: comp.label, rawValue: 0, score: 0, weight: comp.weight, missing: true });
      continue;
    }
    const score = comp.score(rawValue);
    weightedSum += score * comp.weight;
    totalWeight += comp.weight;
    components.push({ id: comp.id, label: comp.label, rawValue, score, weight: comp.weight, missing: false });
  }

  if (totalWeight === 0) return null;
  const compositeScore = Math.round((weightedSum / totalWeight) * 10) / 10;
  return { compositeScore, label: stressLabel(compositeScore), components, seededAt, unavailable: false };
}

/** Private-only: fetch the FRED components and compute the composite locally. */
export async function computeLocalPreviewStressIndex(): Promise<GetEconomicStressResponse | null> {
  const series = await fetchLocalFredSeries(STRESS_FRED_SERIES);
  if (!series) return null;
  return computeStressIndexFromSeries(series);
}
