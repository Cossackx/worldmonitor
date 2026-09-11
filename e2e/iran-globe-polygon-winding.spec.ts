import { expect, test } from '@playwright/test';
import sharp from 'sharp';

type PixelDelta = {
  changedPixels: number;
  bounds: { x: number; y: number; width: number; height: number } | null;
};

async function pixelDelta(emptyPng: Buffer, renderedPng: Buffer): Promise<PixelDelta> {
  const [empty, rendered] = await Promise.all([
    sharp(emptyPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(renderedPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  expect(rendered.info.width).toBe(empty.info.width);
  expect(rendered.info.height).toBe(empty.info.height);

  const threshold = 24;
  let changedPixels = 0;
  let minX = empty.info.width;
  let minY = empty.info.height;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < empty.data.length; i += 4) {
    const delta = Math.max(
      Math.abs(empty.data[i]! - rendered.data[i]!),
      Math.abs(empty.data[i + 1]! - rendered.data[i + 1]!),
      Math.abs(empty.data[i + 2]! - rendered.data[i + 2]!),
    );
    if (delta <= threshold) continue;
    changedPixels += 1;
    const pixel = i / 4;
    const x = pixel % empty.info.width;
    const y = Math.floor(pixel / empty.info.width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return {
    changedPixels,
    bounds: changedPixels ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
  };
}

type DiagnosticGlobe = {
  polygonsData: {
    (): Array<{ coordinates: number[][][] }>;
    (data: unknown[]): DiagnosticGlobe;
  };
  polygonCapColor: (color: () => string) => DiagnosticGlobe;
  polygonStrokeColor: (color: () => string) => DiagnosticGlobe;
  polygonSideColor: (color: () => string) => DiagnosticGlobe;
  polygonAltitude: (altitude: () => number) => DiagnosticGlobe;
};

test('normalized Iran geometry is local while unconditional reversal renders its complement', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto('/border-isolated.html', { waitUntil: 'networkidle' });
  await expect.poll(() => page.evaluate(() => Boolean((window as Window & { borderDiagnosticGlobe?: DiagnosticGlobe }).borderDiagnosticGlobe))).toBe(true);

  const polygons = await page.evaluate(() => (window as Window & { borderDiagnosticGlobe?: DiagnosticGlobe }).borderDiagnosticGlobe?.polygonsData() ?? []);
  expect(polygons).toHaveLength(1);
  const coordinates = polygons[0]!.coordinates;

  async function capture(data: unknown[]): Promise<Buffer> {
    await page.evaluate((next) => {
      (window as Window & { borderDiagnosticGlobe?: DiagnosticGlobe }).borderDiagnosticGlobe
        ?.polygonCapColor(() => 'rgba(255,0,255,0.92)')
        .polygonStrokeColor(() => '#00ffff')
        .polygonSideColor(() => 'rgba(0,0,0,0)')
        .polygonAltitude(() => 0.006)
        .polygonsData(next);
    }, data);
    await page.waitForTimeout(600);
    return page.screenshot();
  }

  const empty = await capture([]);
  const normalized = await capture([{ type: 'Polygon', coordinates }]);
  const reversed = await capture([{ type: 'Polygon', coordinates: coordinates.map((ring) => [...ring].reverse()) }]);
  const [normalizedDelta, reversedDelta] = await Promise.all([
    pixelDelta(empty, normalized),
    pixelDelta(empty, reversed),
  ]);

  // The pinned Iran-centred camera makes the regression observable without a
  // golden image: local normalized geometry changes a bounded patch, while the
  // old unconditional reversal changes a near-full-canvas complement.
  expect(normalizedDelta.changedPixels).toBeGreaterThan(2_000);
  expect(normalizedDelta.bounds).not.toBeNull();
  expect(normalizedDelta.bounds!.width).toBeLessThan(600);
  expect(normalizedDelta.bounds!.height).toBeLessThan(550);
  expect(reversedDelta.changedPixels).toBeGreaterThan(2_000);
  expect(reversedDelta.bounds).not.toBeNull();
  expect(reversedDelta.bounds!.width).toBeGreaterThan(1_000);
  expect(reversedDelta.bounds!.height).toBeGreaterThan(700);
});
