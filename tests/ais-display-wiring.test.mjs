import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const maritime = read('src/services/maritime/index.ts');
const loader = read('src/app/data-loader.ts');
const panel = read('src/components/StrategicPosturePanel.ts');

 test('AIS snapshot semantics preserve source freshness and candidate absence', () => {
  assert.match(maritime, /fetchedAt: response\.fetchedAt/);
  assert.match(maritime, /dataAvailable: response\.dataAvailable/);
  assert.match(maritime, /candidateCount: latestCandidateCount/);
  assert.match(maritime, /candidatesRequested: latestCandidatesRequested/);
  assert.match(maritime, /function shouldIncludeCandidates\(\): boolean \{\s*return positionCallbacks\.size > 0;/s);
});

test('military loading does not discard AIS when OpenSky rejects', () => {
  assert.equal((loader.match(/const \[flightResult, vesselResult\] = await Promise\.allSettled\(/g) ?? []).length, 2);
  assert.match(loader, /OpenSky military flights unavailable; retaining AIS result/);
  assert.match(loader, /const vesselData = vesselResult\.status === 'fulfilled'/);
});

test('posture panel reports AIS separately without turning density into ship markers', () => {
  assert.match(loader, /updateAisAvailability/);
  assert.match(panel, /data-ais-source="AISStream"/);
  assert.doesNotMatch(panel, /no military-matched vessel reports/);
  assert.match(panel, /getAisCandidateSummary/);
  assert.match(panel, /Density zones are not individual ship markers/);
});
