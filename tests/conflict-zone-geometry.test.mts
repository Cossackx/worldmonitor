import test from 'node:test';
import assert from 'node:assert/strict';
import type { FeatureCollection, Geometry } from 'geojson';
import { CONFLICT_ZONES } from '../shared/geo-data.ts';
import { CONFLICT_COUNTRY_ISO, resolveConflictZoneFeatures, shouldSimplifyConflictGeometry } from '../shared/conflict-zone-geometry.ts';

const country = (code: string, geometry: Geometry) => ({
  type: 'Feature' as const,
  properties: { 'ISO3166-1-Alpha-2': code },
  geometry,
});

const iranGeometry: Geometry = {
  type: 'Polygon',
  coordinates: [[[44, 25], [63, 25], [63, 40], [44, 40], [44, 25]]],
};

const countries = (features: ReturnType<typeof country>[]): FeatureCollection<Geometry> => ({
  type: 'FeatureCollection',
  features,
});

test('uses the authoritative Iran country geometry exactly', () => {
  const result = resolveConflictZoneFeatures(CONFLICT_ZONES, CONFLICT_COUNTRY_ISO, countries([country('IR', iranGeometry)]));
  const iran = result.find((feature) => feature.properties?.id === 'iran');
  assert.deepEqual(iran?.geometry, iranGeometry);
  assert.equal(iran?.properties?.geometryKind, 'country');
  assert.equal(iran?.properties?.label, 'Iran War Theater');
  assert.equal(iran?.properties?.countryCode, 'IR');
  assert.equal(shouldSimplifyConflictGeometry(iran!), false);
});

test('does not create a rough national fallback when country geometry is unavailable', () => {
  const result = resolveConflictZoneFeatures(CONFLICT_ZONES, CONFLICT_COUNTRY_ISO, null);
  assert.equal(result.some((feature) => feature.properties?.id === 'iran'), false);
  assert.equal(result.some((feature) => feature.properties?.id === 'ukraine'), false);
});

test('preserves Pakistan regional geometry and labels it as approximate conflict area', () => {
  const result = resolveConflictZoneFeatures(CONFLICT_ZONES, CONFLICT_COUNTRY_ISO, null);
  const pakistan = result.find((feature) => feature.properties?.id === 'pak_afghan');
  assert.deepEqual(pakistan?.geometry, {
    type: 'Polygon',
    coordinates: [[
      [72.5, 35.7], [69.4, 31.69], [65.95, 29.33], [64.9, 30.29], [71.02, 36.55], [72.5, 35.7],
    ]],
  });
  assert.equal(pakistan?.properties?.geometryKind, 'regional');
  assert.match(String(pakistan?.properties?.label), /approximate conflict area/i);
  assert.equal(shouldSimplifyConflictGeometry(pakistan!), true);
});
