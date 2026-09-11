import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import CesiumMapAdapter from '@/components/CesiumMapAdapter';
import type { MapContainerState } from '@/components/MapContainer';
import type { Earthquake } from '@/services/earthquakes';
import type { MapLayers } from '@/types';

// Cesium's runtime assets stay same-origin and package-local. The Vite dev
// server exposes this installed package path; no CDN, ion token, or provider.
const CESIUM_ASSET_BASE = '/node_modules/cesium/Build/Cesium/';
(globalThis as typeof globalThis & { CESIUM_BASE_URL?: string }).CESIUM_BASE_URL = CESIUM_ASSET_BASE;

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Cesium spike fixture is missing ${selector}`);
  return element;
}

const container = requireElement<HTMLElement>('#cesium-container');
const operation = requireElement<HTMLElement>('#operation');
const status = requireElement<HTMLElement>('#status');
const mountCount = requireElement<HTMLElement>('#mount-count');
const destroyCount = requireElement<HTMLElement>('#destroy-count');
const resizeCount = requireElement<HTMLElement>('#resize-count');
const fixtureCount = requireElement<HTMLElement>('#fixture-count');
const mountButton = requireElement<HTMLButtonElement>('#mount');
const destroyButton = requireElement<HTMLButtonElement>('#destroy');
const remountButton = requireElement<HTMLButtonElement>('#remount');
const resizeButton = requireElement<HTMLButtonElement>('#resize');

const initialState: MapContainerState = {
  zoom: 2.5,
  pan: { x: 142.37, y: 38.32 },
  view: 'global',
  // The adapter lifecycle only reads/clones this object in this isolated
  // harness. Production MapContainer owns the complete layer registry.
  layers: {} as MapLayers,
  timeRange: '24h',
};

const earthquakeFixture: Earthquake = {
  id: 'fixture-japan-001',
  place: 'Fixture offshore Japan',
  magnitude: 5.4,
  depthKm: 42,
  location: { latitude: 38.32, longitude: 142.37 },
  occurredAt: 1_725_000_000,
  sourceUrl: 'fixture://cesium-spike/earthquake-001',
  source: 'fixture',
  category: 'earthquake',
};

let adapter: CesiumMapAdapter | null = null;
let mounts = 0;
let destroys = 0;
let resizes = 0;
let fixtureEntities = 0;

function setReadout(message: string, isError = false): void {
  operation.textContent = message;
  operation.className = isError ? 'error' : 'ok';
  status.textContent = `Status: ${message}`;
  status.className = isError ? 'error' : 'ok';
}

function updateCounters(): void {
  mountCount.textContent = String(mounts);
  destroyCount.textContent = String(destroys);
  resizeCount.textContent = String(resizes);
  fixtureCount.textContent = String(fixtureEntities);
}

function syncButtons(): void {
  const mounted = adapter !== null;
  mountButton.disabled = mounted;
  destroyButton.disabled = !mounted;
  resizeButton.disabled = !mounted;
  remountButton.disabled = false;
}

async function mount(): Promise<void> {
  if (adapter) {
    setReadout('mount skipped: already mounted');
    return;
  }
  try {
    adapter = new CesiumMapAdapter(container, initialState, {
      chrome: false,
      onInitError: (error) => setReadout(`mount error: ${String(error)}`, true),
    });
    await adapter.whenReady();
    adapter.setEarthquakes([earthquakeFixture]);
    mounts += 1;
    fixtureEntities = 1;
    setReadout('mount success: Cesium ready + fixture applied');
  } catch (error) {
    adapter = null;
    fixtureEntities = 0;
    setReadout(`mount error: ${error instanceof Error ? error.message : String(error)}`, true);
  }
  updateCounters();
  syncButtons();
}

function destroy(): void {
  if (!adapter) {
    setReadout('destroy skipped: not mounted');
    return;
  }
  try {
    adapter.destroy();
    adapter = null;
    destroys += 1;
    fixtureEntities = 0;
    setReadout('destroy success');
  } catch (error) {
    setReadout(`destroy error: ${error instanceof Error ? error.message : String(error)}`, true);
  }
  updateCounters();
  syncButtons();
}

function resize(): void {
  if (!adapter) {
    setReadout('resize skipped: not mounted');
    return;
  }
  try {
    adapter.resize();
    resizes += 1;
    setReadout('resize success');
  } catch (error) {
    setReadout(`resize error: ${error instanceof Error ? error.message : String(error)}`, true);
  }
  updateCounters();
}

mountButton.addEventListener('click', () => { void mount(); });
destroyButton.addEventListener('click', destroy);
resizeButton.addEventListener('click', resize);
remountButton.addEventListener('click', () => {
  destroy();
  void mount();
});

updateCounters();
syncButtons();
setReadout('ready: click Mount 3D');

// Keep these references discoverable for parent browser checks without adding
// an application integration surface.
Object.assign(globalThis, { cesiumSpike: { mount, destroy, resize, remount: async () => { destroy(); await mount(); } } });

void Cesium;
