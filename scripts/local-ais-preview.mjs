#!/usr/bin/env node
/**
 * Start a private AIS relay and Vite preview without inheriting the workstation
 * environment. The original env file is read only to obtain AISSTREAM_API_KEY.
 * No secret is written to disk or printed.
 *
 * Usage: node scripts/local-ais-preview.mjs --env C:/path/to/gev/.env
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RELAY_HOST = '127.0.0.1';
// 4190 is on the Fetch blocked-port list (Sieve); use an HTTP-safe port.
export const RELAY_PORT = 4191;
export const PREVIEW_PORT = 4189;
export const RELAY_URL = `ws://${RELAY_HOST}:${RELAY_PORT}`;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '..');
const RELAY_SCRIPT = resolve(SCRIPT_DIR, 'ais-relay.cjs');
const VITE_CLI = resolve(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

// Keep this list deliberately small. In particular, do not forward provider,
// package-manager, proxy, cloud, or dotenv-related variables.
const PROCESS_ENV_ALLOWLIST = [
  'PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE',
  'LOCALAPPDATA', 'APPDATA', 'HOME', 'COMSPEC', 'PATHEXT',
];

export function isolatedEnv(extra = {}) {
  return Object.fromEntries(
    PROCESS_ENV_ALLOWLIST
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]])
      .concat(Object.entries(extra)),
  );
}

function readArgs(argv) {
  const index = argv.indexOf('--env');
  const envPath = index >= 0 ? argv[index + 1] : undefined;
  if (!envPath || envPath.startsWith('-')) {
    throw new Error('Usage: node scripts/local-ais-preview.mjs --env <original GEV .env path>');
  }
  return resolve(envPath);
}

function loadAisKey(envPath) {
  if (!existsSync(envPath)) throw new Error(`Environment file not found: ${envPath}`);
  // Do not let an inherited key satisfy this check; only the explicit file may provide it.
  delete process.env.AISSTREAM_API_KEY;
  delete process.env.VITE_AISSTREAM_API_KEY;
  loadEnvFile(envPath);
  const key = process.env.AISSTREAM_API_KEY;
  if (!key) throw new Error('AISSTREAM_API_KEY is missing from the supplied environment file');
  return key;
}

function start(command, args, env) {
  return spawn(process.execPath, [command, ...args], {
    cwd: ROOT,
    env,
    stdio: 'inherit',
    windowsHide: false,
  });
}

async function main() {
  const envPath = readArgs(process.argv.slice(2));
  const aisKey = loadAisKey(envPath);
  const relaySecret = randomBytes(32).toString('hex');
  const common = {
    HOST: RELAY_HOST,
    RELAY_SHARED_SECRET: relaySecret,
    WS_RELAY_URL: RELAY_URL,
    VITE_WS_RELAY_URL: RELAY_URL,
    WM_SKIP_DOTENV: '1',
  };
  const relayEnv = isolatedEnv({ ...common, PORT: String(RELAY_PORT), AISSTREAM_API_KEY: aisKey, RELAY_TEST_MODE: 'true' });
  const viteEnv = isolatedEnv({ ...common, PORT: String(PREVIEW_PORT), VITE_VARIANT: 'full', VITE_PRIVATE_WORKSPACE: '1' });

  const relay = start(RELAY_SCRIPT, [], relayEnv);
  let preview;
  let stopping = false;
  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true;
    for (const child of [preview, relay]) {
      if (child && !child.killed) child.kill('SIGTERM');
    }
    setTimeout(() => process.exit(code), 2000).unref();
  };
  process.once('SIGINT', () => stop(0));
  process.once('SIGTERM', () => stop(0));
  relay.once('exit', (code, signal) => {
    if (!stopping) stop(code ?? (signal ? 1 : 0));
  });

  // The maritime API is registered by configureServer, not configurePreviewServer.
  // Use the dev server for this local test; static preview would omit the handler.
  preview = start(VITE_CLI, ['--host', RELAY_HOST, '--port', String(PREVIEW_PORT), '--strictPort'], viteEnv);
  preview.once('exit', (code, signal) => {
    if (!stopping) stop(code ?? (signal ? 1 : 0));
  });
  console.log(`[Local AIS] preview: http://${RELAY_HOST}:${PREVIEW_PORT}`);
  console.log(`[Local AIS] relay:  ${RELAY_URL}`);
  // Trigger on-demand AIS ingestion only after the authenticated relay is ready.
  for (let attempt = 0; attempt < 10 && !stopping; attempt++) {
    try {
      const response = await fetch(`http://${RELAY_HOST}:${RELAY_PORT}/ais/snapshot`, {
        headers: { 'x-relay-key': relaySecret }, signal: AbortSignal.timeout(3000),
      });
      console.log(`[Local AIS] authenticated relay HTTP ${response.status}`);
      if (!response.ok) stop(1);
      break;
    } catch (error) {
      console.error('[Local AIS] readiness failure', error?.cause?.code ?? error?.name);
      if (attempt === 9) { console.error('[Local AIS] relay did not become reachable'); stop(1); }
      else await new Promise((done) => setTimeout(done, 500));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[Local AIS] ${error.message}`);
    process.exitCode = 1;
  });
}
