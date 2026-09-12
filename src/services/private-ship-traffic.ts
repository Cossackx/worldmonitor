/**
 * Private-build ship traffic feed (VITE_PRIVATE_WORKSPACE=1 only).
 *
 * The hosted product never renders individual civilian vessels: the AIS
 * snapshot carries density zones, disruptions and the capped military and
 * tanker reports. The personal build's Cesium "Ship Traffic" layer wants every
 * live contact in view, God's Eye style, so this module polls the private dev
 * route `/api/private/ais/vessels` (relay listing, bbox-scoped) for the
 * camera's current bounds and keeps a session-local track history per MMSI
 * for click-to-track trails.
 *
 * VesselAPI is the on-demand "check" half of cue-then-check: the relay's
 * volunteer AISStream feed has no receivers in some waters (the Gulf, most
 * open ocean), so the operator can spend one of the ~150 monthly VesselAPI
 * requests on the current view. Results merge into the same contact map,
 * tagged `source: 'vesselapi'`, and age out like everything else.
 *
 * Pure helpers are exported for tests; the feed itself owns timers only.
 */

export type ShipSource = 'relay' | 'vesselapi';

export interface ShipContact {
  mmsi: string;
  name: string;
  lat: number;
  lon: number;
  /** Position fix time, epoch ms. */
  timestamp: number;
  /** AIS ship type code (ITU-R M.1371); 0 when unknown. */
  shipType: number;
  heading: number | null;
  /** Speed over ground, knots. */
  speed: number | null;
  /** Course over ground, degrees. */
  course: number | null;
  source: ShipSource;
  imo?: number | null;
  navStatus?: number | null;
}

export interface ShipBounds { swLat: number; swLon: number; neLat: number; neLon: number }

export interface TrackPoint { lon: number; lat: number; timestamp: number }

export type ShipClass = 'cargo' | 'tanker' | 'passenger' | 'fishing' | 'tug' | 'highSpeed' | 'pleasure' | 'military' | 'sar' | 'other';

export const SHIP_CLASS_LABELS: Record<ShipClass, string> = {
  cargo: 'Cargo', tanker: 'Tanker', passenger: 'Passenger', fishing: 'Fishing', tug: 'Tug/Pilot',
  highSpeed: 'High-speed craft', pleasure: 'Pleasure/Sailing', military: 'Military', sar: 'SAR', other: 'Vessel',
};

/** ITU-R M.1371 first-digit classes, the same grouping MarineTraffic uses for its colour key. */
export function classifyShipType(code: number | null | undefined): ShipClass {
  if (!Number.isFinite(code) || !code) return 'other';
  const c = Number(code);
  if (c === 35) return 'military';
  if (c === 51) return 'sar';
  if (c === 30) return 'fishing';
  if (c === 31 || c === 32 || c === 50 || c === 52 || c === 53) return 'tug';
  if (c === 36 || c === 37) return 'pleasure';
  if (c >= 40 && c <= 49) return 'highSpeed';
  if (c >= 60 && c <= 69) return 'passenger';
  if (c >= 70 && c <= 79) return 'cargo';
  if (c >= 80 && c <= 89) return 'tanker';
  return 'other';
}

const RELAY_ROUTE = '/api/private/ais/vessels';
const VESSELAPI_ROUTE = '/api/private/vesselapi/bbox';
export const SHIP_POLL_INTERVAL_MS = 20_000;
export const SHIP_CONTACT_MAX_AGE_MS = 30 * 60 * 1000;
export const SHIP_TRACK_MAX_POINTS = 240;
/** Beyond this span the relay listing would be a world dump; ask the operator to zoom in instead. */
export const SHIP_MAX_VIEW_SPAN_DEG = 10;
export const VESSELAPI_MAX_SPAN_DEG = 4;
const RELAY_LIMIT = 600;

export function boundsSpan(b: ShipBounds): number {
  return Math.max(b.neLat - b.swLat, b.neLon - b.swLon);
}

export function boundsQuery(b: ShipBounds): string {
  const f = (v: number) => v.toFixed(3);
  return `${f(b.swLat)},${f(b.swLon)},${f(b.neLat)},${f(b.neLon)}`;
}

interface RawVessel {
  mmsi?: unknown; name?: unknown; lat?: unknown; lon?: unknown; timestamp?: unknown; shipType?: unknown;
  heading?: unknown; speed?: unknown; course?: unknown; imo?: unknown; navStatus?: unknown;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Normalise one relay or VesselAPI record (both routes emit the same field names). */
export function normalizeContact(raw: RawVessel, source: ShipSource, now = Date.now()): ShipContact | null {
  const mmsi = raw.mmsi === undefined || raw.mmsi === null ? '' : String(raw.mmsi);
  const lat = num(raw.lat);
  const lon = num(raw.lon);
  if (!mmsi || lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const ts = num(raw.timestamp);
  return {
    mmsi,
    name: typeof raw.name === 'string' ? raw.name.trim() : '',
    lat, lon,
    timestamp: ts ?? now,
    shipType: num(raw.shipType) ?? 0,
    heading: num(raw.heading),
    speed: num(raw.speed),
    course: num(raw.course),
    source,
    imo: num(raw.imo),
    navStatus: num(raw.navStatus),
  };
}

/**
 * Merge a batch into the contact map. A relay fix never overwrites a newer
 * VesselAPI fix and vice versa: the newest timestamp wins regardless of source.
 */
export function mergeContacts(map: Map<string, ShipContact>, incoming: ShipContact[]): number {
  let changed = 0;
  for (const c of incoming) {
    const prev = map.get(c.mmsi);
    if (prev && prev.timestamp > c.timestamp) continue;
    if (prev && prev.timestamp === c.timestamp && prev.lat === c.lat && prev.lon === c.lon) continue;
    // Keep a known name/type when the newer fix lacks it.
    map.set(c.mmsi, { ...c, name: c.name || prev?.name || '', shipType: c.shipType || prev?.shipType || 0 });
    changed++;
  }
  return changed;
}

export function pruneContacts(map: Map<string, ShipContact>, now = Date.now(), maxAgeMs = SHIP_CONTACT_MAX_AGE_MS): number {
  let removed = 0;
  for (const [mmsi, c] of map) if (now - c.timestamp > maxAgeMs) { map.delete(mmsi); removed++; }
  return removed;
}

/** Append a fix to a track, skipping duplicates and out-of-order fixes; bounded to SHIP_TRACK_MAX_POINTS. */
export function appendTrackPoint(track: TrackPoint[], c: ShipContact, maxPoints = SHIP_TRACK_MAX_POINTS): boolean {
  const last = track[track.length - 1];
  if (last && (c.timestamp <= last.timestamp || (last.lat === c.lat && last.lon === c.lon))) return false;
  track.push({ lon: c.lon, lat: c.lat, timestamp: c.timestamp });
  if (track.length > maxPoints) track.splice(0, track.length - maxPoints);
  return true;
}

export interface ShipFeedStatus {
  state: 'idle' | 'polling' | 'zoom-in' | 'error' | 'unavailable';
  contacts: number;
  inView: number;
  truncated: boolean;
  lastPollAt: number;
  message: string;
}

export interface VesselApiCheckResult {
  ok: boolean;
  added: number;
  total: number;
  remainingMonth: string | null;
  usedToday: number | null;
  dailyCap: number | null;
  message: string;
}

export interface ShipTrafficFeedOptions {
  getBounds: () => ShipBounds | null;
  onUpdate: (contacts: ShipContact[], status: ShipFeedStatus) => void;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
}

export class ShipTrafficFeed {
  private readonly contacts = new Map<string, ShipContact>();
  private readonly tracks = new Map<string, TrackPoint[]>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private status: ShipFeedStatus = { state: 'idle', contacts: 0, inView: 0, truncated: false, lastPollAt: 0, message: '' };
  private readonly fetchImpl: typeof fetch;

  public constructor(private readonly options: ShipTrafficFeedOptions) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  }

  public start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => { void this.poll(); }, this.options.intervalMs ?? SHIP_POLL_INTERVAL_MS);
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  public isRunning(): boolean { return this.timer !== null; }
  public getStatus(): ShipFeedStatus { return this.status; }
  public getContact(mmsi: string): ShipContact | undefined { return this.contacts.get(mmsi); }
  public getContacts(): ShipContact[] { return [...this.contacts.values()]; }
  public getTrack(mmsi: string): TrackPoint[] { return this.tracks.get(mmsi) ?? []; }

  /** Re-poll immediately (camera settled, layer re-enabled). */
  public refresh(): Promise<void> { return this.poll(); }

  public async poll(): Promise<void> {
    if (this.inFlight) return;
    const bounds = this.options.getBounds();
    if (!bounds) return;
    if (boundsSpan(bounds) > SHIP_MAX_VIEW_SPAN_DEG) {
      this.emit({ state: 'zoom-in', message: `Zoom in to ${SHIP_MAX_VIEW_SPAN_DEG}° or less to list ships` });
      return;
    }
    this.inFlight = true;
    try {
      const resp = await this.fetchImpl(`${RELAY_ROUTE}?bbox=${boundsQuery(bounds)}&limit=${RELAY_LIMIT}`, { signal: AbortSignal.timeout(10_000) });
      const body = await resp.json().catch(() => null) as { vessels?: RawVessel[]; total?: number; truncated?: boolean; error?: string } | null;
      if (!resp.ok || !body) {
        this.emit({ state: resp.status === 503 ? 'unavailable' : 'error', message: body?.error ?? `relay HTTP ${resp.status}` });
        return;
      }
      const now = Date.now();
      const incoming = (body.vessels ?? []).map((v) => normalizeContact(v, 'relay', now)).filter((c): c is ShipContact => c !== null);
      this.ingest(incoming, now);
      this.emit({ state: 'polling', lastPollAt: now, truncated: body.truncated === true, inView: incoming.length, message: body.truncated ? `${incoming.length} of ${body.total ?? '?'} in view (newest first)` : `${incoming.length} in view` });
    } catch (error) {
      this.emit({ state: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.inFlight = false;
    }
  }

  /** Spend one VesselAPI request on the current view. */
  public async checkVesselApi(): Promise<VesselApiCheckResult> {
    const bounds = this.options.getBounds();
    if (!bounds) return { ok: false, added: 0, total: 0, remainingMonth: null, usedToday: null, dailyCap: null, message: 'No view bounds' };
    const span = boundsSpan(bounds);
    if (span > VESSELAPI_MAX_SPAN_DEG) return { ok: false, added: 0, total: 0, remainingMonth: null, usedToday: null, dailyCap: null, message: `Zoom in: VesselAPI accepts ${VESSELAPI_MAX_SPAN_DEG}° spans, view is ${span.toFixed(1)}°` };
    try {
      const resp = await this.fetchImpl(`${VESSELAPI_ROUTE}?bbox=${boundsQuery(bounds)}`, { signal: AbortSignal.timeout(20_000) });
      const body = await resp.json().catch(() => null) as { vessels?: RawVessel[]; total?: number; remainingMonth?: string | null; usedToday?: number; dailyCap?: number; error?: string } | null;
      const remainingMonth = body?.remainingMonth ?? null;
      if (!resp.ok || !body) {
        const reason = body?.error === 'vesselapi_key_missing' ? 'VesselAPI key not configured in the private env'
          : body?.error === 'daily_cap' ? `Daily VesselAPI cap reached (${body.dailyCap ?? '?'}/day)`
          : body?.error === 'bbox_too_large' ? `Zoom in: VesselAPI accepts ${VESSELAPI_MAX_SPAN_DEG}° spans`
          : `VesselAPI ${body?.error ?? `HTTP ${resp.status}`}`;
        return { ok: false, added: 0, total: 0, remainingMonth, usedToday: body?.usedToday ?? null, dailyCap: body?.dailyCap ?? null, message: reason };
      }
      const now = Date.now();
      const incoming = (body.vessels ?? []).map((v) => normalizeContact(v, 'vesselapi', now)).filter((c): c is ShipContact => c !== null);
      const added = this.ingest(incoming, now);
      this.emit({ message: `VesselAPI: ${incoming.length} contacts in view, ${remainingMonth ?? '?'} requests left this month` });
      return { ok: true, added, total: incoming.length, remainingMonth, usedToday: body.usedToday ?? null, dailyCap: body.dailyCap ?? null, message: `VesselAPI returned ${incoming.length} contacts (${remainingMonth ?? '?'} left this month)` };
    } catch (error) {
      return { ok: false, added: 0, total: 0, remainingMonth: null, usedToday: null, dailyCap: null, message: error instanceof Error ? error.message : String(error) };
    }
  }

  private ingest(incoming: ShipContact[], now: number): number {
    const changed = mergeContacts(this.contacts, incoming);
    for (const c of incoming) {
      const merged = this.contacts.get(c.mmsi);
      if (!merged) continue;
      const track = this.tracks.get(c.mmsi) ?? [];
      if (appendTrackPoint(track, merged)) this.tracks.set(c.mmsi, track);
    }
    pruneContacts(this.contacts, now);
    for (const mmsi of [...this.tracks.keys()]) if (!this.contacts.has(mmsi)) this.tracks.delete(mmsi);
    return changed;
  }

  private emit(patch: Partial<ShipFeedStatus>): void {
    this.status = { ...this.status, ...patch, contacts: this.contacts.size };
    this.options.onUpdate(this.getContacts(), this.status);
  }
}
