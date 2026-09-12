#!/usr/bin/env node
/**
 * Default-layout review package (development plan gate M1).
 *
 * Captures what Raz would see with NO manual layer changes: the private
 * dashboard's default layer set in 2D, the same state switched to the Cesium
 * 3D renderer, a proof that the 3D layer picker drives the renderer, and a
 * regional 3D close-up. Frames are for a human accept/reject decision; the
 * script asserts only what makes the frames trustworthy: both renderers
 * mounted, the build is the private one, the 3D chrome exists and works, the
 * basemap is ready, and no page error fired.
 *
 * Captured in the DARK colour scheme: the app follows prefers-color-scheme
 * and the owner's Windows runs dark. Playwright defaults to light, which is
 * why the 2026-09-11 15:00 frames showed a white dashboard nobody uses.
 * Override with GEV_COLOR_SCHEME=light.
 *
 * Usage (dev server running with VITE_PRIVATE_WORKSPACE=1):
 *   GEV_URL=http://127.0.0.1:4200 node docs/discovery/default-layout-review.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'default-layout-review.out');
mkdirSync(outDir, { recursive: true });
const baseUrl = (process.env.GEV_URL ?? 'http://127.0.0.1:4200').replace(/\/$/, '');
const channel = process.env.CHROME_CHANNEL === undefined ? 'chrome' : process.env.CHROME_CHANNEL || undefined;
const colorScheme = process.env.GEV_COLOR_SCHEME === 'light' ? 'light' : 'dark';
const report = { startedAt: new Date().toISOString(), colorScheme, steps: [], checks: {}, pass: false };
const step = (name, data) => { report.steps.push({ name, ...data }); console.log(`[${name}]`, JSON.stringify(data)); };

/** Layer picker rows as the user sees them: identity lives on the row, not the input. */
const readLayerRows = (page) => page.evaluate(() => [...document.querySelectorAll('.layer-toggle-row[data-layer]')]
  .map((row) => ({ layer: row.dataset.layer, on: !!row.querySelector('input[type=checkbox]')?.checked, loading: !!row.querySelector('.layer-toggle.loading') })));

/** Wait until no picker row still carries the loading badge (feeds landed), or give up quietly. */
async function waitForFeeds(page, timeout) {
  try {
    await page.waitForFunction(() => document.querySelectorAll('.layer-toggle.loading').length === 0, null, { timeout });
    return { feedsSettled: true };
  } catch {
    return { feedsSettled: false, stillLoading: (await readLayerRows(page)).filter((r) => r.loading).map((r) => r.layer) };
  }
}

async function settle(page) {
  return page.evaluate(async () => {
    const v = window.__cesiumMapAdapter.getViewerForDiagnostics();
    let renders = 0;
    v.render(); renders++;
    while (!v.scene.globe.tilesLoaded && renders < 400) { v.render(); await new Promise((r) => setTimeout(r, 50)); renders++; }
    let ready = 0;
    while (ready < 40) { v.render(); await new Promise((r) => setTimeout(r, 50)); renders++; if (v.dataSourceDisplay?.ready !== false) ready++; }
    return { tilesLoaded: v.scene.globe.tilesLoaded, renders };
  });
}

/** Poll the marker budget until the rendered count holds still for three samples. */
async function waitForMarkersStable(page, timeout) {
  const deadline = Date.now() + timeout;
  let last = -1; let stable = 0;
  while (Date.now() < deadline) {
    const rendered = await page.evaluate(() => window.__cesiumMapAdapter.getMarkerLoad().rendered);
    stable = rendered === last ? stable + 1 : 0;
    last = rendered;
    if (stable >= 3) return { markersStable: true, rendered };
    await page.waitForTimeout(1000);
  }
  return { markersStable: false, rendered: last };
}

const status3dOf = (page) => page.evaluate(() => {
  const a = window.__cesiumMapAdapter;
  const on = Object.entries(a.getState().layers).filter(([, v]) => v).map(([k]) => k);
  return {
    layersOn: on,
    rendered: on.filter((l) => a.getLayerStatus(l) === 'rendered'),
    notRendered: on.filter((l) => a.getLayerStatus(l) !== 'rendered'),
    markerLoad: a.getMarkerLoad(),
    basemap: a.getBasemapStatus(),
    terrain: a.getTerrainStatus(),
    borders: a.getBorderEntityIds().length,
  };
});

const browser = await chromium.launch({ channel, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // ── 2D default ────────────────────────────────────────────────────────────
  // No layer overrides: whatever the private dashboard shows by default.
  await page.goto(`${baseUrl}/?cesiumSpike=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#mapContainer.deckgl-mode canvas', { timeout: 60_000 });
  await page.waitForSelector('#mapContainer .deckgl-layer-toggles', { timeout: 30_000 });
  const feeds2d = await waitForFeeds(page, 30_000);
  await page.waitForTimeout(3000);
  const defaults = await page.evaluate(() => ({
    url: location.href,
    mode: document.querySelector('#mapContainer')?.className ?? null,
    theme: document.documentElement.dataset.theme ?? null,
    authorBadge: !!document.querySelector('.map-author-badge'),
    hostedHandleInBody: (document.body.textContent ?? '').includes('@eliehabib'),
    bannerIn2d: !!document.querySelector('#mapContainer .cesium-spike-limitations-banner'),
  }));
  const rows2d = await readLayerRows(page);
  step('default-2d', { ...defaults, ...feeds2d, layersOn: rows2d.filter((r) => r.on).map((r) => r.layer) });
  await page.screenshot({ path: join(outDir, '01-default-2d-full-page.png') });

  // ── 3D default ────────────────────────────────────────────────────────────
  await page.locator('.map-dim-btn[title="3D Globe"]').click({ timeout: 30_000 });
  await page.waitForSelector('#mapContainer.cesium-map-adapter', { timeout: 30_000 });
  await page.waitForFunction(() => !!window.__cesiumMapAdapter, null, { timeout: 30_000 });
  await page.evaluate(async () => { const a = window.__cesiumMapAdapter; await a.whenReady(); await a.whenTerrainSettled(); await a.whenCountriesSettled(); });
  const chrome3d = await page.evaluate(() => {
    const q = (s) => !!document.querySelector(`#mapContainer.cesium-map-adapter ${s}`);
    return {
      layerPicker: q('.deckgl-layer-toggles'), timeRange: q('.deckgl-time-slider'), zoom: q('.deckgl-controls .zoom-in'), legend: q('.deckgl-legend'),
      creditDock: q('.cesium-credit-dock'), ionLogo: q('.cesium-credit-logoContainer img'),
      bannerText: document.querySelector('#mapContainer .cesium-spike-limitations-banner')?.textContent ?? null,
    };
  });
  step('default-3d-chrome', chrome3d);
  const markers3d = await waitForMarkersStable(page, 20_000);
  step('default-3d-settle', { ...(await settle(page)), ...markers3d });
  const status3d = await status3dOf(page);
  step('default-3d', status3d);
  await page.screenshot({ path: join(outDir, '02-default-3d-full-page.png') });

  // ── 3D picker proof: hotspots off through the in-pane picker, then back on ──
  const hotspotsInput = page.locator('#mapContainer.cesium-map-adapter .layer-toggle[data-layer="hotspots"] input');
  await hotspotsInput.click({ timeout: 10_000 });
  const afterOff = await page.evaluate(() => ({ hotspots: window.__cesiumMapAdapter.getState().layers.hotspots, status: window.__cesiumMapAdapter.getLayerStatus('hotspots'), urlLayers: new URLSearchParams(location.search).get('layers') }));
  await settle(page);
  await page.screenshot({ path: join(outDir, '02b-default-3d-hotspots-off.png') });
  await hotspotsInput.click({ timeout: 10_000 });
  await settle(page);
  const afterOn = await page.evaluate(() => ({ hotspots: window.__cesiumMapAdapter.getState().layers.hotspots, status: window.__cesiumMapAdapter.getLayerStatus('hotspots') }));
  step('default-3d-picker', { afterOff, afterOn });

  // ── Regional 3D ───────────────────────────────────────────────────────────
  await page.evaluate(() => window.__cesiumMapAdapter.setCenter(31, 36, 4.2));
  // The nearest-first marker budget re-selects ~400 ms after the camera settles.
  await page.waitForTimeout(1200);
  step('regional-3d-settle', await settle(page));
  const regional = await page.evaluate(() => ({ center: window.__cesiumMapAdapter.getCenter(), zoom: window.__cesiumMapAdapter.getState().zoom, markerLoad: window.__cesiumMapAdapter.getMarkerLoad() }));
  step('regional-3d', regional);
  await page.screenshot({ path: join(outDir, '03-default-3d-levant-gulf.png') });

  report.pageErrors = pageErrors;
  report.checks = {
    mode2d: typeof defaults.mode === 'string' && defaults.mode.includes('deckgl-mode'),
    darkTheme: colorScheme !== 'dark' || defaults.theme === 'dark',
    privateBuild: !defaults.authorBadge,
    noBannerIn2d: !defaults.bannerIn2d,
    chrome3d: chrome3d.layerPicker && chrome3d.timeRange && chrome3d.zoom && chrome3d.legend,
    noIonLogo: !chrome3d.ionLogo,
    basemapReady: status3d.basemap.status === 'ready',
    bordersDrawn: status3d.borders > 0,
    pickerDrivesRenderer: afterOff.hotspots === false && afterOn.hotspots === true,
    noPageErrors: pageErrors.length === 0,
  };
  report.pass = Object.values(report.checks).every(Boolean);
} catch (error) {
  report.error = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  await browser.close();
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`PASS=${report.pass}  checks=${JSON.stringify(report.checks)}  report: ${join(outDir, 'report.json')}`);
  process.exitCode = report.pass ? 0 : 1;
}
