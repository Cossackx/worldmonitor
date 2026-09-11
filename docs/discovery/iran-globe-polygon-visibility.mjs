#!/usr/bin/env node
/**
 * Test-only renderer diagnostic for the Iran conflict polygon.
 *
 * It uses border-isolated.html (no application source imports beyond the
 * existing test page), renders the exact loaded IR geometry in deterministic
 * variants, and compares each canvas screenshot against the same empty globe.
 * A visible polygon must produce a bounded, non-zero pixel delta.
 *
 * Usage: GEV_URL=http://127.0.0.1:4187 node docs/discovery/iran-globe-polygon-visibility.mjs
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';

const base = (process.env.GEV_URL || 'http://127.0.0.1:4187').replace(/\/$/, '');
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'iran-globe-polygon-visibility.out');
const threshold = 24;
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

async function rgba(png) {
  const decoded = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { pixels: decoded.data, width: decoded.info.width, height: decoded.info.height };
}

function difference(empty, rendered) {
  if (empty.width !== rendered.width || empty.height !== rendered.height) throw new Error('screenshot dimensions changed');
  let changed = 0;
  let total = 0;
  let minX = empty.width;
  let minY = empty.height;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < empty.pixels.length; i += 4) {
    const delta = Math.max(
      Math.abs(empty.pixels[i] - rendered.pixels[i]),
      Math.abs(empty.pixels[i + 1] - rendered.pixels[i + 1]),
      Math.abs(empty.pixels[i + 2] - rendered.pixels[i + 2]),
    );
    if (delta <= threshold) continue;
    changed += 1;
    total += delta;
    const p = i / 4;
    const x = p % empty.width;
    const y = Math.floor(p / empty.width);
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return {
    changedPixels: changed,
    meanChangedDelta: changed ? +(total / changed).toFixed(2) : 0,
    bounds: changed ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
  };
}

const browser = await chromium.launch({ headless: true, channel: process.env.CHROME_CHANNEL || 'chrome' });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', error => errors.push(`pageerror: ${String(error.stack || error)}`));
page.on('console', message => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});

try {
  await page.goto(`${base}/border-isolated.html`, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForFunction(() => Boolean(window.borderDiagnosticGlobe), { timeout: 30_000 });
  await page.waitForTimeout(1_000);

  const metadata = await page.evaluate(() => {
    const globe = window.borderDiagnosticGlobe;
    const initial = globe.polygonsData();
    if (!Array.isArray(initial) || initial.length !== 1) throw new Error(`expected one loaded Iran polygon, got ${initial?.length}`);
    const coords = initial[0].coordinates;
    const points = coords.flat();
    const bbox = [
      Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])),
      Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1])),
    ];
    globe.polygonCapColor(() => 'rgba(255,0,255,0.92)').polygonStrokeColor(() => '#00ffff').polygonSideColor(() => 'rgba(0,0,0,0)');
    return { polygonCount: initial.length, ringCount: coords.length, pointCount: points.length, bbox, coords };
  });

  async function capture(label, data, altitude) {
    await page.evaluate(({ data, altitude }) => {
      const globe = window.borderDiagnosticGlobe;
      globe.polygonAltitude(() => altitude).polygonsData(data);
    }, { data, altitude });
    await page.waitForTimeout(600);
    const png = await page.screenshot({ path: path.join(out, `${label}.png`) });
    return rgba(png);
  }

  const empty = await capture('00-empty', [], 0);
  const normalized = await capture('01-loaded-normalized', [{ type: 'Polygon', coordinates: metadata.coords }], 0.006);
  const reversed = await capture('02-reversed', [{ type: 'Polygon', coordinates: metadata.coords.map(ring => [...ring].reverse()) }], 0.006);
  const surface = await capture('03-loaded-surface', [{ type: 'Polygon', coordinates: metadata.coords }], 0);
  const report = {
    base,
    assertion: 'A loaded Iran polygon is render-visible when its screenshot differs materially from the identical empty globe.',
    metadata: { ...metadata, coords: undefined },
    threshold,
    variants: {
      normalizedAltitude006: difference(empty, normalized),
      reversedAltitude006: difference(empty, reversed),
      normalizedSurface: difference(empty, surface),
    },
    errors,
  };
  report.pass = report.variants.normalizedAltitude006.changedPixels > 2_000;
  await writeFile(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
} finally {
  await browser.close();
}
