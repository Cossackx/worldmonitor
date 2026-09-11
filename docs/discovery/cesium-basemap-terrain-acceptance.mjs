#!/usr/bin/env node
/**
 * Browser acceptance for the keyless Cesium basemap + terrain port.
 *
 * Opens the private dashboard, switches to the 3D (Cesium) renderer, waits for
 * the adapter's truthful status via the dev-only `window.__cesiumMapAdapter`
 * seam, forces tile loading to settle, samples terrain heights at known points,
 * and captures two frames: an overhead Iran / Persian Gulf view and an oblique
 * Alborz / Caspian view that only looks right if terrain relief is real.
 *
 * Usage (dev server must already be running with VITE_PRIVATE_WORKSPACE=1):
 *   GEV_URL=http://127.0.0.1:4200 node docs/discovery/cesium-basemap-terrain-acceptance.mjs
 *
 * Optional: CHROME_CHANNEL=chrome (default) to use installed Chrome, or
 * CHROME_CHANNEL= (empty) for the bundled Playwright Chromium.
 *
 * Artifacts: docs/discovery/cesium-basemap-terrain-acceptance.out/
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'cesium-basemap-terrain-acceptance.out');
mkdirSync(outDir, { recursive: true });

const baseUrl = (process.env.GEV_URL ?? 'http://127.0.0.1:4200').replace(/\/$/, '');
const channel = process.env.CHROME_CHANNEL === undefined ? 'chrome' : process.env.CHROME_CHANNEL || undefined;
const url = `${baseUrl}/?cesiumSpike=1&lat=32&lon=53&zoom=4`;

// Expected ground heights (metres, ellipsoidal-ish; tolerance is generous
// because the mesh is sampled, not a survey). Flat ellipsoid would give 0.
// All three points sit inside the oblique Alborz/Caspian frame so they are
// sampled from fine-level tiles.
const HEIGHT_CHECKS = [
  { name: 'Tehran', lon: 51.4, lat: 35.7, min: 900, max: 1800 },
  { name: 'Damavand summit area', lon: 52.11, lat: 35.95, min: 3500, max: 5800 },
  { name: 'Caspian Sea (water, ~-28 m)', lon: 51.2, lat: 36.9, min: -200, max: 150 },
];

const report = { url, startedAt: new Date().toISOString(), steps: [], pass: false };
const step = (name, data) => { report.steps.push({ name, ...data }); console.log(`[${name}]`, JSON.stringify(data)); };

const browser = await chromium.launch({ channel, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('.map-dim-btn[title="3D Globe"]').click({ timeout: 30_000 });
  await page.waitForSelector('#mapContainer.cesium-map-adapter', { timeout: 30_000 });
  await page.waitForFunction(() => !!window.__cesiumMapAdapter, null, { timeout: 30_000 });

  const status = await page.evaluate(async () => {
    const a = window.__cesiumMapAdapter;
    await a.whenReady();
    await a.whenTerrainSettled();
    const v = a.getViewerForDiagnostics();
    return {
      basemap: a.getBasemapStatus(),
      terrain: a.getTerrainStatus(),
      terrainProvider: v?.terrainProvider?.constructor?.name ?? null,
      imageryProvider: v?.imageryLayers?.get(0)?.imageryProvider?.constructor?.name ?? null,
      imageryLayers: v?.imageryLayers?.length ?? 0,
      creditText: document.querySelector('.cesium-credit-textContainer')?.textContent ?? null,
    };
  });
  step('adapter-status', status);

  // Settle tiles. Headless Chrome runs rAF normally; if a host suspends rAF
  // (seen in an embedded preview pane) the manual render pump still converges.
  const settle = async () => page.evaluate(async () => {
    const v = window.__cesiumMapAdapter.getViewerForDiagnostics();
    let renders = 0;
    // Render once first so a camera change is reflected before tilesLoaded is read.
    v.render(); renders++;
    while (!v.scene.globe.tilesLoaded && renders < 400) { v.render(); await new Promise((r) => setTimeout(r, 50)); renders++; }
    for (let i = 0; i < 3; i++) v.render();
    return { tilesLoaded: v.scene.globe.tilesLoaded, renders };
  });

  // The dashboard may apply its own default view after mount, so frame the
  // overhead shot explicitly through the adapter rather than trusting the URL.
  await page.evaluate(() => window.__cesiumMapAdapter.setCenter(32, 53, 4));
  step('overhead-settle', await settle());
  await page.screenshot({ path: join(outDir, '01-iran-overhead-esri.png') });

  await page.evaluate(async () => {
    const v = window.__cesiumMapAdapter.getViewerForDiagnostics();
    const cam = v.scene.camera;
    // Oblique Alborz / Caspian framing; heading/pitch use the live camera API.
    cam.setView({ destination: cam.positionWC.constructor.fromDegrees(51.4, 35.2, 60_000), orientation: { heading: 20 * Math.PI / 180, pitch: -25 * Math.PI / 180, roll: 0 } });
  });
  step('oblique-settle', await settle());
  await page.screenshot({ path: join(outDir, '02-alborz-oblique-terrain.png') });

  // Sample heights only after the close oblique view has loaded fine terrain
  // tiles; at the overhead zoom the mesh is too coarse to be meaningful.
  // Globe.getHeight only reads longitude/latitude (radians) from its argument,
  // so a plain object avoids importing the Cesium module into the page.
  const heights = await page.evaluate((checks) => {
    const v = window.__cesiumMapAdapter.getViewerForDiagnostics();
    const rad = (deg) => deg * Math.PI / 180;
    return checks.map((c) => ({ ...c, height: v.scene.globe.getHeight({ longitude: rad(c.lon), latitude: rad(c.lat), height: 0 }) ?? null }));
  }, HEIGHT_CHECKS);
  const heightResults = heights.map((h) => ({ ...h, ok: h.height !== null && h.height >= h.min && h.height <= h.max }));
  step('terrain-heights', { results: heightResults });

  const esriRequests = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('arcgisonline.com')).length);
  const reearthRequests = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('terrain.reearth.land')).length);
  step('network', { esriRequests, reearthRequests, note: 'performance buffer may cap; >0 is the signal' });

  report.pageErrors = pageErrors;
  report.pass = status.basemap.status === 'ready' && status.basemap.source === 'esri-imagery'
    && status.terrain.status === 'ready' && status.terrainProvider === 'CesiumTerrainProvider'
    && heightResults.every((h) => h.ok) && pageErrors.length === 0;
} catch (error) {
  report.error = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  await browser.close();
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`PASS=${report.pass}  report: ${join(outDir, 'report.json')}`);
  process.exitCode = report.pass ? 0 : 1;
}
