import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createTempDir, removeTempDir } from './helpers/temp-dir.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envKeys = ['LOCAL_API_MODE', 'VITE_PRIVATE_WORKSPACE', 'WS_RELAY_URL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

function resolveSibling(fromDir, specifier) {
  for (const candidate of [resolve(fromDir, specifier), resolve(fromDir, `${specifier}.ts`), resolve(fromDir, `${specifier}.js`)]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

async function importListMilitaryFlights() {
  const sourcePath = resolve(root, 'server/worldmonitor/military/v1/list-military-flights.ts');
  const sourceDir = dirname(sourcePath);
  let source = readFileSync(sourcePath, 'utf8');
  const replacements = {
    './_shared': resolve(root, 'server/worldmonitor/military/v1/_shared.ts'),
    './_bounds': resolve(root, 'server/worldmonitor/military/v1/_bounds.ts'),
    '../../../_shared/constants': resolve(root, 'server/_shared/constants.ts'),
    '../../../_shared/redis': resolve(root, 'server/_shared/redis.ts'),
    '../../../_shared/relay': resolve(root, 'server/_shared/relay.ts'),
    '../../../_shared/response-headers': resolve(root, 'server/_shared/response-headers.ts'),
    '../../../_shared/provider-redistribution': resolve(root, 'server/_shared/provider-redistribution.ts'),
    '../../../_shared/seed-envelope': resolve(root, 'server/_shared/seed-envelope.ts'),
  };
  for (const [specifier, target] of Object.entries(replacements)) source = source.replaceAll(`'${specifier}'`, `'${pathToFileURL(target).href}'`);
  source = source.replaceAll(/from '((?:\.\.?\/)[^']+)'/g, (match, specifier) => {
    const target = resolveSibling(sourceDir, specifier);
    return target ? `from '${pathToFileURL(target).href}'` : match;
  });
  const tempDir = createTempDir('wm-local-flight-fallback-');
  const tempPath = join(tempDir, basename(sourcePath));
  writeFileSync(tempPath, source);
  const module = await import(`${pathToFileURL(tempPath).href}?t=${Date.now()}-${Math.random()}`);
  return { module, cleanup: () => removeTempDir(tempDir) };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of savedEnv) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

test('private local preview falls back to free direct OpenSky when relay is unavailable', async () => {
  process.env.VITE_PRIVATE_WORKSPACE = '1';
  process.env.WS_RELAY_URL = 'http://relay.test';
  delete process.env.LOCAL_API_MODE;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  const calls = [];
  globalThis.fetch = async (url) => {
    const raw = String(url);
    calls.push(raw);
    if (raw.startsWith('http://relay.test/opensky')) return new Response('{"error":"Unauthorized"}', { status: 401 });
    if (raw.startsWith('https://opensky-network.org/api/states/all')) {
      return Response.json({ states: [['ae0001', 'RCH101 ', 'United States', 1789143900, 1789143900, -100, 40, 9000, false, 200, 180, 0]] });
    }
    throw new Error(`unexpected fetch: ${raw}`);
  };
  const { module, cleanup } = await importListMilitaryFlights();
  try {
    const result = await module.listMilitaryFlights(
      { request: new Request('http://127.0.0.1:4189/api/military/v1/list-military-flights') },
      { swLat: 30, swLon: -120, neLat: 50, neLon: -70, pageSize: 10, cursor: '' },
    );
    assert.equal(result.flights.length, 1);
    assert.equal(result.flights[0].source, 'opensky');
    assert.ok(calls.some((url) => url.startsWith('https://opensky-network.org/api/states/all')));
  } finally {
    cleanup();
  }
});

test('hosted/provider paths stay fail-closed when the private preview flag is absent', async () => {
  delete process.env.VITE_PRIVATE_WORKSPACE;
  process.env.WS_RELAY_URL = 'http://relay.test';
  delete process.env.LOCAL_API_MODE;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  const calls = [];
  globalThis.fetch = async (url) => {
    const raw = String(url);
    calls.push(raw);
    if (raw.startsWith('http://relay.test/opensky')) return new Response('{"error":"Unauthorized"}', { status: 401 });
    throw new Error(`unexpected provider fallback: ${raw}`);
  };
  const { module, cleanup } = await importListMilitaryFlights();
  try {
    const result = await module.listMilitaryFlights(
      { request: new Request('https://worldmonitor.app/api/military/v1/list-military-flights') },
      { swLat: 30, swLon: -120, neLat: 50, neLon: -70, pageSize: 10, cursor: '' },
    );
    assert.equal(result.flights.length, 0);
    assert.equal(calls.some((url) => url.startsWith('https://opensky-network.org/api/states/all')), false);
  } finally {
    cleanup();
  }
});

test('private local preview prefers the keyless adsb.lol military set and filters it to the request bbox', async () => {
  process.env.VITE_PRIVATE_WORKSPACE = '1';
  process.env.WS_RELAY_URL = 'http://relay.test';
  delete process.env.LOCAL_API_MODE;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  const calls = [];
  globalThis.fetch = async (url) => {
    const raw = String(url);
    calls.push(raw);
    if (raw.startsWith('https://api.adsb.lol/v2/mil')) {
      return Response.json({ ac: [
        { hex: 'ae1234', flight: 'RCH123 ', r: '07-7183', t: 'C17', lat: 40, lon: -100, alt_baro: 31000, gs: 450, track: 270, baro_rate: 0, squawk: '4021' },
        { hex: 'ae9999', flight: 'REACH9 ', lat: 40, lon: -100, alt_baro: 'ground' },
        { hex: '43c1aa', flight: 'RRR7101', lat: 51, lon: -1, alt_baro: 20000, gs: 400, track: 90 },
        { hex: 'ae1234', flight: 'DUPLICATE', lat: 41, lon: -101, alt_baro: 30000 },
      ] });
    }
    throw new Error(`unexpected fetch: ${raw}`);
  };
  const { module, cleanup } = await importListMilitaryFlights();
  try {
    const result = await module.listMilitaryFlights(
      { request: new Request('http://127.0.0.1:4200/api/military/v1/list-military-flights') },
      { swLat: 30, swLon: -120, neLat: 50, neLon: -70, pageSize: 10, cursor: '' },
    );
    assert.equal(result.flights.length, 1, 'ground, out-of-bbox and duplicate aircraft are dropped');
    const flight = result.flights[0];
    assert.equal(flight.source, 'adsb.lol');
    assert.equal(flight.hexCode, 'AE1234');
    assert.equal(flight.callsign, 'RCH123');
    assert.equal(flight.registration, '07-7183');
    assert.equal(flight.aircraftModel, 'C17');
    assert.equal(flight.altitude, 31000);
    assert.equal(flight.speed, 450);
    assert.equal(flight.heading, 270);
    assert.equal(calls.some((url) => url.startsWith('http://relay.test/opensky')), false, 'OpenSky is not consulted when adsb.lol answers');
  } finally {
    cleanup();
  }
});

test('hosted path never calls adsb.lol', async () => {
  delete process.env.VITE_PRIVATE_WORKSPACE;
  process.env.WS_RELAY_URL = 'http://relay.test';
  delete process.env.LOCAL_API_MODE;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  const calls = [];
  globalThis.fetch = async (url) => {
    const raw = String(url);
    calls.push(raw);
    if (raw.startsWith('http://relay.test/opensky')) return new Response('{"error":"Unauthorized"}', { status: 401 });
    throw new Error(`unexpected provider fallback: ${raw}`);
  };
  const { module, cleanup } = await importListMilitaryFlights();
  try {
    await module.listMilitaryFlights(
      { request: new Request('https://worldmonitor.app/api/military/v1/list-military-flights') },
      { swLat: 30, swLon: -120, neLat: 50, neLon: -70, pageSize: 10, cursor: '' },
    );
    assert.equal(calls.some((url) => url.includes('adsb.lol')), false);
  } finally {
    cleanup();
  }
});
