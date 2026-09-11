#!/usr/bin/env node
/** Capture renderer choice, actual WebGL capabilities, and MapContainer failures. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const base = process.env.GEV_URL || 'http://127.0.0.1:4187/';
const browser = await chromium.launch({ headless: true, channel: process.env.CHROME_CHANNEL || 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const logs = [];
const pageErrors = [];
page.on('console', message => {
  const text = message.text();
  if (/MapContainer|DeckGLMap|WebGL|fallback|Cannot access|TDZ/i.test(text)) logs.push({ type: message.type(), text });
});
page.on('pageerror', error => pageErrors.push(String(error.stack || error)));
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(9000);
const state = await page.evaluate(() => {
  const canvas = document.createElement('canvas');
  const webgl2 = canvas.getContext('webgl2');
  const debug = webgl2?.getExtension('WEBGL_debug_renderer_info');
  const map = document.querySelector('#mapContainer, .map-container');
  return {
    rendererClass: map?.className || null,
    webgl2: Boolean(webgl2),
    webgl1: Boolean(canvas.getContext('webgl')),
    vendor: debug && webgl2 ? webgl2.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
    renderer: debug && webgl2 ? webgl2.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
    userAgent: navigator.userAgent,
    touchPoints: navigator.maxTouchPoints,
    viewport: { width: innerWidth, height: innerHeight },
    canvasCount: document.querySelectorAll('canvas').length,
    svgCount: document.querySelectorAll('svg').length,
    relevantStorage: Object.fromEntries(Object.entries(localStorage).filter(([key]) => /map|globe|renderer/i.test(key))),
  };
});
const output = { base, state, logs, pageErrors };
const outputPath = path.resolve('docs/discovery/map-renderer-runtime.json');
await fs.writeFile(outputPath, JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
await browser.close();
