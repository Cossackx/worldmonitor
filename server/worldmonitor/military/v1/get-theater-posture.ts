import type {
  ServerContext,
  GetTheaterPostureRequest,
  GetTheaterPostureResponse,
  TheaterPosture,
} from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

import { POSTURE_THEATERS, detectAircraftType, type RawFlight } from './_shared';
import { getCachedJson } from '../../../_shared/redis';
import {
  hasRedistributableProviderAttribution,
  requiresRedistributableProviders,
} from '../../../_shared/provider-redistribution';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';

const CACHE_KEY = 'theater-posture:sebuf:v1';
const STALE_CACHE_KEY = 'theater_posture:sebuf:stale:v1';
const BACKUP_CACHE_KEY = 'theater-posture:sebuf:backup:v1';

// All theater posture assembly (product-only OpenSky fallback + redistributable
// providers + classification)
// happens on Railway (ais-relay.cjs seedTheaterPosture loop + seed-military-flights.mjs).
// This handler reads pre-built data from Redis only.
// Gold standard: Vercel reads, Railway writes.

type ProviderAttributedPosture = GetTheaterPostureResponse & { provider?: unknown };

function projectAllowedPosture(
  value: unknown,
  redistributableOnly: boolean,
): GetTheaterPostureResponse | null {
  const posture = value as ProviderAttributedPosture | null;
  if (!posture?.theaters?.length) return null;
  if (redistributableOnly && !hasRedistributableProviderAttribution(posture.provider)) return null;
  return { theaters: posture.theaters };
}

// ========================================================================
// Private local preview: on-demand posture from adsb.lol
//
// The hosted path above is Redis-read-only; the Railway relay's
// seedTheaterPosture loop is what writes those keys, and it is disabled both
// in RELAY_TEST_MODE and whenever Upstash is absent — which is exactly the
// workstation setup. Without this the AI Strategic Posture panel can never
// leave "No current posture snapshot" locally. This mirrors the relay's
// aircraft-only classification (calculateTheaterPostures) against the same
// keyless adsb.lol /v2/mil set list-military-flights.ts already uses in the
// private preview; vessels are added client-side by StrategicPosturePanel.
// Strictly opt-in to VITE_PRIVATE_WORKSPACE=1; hosted behaviour is unchanged.
// ========================================================================

const LOCAL_ADSB_LOL_MIL_URL = 'https://api.adsb.lol/v2/mil';
const LOCAL_ADSB_LOL_TIMEOUT_MS = 15_000;
// Matches the relay's 10-minute seed cadence so a panel refresh does not
// re-hit adsb.lol on every RPC.
const LOCAL_POSTURE_TTL_MS = 10 * 60 * 1000;
const LOCAL_POSTURE_PROVIDER = 'adsb.lol';

interface AdsbLolAircraft {
  hex?: string;
  flight?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | 'ground';
  gs?: number;
  track?: number;
}

let localPostureCache: { response: ProviderAttributedPosture; expiresAt: number } | null = null;

function isInBounds(lat: number, lon: number, bounds: { north: number; south: number; east: number; west: number }): boolean {
  return lat >= bounds.south && lat <= bounds.north && lon >= bounds.west && lon <= bounds.east;
}

/** Port of the relay's calculateTheaterPostures with no vessel contribution. */
export function computeTheaterPosturesFromFlights(flights: RawFlight[], assessedAt = Date.now()): TheaterPosture[] {
  return POSTURE_THEATERS.map((theater) => {
    const tf = flights.filter((f) => isInBounds(f.lat, f.lon, theater.bounds));
    const total = tf.length;
    const tankers = tf.filter((f) => f.aircraftType === 'tanker').length;
    const awacs = tf.filter((f) => f.aircraftType === 'awacs').length;
    const fighters = tf.filter((f) => f.aircraftType === 'fighter').length;
    const postureLevel = total >= theater.thresholds.critical ? 'critical'
      : total >= theater.thresholds.elevated ? 'elevated' : 'normal';
    const strikeCapable = tankers >= theater.strikeIndicators.minTankers
      && awacs >= theater.strikeIndicators.minAwacs
      && fighters >= theater.strikeIndicators.minFighters;
    const activeOperations: string[] = [];
    if (strikeCapable) activeOperations.push('strike_capable');
    if (tankers > 0) activeOperations.push('aerial_refueling');
    if (awacs > 0) activeOperations.push('airborne_early_warning');
    return {
      theater: theater.id,
      postureLevel,
      activeFlights: total,
      trackedVessels: 0,
      activeOperations,
      assessedAt,
    };
  });
}

/** Parse adsb.lol /v2/mil into theater-bounded airborne RawFlights (dedup by hex). */
export function parseAdsbLolTheaterFlights(aircraft: unknown): RawFlight[] {
  if (!Array.isArray(aircraft)) return [];
  const flights: RawFlight[] = [];
  const seen = new Set<string>();
  for (const a of aircraft as AdsbLolAircraft[]) {
    const lat = a?.lat; const lon = a?.lon;
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;
    if (a.alt_baro === 'ground') continue;
    const id = (a.hex ?? '').trim().replace(/~/g, '');
    if (!id || seen.has(id)) continue;
    if (!POSTURE_THEATERS.some((t) => isInBounds(lat, lon, t.bounds))) continue;
    seen.add(id);
    const callsign = (a.flight ?? '').trim();
    flights.push({
      id,
      callsign,
      lat,
      lon,
      altitude: typeof a.alt_baro === 'number' ? a.alt_baro : 0,
      heading: a.track ?? 0,
      speed: a.gs ?? 0,
      aircraftType: detectAircraftType(callsign),
    });
  }
  return flights;
}

async function fetchLocalAdsbLolPosture(): Promise<ProviderAttributedPosture | null> {
  if (process.env.VITE_PRIVATE_WORKSPACE !== '1') return null;
  const now = Date.now();
  if (localPostureCache && localPostureCache.expiresAt > now) return localPostureCache.response;
  const response = await fetch(LOCAL_ADSB_LOL_MIL_URL, {
    headers: { Accept: 'application/json', 'User-Agent': 'WorldMonitor-local-preview/1.0' },
    signal: AbortSignal.timeout(LOCAL_ADSB_LOL_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { ac?: unknown };
  if (!Array.isArray(data.ac)) return null;
  const flights = parseAdsbLolTheaterFlights(data.ac);
  // Same rule as the relay: an empty input set is not a publishable posture.
  if (flights.length === 0) return null;
  const posture: ProviderAttributedPosture = {
    theaters: computeTheaterPosturesFromFlights(flights, now),
    provider: LOCAL_POSTURE_PROVIDER,
  };
  localPostureCache = { response: posture, expiresAt: now + LOCAL_POSTURE_TTL_MS };
  return posture;
}

export function __resetLocalPostureCacheForTests(): void {
  localPostureCache = null;
}

export async function getTheaterPosture(
  ctx: ServerContext,
  _req: GetTheaterPostureRequest,
): Promise<GetTheaterPostureResponse> {
  const redistributableOnly = requiresRedistributableProviders(ctx.request);
  try {
    const live = projectAllowedPosture(await getCachedJson(CACHE_KEY, true), redistributableOnly);
    if (live) return live;
  } catch { /* fall through to stale/backup */ }

  try {
    const stale = projectAllowedPosture(await getCachedJson(STALE_CACHE_KEY, true), redistributableOnly);
    if (stale) return stale;
  } catch { /* fall through to backup */ }

  try {
    const backup = projectAllowedPosture(await getCachedJson(BACKUP_CACHE_KEY, true), redistributableOnly);
    if (backup) return backup;
  } catch { /* empty */ }

  // Private local preview only (no-op when VITE_PRIVATE_WORKSPACE !== '1').
  try {
    const local = projectAllowedPosture(await fetchLocalAdsbLolPosture(), redistributableOnly);
    if (local) return markNoStoreFallbackResponse(ctx.request, local);
  } catch { /* fall through to empty */ }

  return markNoStoreFallbackResponse(ctx.request, { theaters: [] });
}
