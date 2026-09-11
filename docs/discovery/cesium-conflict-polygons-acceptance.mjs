#!/usr/bin/env node
/**
 * Browser acceptance for conflict-zone and country polygons on the Cesium
 * renderer (carry-over step 2).
 *
 * Proves, against the running private dashboard:
 *  1. the Iran country-mapped zone is drawn from the canonical country
 *     geometry (entity `conflict:iran:IR:0` exists) and regional zones carry
 *     their approximate-area label;
 *  2. toggling the conflicts layer changes a LOCAL region of the frame (an
 *     Iran-sized box), not the whole globe — the failure mode the globe.gl
 *     path had with reversed winding;
 *  3. a bare globe click inside Iran resolves to country IR via the shared
 *     geometry service;
 *  4. fitCountry('IR') recentres on Iran.
 *
 * Usage (dev server running with VITE_PRIVATE_WORKSPACE=1):
 *   GEV_URL=http://127.0.0.1:4200 node docs/discovery/cesium-conflict-polygons-acceptance.mjs
 */
import { chromium } from 'playwright';
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'cesium-conflict-polygons-acceptance.out');
mkdirSync(outDir, { recursive: true });

const baseUrl = (process.env.GEV_URL ?? 'http://127.0.0.1:4200').replace(/\/$/, '');
const channel = process.env.CHROME_CHANNEL === undefined ? 'chrome' : process.env.CHROME_CHANNEL || undefined;
const url = `${baseUrl}/?cesiumSpike=1&lat=32&lon=53&zoom=4&layers=conflicts`;
const VIEWPORT = { width: 1440, height: 900 };
const PIXEL_DELTA = 24;

const report = { url, startedAt: new Date().toISOString(), steps: [], pass: false };
const step = (name, data) => { report.steps.push({ name, ...data }); console.log(`[${name}]`, JSON.stringify(data)); };

async function settle(page) {
  return page.evaluate(async () => {
    const v = window.__cesiumMapAdapter.getViewerForDiagnostics();
    let renders = 0;
    v.render(); renders++;
    while (!v.scene.globe.tilesLoaded && renders < 400) { v.render(); await new Promise((r) => setTimeout(r, 50)); renders++; }
    for (let i = 0; i < 3; i++) v.render();
    return { tilesLoaded: v.scene.globe.tilesLoaded, renders };
  });
}

async function canvasBox(page) {
  return page.evaluate(() => {
    const r = document.querySelector('#mapContainer canvas')?.getBoundingClientRect();
    return r ? { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } : null;
  });
}

/** Changed-pixel count and bounding box between two same-size raw RGBA buffers. */
function diffStats(a, b, width, height) {
  let count = 0; let minX = width; let minY = height; let maxX = -1; let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (d > PIXEL_DELTA) { count++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
  }
  return count === 0 ? { count: 0, box: null } : { count, box: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } };
}

const browser = await chromium.launch({ channel, headless: true });
try {
  const page = await browser.newPage({ viewport: VIEWPORT });
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
    await a.whenCountriesSettled();
    const layers = a.getState().layers;
    if (layers.conflicts !== true) a.setLayers({ ...layers, conflicts: true });
    a.setCenter(32, 53, 4);
    const ids = a.getConflictEntityIds();
    const v = a.getViewerForDiagnostics();
    const label = ids.filter((id) => id.endsWith(':label')).map((id) => v.entities.getById(id)?.label?.text?.getValue?.() ?? v.entities.getById(id)?.label?.text ?? null);
    return {
      basemap: a.getBasemapStatus(), terrain: a.getTerrainStatus(),
      conflictsLayer: a.getState().layers.conflicts, layerStatus: a.getLayerStatus('conflicts'),
      entityCount: ids.length, hasIranCountryPolygon: ids.includes('conflict:iran:IR:0'),
      regionalIds: ids.filter((id) => id.includes(':regional:') && !id.endsWith(':stroke')),
      regionalLabels: label,
    };
  });
  step('adapter-status', status);

  step('settle-with-conflicts', await settle(page));
  const box = await canvasBox(page);
  const clip = { x: box.x, y: box.y, width: box.width, height: box.height };
  await page.screenshot({ path: join(outDir, '01-iran-conflicts-on.png'), clip });

  // Pixel-footprint check at a wider view so Iran occupies well under half the
  // frame: a correct fill changes an Iran-sized box; a reversed/complement fill
  // (the old globe.gl failure) would change most of the visible globe.
  await page.evaluate(() => window.__cesiumMapAdapter.setCenter(32, 53, 2.6));
  step('settle-wide-with-conflicts', await settle(page));
  const withPng = await page.screenshot({ path: join(outDir, '02-wide-conflicts-on.png'), clip });
  await page.evaluate(() => { const a = window.__cesiumMapAdapter; a.setLayers({ ...a.getState().layers, conflicts: false }); });
  step('settle-wide-without-conflicts', await settle(page));
  const withoutPng = await page.screenshot({ path: join(outDir, '03-wide-conflicts-off.png'), clip });

  const [aRaw, bRaw] = await Promise.all([withPng, withoutPng].map((buf) => sharp(buf).raw().toBuffer({ resolveWithObject: true })));
  const stats = diffStats(aRaw.data, bRaw.data, aRaw.info.width, aRaw.info.height);
  // Several zones (Iran, Ukraine, Sudan, the regional areas) are in the wide
  // frame, so the changed *bounding box* legitimately spans it. The
  // discriminating signal is the changed *fraction*: filled zones cover well
  // under a third of the frame; a complement fill would flip most of the globe.
  const changedFraction = stats.count / (aRaw.info.width * aRaw.info.height);
  const local = stats.count > 2000 && changedFraction < 0.35;
  step('pixel-diff', { canvas: { w: aRaw.info.width, h: aRaw.info.height }, changedPixels: stats.count, changedFraction: Math.round(changedFraction * 1000) / 1000, changedBox: stats.box, localFootprint: local });

  // Restore the layer and the close view, then click the real canvas centre
  // (inside Iran) with the mouse so the adapter's own picking path is exercised.
  await page.evaluate(() => { const a = window.__cesiumMapAdapter; a.setLayers({ ...a.getState().layers, conflicts: true }); a.setCenter(32, 53, 4); });
  step('settle-for-click', await settle(page));
  // Ground primitives are created asynchronously after the entity is added;
  // give them a few frames to become pickable before clicking.
  await page.evaluate(async () => { const v = window.__cesiumMapAdapter.getViewerForDiagnostics(); for (let i = 0; i < 20; i++) { v.render(); await new Promise((r) => setTimeout(r, 50)); } });
  // The canvas centre is inside the Iran conflict polygon, so the pick must
  // open the shared conflict popup (appended to document.body by MapPopup).
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(600);
  const conflictClick = await page.evaluate(() => {
    const popups = [...document.querySelectorAll('body > .map-popup')];
    return { popups: popups.length, text: popups.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)) };
  });
  step('click-conflict-popup', conflictClick);

  // A bare-globe click (conflicts hidden) must resolve to the country via the
  // shared geometry service and emit the dashboard's country-click payload.
  const clickPromise = page.evaluate(() => new Promise((resolve) => {
    const a = window.__cesiumMapAdapter;
    a.setLayers({ ...a.getState().layers, conflicts: false });
    a.setOnCountryClick((payload) => resolve({ via: 'callback', ...payload }));
    setTimeout(() => resolve({ via: 'timeout' }), 4000);
  }));
  await page.waitForTimeout(200);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const clickResult = await clickPromise;
  step('click-country', clickResult);
  await page.evaluate(() => { const a = window.__cesiumMapAdapter; a.setLayers({ ...a.getState().layers, conflicts: true }); });

  const fit = await page.evaluate(() => { const a = window.__cesiumMapAdapter; a.setCenter(0, 0, 2); a.fitCountry('IR'); const c = a.getCenter(); return { lat: Math.round(c.lat * 10) / 10, lon: Math.round(c.lon * 10) / 10, zoom: Math.round(a.getState().zoom * 10) / 10 }; });
  step('fit-country', fit);
  step('settle-fit', await settle(page));
  await page.screenshot({ path: join(outDir, '03-fit-iran.png'), clip });

  report.pageErrors = pageErrors;
  report.pass = status.hasIranCountryPolygon && status.layerStatus === 'rendered'
    && status.regionalLabels.every((t) => typeof t === 'string' && /approximate conflict area/.test(t))
    && local
    && conflictClick.popups >= 1 && conflictClick.text.some((t) => /iran/i.test(t))
    && clickResult.code === 'IR'
    && fit.lat > 30 && fit.lat < 35 && fit.lon > 50 && fit.lon < 57
    && pageErrors.length === 0;
} catch (error) {
  report.error = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  await browser.close();
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`PASS=${report.pass}  report: ${join(outDir, 'report.json')}`);
  process.exitCode = report.pass ? 0 : 1;
}
