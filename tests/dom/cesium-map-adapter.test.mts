import { describe, expect, it, vi } from 'vitest';
import type { MapContainerState } from '@/components/MapContainer';
import type { MapLayers } from '@/types';
import {
  CesiumMapAdapter,
  type CesiumDependency,
  type CesiumViewer,
  clampCesiumCameraState,
  CESIUM_SPIKE_LIMITATIONS,
  ESRI_WORLD_IMAGERY_URL,
  ESRI_IMAGERY_CREDIT,
  ESRI_ATTRIBUTION_HTML,
  REEARTH_TERRAIN_URL,
  REEARTH_TERRAIN_CREDIT,
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

type ErrorListener = (error: unknown) => void;

function fakeCesium(options: { esriFails?: boolean; terrainFails?: boolean } = {}) {
  const entities = new Map<string, Record<string, unknown>>();
  const imageryProviders: Array<Record<string, unknown>> = [];
  const esriRequests: Array<{ url: string; options?: Record<string, unknown> }> = [];
  const terrainRequests: string[] = [];
  const staticCredits: unknown[] = [];
  const errorListeners = new Map<Record<string, unknown>, ErrorListener>();
  const creditDisplay = {
    addStaticCredit: vi.fn((credit: unknown) => { staticCredits.push(credit); }),
    removeStaticCredit: vi.fn((credit: unknown) => { const i = staticCredits.indexOf(credit); if (i >= 0) staticCredits.splice(i, 1); }),
  };
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
    scene: { camera, globe: { ellipsoid: {} }, frameState: { creditDisplay }, requestRender: vi.fn(), pick: vi.fn() },
    terrainProvider: undefined,
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
    Cartesian3: {
      fromDegrees: vi.fn((lon: number, lat: number, height?: number) => ({ lon, lat, height })),
      fromDegreesArray: vi.fn((flat: number[]) => { const out: Array<{ lon: number; lat: number }> = []; for (let i = 0; i < flat.length; i += 2) out.push({ lon: flat[i]!, lat: flat[i + 1]! }); return out; }),
    },
    Cartographic: { fromCartesian: (position: { longitude: number; latitude: number }) => position },
    Math: { toDegrees: (value: number) => value, toRadians: (value: number) => value },
    Color: { CYAN: 'cyan', ORANGE: 'orange', RED: 'red', YELLOW: 'yellow', fromCssColorString: (css: string) => `css(${css})` },
    ScreenSpaceEventType: { LEFT_CLICK: 'left', RIGHT_CLICK: 'right' },
    PolygonHierarchy: class { constructor(public positions: unknown[], public holes: unknown[] = []) {} },
    ClassificationType: { TERRAIN: 'terrain' },
    VerticalOrigin: { BOTTOM: 'bottom', CENTER: 'center' },
    HorizontalOrigin: { CENTER: 'center' },
    LabelStyle: { FILL_AND_OUTLINE: 'fill-outline' },
    HeightReference: { CLAMP_TO_GROUND: 'clamp', NONE: 'none' },
    EllipsoidTerrainProvider: class {},
    OpenStreetMapImageryProvider: class {
      kind = 'osm';
      errorEvent = { addEventListener: vi.fn((listener: ErrorListener) => { errorListeners.set(this as unknown as Record<string, unknown>, listener); return vi.fn(); }) };
      constructor(options: Record<string, unknown>) { imageryProviders.push({ kind: 'osm', ...options }); }
    },
    ArcGisMapServerImageryProvider: {
      fromUrl: vi.fn(async (url: string, opts?: Record<string, unknown>) => {
        esriRequests.push({ url, options: opts });
        if (options.esriFails) throw new Error('arcgis unreachable');
        const provider = {
          kind: 'esri',
          errorEvent: { addEventListener: vi.fn((listener: ErrorListener) => { errorListeners.set(provider, listener); return vi.fn(); }) },
        };
        imageryProviders.push({ kind: 'esri', url, ...opts });
        return provider;
      }),
    },
    CesiumTerrainProvider: {
      fromUrl: vi.fn(async (url: string) => {
        terrainRequests.push(url);
        if (options.terrainFails) throw new Error('layer.json 503');
        return { kind: 'reearth-terrain', url };
      }),
    },
    Credit: class { constructor(public html: string, public showOnScreen?: boolean) {} },
    ImageryLayer: class { constructor(public provider: unknown) {} },
  } as unknown as CesiumDependency;
  const fireImageryError = (kind: 'esri' | 'osm', error: unknown) => {
    for (const [provider, listener] of errorListeners) if (provider.kind === kind) listener(error);
  };
  return { dependency, viewer, entities, camera, handler, imageryProviders, esriRequests, terrainRequests, staticCredits, creditDisplay, fireImageryError };
}

describe('CesiumMapAdapter spike', () => {
  it('stays isolated by default and reports the explicit opt-in state', async () => {
    const fake = fakeCesium();
    const adapter = new CesiumMapAdapter(document.createElement('div'), state(), {
      chrome: false,
      onInitError: vi.fn(),
      cesium: fake.dependency,
      loadCountries: async () => null,
      createViewer: () => fake.viewer,
    });

    await adapter.whenReady();

    expect(fake.imageryProviders).toHaveLength(0);
    expect(fake.terrainRequests).toHaveLength(0);
    expect(adapter.getBasemapStatus()).toEqual({ status: 'isolated', source: null, error: null, notice: null });
    expect(adapter.getTerrainStatus()).toEqual({ status: 'isolated', error: null });
  });

  it('defaults the keyless basemap to Esri World Imagery with the required on-screen credit', async () => {
    const fake = fakeCesium();
    const adapter = new CesiumMapAdapter(document.createElement('div'), state(), {
      chrome: false,
      onInitError: vi.fn(),
      cesium: fake.dependency,
      loadCountries: async () => null,
      createViewer: () => fake.viewer,
      enableKeylessBasemap: true,
    });

    await adapter.whenReady();

    expect(fake.esriRequests).toEqual([{ url: ESRI_WORLD_IMAGERY_URL, options: { credit: ESRI_IMAGERY_CREDIT } }]);
    expect(fake.imageryProviders).toEqual([expect.objectContaining({ kind: 'esri' })]);
    expect(adapter.getBasemapStatus()).toEqual({ status: 'ready', source: 'esri-imagery', error: null, notice: null });
    // Cesium ignores `credit` for tiled ArcGIS servers, so the notice is an explicit static credit.
    expect(fake.staticCredits).toContainEqual(expect.objectContaining({ html: ESRI_ATTRIBUTION_HTML, showOnScreen: true }));

    adapter.destroy();
    expect(fake.staticCredits).not.toContainEqual(expect.objectContaining({ html: ESRI_ATTRIBUTION_HTML }));
  });

  it('falls back to OSM truthfully when Esri cannot be constructed', async () => {
    const fake = fakeCesium({ esriFails: true });
    const onInitError = vi.fn();
    const adapter = new CesiumMapAdapter(document.createElement('div'), state(), {
      chrome: false,
      onInitError,
      cesium: fake.dependency,
      loadCountries: async () => null,
      createViewer: () => fake.viewer,
      enableKeylessBasemap: true,
    });

    await adapter.whenReady();

    expect(fake.imageryProviders).toEqual([expect.objectContaining({ kind: 'osm', url: 'https://tile.openstreetmap.org/', credit: '© OpenStreetMap contributors' })]);
    const status = adapter.getBasemapStatus();
    expect(status.status).toBe('ready');
    expect(status.source).toBe('osm');
    expect(status.notice).toMatch(/Esri Satellite is unavailable; using OSM/);
    expect(fake.staticCredits).not.toContainEqual(expect.objectContaining({ html: ESRI_ATTRIBUTION_HTML }));
    expect(onInitError).not.toHaveBeenCalled();
  });

  it('swaps to OSM after repeated Esri tile failures, leaving one transient error to Cesium', async () => {
    const fake = fakeCesium();
    const adapter = new CesiumMapAdapter(document.createElement('div'), state(), {
      chrome: false,
      onInitError: vi.fn(),
      cesium: fake.dependency,
      loadCountries: async () => null,
      createViewer: () => fake.viewer,
      enableKeylessBasemap: true,
    });
    await adapter.whenReady();

    fake.fireImageryError('esri', { timesRetried: 0 });
    expect(adapter.getBasemapStatus().source).toBe('esri-imagery');

    fake.fireImageryError('esri', { timesRetried: 1 });
    const status = adapter.getBasemapStatus();
    expect(status).toMatchObject({ status: 'ready', source: 'osm', error: null });
    expect(status.notice).toMatch(/tile requests failed; using OSM/);
    expect(fake.imageryProviders.map((p) => p.kind)).toEqual(['esri', 'osm']);
    expect(fake.viewer.imageryLayers.remove).toHaveBeenCalledOnce();
    expect(fake.staticCredits).not.toContainEqual(expect.objectContaining({ html: ESRI_ATTRIBUTION_HTML }));
  });

  it('honors an explicit OSM preference and keeps an OSM failure visible', async () => {
    const fake = fakeCesium();
    fake.dependency.OpenStreetMapImageryProvider = class {
      errorEvent = { addEventListener: vi.fn(() => vi.fn()) };
      constructor() { throw new Error('tiles unavailable'); }
    } as unknown as CesiumDependency['OpenStreetMapImageryProvider'];
    const adapter = new CesiumMapAdapter(document.createElement('div'), state(), {
      chrome: false,
      onInitError: vi.fn(),
      cesium: fake.dependency,
      loadCountries: async () => null,
      createViewer: () => fake.viewer,
      enableKeylessBasemap: true,
      basemap: 'osm',
    });

    await adapter.whenReady();
    expect(fake.esriRequests).toHaveLength(0);
    expect(adapter.getBasemapStatus()).toEqual({ status: 'failed', source: null, error: 'tiles unavailable', notice: null });
  });

  it('installs keyless Re:Earth terrain lazily without blocking readiness', async () => {
    const fake = fakeCesium();
    const adapter = new CesiumMapAdapter(document.createElement('div'), state(), {
      chrome: false,
      onInitError: vi.fn(),
      cesium: fake.dependency,
      loadCountries: async () => null,
      createViewer: () => fake.viewer,
      enableKeylessBasemap: true,
    });

    await adapter.whenReady();
    expect(fake.terrainRequests).toEqual([REEARTH_TERRAIN_URL]);
    await adapter.whenTerrainSettled();

    expect(adapter.getTerrainStatus()).toEqual({ status: 'ready', error: null });
    expect(fake.viewer.terrainProvider).toEqual({ kind: 'reearth-terrain', url: REEARTH_TERRAIN_URL });
    expect(fake.staticCredits).toContainEqual(expect.objectContaining({ html: REEARTH_TERRAIN_CREDIT, showOnScreen: false }));
  });

  it('keeps the flat ellipsoid when Re:Earth is unreachable and says so', async () => {
    const fake = fakeCesium({ terrainFails: true });
    const onInitError = vi.fn();
    const adapter = new CesiumMapAdapter(document.createElement('div'), state(), {
      chrome: false,
      onInitError,
      cesium: fake.dependency,
      loadCountries: async () => null,
      createViewer: () => fake.viewer,
      enableKeylessBasemap: true,
    });

    await adapter.whenReady();
    await adapter.whenTerrainSettled();

    expect(adapter.getTerrainStatus()).toEqual({ status: 'flat', error: 'layer.json 503' });
    expect(fake.viewer.terrainProvider).toBeUndefined();
    expect(adapter.getBasemapStatus().status).toBe('ready');
    expect(onInitError).not.toHaveBeenCalled();
  });

  it('skips terrain when explicitly disabled', async () => {
    const fake = fakeCesium();
    const adapter = new CesiumMapAdapter(document.createElement('div'), state(), {
      chrome: false,
      onInitError: vi.fn(),
      cesium: fake.dependency,
      loadCountries: async () => null,
      createViewer: () => fake.viewer,
      enableKeylessBasemap: true,
      enableKeylessTerrain: false,
    });
    await adapter.whenReady();
    await adapter.whenTerrainSettled();
    expect(fake.terrainRequests).toHaveLength(0);
    expect(adapter.getTerrainStatus()).toEqual({ status: 'isolated', error: null });
  });

  it('is lazy, replays the latest pre-ready camera state, and cleans up', async () => {
    const fake = fakeCesium();
    const container = document.createElement('div');
    const createViewer = vi.fn(() => fake.viewer);
    const adapter = new CesiumMapAdapter(container, state(), {
      chrome: false,
      onInitError: vi.fn(),
      cesium: fake.dependency,
      loadCountries: async () => null,
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
      loadCountries: async () => null,
      createViewer: () => fake.viewer,
    });
    adapter.setNaturalEvents([{ id: 'queued', title: 'Queued', category: 'earthquakes', categoryTitle: 'Other', lat: 3, lon: 4, date: new Date(), closed: false }]);
    expect(fake.entities.size).toBe(0);
    expect(adapter.getLayerStatus('natural')).toBe('unsupported');

    await adapter.whenReady();
    expect(fake.entities.has('m:natural:queued')).toBe(true);
    expect(adapter.getLayerStatus('natural')).toBe('rendered');

    adapter.setLayers({ ...state().layers, natural: false } as MapLayers);
    expect(fake.entities.has('m:natural:queued')).toBe(false);
    expect(adapter.getLayerStatus('natural')).toBe('unsupported');
    adapter.setLayers({ ...state().layers, natural: true } as MapLayers);
    expect(fake.entities.has('m:natural:queued')).toBe(true);
  });

  it('reads the live Cesium camera after user movement', async () => {
    const fake = fakeCesium();
    const adapter = new CesiumMapAdapter(document.createElement('div'), state(), {
      chrome: false,
      onInitError: vi.fn(),
      cesium: fake.dependency,
      loadCountries: async () => null,
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
      loadCountries: async () => null,
      createViewer: () => fake.viewer,
    });
    const onCountryClick = vi.fn();
    adapter.setOnCountryClick(onCountryClick);
    await adapter.whenReady();
    adapter.setNaturalEvents([{ id: 'point', title: 'Point', category: 'earthquakes', categoryTitle: 'Other', lat: 1, lon: 2, date: new Date(), closed: false }]);
    fake.viewer.scene.pick = vi.fn(() => ({ id: { id: 'm:natural:point' } }));

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
      loadCountries: async () => null,
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
      loadCountries: async () => null,
      createViewer: () => fake.viewer,
    });
    await adapter.whenReady();

    adapter.setNaturalEvents([{ id: 'old', title: 'Old', category: 'earthquakes', categoryTitle: 'Other', lat: 1, lon: 2, date: new Date(), closed: false }]);
    adapter.setNaturalEvents([{ id: 'new', title: 'New', category: 'earthquakes', categoryTitle: 'Other', lat: 3, lon: 4, date: new Date(), closed: false }]);

    expect([...fake.entities.keys()]).toContain('m:natural:new');
    expect([...fake.entities.keys()]).not.toContain('m:natural:old');
    expect(CESIUM_SPIKE_LIMITATIONS.unsupportedLayers).toMatch('state');
    expect(adapter.getLayerStatus('natural')).toBe('rendered');
    expect(adapter.getLayerStatus('conflicts')).toBe('unsupported');
  });

  describe('conflict zones and country boundaries', () => {
    // A tiny stand-in for /data/countries.geojson: Iran as a square with a hole,
    // plus an unrelated neighbour. The resolver only needs ISO codes + geometry.
    const IRAN_OUTER = [[44, 25], [63, 25], [63, 40], [44, 40], [44, 25]];
    const IRAN_HOLE = [[50, 30], [52, 30], [52, 32], [50, 32], [50, 30]];
    const countries = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { name: 'Iran', 'ISO3166-1-Alpha-2': 'IR', 'ISO3166-1-Alpha-3': 'IRN' }, geometry: { type: 'Polygon', coordinates: [IRAN_OUTER, IRAN_HOLE] } },
        { type: 'Feature', properties: { name: 'Oman', 'ISO3166-1-Alpha-2': 'OM', 'ISO3166-1-Alpha-3': 'OMN' }, geometry: { type: 'Polygon', coordinates: [[[52, 17], [60, 17], [60, 24], [52, 24], [52, 17]]] } },
      ],
    } as unknown as import('geojson').FeatureCollection;
    const countryAt = (lat: number, lon: number) => (lon >= 44 && lon <= 63 && lat >= 25 && lat <= 40 ? { code: 'IR', name: 'Iran' } : null);
    const popup = () => ({ show: vi.fn(), loadConflictHistory: vi.fn(), hide: vi.fn() });

    function build(fake: ReturnType<typeof fakeCesium>, overrides: Partial<ConstructorParameters<typeof CesiumMapAdapter>[2]> = {}, layers: Partial<MapLayers> = {}) {
      const p = popup();
      const adapter = new CesiumMapAdapter(document.createElement('div'), { ...state(), layers: { ...state().layers, conflicts: true, ...layers } as MapLayers }, {
        chrome: false,
        onInitError: vi.fn(),
        cesium: fake.dependency,
        createViewer: () => fake.viewer,
        loadCountries: async () => countries,
        countryAt,
        countryBbox: (code) => (code === 'IR' ? [44, 25, 63, 40] : null),
        createPopup: () => p,
        ...overrides,
      });
      return { adapter, popup: p };
    }

    it('draws country-mapped zones from the canonical country geometry, with holes, on the terrain', async () => {
      const fake = fakeCesium();
      const { adapter } = build(fake);
      await adapter.whenReady();
      await adapter.whenCountriesSettled();

      const iran = fake.entities.get('conflict:iran:IR:0') as { polygon: { hierarchy: { positions: unknown[]; holes: Array<{ positions: unknown[] }> }; material: string; classificationType: string } };
      expect(iran).toBeDefined();
      expect(iran.polygon.hierarchy.positions).toHaveLength(IRAN_OUTER.length);
      expect(iran.polygon.hierarchy.holes).toHaveLength(1);
      expect(iran.polygon.hierarchy.holes[0]?.positions).toHaveLength(IRAN_HOLE.length);
      expect(iran.polygon.classificationType).toBe('terrain');
      expect(iran.polygon.material).toBe('css(rgba(255,40,40,0.25))');
      // Ground polygons carry no outline in Cesium, so the border is a clamped polyline.
      const stroke = fake.entities.get('conflict:iran:IR:0:stroke') as { polyline: { clampToGround: boolean; material: string } };
      expect(stroke.polyline.clampToGround).toBe(true);
      expect(stroke.polyline.material).toBe('css(#ff3030)');
      expect(adapter.getLayerStatus('conflicts')).toBe('rendered');
    });

    it('never fabricates a national border for a country-mapped zone when geometry is missing', async () => {
      const fake = fakeCesium();
      const { adapter } = build(fake, { loadCountries: async () => null });
      await adapter.whenReady();
      await adapter.whenCountriesSettled();

      expect(adapter.getConflictEntityIds().some((id) => id.startsWith('conflict:iran:'))).toBe(false);
      // Regional zones keep their configured approximate polygon and are labelled as such.
      const regional = adapter.getConflictEntityIds().filter((id) => id.includes(':regional:'));
      expect(regional.length).toBeGreaterThan(0);
      const label = [...fake.entities.values()].find((e) => typeof e.id === 'string' && e.id.endsWith(':label')) as { label: { text: string; fillColor: string } } | undefined;
      expect(label?.label.text).toMatch(/approximate conflict area/);
      expect(label?.label.fillColor).toBe('css(#ff9600)');
    });

    it('removes and restores conflict entities with the layer toggle', async () => {
      const fake = fakeCesium();
      const { adapter } = build(fake);
      await adapter.whenReady();
      await adapter.whenCountriesSettled();
      expect(adapter.getConflictEntityIds().length).toBeGreaterThan(0);

      adapter.setLayers({ ...state().layers, conflicts: false } as MapLayers);
      expect(adapter.getConflictEntityIds()).toHaveLength(0);
      expect(adapter.getLayerStatus('conflicts')).toBe('unsupported');

      adapter.setLayers({ ...state().layers, conflicts: true } as MapLayers);
      expect(fake.entities.has('conflict:iran:IR:0')).toBe(true);
    });

    it('resolves bare globe clicks to a country and conflict picks to the shared popup', async () => {
      const fake = fakeCesium();
      const { adapter, popup: p } = build(fake);
      const onCountryClick = vi.fn();
      adapter.setOnCountryClick(onCountryClick);
      await adapter.whenReady();
      await adapter.whenCountriesSettled();
      const leftClick = fake.handler.setInputAction.mock.calls.find(([, type]) => type === 'left')?.[0] as ((movement: { position: { x: number; y: number } }) => void);

      fake.camera.pickEllipsoid = vi.fn(() => ({ longitude: 53, latitude: 32 }));
      fake.viewer.scene.pick = vi.fn(() => undefined);
      leftClick({ position: { x: 5, y: 6 } });
      expect(onCountryClick).toHaveBeenCalledWith({ lat: 32, lon: 53, code: 'IR', name: 'Iran' });

      fake.viewer.scene.pick = vi.fn(() => ({ id: { id: 'conflict:iran:IR:0' } }));
      leftClick({ position: { x: 7, y: 8 } });
      expect(p.show).toHaveBeenCalledWith(expect.objectContaining({ type: 'conflict', data: expect.objectContaining({ id: 'iran' }) }));
      expect(p.loadConflictHistory).toHaveBeenCalledOnce();
      expect(onCountryClick).toHaveBeenCalledOnce();
    });

    it('supports fitCountry and a removable country highlight outline', async () => {
      const fake = fakeCesium();
      const { adapter } = build(fake);
      await adapter.whenReady();
      await adapter.whenCountriesSettled();

      adapter.fitCountry('IR');
      expect(fake.camera.setView).toHaveBeenLastCalledWith({ destination: { lon: 53.5, lat: 32.5, height: expect.any(Number) } });
      expect(adapter.getCenter()).toEqual({ lat: 32.5, lon: 53.5 });
      adapter.fitCountry('ZZ');

      adapter.highlightCountry('ir');
      const highlight = fake.entities.get('country-highlight:IR:0') as { polyline: { positions: unknown[]; clampToGround: boolean } };
      expect(highlight.polyline.positions).toHaveLength(IRAN_OUTER.length);
      expect(highlight.polyline.clampToGround).toBe(true);
      adapter.clearCountryHighlight();
      expect(fake.entities.has('country-highlight:IR:0')).toBe(false);
    });
  });

  describe('layer parity with GlobeMap', () => {
    const popup = () => ({ show: vi.fn(), loadConflictHistory: vi.fn(), loadWingbitsLiveFlight: vi.fn(), setChokepointData: vi.fn(), hide: vi.fn() });
    function build(fake: ReturnType<typeof fakeCesium>, layers: Partial<MapLayers>) {
      const p = popup();
      const adapter = new CesiumMapAdapter(document.createElement('div'), { ...state(), layers: { ...state().layers, ...layers } as MapLayers }, {
        chrome: false, onInitError: vi.fn(), cesium: fake.dependency, createViewer: () => fake.viewer, loadCountries: async () => null, createPopup: () => p,
      });
      return { adapter, popup: p };
    }
    const entity = (fake: ReturnType<typeof fakeCesium>, id: string) => fake.entities.get(id) as Record<string, any> | undefined;

    it('renders hotspots as escalation-coloured glyphs and routes clicks to the hotspot callback', async () => {
      const fake = fakeCesium();
      const { adapter } = build(fake, { hotspots: true });
      const onHotspot = vi.fn();
      adapter.setOnHotspotClick(onHotspot);
      await adapter.whenReady();
      // The dashboard never pushes hotspots; the renderer seeds the bundled set itself.
      expect([...fake.entities.keys()].filter((id) => id.startsWith('m:hotspots:')).length).toBeGreaterThan(0);
      expect(adapter.getLayerStatus('hotspots')).toBe('rendered');
      adapter.setHotspots([{ id: 'h1', name: 'Taiwan Strait', lat: 24, lon: 120, keywords: [], escalationScore: 5 } as any]);
      expect([...fake.entities.keys()].filter((id) => id.startsWith('m:hotspots:'))).toEqual(['m:hotspots:h1']);

      const e = entity(fake, 'm:hotspots:h1');
      expect(e?.label).toMatchObject({ text: '◆', fillColor: 'css(#ff2020)', heightReference: 'clamp' });
      expect(adapter.getLayerStatus('hotspots')).toBe('rendered');

      fake.viewer.scene.pick = vi.fn(() => ({ id: { id: 'm:hotspots:h1' } }));
      const leftClick = fake.handler.setInputAction.mock.calls.find(([, type]) => type === 'left')?.[0] as ((movement: { position: { x: number; y: number } }) => void);
      leftClick({ position: { x: 1, y: 2 } });
      expect(onHotspot).toHaveBeenCalledWith(expect.objectContaining({ id: 'h1', escalationScore: 5 }));
    });

    it('opens the shared popup for flights, vessels and clusters, and a tooltip for everything else', async () => {
      const fake = fakeCesium();
      const container = document.createElement('div');
      const p = popup();
      const adapter = new CesiumMapAdapter(container, { ...state(), layers: { ...state().layers, military: true, fires: true } as MapLayers }, {
        chrome: false, onInitError: vi.fn(), cesium: fake.dependency, createViewer: () => fake.viewer, loadCountries: async () => null, createPopup: () => p,
      });
      await adapter.whenReady();
      adapter.setMilitaryFlights([{ id: 'f1', callsign: 'RCH123', lat: 50, lon: 10, aircraftType: 'transport', hexCode: 'abc' } as any]);
      adapter.setMilitaryVessels([{ id: 'v1', name: 'USS Ford', lat: 36, lon: 15, vesselType: 'carrier' } as any], [{ id: 'c1', name: 'CSG', lat: 30, lon: 20, vesselCount: 4, activityType: 'deployment' } as any]);
      adapter.setFires([{ lat: -20, lon: 130, brightness: 420, region: 'Outback' }]);

      expect(entity(fake, 'm:flights:f1')?.label).toMatchObject({ text: '✈', fillColor: 'css(#aaaaff)' });
      expect(entity(fake, 'm:vessels:v1')?.label).toMatchObject({ text: '⛴', font: '15px sans-serif' });
      expect(entity(fake, 'm:vesselClusters:c1')?.label).toMatchObject({ text: '4', fillColor: 'css(#ff4444)' });
      expect(adapter.getLayerStatus('military')).toBe('rendered');
      expect(adapter.getLayerStatus('fires')).toBe('rendered');

      const leftClick = fake.handler.setInputAction.mock.calls.find(([, type]) => type === 'left')?.[0] as ((movement: { position: { x: number; y: number } }) => void);
      fake.viewer.scene.pick = vi.fn(() => ({ id: { id: 'm:flights:f1' } }));
      leftClick({ position: { x: 1, y: 2 } });
      expect(p.show).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'militaryFlight', data: expect.objectContaining({ id: 'f1' }) }));
      expect(p.loadWingbitsLiveFlight).toHaveBeenCalledWith('abc');
      fake.viewer.scene.pick = vi.fn(() => ({ id: { id: 'm:vesselClusters:c1' } }));
      leftClick({ position: { x: 1, y: 2 } });
      expect(p.show).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'militaryVesselCluster' }));

      fake.viewer.scene.pick = vi.fn(() => ({ id: { id: 'm:fires:-20,130' } }));
      leftClick({ position: { x: 40, y: 50 } });
      expect(container.querySelector('.cesium-marker-tooltip')?.textContent).toBe('Fire — Outback');
      // A bare-globe click clears the tooltip.
      fake.viewer.scene.pick = vi.fn(() => undefined);
      leftClick({ position: { x: 40, y: 50 } });
      expect(container.querySelector('.cesium-marker-tooltip')).toBeNull();
    });

    it('draws bundled static layers, cables and pipelines only while their toggles are on', async () => {
      const fake = fakeCesium();
      const { adapter } = build(fake, { nuclear: false, cables: false, pipelines: false });
      await adapter.whenReady();
      expect(adapter.getLayerStatus('nuclear')).toBe('unsupported');
      expect([...fake.entities.keys()].some((id) => id.startsWith('m:static:nuclear:'))).toBe(false);

      adapter.setLayers({ ...state().layers, nuclear: true, cables: true, pipelines: true } as MapLayers);
      const nuclear = [...fake.entities.keys()].filter((id) => id.startsWith('m:static:nuclear:'));
      expect(nuclear.length).toBeGreaterThan(0);
      expect(entity(fake, nuclear[0]!)?.label).toMatchObject({ text: '☢', fillColor: 'css(#ffd700)' });
      const cables = [...fake.entities.keys()].filter((id) => id.startsWith('p:cables:'));
      const pipelines = [...fake.entities.keys()].filter((id) => id.startsWith('p:pipelines:'));
      expect(cables.length).toBeGreaterThan(0);
      expect(pipelines.length).toBeGreaterThan(0);
      expect(entity(fake, cables[0]!)?.polyline).toMatchObject({ clampToGround: true, material: 'css(rgba(0,200,255,0.65))' });
      expect(adapter.getLayerStatus('cables')).toBe('rendered');
      expect(adapter.getLayerStatus('pipelines')).toBe('rendered');

      adapter.setLayers({ ...state().layers, nuclear: false, cables: false, pipelines: true } as MapLayers);
      expect([...fake.entities.keys()].some((id) => id.startsWith('m:static:nuclear:'))).toBe(false);
      expect([...fake.entities.keys()].some((id) => id.startsWith('p:cables:'))).toBe(false);
      expect([...fake.entities.keys()].some((id) => id.startsWith('p:pipelines:'))).toBe(true);
    });

    it('recolours a cable when an advisory reports a fault on it', async () => {
      const fake = fakeCesium();
      const { adapter } = build(fake, { cables: true });
      await adapter.whenReady();
      const first = [...fake.entities.keys()].find((id) => id.startsWith('p:cables:'))!;
      const cableId = first.slice('p:cables:'.length);
      adapter.setCableActivity([{ id: 'adv1', cableId, title: 'Cut', severity: 'fault', lat: 1, lon: 2 } as any], []);
      expect(entity(fake, first)?.polyline.material).toBe('css(#ff3030)');
      expect(entity(fake, 'm:cableAdvisories:adv1')?.label).toMatchObject({ text: '🔌', fillColor: 'css(#ff2020)' });
    });

    it('places satellites at orbital altitude with unclamped trails, and drapes CII choropleth on countries', async () => {
      const fake = fakeCesium();
      const countries = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { 'ISO3166-1-Alpha-2': 'IR' }, geometry: { type: 'Polygon', coordinates: [[[44, 25], [63, 25], [63, 40], [44, 40], [44, 25]]] } }] } as any;
      const p = popup();
      const adapter = new CesiumMapAdapter(document.createElement('div'), { ...state(), layers: { ...state().layers, satellites: true, ciiChoropleth: true } as MapLayers }, {
        chrome: false, onInitError: vi.fn(), cesium: fake.dependency, createViewer: () => fake.viewer, loadCountries: async () => countries, createPopup: () => p,
      });
      await adapter.whenReady();
      await adapter.whenCountriesSettled();
      adapter.setSatellites([{ noradId: '25544', name: 'ISS', lat: 10, lng: 20, alt: 420, country: 'US', type: 'station', velocity: 7.6, inclination: 51.6, trail: [[21, 11, 420], [22, 12, 420]] } as any]);
      const sat = entity(fake, 'm:satellites:25544');
      expect(sat?.position).toEqual({ lon: 20, lat: 10, height: 420_000 });
      expect(sat?.point).toMatchObject({ heightReference: 'none', color: 'css(#4488ff)' });
      const orbit = entity(fake, 'p:orbits:orbit-25544');
      expect(orbit?.polyline.clampToGround).toBe(false);
      expect(orbit?.polyline.positions).toHaveLength(3);
      expect(adapter.getLayerStatus('satellites')).toBe('rendered');

      adapter.setCIIScores([{ code: 'IR', score: 82, level: 'critical' }]);
      const cii = entity(fake, 'poly:cii:IR:0');
      expect(cii?.polygon).toMatchObject({ material: 'css(rgba(140, 10, 0, 0.50))', classificationType: 'terrain' });
      expect(adapter.getLayerStatus('ciiChoropleth')).toBe('rendered');
      adapter.setLayers({ ...state().layers, satellites: true, ciiChoropleth: false } as MapLayers);
      expect(fake.entities.has('poly:cii:IR:0')).toBe(false);
    });

    it('applies the shared marker budget so an oversized feed is truncated, not dropped', async () => {
      const fake = fakeCesium();
      const { adapter } = build(fake, { fires: true });
      await adapter.whenReady();
      adapter.setFires(Array.from({ length: 900 }, (_, i) => ({ id: `f${i}`, lat: (i % 90) - 45, lon: (i % 180) - 90, brightness: 300 + (i % 200), region: `r${i}` })));
      const rendered = [...fake.entities.keys()].filter((id) => id.startsWith('m:fires:')).length;
      expect(rendered).toBeGreaterThan(0);
      expect(rendered).toBeLessThan(900);
      const load = adapter.getMarkerLoad();
      expect(load.rendered).toBe(rendered);
      expect(Object.keys(load.truncated)).toContain('fires');
    });

    it('reports honest layer status for layers GlobeMap never rendered', async () => {
      const fake = fakeCesium();
      const { adapter } = build(fake, { sanctions: true, dayNight: true } as Partial<MapLayers>);
      await adapter.whenReady();
      expect(adapter.getLayerStatus('sanctions' as keyof MapLayers)).toBe('unsupported');
      expect(adapter.getLayerStatus('dayNight' as keyof MapLayers)).toBe('unsupported');
      expect(CESIUM_SPIKE_LIMITATIONS.renderedLayers).not.toContain('sanctions');
    });
  });

  it('normalizes antimeridian and latitude bounds deterministically', () => {
    expect(clampCesiumCameraState(120, 540, 100)).toEqual({ lat: 89.9, lon: -180, zoom: 20 });
    expect(clampCesiumCameraState(-120, -540, 0)).toEqual({ lat: -89.9, lon: -180, zoom: 0.5 });
  });
});
