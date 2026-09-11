# Local AIS preview

This launcher is for the approved local AIS smoke test only. It does not deploy,
create a secret file, or copy `.env` files.

## Start

From the GEV repository root (`C:\Users\aleks\AppData\Local\Temp\gev-worldmonitor-discovery`):

```text
node scripts/local-ais-preview.mjs --env C:/Users/aleks/Projects/gods-eye-view/.env
```

The `--env` path is required and must be the original GEV environment file. The
launcher uses Node's built-in `loadEnvFile()` and reads only
`AISSTREAM_API_KEY`. It never prints that value. The launcher generates a
cryptographically random 32-byte `RELAY_SHARED_SECRET` in memory and gives the
same value to the relay and preview children.

After the build completes:

- Preview: `http://127.0.0.1:4189`
- Relay: `ws://127.0.0.1:4190` (HTTP health: `http://127.0.0.1:4190/health`)

Use Ctrl-C once to stop both children. The launcher also stops both children if
either child exits. The secret is not persisted.

## Isolation and limits

Child environments are allowlisted OS/process variables plus these required
values: `AISSTREAM_API_KEY` (relay only), `RELAY_SHARED_SECRET`, `WS_RELAY_URL`,
`VITE_WS_RELAY_URL`, `HOST`, `PORT`, and `WM_SKIP_DOTENV`. No other provider,
proxy, Redis, Telegram, X, LLM, paid-service, or inherited credential is passed.
The relay runs with `RELAY_TEST_MODE=true`, which keeps its ancillary background
seed loops disabled while preserving the real AIS upstream connection path.

The relay itself contains many ancillary routes and tasks. With this launcher's
allowlist they are either disabled by missing credentials or unavailable because
background seeding is disabled in test mode. This is not a general-purpose
replacement for the production relay: some free/public route code remains
present, and the launcher does not assert that every ancillary route is inert.

`VITE_WS_RELAY_URL` is embedded during the sanitized build. `WM_SKIP_DOTENV=1`
changes the Vite config's env loading for this run so Vite does not read ambient
`.env` or `.env.local` files. The preview serves that built output; changing the
launcher environment after the build does not change the bundle.

## Acceptance boundary

This setup proves process startup, loopback binding, authentication plumbing,
and the configured AIS path. It does **not** claim live vessel data. The parent
acceptance step must query `/health` and the vessel snapshot endpoint and report
whether current AIS positions were actually observed. No fixture or fabricated
provider data is used.
