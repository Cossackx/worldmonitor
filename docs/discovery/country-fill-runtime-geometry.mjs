#!/usr/bin/env node
/*
 * Runtime-only country-fill diagnostic.  It deliberately does not import app
 * modules or mutate application state beyond clicking the visible controls.
 * Run from the repository root while the private dev server is on port 4187:
 *
 *   node docs/discovery/country-fill-runtime-geometry.mjs
 *
 * Artifacts are written to docs/discovery/country-fill-runtime-geometry.out/.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'country-fill-runtime-geometry.out');
const base = process.env.GEV_URL || 'http://127.0.0.1:4187/';
await fs.rm(root, { recursive: true, force: true });
await fs.mkdir(root, { recursive: true });

const browser = await chromium.launch({ headless: process.env.HEADED !== '0', channel: process.env.CHROME_CHANNEL || 'chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = [];
const consoleLog = [];
page.on('pageerror', error => errors.push({ type: 'pageerror', text: String(error?.stack || error) }));
page.on('console', message => {
  const entry = { type: message.type(), text: message.text() };
  consoleLog.push(entry);
  if (message.type() === 'error' || message.type() === 'warning') errors.push(entry);
});

async function state(label) {
  const result = await page.evaluate(async (label) => {
    const map = document.querySelector('#mapContainer, .map-container');
    const toggles = [...document.querySelectorAll('.layer-toggle-row, .layer-toggle')].map(el => ({
      layer: el.getAttribute('data-layer'),
      checked: el.querySelector('input')?.checked ?? null,
      text: el.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 120),
    }));
    const modeButtons = [...document.querySelectorAll('#mapDimensionToggle [data-mode], .map-dim-btn')].map(el => ({
      mode: el.getAttribute('data-mode'), active: el.classList.contains('active'), title: el.getAttribute('title'),
    }));
    const canvases = [...document.querySelectorAll('canvas')].map((canvas, i) => ({
      i, width: canvas.width, height: canvas.height, css: getComputedStyle(canvas).cssText,
      rect: (() => { const r = canvas.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })(),
      parent: canvas.parentElement?.className || '',
    }));
    const globals = Object.keys(window).filter(k => /map|deck|globe|geo/i.test(k)).slice(0, 100);
    const bodyText = document.body.innerText.replace(/\\s+/g, ' ').slice(0, 1800);
    let geometry = null;
    try {
      const response = await fetch('/data/countries.geojson', { cache: 'no-store' });
      const geojson = await response.json();
      const features = geojson.features || [];
      const wanted = features.filter(f => ['IR', 'PK'].includes(f.properties?.['ISO3166-1-Alpha-2']));
      const bounds = coordinates => {
        const out = [Infinity, Infinity, -Infinity, -Infinity];
        const visit = value => Array.isArray(value) && (typeof value[0] === 'number'
          ? (out[0] = Math.min(out[0], value[0]), out[1] = Math.min(out[1], value[1]), out[2] = Math.max(out[2], value[0]), out[3] = Math.max(out[3], value[1]))
          : value.forEach(visit));
        visit(coordinates); return out;
      };
      const signedArea = ring => ring.reduce((sum, p, i) => { const q = ring[(i + 1) % ring.length]; return sum + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
      geometry = wanted.map(f => ({
        iso2: f.properties?.['ISO3166-1-Alpha-2'], name: f.properties?.name, type: f.geometry?.type,
        bboxFromCoords: bounds(f.geometry?.coordinates),
        polygonRings: f.geometry?.type === 'Polygon' ? f.geometry.coordinates.length : f.geometry?.coordinates?.reduce((n, p) => n + p.length, 0),
        firstRingSignedArea: f.geometry?.type === 'Polygon' ? signedArea(f.geometry.coordinates[0]) : signedArea(f.geometry.coordinates[0]?.[0] || []),
      }));
    } catch (error) { geometry = { fetchError: String(error) }; }
    return { label, url: location.href, map: map ? { className: map.className, html: map.innerHTML.slice(0, 1200) } : null, modeButtons, toggles, canvases, globals, geometry, bodyText };
  }, label);
  await fs.writeFile(path.join(root, `${label}.json`), JSON.stringify(result, null, 2));
  await page.screenshot({ path: path.join(root, `${label}.png`), fullPage: true });
  return result;
}

async function clickVisible(selector, description) {
  const locator = page.locator(`${selector}:visible`).first();
  if (await locator.count()) { await locator.click(); return description; }
  return `not found: ${description}`;
}

await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);
const initial = await state('01-initial-2d');

// Use only controls discovered in the live DOM.  This makes the diagnostic
// survive label/localization changes without inventing private app globals.
const conflict = page.locator('.layer-toggle[data-layer="conflicts"] input:visible, .layer-toggle-row[data-layer="conflicts"] input:visible').first();
if (await conflict.count() && !(await conflict.isChecked())) await conflict.check();
await page.waitForTimeout(2500);
const conflictState = await state('02-conflicts-2d');

// Focus Iran through the visible search UI when present. If search is absent,
// the report still contains the exact renderer state and country geometry.
  const searchCandidates = page.locator('button:visible, [role="button"]:visible').filter({ hasText: /search/i });
if (await searchCandidates.count()) {
  await searchCandidates.first().click().catch(() => {});
  await page.waitForTimeout(300);
  const input = page.locator('input:visible').last();
  if (await input.count()) {
    await input.fill('Iran');
    await page.waitForTimeout(800);
    const iranChoice = page.locator('button, [role="option"], li').filter({ hasText: /^Iran(?:$|\\s)/i }).first();
    if (await iranChoice.count()) await iranChoice.click().catch(() => {});
  }
}
await page.waitForTimeout(1800);
const focused2d = await state('03-iran-focused-2d');

let globe = null;
const globeButton = page.locator('#mapDimensionToggle [data-mode="globe"]:visible, .map-dim-btn[data-mode="globe"]:visible').first();
if (await globeButton.count()) {
  await globeButton.click().catch(() => {});
  await page.waitForTimeout(5000);
  globe = await state('04-iran-focused-3d');
}

const report = { base, initial, conflictState, focused2d, globe, errors, consoleLog };
await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output: root, renderer2d: conflictState.modeButtons, renderer3dCaptured: Boolean(globe), errors: errors.length, geometry: conflictState.geometry }, null, 2));
await browser.close();
