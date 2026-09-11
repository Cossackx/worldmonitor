/**
 * Cesium marker/path/polygon model for the World Monitor 3D renderer.
 *
 * Pure builders: every World Monitor feed the globe.gl renderer (GlobeMap)
 * draws is turned here into renderer-neutral marker, path and polygon records
 * carrying the same colours, glyphs and sizes GlobeMap uses, so the 2D and 3D
 * panes read identically. CesiumMapAdapter owns the Cesium entities; this
 * module has no Cesium dependency and is unit-testable in Node/jsdom.
 *
 * Parity target: GlobeMap. Layers GlobeMap itself does not render (sanctions,
 * canada*, startupHubs, cloudRegions, tech HQ/finance layers, positive/kindness,
 * happiness, speciesRecovery, renewables, resilienceScore, dayNight, mining and
 * commodity layers, disease, storage, fuel, liveTankers) are not claimed here.
 */
import { CONFLICT_ZONES, STRATEGIC_WATERWAYS } from '@/config/geo';
import { NUCLEAR_FACILITIES, SPACEPORTS, ECONOMIC_CENTERS, CRITICAL_MINERALS, UNDERSEA_CABLES } from '@/config/geo-map';
import { PIPELINES } from '@/config/pipelines';
import { GAMMA_IRRADIATORS } from '@/config/irradiators';
import { AI_DATA_CENTERS } from '@/config/ai-datacenters';
import { resolveTradeRouteSegments, type TradeRouteSegment } from '@/config/trade-routes';
import { getIranEventHexColor, type IranEvent } from '@/services/conflict';
import { getCategoryStyle } from '@/services/webcams';
import type {
  MapLayers, Hotspot, MilitaryFlight, MilitaryVessel, MilitaryVesselCluster, NaturalEvent, InternetOutage,
  CyberThreat, SocialUnrestEvent, UcdpGeoEvent, MilitaryBase, GammaIrradiator, Spaceport, EconomicCenter,
  StrategicWaterway, CriticalMineralProject, AIDataCenter, UnderseaCable, Pipeline, CableAdvisory, RepairShip,
  AisDisruptionEvent, ConflictZone,
} from '@/types';
import type { Earthquake } from '@/services/earthquakes';
import type { AirportDelayAlert } from '@/services/aviation';
import type { WeatherAlert } from '@/services/weather';
import type { DisplacementFlow } from '@/services/displacement';
import type { ClimateAnomaly } from '@/services/climate';
import type { GpsJamHex } from '@/services/gps-interference';
import type { SatellitePosition } from '@/services/satellites';
import type { RadiationObservation } from '@/services/radiation';
import type { ImageryScene } from '@/generated/server/worldmonitor/imagery/v1/service_server';
import type { WebcamEntry, WebcamCluster } from '@/generated/client/worldmonitor/webcam/v1/service_client';
import type { TrafficAnomaly as ProtoTrafficAnomaly, DdosLocationHit } from '@/generated/client/worldmonitor/infrastructure/v1/service_client';

// ─── Renderer-neutral records ────────────────────────────────────────────────

/** What a marker looks like. `glyph` draws a text glyph; otherwise a dot. */
export interface MarkerStyle {
  glyph?: string;
  /** CSS colour for the dot or glyph. */
  color: string;
  /** Pixel size: font size for glyphs, diameter for dots. */
  size: number;
  /** Dots only: outline colour (defaults to a lighter ring). */
  outline?: string;
  /** Dots only: fill alpha override (0..1), e.g. earthquake rings are hollow-ish. */
  fillAlpha?: number;
}

/** Popup payloads the Cesium adapter can hand to the shared MapPopup. */
export type MarkerPopup =
  | { type: 'militaryFlight'; data: MilitaryFlight }
  | { type: 'militaryVessel'; data: MilitaryVessel }
  | { type: 'militaryVesselCluster'; data: MilitaryVesselCluster }
  | { type: 'conflict'; data: ConflictZone }
  | { type: 'radiation'; data: Record<string, unknown> };

export interface CesiumMarker {
  /** Stable id, unique within its group. */
  id: string;
  kind: string;
  lat: number;
  lon: number;
  /** Height above the ellipsoid in metres; undefined means clamp to ground. */
  heightM?: number;
  /** Tooltip text (GlobeMap's `title`). */
  title: string;
  style: MarkerStyle;
  /** Rank for the marker budget (higher survives truncation first). */
  rank?: number;
  popup?: MarkerPopup;
  hotspot?: Hotspot;
  /** Clicking a cluster zooms toward it instead of opening anything. */
  zoomOnClick?: boolean;
}

export interface CesiumPath {
  id: string;
  name: string;
  /** [lon, lat] or [lon, lat, altKm] points. */
  points: number[][];
  color: string;
  width: number;
  /** Orbit paths carry altitude and must not be clamped. */
  clampToGround: boolean;
}

export interface CesiumPolygon {
  id: string;
  /** Outer ring + holes, [lon, lat]. */
  rings: number[][][];
  fill: string;
  stroke: string | null;
  label?: string;
}

export interface MarkerGroupRecord {
  layer: keyof MapLayers | 'news' | 'flash';
  markers: CesiumMarker[];
  exempt?: boolean;
}

// ─── Palette (copied from GlobeMap so both renderers agree) ──────────────────

export const FLIGHT_TYPE_COLORS: Record<string, string> = {
  fighter: '#ff4444', bomber: '#ff8800', recon: '#44aaff',
  tanker: '#88ff44', transport: '#aaaaff', helicopter: '#ffff44',
  drone: '#ff44ff', maritime: '#44ffff',
};
export const VESSEL_TYPE_COLORS: Record<string, string> = {
  carrier: '#ff4444', destroyer: '#ff8800', frigate: '#ffcc00', submarine: '#8844ff', amphibious: '#44cc88',
  patrol: '#44aaff', auxiliary: '#aaaaaa', research: '#44ffff', icebreaker: '#88ccff', special: '#ff44ff',
};
export const VESSEL_TYPE_ICONS: Record<string, string> = {
  carrier: '⛴', destroyer: '▲', frigate: '▲', submarine: '◆', amphibious: '⬡',
  patrol: '▶', auxiliary: '●', research: '◎', icebreaker: '❅', special: '★',
};
const VESSEL_TYPE_LABELS: Record<string, string> = {
  carrier: 'Aircraft Carrier', destroyer: 'Destroyer', frigate: 'Frigate', submarine: 'Submarine', amphibious: 'Amphibious',
  patrol: 'Patrol', auxiliary: 'Auxiliary', research: 'Research', icebreaker: 'Icebreaker', special: 'Special Mission', unknown: 'Unknown',
};
const CLUSTER_ACTIVITY_COLORS: Record<string, string> = { deployment: '#ff4444', exercise: '#ff8800', transit: '#ffcc00', unknown: '#6688aa' };
export const SAT_COUNTRY_COLORS: Record<string, string> = { CN: '#ff2020', RU: '#ff8800', US: '#4488ff', EU: '#44cc44', KR: '#aa66ff', IN: '#ff66aa', TR: '#ff4466', OTHER: '#ccccff' };
const HOTSPOT_COLORS: Record<number, string> = { 5: '#ff2020', 4: '#ff6600', 3: '#ffaa00', 2: '#ffdd00', 1: '#88ff44' };
const MILBASE_COLORS: Record<string, string> = { 'us-nato': '#4488ff', uk: '#4488ff', france: '#4488ff', russia: '#ff4444', china: '#ff8844', india: '#ff8844', other: '#aaaaaa' };
const NATURAL_ICONS: Record<string, string> = { earthquakes: '〽', volcanoes: '🌋', severeStorms: '🌀', floods: '💧', wildfires: '🔥', drought: '☀' };
const WEATHER_SEVERITY_COLORS: Record<string, string> = { Extreme: '#ff0044', Severe: '#ff6600', Moderate: '#ffaa00', Minor: '#88aaff' };
const PROTEST_COLORS: Record<string, string> = { riot: '#ff3030', protest: '#ffaa00', strike: '#44aaff', demonstration: '#88ff44', civil_unrest: '#ff6600' };
const CLIMATE_COLORS: Record<string, string> = { warm: '#ff4400', cold: '#44aaff', wet: '#00ccff', dry: '#ff8800', mixed: '#88ff88' };
export const CII_COLORS: Record<string, string> = {
  low: 'rgba(40, 180, 60, 0.35)', normal: 'rgba(220, 200, 50, 0.35)', elevated: 'rgba(240, 140, 30, 0.40)',
  high: 'rgba(220, 50, 20, 0.45)', critical: 'rgba(140, 10, 0, 0.50)',
};

const finite = (lat: unknown, lon: unknown): boolean => typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon);

// ─── Marker builders (one per GlobeMap setter or static layer) ───────────────

export function buildHotspotMarkers(hotspots: Hotspot[]): CesiumMarker[] {
  return (hotspots ?? []).filter((h) => finite(h.lat, h.lon)).map((h) => {
    const score = h.escalationScore ?? 1;
    return {
      id: h.id, kind: 'hotspot', lat: h.lat, lon: h.lon, title: h.name, rank: score,
      style: { glyph: '◆', color: HOTSPOT_COLORS[score] ?? '#ffaa00', size: 14 },
      hotspot: { id: h.id, name: h.name, lat: h.lat, lon: h.lon, keywords: [], escalationScore: score as Hotspot['escalationScore'] },
    };
  });
}

export function buildConflictZoneMarkers(zones: readonly ConflictZone[] = CONFLICT_ZONES): CesiumMarker[] {
  return zones.map((z) => {
    const c = z.intensity === 'high' ? '#ff2020' : z.intensity === 'medium' ? '#ff8800' : '#ffcc00';
    return { id: z.id, kind: 'conflictZone', lat: z.center[1], lon: z.center[0], title: z.name, style: { glyph: '⚔', color: c, size: 13 }, popup: { type: 'conflict', data: z } };
  });
}

export function buildMilitaryFlightMarkers(flights: MilitaryFlight[]): CesiumMarker[] {
  return (flights ?? []).filter((f) => finite(f.lat, f.lon)).map((f) => {
    const type = ((f as unknown as { aircraftType?: string; type?: string }).aircraftType ?? (f as unknown as { type?: string }).type ?? 'fighter');
    return { id: f.id, kind: 'flight', lat: f.lat, lon: f.lon, title: `${f.callsign ?? ''} (${type})`, style: { glyph: '✈', color: FLIGHT_TYPE_COLORS[type] ?? '#cccccc', size: 12 }, popup: { type: 'militaryFlight', data: f } };
  });
}

export function buildMilitaryVesselMarkers(vessels: MilitaryVessel[]): CesiumMarker[] {
  return (vessels ?? []).filter((v) => finite(v.lat, v.lon)).map((v) => {
    const isCarrier = v.vesselType === 'carrier';
    return {
      id: v.id, kind: 'vessel', lat: v.lat, lon: v.lon, rank: isCarrier ? 1 : 0,
      title: `${v.name ?? 'vessel'}${v.hullNumber ? ` (${v.hullNumber})` : ''} · ${VESSEL_TYPE_LABELS[v.vesselType] ?? v.vesselType} · ${v.usniSource ? 'EST. POSITION' : 'AIS LIVE'}`,
      style: { glyph: VESSEL_TYPE_ICONS[v.vesselType] ?? '⛴', color: VESSEL_TYPE_COLORS[v.vesselType] ?? '#44aaff', size: isCarrier ? 15 : 10 },
      popup: { type: 'militaryVessel', data: v },
    };
  });
}

export function buildVesselClusterMarkers(clusters: MilitaryVesselCluster[]): CesiumMarker[] {
  return (clusters ?? []).filter((c) => finite(c.lat, c.lon)).map((c) => ({
    id: c.id, kind: 'cluster', lat: c.lat, lon: c.lon, title: `${c.name} · ${c.vesselCount} vessel${c.vesselCount !== 1 ? 's' : ''}`,
    style: { glyph: String(c.vesselCount), color: CLUSTER_ACTIVITY_COLORS[c.activityType ?? 'unknown'] ?? '#6688aa', size: Math.max(12, Math.min(20, 10 + c.vesselCount)) },
    popup: { type: 'militaryVesselCluster', data: c },
  }));
}

export function buildWeatherMarkers(alerts: WeatherAlert[]): CesiumMarker[] {
  return (alerts ?? []).filter((a) => a.centroid != null).map((a) => ({
    id: a.id, kind: 'weather', lat: a.centroid![1], lon: a.centroid![0], title: a.headline ?? a.event ?? '',
    style: { glyph: '⚡', color: WEATHER_SEVERITY_COLORS[a.severity ?? 'Minor'] ?? '#88aaff', size: 11 },
  }));
}

export function buildNaturalMarkers(events: NaturalEvent[]): CesiumMarker[] {
  return (events ?? []).filter((e) => finite(e.lat, e.lon)).map((e) => ({
    id: e.id, kind: 'natural', lat: e.lat, lon: e.lon, title: e.title ?? '',
    style: { glyph: NATURAL_ICONS[e.category ?? ''] ?? '⚠', color: '#ffffff', size: 13 },
  }));
}

export function buildEarthquakeMarkers(earthquakes: Earthquake[]): CesiumMarker[] {
  return (earthquakes ?? []).filter((e) => e.location != null).map((e) => {
    const m = e.magnitude ?? 0;
    const c = m >= 6 ? '#ff2020' : m >= 4 ? '#ff8800' : '#ffcc00';
    return { id: String(e.id), kind: 'earthquake', lat: e.location!.latitude, lon: e.location!.longitude, title: `M${m.toFixed(1)} — ${e.place ?? ''}`, rank: m, style: { color: c, size: Math.max(8, Math.min(18, Math.round(m * 2.5))), outline: c, fillAlpha: 0.27 } };
  });
}

export function buildRadiationMarkers(observations: RadiationObservation[]): CesiumMarker[] {
  return (observations ?? []).filter((o) => finite(o.lat, o.lon)).map((o) => ({
    id: o.id, kind: 'radiation', lat: o.lat, lon: o.lon, title: `${o.location} · ${o.severity} · ${o.confidence}`,
    style: { glyph: '☢', color: o.severity === 'spike' ? '#ff3030' : '#ffaa00', size: 13 },
    popup: { type: 'radiation', data: { ...o, lat: o.lat, lon: o.lon } as unknown as Record<string, unknown> },
  }));
}

export function buildOutageMarkers(outages: InternetOutage[]): CesiumMarker[] {
  return (outages ?? []).filter((o) => finite(o.lat, o.lon)).map((o) => ({
    id: o.id, kind: 'outage', lat: o.lat, lon: o.lon, title: `${o.country ?? ''}: ${o.title ?? ''}`,
    style: { glyph: '📡', color: o.severity === 'total' ? '#ff2020' : o.severity === 'major' ? '#ff8800' : '#ffcc00', size: 13 },
  }));
}

export function buildTrafficAnomalyMarkers(anomalies: ProtoTrafficAnomaly[]): CesiumMarker[] {
  return (anomalies ?? []).filter((a) => a.latitude !== 0 || a.longitude !== 0).map((a) => ({
    id: a.uuid || `ta-${a.locationCode}-${a.startDate}`, kind: 'trafficAnomaly', lat: a.latitude, lon: a.longitude,
    title: `${a.type || 'Traffic Anomaly'}: ${a.locationName || ''}`, style: { glyph: '⚡', color: '#ffa000', size: 12 },
  }));
}

export function buildDdosMarkers(hits: DdosLocationHit[]): CesiumMarker[] {
  return (hits ?? []).filter((h) => h.latitude !== 0 || h.longitude !== 0).map((h) => ({
    id: `ddos-${h.countryCode}`, kind: 'ddosHit', lat: h.latitude, lon: h.longitude,
    title: `DDoS: ${h.countryName || ''} (${(h.percentage || 0).toFixed(1)}%)`, style: { glyph: '⚔', color: '#b400ff', size: 12 },
  }));
}

export function buildAisDisruptionMarkers(disruptions: AisDisruptionEvent[]): CesiumMarker[] {
  return (disruptions ?? []).filter((d) => finite(d.lat, d.lon)).map((d) => ({
    id: d.id, kind: 'aisDisruption', lat: d.lat, lon: d.lon, title: d.name,
    style: { glyph: '⛴', color: d.severity === 'high' ? '#ff2020' : d.severity === 'elevated' ? '#ff8800' : '#44aaff', size: 13 },
  }));
}

export function buildCableActivityMarkers(advisories: CableAdvisory[], repairShips: RepairShip[]): { advisories: CesiumMarker[]; ships: CesiumMarker[]; faultIds: Set<string>; degradedIds: Set<string> } {
  const faultIds = new Set<string>();
  const degradedIds = new Set<string>();
  const adv = (advisories ?? []).filter((a) => finite(a.lat, a.lon)).map((a) => {
    if (a.cableId) (a.severity === 'fault' ? faultIds : degradedIds).add(a.cableId);
    return { id: a.id, kind: 'cableAdvisory', lat: a.lat, lon: a.lon, title: `${a.title ?? ''} (${a.severity})`, style: { glyph: '🔌', color: a.severity === 'fault' ? '#ff2020' : '#ff8800', size: 13 } };
  });
  const ships = (repairShips ?? []).filter((r) => finite(r.lat, r.lon)).map((r) => ({
    id: r.id, kind: 'repairShip', lat: r.lat, lon: r.lon, title: r.name, style: { glyph: '🚢', color: r.status === 'on-station' ? '#44ff88' : '#44aaff', size: 13 },
  }));
  return { advisories: adv, ships, faultIds, degradedIds };
}

export function buildProtestMarkers(events: SocialUnrestEvent[]): CesiumMarker[] {
  return (events ?? []).filter((e) => finite(e.lat, e.lon)).map((e) => ({
    id: e.id, kind: 'protest', lat: e.lat, lon: e.lon, title: e.title ?? '',
    style: { glyph: '📢', color: PROTEST_COLORS[e.eventType ?? 'protest'] ?? '#ffaa00', size: 13 },
  }));
}

export function buildFlightDelayMarkers(delays: AirportDelayAlert[]): { delays: CesiumMarker[]; notams: CesiumMarker[] } {
  const usable = (delays ?? []).filter((d) => finite(d.lat, d.lon));
  return {
    delays: usable.filter((d) => d.severity !== 'normal').map((d) => {
      const c = d.severity === 'severe' ? '#ff2020' : d.severity === 'major' ? '#ff6600' : d.severity === 'moderate' ? '#ffaa00' : d.severity === 'unknown' ? '#7d7d8a' : '#ffee44';
      return { id: d.id, kind: 'flightDelay', lat: d.lat, lon: d.lon, title: `${d.iata} — ${d.severity}`, style: { glyph: '✈', color: c, size: 13 } };
    }),
    notams: usable.filter((d) => d.delayType === 'closure').map((d) => ({
      id: `notam-${d.id}`, kind: 'notamRing', lat: d.lat, lon: d.lon, title: `NOTAM: ${d.name || d.iata}`, style: { glyph: '⚠', color: '#ff2828', size: 14 },
    })),
  };
}

export function buildNewsLocationMarkers(data: Array<{ lat: number; lon: number; title: string; threatLevel: string; timestamp?: Date }>): CesiumMarker[] {
  return (data ?? []).filter((d) => finite(d.lat, d.lon)).map((d, i) => {
    const t = d.threatLevel ?? 'info';
    const c = t === 'critical' ? '#ff2020' : t === 'high' ? '#ff6600' : (t === 'elevated' || t === 'medium') ? '#ffaa00' : '#44aaff';
    return { id: `news-${i}-${d.title.slice(0, 20)}`, kind: 'newsLocation', lat: d.lat, lon: d.lon, title: d.title, style: { color: c, size: 12, outline: c, fillAlpha: 0.27 } };
  });
}

export function buildCyberMarkers(threats: CyberThreat[]): CesiumMarker[] {
  return (threats ?? []).filter((t) => finite(t.lat, t.lon)).map((t) => {
    const s = t.severity ?? 'low';
    const c = s === 'critical' ? '#ff0044' : s === 'high' ? '#ff4400' : s === 'medium' ? '#ffaa00' : '#44aaff';
    return { id: t.id, kind: 'cyber', lat: t.lat, lon: t.lon, title: `${t.type ?? 'malware_host'}: ${t.indicator ?? ''}`, style: { glyph: '🛡', color: c, size: 12 } };
  });
}

export function buildIranEventMarkers(events: IranEvent[]): CesiumMarker[] {
  return (events ?? []).filter((e) => finite(e.latitude, e.longitude)).map((e) => ({
    id: e.id, kind: 'iran', lat: e.latitude, lon: e.longitude, title: e.title ?? '',
    style: { color: getIranEventHexColor(e), size: 9, outline: 'rgba(255,255,255,0.5)' },
  }));
}

export function buildFireMarkers(fires: Array<{ lat: number; lon: number; brightness: number; region: string; [key: string]: unknown }>): CesiumMarker[] {
  return (fires ?? []).filter((f) => finite(f.lat, f.lon)).map((f) => {
    const b = f.brightness ?? 330;
    return { id: (f.id as string | undefined) ?? `${f.lat},${f.lon}`, kind: 'fire', lat: f.lat, lon: f.lon, title: `Fire — ${f.region ?? ''}`, rank: b, style: { glyph: '🔥', color: b > 400 ? '#ff2020' : b > 330 ? '#ff6600' : '#ffaa00', size: 12 } };
  });
}

export function buildWebcamMarkers(markers: Array<WebcamEntry | WebcamCluster>): CesiumMarker[] {
  return (markers ?? []).filter((m) => finite(m.lat, m.lng)).map((m) => {
    if ('count' in m) return { id: `webcam-cluster-${m.lat.toFixed(3)},${m.lng.toFixed(3)}`, kind: 'webcam-cluster', lat: m.lat, lon: m.lng, title: `${m.count} webcams`, style: { glyph: String(m.count), color: '#7dd3fc', size: 12 }, zoomOnClick: true };
    const cat = getCategoryStyle(m.category || 'other');
    return { id: `webcam-${m.webcamId}`, kind: 'webcam', lat: m.lat, lon: m.lng, title: m.title, style: { glyph: cat.emoji ?? '📷', color: cat.color ?? '#7dd3fc', size: 12 } };
  });
}

export function buildUcdpMarkers(events: UcdpGeoEvent[]): CesiumMarker[] {
  return (events ?? []).filter((e) => finite(e.latitude, e.longitude)).map((e) => {
    const deaths = e.deaths_best ?? 0;
    return { id: e.id, kind: 'ucdp', lat: e.latitude, lon: e.longitude, title: `${e.side_a ?? ''} vs ${e.side_b ?? ''}`, rank: deaths, style: { color: 'rgba(255,100,0,0.85)', size: Math.min(10, 5 + deaths * 0.3), outline: 'rgba(255,160,80,0.9)' } };
  });
}

export function buildDisplacementMarkers(flows: DisplacementFlow[]): CesiumMarker[] {
  return (flows ?? []).filter((f) => finite(f.originLat, f.originLon)).map((f) => ({
    id: `${f.originCode}-${f.asylumCode}`, kind: 'displacement', lat: f.originLat!, lon: f.originLon!,
    title: `${f.originName ?? f.originCode} → ${f.asylumName ?? f.asylumCode}`, style: { glyph: '👥', color: '#88bbff', size: 13 },
  }));
}

export function buildClimateMarkers(anomalies: ClimateAnomaly[]): CesiumMarker[] {
  return (anomalies ?? []).filter((a) => finite(a.lat, a.lon)).map((a) => ({
    id: `${a.zone}-${a.period}`, kind: 'climate', lat: a.lat, lon: a.lon, title: `${a.zone ?? ''} (${a.type ?? 'mixed'})`,
    style: { glyph: '🌡', color: CLIMATE_COLORS[a.type ?? 'mixed'] ?? '#88ff88', size: 12 },
  }));
}

export function buildGpsJamMarkers(hexes: GpsJamHex[]): CesiumMarker[] {
  return (hexes ?? []).filter((h) => finite(h.lat, h.lon)).map((h) => ({
    id: h.h3, kind: 'gpsjam', lat: h.lat, lon: h.lon, title: `GPS Jamming (${h.level})`, style: { glyph: '📡', color: h.level === 'high' ? '#ff2020' : '#ff8800', size: 12 },
  }));
}

export function buildTechEventMarkers(events: Array<{ id: string; title: string; lat: number; lng: number; country: string; daysUntil: number; [key: string]: unknown }>): CesiumMarker[] {
  return (events ?? []).filter((e) => finite(e.lat, e.lng)).map((e) => ({
    id: e.id, kind: 'tech', lat: e.lat, lon: e.lng, title: e.title ?? '', style: { glyph: '💻', color: '#44aaff', size: 12 },
  }));
}

export function buildSatelliteMarkers(positions: SatellitePosition[]): { markers: CesiumMarker[]; orbits: CesiumPath[] } {
  const usable = (positions ?? []).filter((s) => finite(s.lat, s.lng));
  return {
    markers: usable.map((s) => ({
      id: s.noradId, kind: 'satellite', lat: s.lat, lon: s.lng, heightM: (s.alt ?? 0) * 1000, title: s.name,
      style: { color: SAT_COUNTRY_COLORS[s.country] ?? '#ccccff', size: 6 },
    })),
    orbits: usable.filter((s) => s.trail && s.trail.length > 1).map((s) => {
      const colors: Record<string, string> = { CN: 'rgba(255,32,32,0.4)', RU: 'rgba(255,136,0,0.4)', US: 'rgba(68,136,255,0.4)', EU: 'rgba(68,204,68,0.4)' };
      return { id: `orbit-${s.noradId}`, name: s.name, points: [[s.lng, s.lat, s.alt], ...s.trail], color: colors[s.country] ?? 'rgba(200,200,255,0.3)', width: 1, clampToGround: false };
    }),
  };
}

export function buildImagerySceneMarkers(scenes: ImageryScene[]): { markers: CesiumMarker[]; footprints: CesiumPolygon[] } {
  const parsed = (scenes ?? []).flatMap((s) => {
    try {
      const geom = JSON.parse(s.geometryGeojson) as { type?: string; coordinates?: number[][][] };
      if (geom?.type !== 'Polygon' || !geom.coordinates?.[0]?.[0]) return [];
      return [{ s, coords: geom.coordinates }];
    } catch { return []; }
  });
  return {
    markers: parsed.map(({ s, coords }, i) => {
      const ring = coords[0]!;
      const lats = ring.map((c) => c[1] ?? 0); const lons = ring.map((c) => c[0] ?? 0);
      return { id: `scene-${i}-${s.satellite}-${s.datetime}`, kind: 'imageryScene', lat: (Math.min(...lats) + Math.max(...lats)) / 2, lon: (Math.min(...lons) + Math.max(...lons)) / 2, title: `${s.satellite} ${s.datetime}`, style: { glyph: '🛰', color: '#00b4ff', size: 13 } };
    }),
    footprints: parsed.map(({ s, coords }, i) => ({ id: `footprint-${i}-${s.satellite}-${s.datetime}`, rings: coords, fill: 'rgba(0,0,0,0)', stroke: '#00b4ff', label: `${s.satellite} ${s.datetime}` })),
  };
}

export function buildStormPathsAndCones(events: NaturalEvent[]): { paths: CesiumPath[]; cones: CesiumPolygon[] } {
  const paths: CesiumPath[] = [];
  const cones: CesiumPolygon[] = [];
  for (const e of events ?? []) {
    const name = e.stormName || e.title || '';
    if (e.forecastTrack?.length) paths.push({ id: `storm-forecast-${e.id}`, name, points: [[e.lon, e.lat], ...e.forecastTrack.map((p) => [p.lon, p.lat])], color: 'rgba(255,100,100,0.8)', width: 2.5, clampToGround: true });
    if (e.pastTrack?.length) {
      for (let i = 0; i < e.pastTrack.length - 1; i++) {
        const a = e.pastTrack[i]!; const b = e.pastTrack[i + 1]!;
        const w = b.windKt ?? a.windKt ?? 0;
        const color = w >= 137 ? 'rgba(255,96,96,0.8)' : w >= 96 ? 'rgba(255,140,0,0.8)' : w >= 64 ? 'rgba(255,231,117,0.8)' : w >= 34 ? 'rgba(94,186,255,0.8)' : 'rgba(160,160,160,0.6)';
        paths.push({ id: `storm-past-${e.id}-${i}`, name, points: [[a.lon, a.lat], [b.lon, b.lat]], color, width: 2.5, clampToGround: true });
      }
    }
    if (e.conePolygon?.length) e.conePolygon.forEach((ring, i) => cones.push({ id: `cone-${e.id}-${i}`, rings: [ring as number[][]], fill: 'rgba(255,140,60,0.2)', stroke: 'rgba(255,140,60,0.5)', label: `${name} Forecast Cone` }));
  }
  return { paths, cones };
}

// ─── Static layers (bundled config, no network) ──────────────────────────────

export function buildMilitaryBaseMarkers(bases: MilitaryBase[]): CesiumMarker[] {
  return (bases ?? []).filter((b) => finite(b.lat, b.lon)).map((b) => ({
    id: b.id, kind: 'milbase', lat: b.lat, lon: b.lon, title: `${b.name}${b.country ? ' · ' + b.country : ''}`, style: { glyph: '▲', color: MILBASE_COLORS[b.type] ?? '#aaaaaa', size: 11 },
  }));
}

export function buildStaticMarkers(layer: keyof MapLayers): CesiumMarker[] {
  switch (layer) {
    case 'nuclear':
      return NUCLEAR_FACILITIES.filter((f) => f.status !== 'decommissioned').map((f) => ({ id: f.id, kind: 'nuclearSite', lat: f.lat, lon: f.lon, title: `${f.name} (${f.type})`, style: { glyph: '☢', color: '#ffd700', size: 13 } }));
    case 'irradiators':
      return (GAMMA_IRRADIATORS as GammaIrradiator[]).map((g) => ({ id: g.id, kind: 'irradiator', lat: g.lat, lon: g.lon, title: `${g.city}, ${g.country}`, style: { glyph: '⚠', color: '#ff8800', size: 12 } }));
    case 'spaceports':
      return (SPACEPORTS as Spaceport[]).filter((s) => s.status === 'active').map((s) => ({ id: s.id, kind: 'spaceport', lat: s.lat, lon: s.lon, title: `${s.name} (${s.operator})`, style: { glyph: '🚀', color: '#88ddff', size: 13 } }));
    case 'economic':
      return (ECONOMIC_CENTERS as EconomicCenter[]).map((c) => ({ id: c.id, kind: 'economic', lat: c.lat, lon: c.lon, title: `${c.name} · ${c.country}`, style: { glyph: '💰', color: c.type === 'exchange' ? '#ffd700' : c.type === 'central-bank' ? '#4488ff' : '#44cc88', size: 13 } }));
    case 'datacenters':
      return (AI_DATA_CENTERS as AIDataCenter[]).filter((d) => d.status !== 'decommissioned').map((d) => ({ id: d.id, kind: 'datacenter', lat: d.lat, lon: d.lon, title: `${d.name} (${d.owner})`, style: { glyph: '🖥', color: '#88aaff', size: 12 } }));
    case 'waterways':
      return (STRATEGIC_WATERWAYS as StrategicWaterway[]).map((w) => ({ id: w.id, kind: 'waterway', lat: w.lat, lon: w.lon, title: w.name, style: { glyph: '⚓', color: '#44aadd', size: 12 } }));
    case 'minerals':
      return (CRITICAL_MINERALS as CriticalMineralProject[]).filter((m) => m.status === 'producing' || m.status === 'development').map((m) => ({ id: m.id, kind: 'mineral', lat: m.lat, lon: m.lon, title: `${m.mineral} — ${m.name}`, style: { glyph: '💎', color: '#cc88ff', size: 12 } }));
    default:
      return [];
  }
}

export function buildStaticPaths(faultIds: ReadonlySet<string> = new Set(), degradedIds: ReadonlySet<string> = new Set()): { cables: CesiumPath[]; pipelines: CesiumPath[] } {
  return {
    cables: (UNDERSEA_CABLES as UnderseaCable[]).map((c) => ({
      id: c.id, name: c.name, points: c.points, width: 1.5, clampToGround: true,
      color: faultIds.has(c.id) ? '#ff3030' : degradedIds.has(c.id) ? '#ff8800' : 'rgba(0,200,255,0.65)',
    })),
    pipelines: (PIPELINES as Pipeline[]).map((p) => ({
      id: p.id, name: p.name, points: p.points, width: 1.5, clampToGround: true,
      color: p.type === 'oil' ? 'rgba(255,140,0,0.6)' : p.type === 'gas' ? 'rgba(80,220,120,0.6)' : 'rgba(180,160,255,0.6)',
    })),
  };
}

/** Trade routes are drawn as lifted great-circle-ish arcs, like globe.gl's arcsData. */
export function buildTradeRouteArcs(segments: TradeRouteSegment[] = resolveTradeRouteSegments()): CesiumPath[] {
  const colorFor = (d: TradeRouteSegment): string => {
    if (d.status === 'disrupted') return 'rgba(255,32,32,0.8)';
    if (d.status === 'high_risk') return 'rgba(255,180,0,0.7)';
    if (d.category === 'energy') return 'rgba(255,140,0,0.6)';
    if (d.category === 'container') return 'rgba(68,136,255,0.6)';
    return 'rgba(68,204,136,0.6)';
  };
  return segments.map((d) => {
    const [lon1, lat1] = d.sourcePosition; const [lon2, lat2] = d.targetPosition;
    const rad = Math.PI / 180;
    const dLon = Math.abs(lon2 - lon1) * rad; const dLat = Math.abs(lat2 - lat1) * rad;
    // Haversine chord for the arc height; 0.3 mirrors arcAltitudeAutoScale(0.3).
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    const distanceM = 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(a)));
    const peak = 0.3 * distanceM;
    const steps = 24;
    const points: number[][] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      points.push([lon1 + (lon2 - lon1) * t, lat1 + (lat2 - lat1) * t, (Math.sin(t * Math.PI) * peak) / 1000]);
    }
    return { id: `trade-${d.routeId}-${d.segmentIndex}`, name: `${d.routeName} · ${d.volumeDesc}`, points, color: colorFor(d), width: 1.5, clampToGround: false };
  });
}
