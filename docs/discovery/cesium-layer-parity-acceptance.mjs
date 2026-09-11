#!/usr/bin/env node
/**
 * Browser acceptance for layer parity on the Cesium renderer (carry-over step 3).
 *
 * Enables the layers GlobeMap renders, switches to 3D, and records for each
 * layer whether the adapter reports it as rendered plus how many entities are
 * on the globe. Static, bundled layers (bases, nuclear, irradiators, spaceports,
 * economic, datacenters, waterways, minerals, cables, pipelines, tradeRoutes,
 * conflicts) must render regardless of backend availability; live feeds are
 * recorded truthfully (they depend on the dev proxies and may be empty).
 *
 * Usage (dev server running with VITE_PRIVATE_WORKSPACE=1):
 *   GEV_URL=http://127.0.0.1:4200 node docs/discovery/cesium-layer-parity-acceptance.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'cesium-layer-parity-acceptance.out');
mkdirSync(outDir, { recursive: true });

const baseUrl = (process.env.GEV_URL ?? 'http://127.0.0.1:4200').replace(/\/$/, '');
const channel = process.env.CHROME_CHANNEL === undefined ? 'chrome' : process.env.CHROME_CHANNEL || undefined;

const STATIC_LAYERS = ['conflicts', 'bases', 'nuclear', 'irradiators', 'spaceports', 'economic', 'datacenters', 'waterways', 'minerals', 'cables', 'pipelines', 'tradeRoutes'];
const LIVE_LAYERS = ['hotspots', 'military', 'weather', 'natural', 'radiationWatch', 'flights', 'ais', 'iranAttacks', 'outages', 'cyberThreats', 'fires', 'protests', 'ucdpEvents', 'displacement', 'climate', 'gpsJamming', 'satellites', 'techEvents', 'webcams', 'ciiChoropleth'];
const ALL = [...STATIC_LAYERS, ...LIVE_LAYERS];
const url = `${baseUrl}/?cesiumSpike=1&lat=30&lon=40&zoom=2.4&layers=${ALL.join(',')}`;

const report = { url, startedAt: new Date().toISOString(), steps: [], pass: false };
const step = (name, data) => { report.steps.push({ name, ...data }); console.log(`[${name}]`, JSON.stringify(data)); };

async function settle(page) {
  return page.evaluate(async () => {
    const v = window.__cesiumMapAdapter.getViewerForDiagnostics();
    let renders = 0;
    v.render(); renders++;
    while (!v.scene.globe.tilesLoaded && renders < 400) { v.render(); await new Promise((r) => setTimeout(r, 50)); renders++; }
    // Ground-clamped polylines/polygons are built asynchronously after their
    // entities exist; keep rendering until the data-source display reports
    // ready and then a little longer so the frame actually shows them.
    let ready = 0;
    while (ready < 40) { v.render(); await new Promise((r) => setTimeout(r, 50)); renders++; if (v.dataSourceDisplay?.ready !== false) ready++; }
    return { tilesLoaded: v.scene.globe.tilesLoaded, dataSourceReady: v.dataSourceDisplay?.ready ?? null, renders };
  });
}

const browser = await chromium.launch({ channel, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('.map-dim-btn[title="3D Globe"]').click({ timeout: 30_000 });
  await page.waitForSelector('#mapContainer.cesium-map-adapter', { timeout: 30_000 });
  await page.waitForFunction(() => !!window.__cesiumMapAdapter, null, { timeout: 30_000 });

  await page.evaluate(async (all) => {
    const a = window.__cesiumMapAdapter;
    await a.whenReady(); await a.whenTerrainSettled(); await a.whenCountriesSettled();
    const layers = { ...a.getState().layers };
    for (const l of all) layers[l] = true;
    a.setLayers(layers);
    a.setCenter(30, 40, 2.4);
  }, ALL);
  // Give live feeds a moment to arrive through the dashboard's loaders.
  await page.waitForTimeout(8000);
  step('settle', await settle(page));

  const status = await page.evaluate((all) => {
    const a = window.__cesiumMapAdapter;
    const v = a.getViewerForDiagnostics();
    const ids = v.entities.values.map((e) => e.id);
    const countByPrefix = (prefix) => ids.filter((id) => id.startsWith(prefix)).length;
    const perLayer = {};
    for (const l of all) perLayer[l] = a.getLayerStatus(l);
    return {
      totalEntities: ids.length,
      markers: countByPrefix('m:'), paths: countByPrefix('p:'), polygons: countByPrefix('poly:'), conflictPolys: countByPrefix('conflict:'),
      groups: Object.fromEntries([...new Set(ids.map((id) => id.split(':').slice(0, 2).join(':')))].map((g) => [g, ids.filter((id) => id.startsWith(g + ':')).length])),
      perLayer,
      markerLoad: a.getMarkerLoad(),
    };
  }, ALL);
  step('layer-status', status);
  await page.screenshot({ path: join(outDir, '01-all-layers-wide.png'), clip: await page.evaluate(() => { const r = document.querySelector('#mapContainer canvas').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }) });

  // Closer frame on the Gulf where bases, waterways, cables, pipelines and the
  // Iran conflict polygon all coexist.
  await page.evaluate(() => window.__cesiumMapAdapter.setCenter(27, 52, 4.2));
  step('settle-gulf', await settle(page));
  await page.screenshot({ path: join(outDir, '02-gulf-close.png'), clip: await page.evaluate(() => { const r = document.querySelector('#mapContainer canvas').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }) });

  // Toggle everything off and confirm the globe is clean again.
  const afterOff = await page.evaluate((all) => {
    const a = window.__cesiumMapAdapter;
    const layers = { ...a.getState().layers };
    for (const l of all) layers[l] = false;
    a.setLayers(layers);
    const v = a.getViewerForDiagnostics();
    return { remaining: v.entities.values.filter((e) => /^(m:|p:|poly:|conflict:)/.test(e.id) && !e.id.startsWith('m:news:') && !e.id.startsWith('m:flash:')).length };
  }, ALL);
  step('all-off', afterOff);

  const staticOk = STATIC_LAYERS.every((l) => status.perLayer[l] === 'rendered');
  const liveRendered = LIVE_LAYERS.filter((l) => status.perLayer[l] === 'rendered');
  step('summary', { staticAllRendered: staticOk, staticMissing: STATIC_LAYERS.filter((l) => status.perLayer[l] !== 'rendered'), liveRendered, liveEmpty: LIVE_LAYERS.filter((l) => status.perLayer[l] !== 'rendered') });

  report.pageErrors = pageErrors;
  report.pass = staticOk && afterOff.remaining === 0 && pageErrors.length === 0;
} catch (error) {
  report.error = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  await browser.close();
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`PASS=${report.pass}  report: ${join(outDir, 'report.json')}`);
  process.exitCode = report.pass ? 0 : 1;
}
