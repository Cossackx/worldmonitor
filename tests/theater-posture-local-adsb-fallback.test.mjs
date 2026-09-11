import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createTempDir, removeTempDir } from './helpers/temp-dir.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envKeys = ['LOCAL_API_MODE', 'VITE_PRIVATE_WORKSPACE', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

function resolveSibling(fromDir, specifier) {
  for (const candidate of [resolve(fromDir, specifier), resolve(fromDir, `${specifier}.ts`), resolve(fromDir, `${specifier}.js`)]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

async function importGetTheaterPosture() {
  const sourcePath = resolve(root, 'server/worldmonitor/military/v1/get-theater-posture.ts');
  const sourceDir = dirname(sourcePath);
  let source = readFileSync(sourcePath, 'utf8');
  const replacements = {
    './_shared': resolve(root, 'server/worldmonitor/military/v1/_shared.ts'),
    '../../../_shared/redis': resolve(root, 'server/_shared/redis.ts'),
    '../../../_shared/response-headers': resolve(root, 'server/_shared/response-headers.ts'),
    '../../../_shared/provider-redistribution': resolve(root, 'server/_shared/provider-redistribution.ts'),
  };
  for (const [specifier, target] of Object.entries(replacements)) source = source.replaceAll(`'${specifier}'`, `'${pathToFileURL(target).href}'`);
  source = source.replaceAll(/from '((?:\.\.?\/)[^']+)'/g, (match, specifier) => {
    const target = resolveSibling(sourceDir, specifier);
    return target ? `from '${pathToFileURL(target).href}'` : match;
  });
  const tempDir = createTempDir('wm-local-theater-posture-');
  const tempPath = join(tempDir, basename(sourcePath));
  writeFileSync(tempPath, source);
  const module = await import(`${pathToFileURL(tempPath).href}?t=${Date.now()}-${Math.random()}`);
  return { module, cleanup: () => removeTempDir(tempDir) };
}

function noRedisEnv() {
  delete process.env.LOCAL_API_MODE;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
}

// Iran theater (north 42, south 20, east 65, west 30): elevated at 8 flights.
const IRAN_FLIGHTS = Array.from({ length: 8 }, (_, i) => ({
  hex: `ae00${i}`, flight: i < 2 ? `SHELL${i}` : i === 2 ? 'MAGIC1' : `RAGE${i}`,
  lat: 30 + i * 0.1, lon: 50, alt_baro: 30000, gs: 400, track: 90,
}));

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of savedEnv) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

test('private local preview computes theater posture on demand from adsb.lol when no Redis snapshot exists', async () => {
  process.env.VITE_PRIVATE_WORKSPACE = '1';
  noRedisEnv();
  const calls = [];
  globalThis.fetch = async (url) => {
    const raw = String(url);
    calls.push(raw);
    if (raw.startsWith('https://api.adsb.lol/v2/mil')) {
      return Response.json({ ac: [
        ...IRAN_FLIGHTS,
        { hex: 'ae0999', flight: 'RCH999', lat: 31, lon: 50, alt_baro: 'ground' },
        { hex: 'ae000', flight: 'DUPLICATE', lat: 31, lon: 51, alt_baro: 20000 },
        { hex: '43c1aa', flight: 'RRR7101', lat: 51, lon: -1, alt_baro: 20000 },
      ] });
    }
    throw new Error(`unexpected fetch: ${raw}`);
  };
  const { module, cleanup } = await importGetTheaterPosture();
  try {
    module.__resetLocalPostureCacheForTests();
    const result = await module.getTheaterPosture(
      { request: new Request('http://127.0.0.1:4200/api/military/v1/get-theater-posture') },
      { theater: '' },
    );
    assert.equal(result.theaters.length, 9, 'every posture theater is reported');
    const iran = result.theaters.find((t) => t.theater === 'iran-theater');
    assert.equal(iran.activeFlights, 8, 'ground, duplicate and out-of-theater aircraft are dropped');
    assert.equal(iran.postureLevel, 'elevated');
    assert.equal(iran.trackedVessels, 0, 'vessels are augmented client-side');
    assert.deepEqual(iran.activeOperations, ['aerial_refueling', 'airborne_early_warning']);
    assert.equal(result.theaters.find((t) => t.theater === 'baltic-theater').activeFlights, 0);
    assert.equal(calls.filter((url) => url.startsWith('https://api.adsb.lol/v2/mil')).length, 1);

    // Second call within the TTL is served from the in-module cache.
    await module.getTheaterPosture(
      { request: new Request('http://127.0.0.1:4200/api/military/v1/get-theater-posture') },
      { theater: '' },
    );
    assert.equal(calls.filter((url) => url.startsWith('https://api.adsb.lol/v2/mil')).length, 1, 'adsb.lol is not re-fetched within the TTL');
  } finally {
    cleanup();
  }
});

test('private local preview returns empty when adsb.lol has no theater traffic', async () => {
  process.env.VITE_PRIVATE_WORKSPACE = '1';
  noRedisEnv();
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://api.adsb.lol/v2/mil')) return Response.json({ ac: [{ hex: '43c1aa', flight: 'RRR7101', lat: 51, lon: -1, alt_baro: 20000 }] });
    throw new Error(`unexpected fetch: ${url}`);
  };
  const { module, cleanup } = await importGetTheaterPosture();
  try {
    module.__resetLocalPostureCacheForTests();
    const result = await module.getTheaterPosture(
      { request: new Request('http://127.0.0.1:4200/api/military/v1/get-theater-posture') },
      { theater: '' },
    );
    assert.deepEqual(result, { theaters: [] });
  } finally {
    cleanup();
  }
});

test('hosted path never calls adsb.lol when the private preview flag is absent', async () => {
  delete process.env.VITE_PRIVATE_WORKSPACE;
  noRedisEnv();
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    throw new Error(`unexpected provider fallback: ${url}`);
  };
  const { module, cleanup } = await importGetTheaterPosture();
  try {
    module.__resetLocalPostureCacheForTests();
    const result = await module.getTheaterPosture(
      { request: new Request('https://worldmonitor.app/api/military/v1/get-theater-posture') },
      { theater: '' },
    );
    assert.deepEqual(result, { theaters: [] });
    assert.equal(calls.length, 0);
  } finally {
    cleanup();
  }
});

test('computeTheaterPosturesFromFlights flags strike packaging and critical thresholds', async () => {
  const { module, cleanup } = await importGetTheaterPosture();
  try {
    // Israel/Gaza: critical at 8, strike = 1 tanker + 1 awacs + 3 fighters.
    const flights = [
      { id: 't1', callsign: 'SHELL1', lat: 31, lon: 34.5, altitude: 1, heading: 0, speed: 0, aircraftType: 'tanker' },
      { id: 'a1', callsign: 'MAGIC1', lat: 31, lon: 34.5, altitude: 1, heading: 0, speed: 0, aircraftType: 'awacs' },
      ...['f1', 'f2', 'f3', 'f4', 'f5', 'f6'].map((id) => ({ id, callsign: 'VIPER1', lat: 31, lon: 34.5, altitude: 1, heading: 0, speed: 0, aircraftType: 'fighter' })),
    ];
    const gaza = module.computeTheaterPosturesFromFlights(flights, 123).find((t) => t.theater === 'israel-gaza-theater');
    assert.equal(gaza.postureLevel, 'critical');
    assert.equal(gaza.assessedAt, 123);
    assert.deepEqual(gaza.activeOperations, ['strike_capable', 'aerial_refueling', 'airborne_early_warning']);
  } finally {
    cleanup();
  }
});
