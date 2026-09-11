import type { Feature, FeatureCollection, Geometry } from 'geojson';
import type { ConflictZone } from './geo-data.ts';

/** Zones whose configured geometry is a whole-country overlay. */
export const CONFLICT_COUNTRY_ISO: Readonly<Record<string, readonly string[]>> = {
  iran: ['IR'],
  ukraine: ['UA'],
  sudan: ['SD'],
  myanmar: ['MM'],
};

export type ConflictGeometryKind = 'country' | 'regional';

export interface ConflictZoneFeatureProperties {
  id: string;
  name: string;
  intensity?: ConflictZone['intensity'];
  geometryKind: ConflictGeometryKind;
  label: string;
  countryCode?: string;
}

export type ConflictZoneFeature = Feature<Geometry, ConflictZoneFeatureProperties>;

function closedRing(coords: ConflictZone['coords']): ConflictZone['coords'] {
  if (coords.length < 2) return coords;
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (first && last && first[0] === last[0] && first[1] === last[1]) return coords;
  return [...coords, coords[0]!];
}

/**
 * Resolve conflict overlays without representing an approximate national shape as
 * authoritative. Country-mapped zones require matching local geometry; regional
 * zones intentionally retain their configured polygon and are labelled as such.
 */
export function resolveConflictZoneFeatures(
  zones: readonly ConflictZone[],
  countryIsoByZone: Readonly<Record<string, readonly string[]>>,
  countries: FeatureCollection<Geometry> | null | undefined,
): ConflictZoneFeature[] {
  const resolved: ConflictZoneFeature[] = [];
  for (const zone of zones) {
    const isoCodes = countryIsoByZone[zone.id];
    const base = {
      id: zone.id,
      name: zone.name,
      intensity: zone.intensity,
    };
    if (isoCodes) {
      if (!countries) continue;
      for (const feature of countries.features) {
        const code = feature.properties?.['ISO3166-1-Alpha-2'];
        if (typeof code !== 'string' || !isoCodes.includes(code) || !feature.geometry) continue;
        resolved.push({
          type: 'Feature',
          properties: { ...base, geometryKind: 'country', label: zone.name, countryCode: code },
          geometry: feature.geometry,
        });
      }
      continue;
    }
    resolved.push({
      type: 'Feature',
      properties: { ...base, geometryKind: 'regional', label: `${zone.name} — approximate conflict area` },
      geometry: { type: 'Polygon', coordinates: [closedRing(zone.coords)] },
    });
  }
  return resolved;
}

/** Country overlays must keep the canonical boundary at every zoom. */
export function shouldSimplifyConflictGeometry(feature: ConflictZoneFeature): boolean {
  return feature.properties.geometryKind === 'regional';
}
