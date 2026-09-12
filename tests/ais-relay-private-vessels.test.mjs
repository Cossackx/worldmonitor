// The relay's private all-ships listing selector (RELAY_PRIVATE_VESSELS route).
// Pure function test: no relay process, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadSelector() {
  // ais-relay.cjs boots servers at require time, so the selector is read out
  // of the source text and evaluated on its own. It has no free variables
  // beyond its three constants.
  const fs = require('node:fs');
  const src = fs.readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
  const start = src.indexOf('const PRIVATE_VESSELS_DEFAULT_LIMIT');
  const end = src.indexOf('function getTankerReportsSnapshot');
  assert.ok(start > 0 && end > start, 'selector block present in relay source');
  const block = src.slice(start, end);
  return new Function(`${block}; return selectVesselsInBbox;`)();
}

const selectVesselsInBbox = loadSelector();
const v = (mmsi, lat, lon, timestamp, extra = {}) => ({ mmsi, name: `S${mmsi}`, lat, lon, timestamp, shipType: 70, heading: 1, speed: 2, course: 3, ...extra });

test('filters by bbox and age, newest first, capped, with truncation flag', () => {
  const now = 1_000_000;
  const vessels = [
    v(1, 26, 56, now - 1_000),
    v(2, 26.5, 56.5, now - 5_000),
    v(3, 10, 10, now - 1_000),                    // outside bbox
    v(4, 26.2, 56.2, now - 30 * 60 * 1000),       // too old
    v(5, 26.3, 56.3, now - 2_000, { shipType: undefined, heading: NaN, speed: null }),
  ];
  const bbox = { sw: { lat: 25, lon: 55 }, ne: { lat: 27, lon: 57 } };
  const r = selectVesselsInBbox(vessels, bbox, { now, limit: 2 });
  assert.equal(r.total, 3);
  assert.equal(r.truncated, true);
  assert.deepEqual(r.vessels.map((x) => x.mmsi), ['1', '5']);
  assert.deepEqual(r.vessels[1], { mmsi: '5', name: 'S5', lat: 26.3, lon: 56.3, timestamp: now - 2_000, shipType: 0, heading: null, speed: null, course: 3 });
});

test('no bbox lists worldwide; limit is clamped', () => {
  const now = 5_000_000;
  const vessels = Array.from({ length: 2_000 }, (_, i) => v(i, 0, i / 100, now - i));
  const r = selectVesselsInBbox(vessels, null, { now, limit: 99_999 });
  assert.equal(r.vessels.length, 1_500);
  assert.equal(r.total, 2_000);
  assert.equal(selectVesselsInBbox(vessels, null, { now, limit: 'nope' }).vessels.length, 400);
});
