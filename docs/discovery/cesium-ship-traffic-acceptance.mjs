#!/usr/bin/env node
/**
 * Browser acceptance for the private all-ships layer + click-to-track on the
 * Cesium renderer (God's Eye carry-over step 4, ship half).
 *
 * Frames the English Channel (dense volunteer AIS coverage), enables the Ship
 * Traffic layer, waits for the relay listing to arrive, records how many
 * ship markers are on the globe, clicks the nearest ship marker to the
 * viewport centre, presses Track, and checks a trail polyline appears once a
 * second distinct fix has been received (or reports truthfully that only one
 * fix arrived in the window). VesselAPI is NOT exercised here: it spends real
 * monthly quota, so the "check" button is only asserted to exist.
 *
 * Usage (private launcher running):
 *   GEV_URL=http://127.0.0.1:4200 node docs/discovery/cesium-ship-traffic-acceptance.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'cesium-ship-traffic-acceptance.out');
mkdirSync(outDir, { recursive: true });
const baseUrl = (process.env.GEV_URL ?? 'http://127.0.0.1:4200').replace(/\/$/, '');
const channel = process.env.CHROME_CHANNEL === undefined ? 'chrome' : process.env.CHROME_CHANNEL || undefined;
// Dover Strait: the busiest volunteer-covered water on AISStream.
const FRAME = { lat: 50.95, lon: 1.45, zoom: 7.5 };
const url = `${baseUrl}/?cesiumSpike=1&lat=${FRAME.lat}&lon=${FRAME.lon}&zoom=${FRAME.zoom}&layers=ais`;
const report = { url, startedAt: new Date().toISOString(), steps: [], pass: false };
const step = (name, data) => { report.steps.push({ name, ...data }); console.log(`[${name}]`, JSON.stringify(data)); };

async function pump(page, ms) {
  return page.evaluate(async (ms) => {
    const v = window.__cesiumMapAdapter.getViewerForDiagnostics();
    const until = Date.now() + ms;
    let renders = 0;
    while (Date.now() < until) { v.render(); renders++; await new Promise((r) => setTimeout(r, 50)); }
    return { renders, tilesLoaded: v.scene.globe.tilesLoaded };
  }, ms);
}
const shipState = (page) => page.evaluate(() => {
  const a = window.__cesiumMapAdapter;
  const v = a.getViewerForDiagnostics();
  const ids = v.entities.values.map((e) => e.id);
  return {
    ships: ids.filter((id) => id.startsWith('m:ships:')).length,
    trails: ids.filter((id) => id.startsWith('p:shipTrack:')).length,
    status: document.querySelector('.cesium-ship-status__text')?.textContent ?? null,
    checkButton: !!document.querySelector('.cesium-ship-status__check'),
    card: document.querySelector('.cesium-ship-card')?.textContent ?? null,
    bounds: a.getViewBounds(),
  };
});
const clip = (page) => page.evaluate(() => { const r = document.querySelector('#mapContainer canvas').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });

const browser = await chromium.launch({ channel, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('.map-dim-btn[title="3D Globe"]').click({ timeout: 30_000 });
  await page.waitForSelector('#mapContainer.cesium-map-adapter', { timeout: 30_000 });
  await page.waitForFunction(() => !!window.__cesiumMapAdapter, null, { timeout: 30_000 });
  await page.evaluate(async (f) => {
    const a = window.__cesiumMapAdapter;
    await a.whenReady(); await a.whenTerrainSettled();
    a.setLayers({ ...a.getState().layers, ais: true });
    a.setCenter(f.lat, f.lon, f.zoom);
  }, FRAME);
  step('pump-initial', await pump(page, 4000));

  // Wait for the first relay listing to land (poll is immediate on start, then every 20 s).
  let state = await shipState(page);
  for (let i = 0; i < 20 && state.ships === 0; i++) { await pump(page, 1500); state = await shipState(page); }
  step('ships-first', state);
  await page.screenshot({ path: join(outDir, '01-channel-ships.png'), clip: await clip(page) });

  // Click the ship marker nearest the screen centre.
  const clicked = await page.evaluate(() => {
    const a = window.__cesiumMapAdapter;
    const v = a.getViewerForDiagnostics();
    const canvas = document.querySelector('#mapContainer canvas');
    const cx = canvas.clientWidth / 2, cy = canvas.clientHeight / 2;
    let best = null;
    for (const e of v.entities.values) {
      if (!e.id.startsWith('m:ships:')) continue;
      const pos = e.position?.getValue(v.clock.currentTime);
      if (!pos) continue;
      const win = window.Cesium ? null : null;
      const scene = v.scene;
      const c2 = scene.cartesianToCanvasCoordinates(pos);
      if (!c2) continue;
      const d = Math.hypot(c2.x - cx, c2.y - cy);
      if (!best || d < best.d) best = { id: e.id, x: c2.x, y: c2.y, d };
    }
    if (!best) return null;
    // Drive the adapter's own pick path via the Cesium input handler.
    const handler = v.screenSpaceEventHandler;
    const action = handler.getInputAction(2 /* LEFT_CLICK */);
    action({ position: { x: best.x, y: best.y } });
    return best;
  });
  step('click', { clicked });
  state = await shipState(page);
  step('card-open', { card: state.card });
  const tracked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.cesium-ship-card button')].find((b) => b.dataset.shipAction === 'track');
    if (!btn) return false;
    btn.click();
    return true;
  });
  step('track-pressed', { tracked });
  await page.screenshot({ path: join(outDir, '02-ship-card.png'), clip: await clip(page) });

  // A trail needs a second distinct fix: wait up to ~70 s of polls.
  let trail = await shipState(page);
  for (let i = 0; i < 24 && trail.trails === 0; i++) { await pump(page, 3000); trail = await shipState(page); }
  step('trail', { trails: trail.trails, card: trail.card, status: trail.status });
  await page.screenshot({ path: join(outDir, '03-ship-trail.png'), clip: await clip(page) });

  const off = await page.evaluate(() => {
    const a = window.__cesiumMapAdapter;
    a.setLayers({ ...a.getState().layers, ais: false });
    const v = a.getViewerForDiagnostics();
    return { ships: v.entities.values.filter((e) => e.id.startsWith('m:ships:')).length, trails: v.entities.values.filter((e) => e.id.startsWith('p:shipTrack:')).length, chip: !!document.querySelector('.cesium-ship-status') };
  });
  step('layer-off', off);

  report.pageErrors = pageErrors;
  report.pass = state.ships > 0 && state.checkButton && !!state.card && tracked && off.ships === 0 && off.trails === 0 && !off.chip && pageErrors.length === 0;
  report.trailObserved = trail.trails > 0;
  step('summary', { pass: report.pass, trailObserved: report.trailObserved, ships: state.ships, pageErrors });
} finally {
  await browser.close();
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
}
process.exit(report.pass ? 0 : 1);
