import { describe, expect, it, vi } from 'vitest';
import type { MapContainerState } from '@/components/MapContainer';
import type { MapLayers } from '@/types';
import {
  CesiumMapAdapter,
  type CesiumDependency,
  type CesiumViewer,
  clampCesiumCameraState,
  CESIUM_SPIKE_LIMITATIONS,
} from '@/components/CesiumMapAdapter';

function state(): MapContainerState {
  return {
    zoom: 1.5,
    pan: { x: 0, y: 20 },
    view: 'global',
    layers: { conflicts: false, natural: true } as MapLayers,
    timeRange: '24h',
  };
}

function fakeCesium() {
  const entities = new Map<string, Record<string, unknown>>();
  const imageryProviders: Array<Record<string, unknown>> = [];
  const camera = {
    setView: vi.fn(),
    pickEllipsoid: vi.fn(() => ({ longitude: 0, latitude: 0 })),
    positionCartographic: undefined as { longitude: number; latitude: number; height?: number } | undefined,
    changed: { addEventListener: vi.fn((_listener: () => void) => vi.fn()) },
  };
  const handler = {
    setInputAction: vi.fn(),
    removeInputAction: vi.fn(),
    destroy: vi.fn(),
  };
  const viewer: CesiumViewer = {
    scene: { camera, globe: { ellipsoid: {} }, requestRender: vi.fn(), pick: vi.fn() },
    imageryLayers: { add: vi.fn(), remove: vi.fn() },
    entities: {
      add: (entity) => { entities.set(String(entity.id), entity); return entity; },
      removeById: (id) => entities.delete(id),
      removeAll: () => entities.clear(),
    },
    screenSpaceEventHandler: handler,
    resize: vi.fn(),
    render: vi.fn(),
    destroy: vi.fn(),
  };
  const dependency = {
    Viewer: vi.fn(() => viewer),
    Cartesian3: { fromDegrees: vi.fn((lon: number, lat: number, height?: number) => ({ lon, lat, height })) },
    Cartographic: { fromCartesian: (position: { longitude: number; latitude: number }) => position },
    Math: { toDegrees: (value: number) => value, toRadians: (value: number) => value },
    Color: { CYAN: 'cyan', ORANGE: 'orange', RED: 'red', YELLOW: 'yellow' },
    ScreenSpaceEventType: { LEFT_CLICK: 'left', RIGHT_CLICK: 'right' },
    EllipsoidTerrainProvider: class {},
    OpenStreetMapImageryProvider: class {
      errorEvent = { addEventListener: vi.fn(() => vi.fn()) };
      constructor(options: Record<string, unknown>) { imageryProviders.push(options); }
    },
    ImageryLayer: class { constructor(public provider: unknown) {} },
  } as unknown as CesiumDependency;
  return { dependency, viewer, entities, camera, handler, imageryProviders };
}

describe('CesiumMapAdapter spike', () => {
  it('stays isolated by default and reports the explicit opt-in state', async () => {
    const fake = fakeCesium();
    const adapter = new CesiumMapAdapter(document.createElement('div'), state(), {
      chrome: false,
      onInitError: vi.fn(),
      cesium: fake.dependency,
      createViewer: () => fake.viewer,
    });

    await adapter.whenReady();

    expect(fake.imageryProviders).toHaveLength(0);
    expect(adapter.getBasemapStatus()).toEqual({ status: 'isolated', error: null });
  });

  it('opts into keyless OSM geography with required attribution', async () => {
    const fake = fakeCesium();
    const adapter = new CesiumMapAdapter(document.createElement('div'), state(), {
      chrome: false,
      onInitError: vi.fn(),
      cesium: fake.dependency,
      createViewer: () => fake.viewer,
      enableKeylessBasemap: true,
    });

    await adapter.whenReady();

    expect(fake.imageryProviders).toEqual([expect.objectContaining({
      url: 'https://tile.openstreetmap.org/',
      credit: '© OpenStreetMap contributors',
    })]);
    expect(adapter.getBasemapStatus()).toEqual({ status: 'ready', error: null });
  });

  it('keeps an imagery failure visible instead of claiming a basemap', async () => {
    const fake = fakeCesium();
    fake.dependency.OpenStreetMapImageryProvider = class {
      errorEvent = { addEventListener: vi.fn(() => vi.fn()) };
      constructor() { throw new Error('tiles unavailable'); }
    } as unknown as CesiumDependency['OpenStreetMapImageryProvider'];
    const adapter = new CesiumMapAdapter(document.createElement('div'), state(), {
      chrome: false,
      onInitError: vi.fn(),
      cesium: fake.dependency,
      createViewer: () => fake.viewer,
      enableKeylessBasemap: true,
    });

    await adapter.whenReady();
    expect(adapter.getBasemapStatus()).toEqual({ status: 'failed', error: 'tiles unavailable' });
  });

  it('is lazy, replays the latest pre-ready camera state, and cleans up', async () => {
    const fake = fakeCesium();
    const container = document.createElement('div');
    const createViewer = vi.fn(() => fake.viewer);
    const adapter = new CesiumMapAdapter(container, state(), {
      chrome: false,
      onInitError: vi.fn(),
      cesium: fake.dependency,
      createViewer,
    });

    expect(createViewer).not.toHaveBeenCalled();
    adapter.setCenter(10, 190, 4);
    await adapter.whenReady();

    expect(createViewer).toHaveBeenCalledOnce();
    expect(adapter.getCenter()).toEqual({ lat: 10, lon: -170 });
    expect(fake.camera.setView).toHaveBeenLastCalledWith({ destination: { lon: -170, lat: 10, height: expect.any(Number) } });

    adapter.destroy();
    expect(fake.viewer.destroy).toHaveBeenCalledOnce();
    expect(container.textContent).toBe('');
    expect(fake.handler.destroy).not.toHaveBeenCalled();
  });

  it('keeps data set before readiness and honors layer visibility', async () => {
    const fake = fakeCesium();
    const adapter = new CesiumMapAdapter(document.createElement('div'), state(), {
      chrome: false,
      onInitError: vi.fn(),
      cesium: fake.dependency,
      createViewer: () => fake.viewer,
    });
    adapter.setNaturalEvents([{ id: 'queued', title: 'Queued', category: 'earthquakes', categoryTitle: 'Other', lat: 3, lon: 4, date: new Date(), closed: false }]);
    expect(fake.entities.size).toBe(0);
    expect(adapter.getLayerStatus('natural')).toBe('unsupported');

    await adapter.whenReady();
    expect(fake.entities.has('natural:queued')).toBe(true);
    expect(adapter.getLayerStatus('natural')).toBe('rendered');

    adapter.setLayers({ ...state().layers, natural: false } as MapLayers);
    expect(fake.entities.has('natural:queued')).toBe(false);
    expect(adapter.getLayerStatus('natural')).toBe('unsupported');
    adapter.setLayers({ ...state().layers, natural: true } as MapLayers);
    expect(fake.entities.has('natural:queued')).toBe(true);
  });

  it('reads the live Cesium camera after user movement', async () => {
    const fake = fakeCesium();
    const adapter = new CesiumMapAdapter(document.createElement('div'), state(), {
      chrome: false,
      onInitError: vi.fn(),
      cesium: fake.dependency,
      createViewer: () => fake.viewer,
    });
    await adapter.whenReady();
    fake.camera.positionCartographic = { longitude: 1.25, latitude: 0.5, height: 1_000_000 };

    expect(adapter.getCenter()).toEqual({ lat: 0.5, lon: 1.25 });
    expect(adapter.getState().pan).toEqual({ x: 1.25, y: 0.5 });
    expect(adapter.getState().zoom).toBeGreaterThan(1.5);
  });

  it('does not translate point-entity picks into country clicks', async () => {
    const fake = fakeCesium();
    const adapter = new CesiumMapAdapter(document.createElement('div'), state(), {
      chrome: false,
      onInitError: vi.fn(),
      cesium: fake.dependency,
      createViewer: () => fake.viewer,
    });
    const onCountryClick = vi.fn();
    adapter.setOnCountryClick(onCountryClick);
    await adapter.whenReady();
    adapter.setNaturalEvents([{ id: 'point', title: 'Point', category: 'earthquakes', categoryTitle: 'Other', lat: 1, lon: 2, date: new Date(), closed: false }]);
    fake.viewer.scene.pick = vi.fn(() => ({ id: { id: 'natural:point' } }));

    const leftClick = fake.handler.setInputAction.mock.calls.find(([, type]) => type === 'left')?.[0] as ((movement: { position: { x: number; y: number } }) => void);
    leftClick({ position: { x: 10, y: 20 } });

    expect(onCountryClick).not.toHaveBeenCalled();
  });

  it('publishes user camera movement and removes the Cesium listener on destroy', async () => {
    const fake = fakeCesium();
    const adapter = new CesiumMapAdapter(document.createElement('div'), state(), {
      chrome: false,
      onInitError: vi.fn(),
      cesium: fake.dependency,
      createViewer: () => fake.viewer,
    });
    const onState = vi.fn();
    adapter.onStateChanged(onState);
    await adapter.whenReady();
    const cameraChanged = fake.camera.changed.addEventListener.mock.calls[0]?.[0] as (() => void);
    fake.camera.positionCartographic = { longitude: 2, latitude: 1, height: 1_000_000 };
    cameraChanged();

    expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ pan: { x: 2, y: 1 } }));
    adapter.destroy();
    expect(fake.camera.changed.addEventListener.mock.results[0]?.value).toHaveBeenCalledOnce();
  });

  it('replaces fixture entities without claiming unsupported layers', async () => {
    const fake = fakeCesium();
    const adapter = new CesiumMapAdapter(document.createElement('div'), state(), {
      chrome: false,
      onInitError: vi.fn(),
      cesium: fake.dependency,
      createViewer: () => fake.viewer,
    });
    await adapter.whenReady();

    adapter.setNaturalEvents([{ id: 'old', title: 'Old', category: 'earthquakes', categoryTitle: 'Other', lat: 1, lon: 2, date: new Date(), closed: false }]);
    adapter.setNaturalEvents([{ id: 'new', title: 'New', category: 'earthquakes', categoryTitle: 'Other', lat: 3, lon: 4, date: new Date(), closed: false }]);

    expect([...fake.entities.keys()]).toContain('natural:new');
    expect([...fake.entities.keys()]).not.toContain('natural:old');
    expect(CESIUM_SPIKE_LIMITATIONS.unsupportedLayers).toMatch('state');
    expect(adapter.getLayerStatus('natural')).toBe('rendered');
    expect(adapter.getLayerStatus('conflicts')).toBe('unsupported');
  });

  it('normalizes antimeridian and latitude bounds deterministically', () => {
    expect(clampCesiumCameraState(120, 540, 100)).toEqual({ lat: 89.9, lon: -180, zoom: 20 });
    expect(clampCesiumCameraState(-120, -540, 0)).toEqual({ lat: -89.9, lon: -180, zoom: 0.5 });
  });
});
