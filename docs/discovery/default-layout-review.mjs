#!/usr/bin/env node
/**
 * Default-layout review package (development plan gate M1).
 *
 * Captures what Raz would see with NO manual layer changes: the private
 * dashboard's default layer set in 2D, then the same state switched to the
 * Cesium 3D renderer, then a regional 3D close-up. Frames are for a human
 * accept/reject decision; the script only asserts that both renderers mounted.
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
const report = { startedAt: new Date().toISOString(), steps: [], pass: false };
const step = (name, data) => { report.steps.push({ name, ...data }); console.log(`[${name}]`, JSON.stringify(data)); };

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

const browser = await chromium.launch({ channel, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  // No layer overrides: whatever the private dashboard shows by default.
  await page.goto(`${baseUrl}/?cesiumSpike=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(12_000);
  const defaults = await page.evaluate(() => {
    const layers = [...document.querySelectorAll('input[type=checkbox][data-layer], .layer-toggle input')].map((i) => ({ layer: i.dataset.layer ?? i.name ?? i.id, on: i.checked }));
    return { url: location.href, mode: document.querySelector('#mapContainer')?.className ?? null, layerToggles: layers.slice(0, 80) };
  });
  step('default-2d', { url: defaults.url, mode: defaults.mode, layersOn: defaults.layerToggles.filter((l) => l.on).map((l) => l.layer) });
  await page.screenshot({ path: join(outDir, '01-default-2d-full-page.png') });

  await page.locator('.map-dim-btn[title="3D Globe"]').click({ timeout: 30_000 });
  await page.waitForSelector('#mapContainer.cesium-map-adapter', { timeout: 30_000 });
  await page.waitForFunction(() => !!window.__cesiumMapAdapter, null, { timeout: 30_000 });
  await page.evaluate(async () => { const a = window.__cesiumMapAdapter; await a.whenReady(); await a.whenTerrainSettled(); await a.whenCountriesSettled(); });
  await page.waitForTimeout(4000);
  step('default-3d-settle', await settle(page));
  const status3d = await page.evaluate(() => {
    const a = window.__cesiumMapAdapter;
    const on = Object.entries(a.getState().layers).filter(([, v]) => v).map(([k]) => k);
    return { layersOn: on, rendered: on.filter((l) => a.getLayerStatus(l) === 'rendered'), notRendered: on.filter((l) => a.getLayerStatus(l) !== 'rendered'), markerLoad: a.getMarkerLoad(), basemap: a.getBasemapStatus(), terrain: a.getTerrainStatus() };
  });
  step('default-3d', status3d);
  await page.screenshot({ path: join(outDir, '02-default-3d-full-page.png') });

  await page.evaluate(() => window.__cesiumMapAdapter.setCenter(31, 36, 4.2));
  step('regional-3d-settle', await settle(page));
  await page.screenshot({ path: join(outDir, '03-default-3d-levant-gulf.png') });

  report.pageErrors = pageErrors;
  report.pass = defaults.mode !== null && status3d.basemap.status === 'ready';
} catch (error) {
  report.error = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  await browser.close();
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`PASS=${report.pass}  report: ${join(outDir, 'report.json')}`);
  process.exitCode = report.pass ? 0 : 1;
}
