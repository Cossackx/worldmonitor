/**
 * Bounded Cesium renderer spike for the World Monitor renderer seam.
 *
 * This file deliberately imports Cesium only for the production default. The
 * `cesium` option is injectable so lifecycle/camera tests do not need WebGL.
 * The parent integration must install the inspected CesiumJS 1.138.x package;
 * this spike does not alter package manifests.
 *
 * The adapter is isolated by default. Dashboard callers must explicitly opt in
 * to the keyless OSM basemap; that opt-in is the only path that creates network
 * imagery. Point data is always supplied by the dashboard, never fabricated here.
 */
import * as Cesium from 'cesium';
import type { MapContainerState, MapView, TimeRange } from './MapContainer';
import type { CountryClickPayload } from './DeckGLMap';
import type { MapLayers, NaturalEvent, SocialUnrestEvent, Hotspot } from '@/types';
import type { Earthquake } from '@/services/earthquakes';
import type { WeatherAlert } from '@/services/weather';

export const CESIUM_SPIKE_LIMITATIONS = Object.freeze({
  renderedLayers: ['earthquakes', 'natural', 'protests', 'weather', 'flash'] as const,
  unsupportedLayers: 'All other MapLayers entries are preserved as state but have no Cesium entities.',
  providers: 'No imagery or terrain network is activated unless enableKeylessBasemap is explicitly true; that option uses OpenStreetMap tiles with attribution.',
  camera: 'Longitude/latitude/zoom are canonical; Cesium heading, pitch, and height are not round-tripped.',
});

export type CesiumMapAdapterOptions = {
  onInitError: (error: unknown) => void;
  chrome: boolean;
  cesium?: CesiumDependency;
  createViewer?: (container: HTMLElement, cesium: CesiumDependency) => CesiumViewer;
  /** Opt into the keyless OpenStreetMap basemap for a real geographic surface. */
  enableKeylessBasemap?: boolean;
};

export type CesiumBasemapStatus = 'isolated' | 'loading' | 'ready' | 'failed';

export interface CesiumDependency {
  Viewer: new (container: HTMLElement, options: Record<string, unknown>) => CesiumViewer;
  Cartesian3: { fromDegrees(lon: number, lat: number, height?: number): unknown };
  Cartographic: { fromCartesian(position: unknown): { longitude: number; latitude: number } };
  Math: { toDegrees(radians: number): number; toRadians(degrees: number): number };
  Color: { CYAN: unknown; ORANGE: unknown; RED: unknown; YELLOW: unknown };
  ScreenSpaceEventType: { LEFT_CLICK: unknown; RIGHT_CLICK: unknown };
  EllipsoidTerrainProvider: new () => unknown;
  OpenStreetMapImageryProvider: new (options: { url: string; credit: string }) => CesiumImageryProvider;
  ImageryLayer: new (provider: CesiumImageryProvider) => unknown;
}

export interface CesiumImageryProvider {
  errorEvent?: { addEventListener(callback: (error: unknown) => void): () => void };
};

export interface CesiumViewer {
  scene: {
    camera: {
      setView(options: { destination: unknown }): void;
      positionCartographic?: { longitude: number; latitude: number; height?: number };
      changed?: { addEventListener(callback: () => void): () => void };
      pickEllipsoid?: (position: { x: number; y: number }, ellipsoid?: unknown) => unknown;
    };
    globe?: { ellipsoid?: unknown };
    requestRender?: () => void;
    pick?: (position: { x: number; y: number }) => { id?: { id?: string } } | undefined;
  };
  canvas?: HTMLCanvasElement;
  entities: {
    add(entity: Record<string, unknown>): unknown;
    removeById(id: string): boolean;
    removeAll(): void;
  };
  imageryLayers: {
    add(layer: unknown, index?: number): unknown;
    remove(layer: unknown, destroy?: boolean): boolean;
  };
  screenSpaceEventHandler?: {
    setInputAction(callback: (movement: { position?: { x: number; y: number } }) => void, type: unknown): void;
    removeInputAction(type: unknown): void;
    destroy?: () => void;
  };
  resize?: () => void;
  render?: () => void;
  destroy(): void;
}

const VIEW_PRESETS: Record<MapView, { lat: number; lon: number; zoom: number }> = {
  global: { lat: 20, lon: 0, zoom: 1.5 },
  america: { lat: 38, lon: -95, zoom: 3 },
  mena: { lat: 28, lon: 45, zoom: 3.5 },
  eu: { lat: 50, lon: 15, zoom: 3.5 },
  asia: { lat: 35, lon: 105, zoom: 3 },
  latam: { lat: -15, lon: -60, zoom: 3 },
  africa: { lat: 5, lon: 20, zoom: 3 },
  oceania: { lat: -25, lon: 135, zoom: 3.5 },
};
const MIN_LATITUDE = -89.9;
const MAX_LATITUDE = 89.9;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 20;
const MAX_CAMERA_HEIGHT = 18_000_000;
const MIN_CAMERA_HEIGHT = 250;
const EVENT_MARKER_HEIGHT = 25_000;
const OSM_TILE_URL = 'https://tile.openstreetmap.org/';
const OSM_CREDIT = '© OpenStreetMap contributors';

export function clampCesiumCameraState(lat: number, lon: number, zoom: number): { lat: number; lon: number; zoom: number } {
  const normalizedLon = ((((lon + 180) % 360) + 360) % 360) - 180;
  return {
    lat: Math.max(MIN_LATITUDE, Math.min(MAX_LATITUDE, lat)),
    lon: normalizedLon,
    zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom)),
  };
}

export function zoomToCameraHeight(zoom: number): number {
  const boundedZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
  return Math.max(MIN_CAMERA_HEIGHT, Math.min(MAX_CAMERA_HEIGHT, MAX_CAMERA_HEIGHT / 2 ** (boundedZoom - MIN_ZOOM)));
}

export class CesiumMapAdapter {
  private readonly container: HTMLElement;
  private readonly options: CesiumMapAdapterOptions;
  private readonly cesium: CesiumDependency;
  private state: MapContainerState;
  private viewer: CesiumViewer | null = null;
  private initPromise: Promise<void> | null = null;
  private destroyed = false;
  private entityIds = new Set<string>();
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private onState: ((state: MapContainerState) => void) | null = null;
  private onTimeRange: ((range: TimeRange) => void) | null = null;
  private onContextMenu: ((payload: { lat: number; lon: number; screenX: number; screenY: number; countryCode?: string; countryName?: string }) => void) | null = null;
  private removeCameraChangedListener: (() => void) | null = null;
  private pendingPointSets = new Map<string, { points: Array<{ id: string; lat: number; lon: number }>; color: unknown }>();
  private basemapStatus: CesiumBasemapStatus;
  private basemapError: string | null = null;
  private basemapLayer: unknown = null;
  private removeBasemapErrorListener: (() => void) | null = null;

  public constructor(container: HTMLElement, initialState: MapContainerState, options: CesiumMapAdapterOptions) {
    this.container = container;
    this.state = { ...initialState, pan: { ...initialState.pan }, layers: { ...initialState.layers } };
    this.options = options;
    this.cesium = options.cesium ?? (Cesium as unknown as CesiumDependency);
    this.basemapStatus = options.enableKeylessBasemap ? 'loading' : 'isolated';
    this.container.classList.add('globe-mode', 'cesium-map-adapter');
    this.container.style.position = 'relative';
  }

  public whenReady(): Promise<void> {
    this.initPromise ??= Promise.resolve().then(() => this.initialize());
    return this.initPromise;
  }

  private async initialize(): Promise<void> {
    if (this.destroyed) return;
    try {
      const createViewer = this.options.createViewer ?? ((element, cesium) => new cesium.Viewer(element, {
        animation: false,
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        fullscreenButton: false,
        timeline: false,
        infoBox: false,
        selectionIndicator: false,
        baseLayer: false,
        terrainProvider: new cesium.EllipsoidTerrainProvider(),
      }));
      this.viewer = createViewer(this.container, this.cesium);
      if (this.options.enableKeylessBasemap) await this.activateKeylessBasemap();
      this.installPicking();
      this.installCameraTracking();
      this.applyCenter(this.state.pan.y, this.state.pan.x, this.state.zoom);
      for (const [prefix, pointSet] of this.pendingPointSets) this.renderPointSet(prefix, pointSet.points, pointSet.color);
      this.resize();
      this.render();
    } catch (error) {
      this.options.onInitError(error);
      throw error;
    }
  }

  /** Reports whether the adapter has a geographic basemap, without hiding failure. */
  public getBasemapStatus(): { status: CesiumBasemapStatus; error: string | null } {
    return { status: this.basemapStatus, error: this.basemapError };
  }

  private async activateKeylessBasemap(): Promise<void> {
    try {
      const provider = new this.cesium.OpenStreetMapImageryProvider({ url: OSM_TILE_URL, credit: OSM_CREDIT });
      this.basemapLayer = new this.cesium.ImageryLayer(provider);
      this.viewer?.imageryLayers.add(this.basemapLayer, 0);
      this.removeBasemapErrorListener = provider.errorEvent?.addEventListener((error) => {
        this.basemapError = error instanceof Error ? error.message : String(error);
        this.basemapStatus = 'failed';
        this.options.onInitError(error);
        this.viewer?.scene.requestRender?.();
      }) ?? null;
      this.basemapStatus = 'ready';
    } catch (error) {
      this.basemapError = error instanceof Error ? error.message : String(error);
      this.basemapStatus = 'failed';
      this.options.onInitError(error);
    }
  }

  private installPicking(): void {
    const handler = this.viewer?.screenSpaceEventHandler;
    if (!handler) return;
    handler.setInputAction((movement) => this.handlePick(movement.position, false), this.cesium.ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction((movement) => this.handlePick(movement.position, true), this.cesium.ScreenSpaceEventType.RIGHT_CLICK);
  }

  private installCameraTracking(): void {
    const changed = this.viewer?.scene.camera.changed;
    if (!changed) return;
    this.removeCameraChangedListener = changed.addEventListener(() => {
      if (this.destroyed) return;
      this.syncStateFromCamera();
      this.onState?.(this.getState());
    });
  }

  private handlePick(position: { x: number; y: number } | undefined, contextMenu: boolean): void {
    if (!position || !this.viewer) return;
    const cartesian = this.viewer.scene.camera.pickEllipsoid?.(position, this.viewer.scene.globe?.ellipsoid);
    if (!cartesian) return;
    const cartographic = this.cesium.Cartographic.fromCartesian(cartesian);
    const lat = this.cesium.Math.toDegrees(cartographic.latitude);
    const lon = this.cesium.Math.toDegrees(cartographic.longitude);
    if (contextMenu) {
      this.onContextMenu?.({ lat, lon, screenX: position.x, screenY: position.y });
      return;
    }
    // This adapter has no country boundary entity/source. Point entities are
    // data markers, so their picks must not become country clicks.
  }

  private applyCamera(view: MapView, zoom: number, _panX = 0, _panY = 0): void {
    const preset = VIEW_PRESETS[view];
    this.applyCenter(preset.lat, preset.lon, zoom || preset.zoom);
  }

  private applyCenter(lat: number, lon: number, zoom = this.state.zoom): void {
    const next = clampCesiumCameraState(lat, lon, zoom);
    this.state = { ...this.state, zoom: next.zoom, pan: { x: next.lon, y: next.lat } };
    this.viewer?.scene.camera.setView({ destination: this.cesium.Cartesian3.fromDegrees(next.lon, next.lat, zoomToCameraHeight(next.zoom)) });
    this.viewer?.scene.requestRender?.();
    this.onState?.(this.getState());
  }

  private readCameraState(): { lat: number; lon: number; zoom: number } | null {
    const position = this.viewer?.scene.camera.positionCartographic;
    if (!position) return null;
    const height = position.height;
    const zoom = height === undefined ? this.state.zoom : MIN_ZOOM + Math.log2(MAX_CAMERA_HEIGHT / Math.max(MIN_CAMERA_HEIGHT, height));
    return clampCesiumCameraState(
      this.cesium.Math.toDegrees(position.latitude),
      this.cesium.Math.toDegrees(position.longitude),
      zoom,
    );
  }

  private syncStateFromCamera(): void {
    const camera = this.readCameraState();
    if (!camera) return;
    this.state = { ...this.state, zoom: camera.zoom, pan: { x: camera.lon, y: camera.lat } };
  }

  public render(): void { if (!this.destroyed) this.viewer?.render?.(); }
  public resize(): void { if (!this.destroyed) this.viewer?.resize?.(); }
  public setIsResizing(_isResizing: boolean): void { /* Cesium owns its render loop during the spike. */ }

  public setView(view: MapView, zoom?: number): void {
    const preset = VIEW_PRESETS[view];
    const nextZoom = zoom ?? preset.zoom;
    this.state = { ...this.state, view, zoom: nextZoom, pan: { x: preset.lon, y: preset.lat } };
    if (this.viewer) this.applyCamera(view, nextZoom);
  }
  public setZoom(zoom: number): void { this.applyCenter(this.state.pan.y, this.state.pan.x, zoom); }
  public setCenter(lat: number, lon: number, zoom?: number): void { this.applyCenter(lat, lon, zoom ?? this.state.zoom); }
  public getCenter(): { lat: number; lon: number } | null {
    this.syncStateFromCamera();
    return { lat: this.state.pan.y, lon: this.state.pan.x };
  }
  public whenViewportSettled(): Promise<boolean> { return Promise.resolve(!this.destroyed && !!this.viewer); }
  public getState(): MapContainerState {
    this.syncStateFromCamera();
    return { ...this.state, pan: { ...this.state.pan }, layers: { ...this.state.layers } };
  }
  public setTimeRange(range: TimeRange): void { this.state = { ...this.state, timeRange: range }; this.onTimeRange?.(range); }
  public getTimeRange(): TimeRange { return this.state.timeRange; }
  public setLayers(layers: MapLayers): void {
    this.state = { ...this.state, layers: { ...layers } };
    for (const [prefix, layer] of Object.entries({ earthquake: 'natural', natural: 'natural', protest: 'protests', weather: 'weather' } as Record<string, keyof MapLayers>)) {
      const ids = [...this.entityIds].filter((id) => id.startsWith(`${prefix}:`));
      if (this.state.layers[layer] === true) {
        const pointSet = this.pendingPointSets.get(prefix);
        if (pointSet && ids.length === 0) this.renderPointSet(prefix, pointSet.points, pointSet.color);
      } else {
        for (const id of ids) { this.viewer?.entities.removeById(id); this.entityIds.delete(id); }
      }
    }
    this.viewer?.scene.requestRender?.();
  }

  public onStateChanged(callback: (state: MapContainerState) => void): void { this.onState = callback; }
  public onTimeRangeChanged(callback: (range: TimeRange) => void): void { this.onTimeRange = callback; }
  public setOnLayerChange(_callback: (layer: keyof MapLayers, enabled: boolean, source: 'user' | 'programmatic') => void): void { /* No interactive layer toggles in this spike. */ }
  public setOnCountryClick(_callback: (country: CountryClickPayload) => void): void { /* No country boundary data is available in this adapter. */ }
  public setOnMapContextMenu(callback: (payload: { lat: number; lon: number; screenX: number; screenY: number; countryCode?: string; countryName?: string }) => void): void { this.onContextMenu = callback; }
  public setOnHotspotClick(_callback: (hotspot: Hotspot) => void): void { /* Hotspot data is unsupported in this spike. */ }
  public setOnAircraftPositionsUpdate(_callback: (positions: never[]) => void): void { /* Aircraft data is unsupported in this spike. */ }

  private replacePoints(prefix: string, points: Array<{ id: string; lat: number; lon: number }>, color: unknown): void {
    this.pendingPointSets.set(prefix, { points, color });
    if (!this.viewer || this.destroyed) return;
    this.renderPointSet(prefix, points, color);
  }

  private renderPointSet(prefix: string, points: Array<{ id: string; lat: number; lon: number }>, color: unknown): void {
    if (!this.viewer || this.destroyed) return;
    const layer = ({ earthquake: 'natural', natural: 'natural', protest: 'protests', weather: 'weather' } as Record<string, keyof MapLayers>)[prefix];
    if (layer && this.state.layers[layer] !== true) return;
    for (const id of this.entityIds) if (id.startsWith(`${prefix}:`)) { this.viewer.entities.removeById(id); this.entityIds.delete(id); }
    for (const point of points) {
      const id = `${prefix}:${point.id}`;
      this.viewer.entities.add({ id, position: this.cesium.Cartesian3.fromDegrees(point.lon, point.lat, EVENT_MARKER_HEIGHT), point: { pixelSize: 8, color } });
      this.entityIds.add(id);
    }
    this.viewer.scene.requestRender?.();
  }

  public setEarthquakes(items: Earthquake[]): void {
    this.replacePoints('earthquake', items.flatMap((item) => item.location ? [{ id: String(item.id), lat: item.location.latitude, lon: item.location.longitude }] : []), this.cesium.Color.YELLOW);
  }
  public setNaturalEvents(items: NaturalEvent[]): void { this.replacePoints('natural', items.map((item) => ({ id: item.id, lat: item.lat, lon: item.lon })), this.cesium.Color.ORANGE); }
  public setProtests(items: SocialUnrestEvent[]): void { this.replacePoints('protest', items.map((item) => ({ id: item.id, lat: item.lat, lon: item.lon })), this.cesium.Color.RED); }
  public setWeatherAlerts(items: WeatherAlert[]): void {
    this.replacePoints('weather', items.flatMap((item) => { const point = item.centroid ?? item.coordinates[0]; return point ? [{ id: item.id, lat: point[1], lon: point[0] }] : []; }), this.cesium.Color.CYAN);
  }
  public setLayerLoading(_layer: keyof MapLayers, _loading: boolean): void { /* Fixture spike has no loading pipeline. */ }
  public setLayerReady(_layer: keyof MapLayers, _hasData: boolean): void { /* Point setters own readiness in this spike. */ }
  public getLayerStatus(layer: keyof MapLayers): 'rendered' | 'unsupported' {
    if (!(CESIUM_SPIKE_LIMITATIONS.renderedLayers as readonly string[]).includes(layer)) return 'unsupported';
    const prefix = ({ earthquakes: 'earthquake', natural: 'natural', protests: 'protest', weather: 'weather', flash: 'flash' } as Record<string, string>)[layer] ?? '';
    return this.viewer && this.state.layers[layer] === true && (this.pendingPointSets.get(prefix)?.points.length ?? 0) > 0 && [...this.entityIds].some((id) => id.startsWith(`${prefix}:`)) ? 'rendered' : 'unsupported';
  }
  public flashLocation(lat: number, lon: number, durationMs = 1500): void {
    this.replacePoints('flash', [{ id: 'active', lat, lon }], this.cesium.Color.CYAN);
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => { if (!this.destroyed) this.replacePoints('flash', [], this.cesium.Color.CYAN); }, durationMs);
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.removeCameraChangedListener?.();
    this.removeCameraChangedListener = null;
    this.removeBasemapErrorListener?.();
    this.removeBasemapErrorListener = null;
    if (this.basemapLayer) this.viewer?.imageryLayers.remove(this.basemapLayer, false);
    this.basemapLayer = null;
    const handler = this.viewer?.screenSpaceEventHandler;
    handler?.removeInputAction(this.cesium.ScreenSpaceEventType.LEFT_CLICK);
    handler?.removeInputAction(this.cesium.ScreenSpaceEventType.RIGHT_CLICK);
    this.viewer?.entities.removeAll();
    this.viewer?.destroy();
    this.viewer = null;
    this.entityIds.clear();
    this.container.textContent = '';
    this.container.classList.remove('cesium-map-adapter', 'globe-mode');
    this.onState = null;
    this.onTimeRange = null;
    this.onContextMenu = null;
  }
}

export default CesiumMapAdapter;
