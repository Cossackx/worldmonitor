import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const lockfile = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
const viteConfig = readFileSync(resolve(root, 'vite.config.ts'), 'utf8');
const spikeViteConfig = readFileSync(resolve(root, 'vite.cesium-spike.config.mts'), 'utf8');

// Cesium 1.138 publishes the engine/widgets ranges independently. A floating
// install can select widgets 14.5 (engine 24) beside Cesium's engine 22.3.
// Viewer and imagery then update different module-singleton ContextLimits,
// leaving maximumTextureSize at its constructor default of zero.
describe('Cesium dependency graph', () => {
  it('pins the matching Cesium 1.138 engine and widgets releases', () => {
    expect(packageJson.overrides['@cesium/engine']).toBe('22.3.0');
    expect(packageJson.overrides['@cesium/widgets']).toBe('14.3.0');
    expect(lockfile.packages['node_modules/@cesium/engine'].version).toBe('22.3.0');
    expect(lockfile.packages['node_modules/@cesium/widgets'].version).toBe('14.3.0');
    expect(lockfile.packages['node_modules/@cesium/widgets/node_modules/@cesium/engine']).toBeUndefined();
  });

  it('does not retain the pre-fix nested engine 24 package', () => {
    expect(lockfile.packages['node_modules/@cesium/widgets/node_modules/@cesium/engine']).toBeUndefined();
  });

  it('deduplicates Cesium engine resolution in both Vite entry points', () => {
    expect(viteConfig).toContain("dedupe: ['@cesium/engine', '@cesium/widgets']");
    expect(spikeViteConfig).toContain("dedupe: ['@cesium/engine', '@cesium/widgets']");
  });
});
