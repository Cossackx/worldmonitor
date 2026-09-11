#!/usr/bin/env node
/**
 * Reproduce the proposed Iran boundary candidate without touching app sources.
 * Research-only: fetches a pinned Natural Earth 50m Admin 0 source, extracts
 * ISO_A2=IR, and writes a local override fixture plus provenance report.
 *
 * Usage: node docs/discovery/boundary-resolution-candidate-iran.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE_COMMIT = 'ca96624a56bd078437bca8184e78163e5039ad19';
const SOURCE_URL = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${SOURCE_COMMIT}/geojson/ne_50m_admin_0_countries.geojson`;
const LICENSE_URL = 'https://github.com/nvkelso/natural-earth-vector/blob/master/LICENSE.md';
const OUT = resolve(ROOT, 'docs/discovery/boundary-resolution-candidate-iran.geojson');
const REPORT = resolve(ROOT, 'docs/discovery/boundary-resolution-candidate-iran.provenance.json');

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function geometryStats(geometry) {
  const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  const rings = polygons.flat();
  const points = rings.flat();
  const xs = points.map(([x]) => x), ys = points.map(([, y]) => y);
  return {
    type: geometry.type,
    polygons: polygons.length,
    rings: rings.length,
    points: points.length,
    bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    closedRings: rings.filter((r) => r.length > 0 && JSON.stringify(r[0]) === JSON.stringify(r[r.length - 1])).length,
  };
}
function assert(condition, message) { if (!condition) throw new Error(message); }

const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(60_000) });
assert(response.ok, `source fetch failed: HTTP ${response.status}`);
const sourceBytes = Buffer.from(await response.arrayBuffer());
const source = JSON.parse(sourceBytes.toString('utf8'));
const matches = source.features.filter((f) => f.properties?.ISO_A2 === 'IR');
assert(matches.length === 1, `expected exactly one ISO_A2=IR feature, got ${matches.length}`);
const sourceFeature = matches[0];
assert(sourceFeature.properties.ISO_A3 === 'IRN', 'source ISO_A3 is not IRN');
assert(sourceFeature.properties.ADMIN === 'Iran', 'source ADMIN is not Iran');
const candidate = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: {
      name: 'Iran',
      'ISO3166-1-Alpha-2': 'IR',
      'ISO3166-1-Alpha-3': 'IRN',
    },
    geometry: sourceFeature.geometry,
  }],
};
const candidateBytes = Buffer.from(`${JSON.stringify(candidate)}\n`);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, candidateBytes);

const base = JSON.parse(readFileSync(resolve(ROOT, 'public/data/countries.geojson'), 'utf8'));
const baseFeature = base.features.find((f) => f.properties?.['ISO3166-1-Alpha-2'] === 'IR');
assert(baseFeature, 'base countries.geojson has no IR feature');
const checks = {
  iso2: candidate.features[0].properties['ISO3166-1-Alpha-2'] === 'IR',
  iso3: candidate.features[0].properties['ISO3166-1-Alpha-3'] === 'IRN',
  name: candidate.features[0].properties.name === 'Iran',
  bboxWithinLongitude: geometryStats(candidate.features[0].geometry).bbox[0] > 43 && geometryStats(candidate.features[0].geometry).bbox[2] < 64,
  bboxWithinLatitude: geometryStats(candidate.features[0].geometry).bbox[1] > 24 && geometryStats(candidate.features[0].geometry).bbox[3] < 41,
  ringsClosed: geometryStats(candidate.features[0].geometry).closedRings === geometryStats(candidate.features[0].geometry).rings,
  sourceFeatureCount: source.features.length === 242,
  baseFeatureCount: base.features.length === 258,
};
assert(Object.values(checks).every(Boolean), `geographic/identity checks failed: ${JSON.stringify(checks)}`);

const report = {
  proposal: 'NOT PRODUCTION — parent must review dataset and browser rendering before applying',
  candidate: 'Iran only; no ISO mapping or disputed-territory convention changes',
  source: {
    dataset: 'Natural Earth Admin 0 Countries, 50m cultural vectors',
    repository: 'https://github.com/nvkelso/natural-earth-vector',
    commit: SOURCE_COMMIT,
    url: SOURCE_URL,
    license: 'Natural Earth public domain; see license URL',
    licenseUrl: LICENSE_URL,
    downloadedSha256: sha256(sourceBytes),
  },
  base: {
    path: 'public/data/countries.geojson',
    sha256: sha256(readFileSync(resolve(ROOT, 'public/data/countries.geojson'))),
    featureCount: base.features.length,
    iran: geometryStats(baseFeature.geometry),
  },
  candidate: {
    path: 'docs/discovery/boundary-resolution-candidate-iran.geojson',
    sha256: sha256(candidateBytes),
    sourceFeatureCount: source.features.length,
    iran: geometryStats(candidate.features[0].geometry),
  },
  checks,
  runtimeNote: 'Fixture is local. Existing runtime override fetch is not modified; no WorldMonitor service dependency is introduced by this proposal.',
};
writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
