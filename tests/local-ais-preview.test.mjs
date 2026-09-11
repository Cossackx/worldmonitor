import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { RELAY_PORT, PREVIEW_PORT } from '../scripts/local-ais-preview.mjs';

test('relay uses a Fetch-safe port distinct from the dashboard', () => {
  assert.equal(RELAY_PORT, 4191);
  assert.notEqual(RELAY_PORT, 4190); // Fetch blocks the Sieve port.
  assert.notEqual(RELAY_PORT, PREVIEW_PORT);
});

const launcher = readFileSync(new URL('../scripts/local-ais-preview.mjs', import.meta.url), 'utf8');
const relay = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
const vite = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');

test('local AIS launcher loads only the explicitly supplied AIS key', () => {
  assert.match(launcher, /loadEnvFile/);
  assert.match(launcher, /AISSTREAM_API_KEY/);
  assert.match(launcher, /randomBytes\(32\)/);
  assert.match(launcher, /VITE_WS_RELAY_URL/);
  assert.match(launcher, /RELAY_SHARED_SECRET/);
  assert.doesNotMatch(launcher, /copyFile|cpSync|writeFile|\.env\.local/);
  assert.match(launcher, /Object\.fromEntries|allowlist|ALLOWLIST/);
});

test('local AIS launcher binds both children to loopback and cleans them up', () => {
  assert.match(launcher, /127\.0\.0\.1/);
  assert.match(launcher, /SIGINT/);
  assert.match(launcher, /SIGTERM/);
  assert.match(launcher, /kill\(/);
  assert.match(launcher, /vite\.js.*preview|preview.*vite\.js/s);
});

test('relay supports an explicit host without changing its default', () => {
  assert.match(relay, /const HOST = process\.env\.HOST \|\| '0\.0\.0\.0'/);
  assert.match(relay, /server\.listen\(PORT, HOST/);
});

test('Vite can be told not to read ambient dotenv files', () => {
  assert.match(vite, /WM_SKIP_DOTENV/);
  assert.match(vite, /process\.env\.WM_SKIP_DOTENV/);
});
