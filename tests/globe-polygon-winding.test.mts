import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geoArea, geoContains } from 'd3-geo';
import { readFileSync } from 'node:fs';
import { CONFLICT_ZONES } from '../shared/geo-data';
import { normalizeGlobePolygonRings } from '../src/utils/globe-polygon-winding';

test('every configured regional ring stays local in either input direction', () => {
  for (const zone of CONFLICT_ZONES) {
    for (const ring of [zone.coords, [...zone.coords].reverse()]) {
      const before = JSON.stringify(ring);
      const coordinates = normalizeGlobePolygonRings([ring]);
      assert.ok(geoArea({ type: 'Polygon', coordinates }) < 2 * Math.PI, zone.id);
      assert.equal(JSON.stringify(ring), before);
    }
  }
});
test('Iran canonical polygon contains Iran and excludes the opposite hemisphere', () => {
  const data = JSON.parse(readFileSync(new URL('../public/data/countries.geojson', import.meta.url), 'utf8'));
  const iran = data.features.find((f: any) => f.properties['ISO3166-1-Alpha-2'] === 'IR');
  const geometry = { type: 'Polygon' as const, coordinates: normalizeGlobePolygonRings(iran.geometry.coordinates) };
  assert.ok(geoContains(geometry, [53, 32]));
  assert.ok(!geoContains(geometry, [-127, -32]));
});
test('holes retain opposite winding', () => {
  const exterior = [[0,0],[10,0],[10,10],[0,10],[0,0]];
  const hole = [[2,2],[4,2],[4,4],[2,4],[2,2]];
  const geometry = { type: 'Polygon' as const, coordinates: normalizeGlobePolygonRings([exterior, hole]) };
  assert.ok(geoContains(geometry, [1,1]));
  assert.ok(!geoContains(geometry, [3,3]));
});
