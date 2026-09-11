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
import type { FeatureCollection, Geometry } from 'geojson';
import type { MapContainerState, MapView, TimeRange } from './MapContainer';
import type { CountryClickPayload } from './DeckGLMap';
import type { MapLayers, NaturalEvent, SocialUnrestEvent, Hotspot, ConflictZone } from '@/types';
import type { Earthquake } from '@/services/earthquakes';
import type { WeatherAlert } from '@/services/weather';
import { CONFLICT_ZONES } from '@/config/geo';
import { getCountryAtCoordinates, getCountryBbox, getCountriesGeoJson } from '@/services/country-geometry';
import { CONFLICT_COUNTRY_ISO, resolveConflictZoneFeatures, type ConflictZoneFeature } from '../../shared/conflict-zone-geometry';
import { MapPopup } from './MapPopup';

export const CESIUM_SPIKE_LIMITATIONS = Object.freeze({
  renderedLayers: ['earthquakes', 'natural', 'protests', 'weather', 'flash', 'conflicts'] as const,
  unsupportedLayers: 'All other MapLayers entries are preserved as state but have no Cesium entities.',
  providers: 'No imagery or terrain network is activated unless enableKeylessBasemap is explicitly true. That option uses the keyless Esri World Imagery service (attribution required) with OpenStreetMap tiles as the fallback, and keyless Re:Earth ellipsoidal terrain with a flat ellipsoid fallback. No key, token, or billable provider is ever used.',
  camera: 'Longitude/latitude/zoom are canonical; Cesium heading, pitch, and height are not round-tripped.',
});

export type CesiumBasemapSource = 'esri-imagery' | 'osm';

export type CesiumMapAdapterOptions = {
  onInitError: (error: unknown) => void;
  chrome: boolean;
  cesium?: CesiumDependency;
  createViewer?: (container: HTMLElement, cesium: CesiumDependency) => CesiumViewer;
  /** Opt into a keyless geographic basemap. Without this the globe stays isolated. */
  enableKeylessBasemap?: boolean;
  /** Preferred keyless basemap. Defaults to Esri World Imagery; OSM is the truthful fallback. */
  basemap?: CesiumBasemapSource;
  /** Opt out of keyless Re:Earth terrain (defaults to enabled whenever a basemap is enabled). */
  enableKeylessTerrain?: boolean;
  /** Country geometry source. Defaults to the shared country-geometry service (`/data/countries.geojson`). */
  loadCountries?: () => Promise<FeatureCollection<Geometry> | null>;
  /** Point-in-country resolver for clicks. Defaults to the shared service. */
  countryAt?: (lat: number, lon: number) => { code: string; name: string } | null;
  /** Country bbox lookup for fitCountry. Defaults to the shared service. */
  countryBbox?: (code: string) => [number, number, number, number] | null;
  /** Popup factory; defaults to the shared MapPopup so conflict clicks match the 2D renderers. */
  createPopup?: (container: HTMLElement) => CesiumPopup;
};

export interface CesiumPopup {
  show(data: { type: 'conflict'; data: ConflictZone; x: number; y: number }): void;
  loadConflictHistory?(conflict: ConflictZone): void;
  hide(): void;
}

export type CesiumBasemapStatus = 'isolated' | 'loading' | 'ready' | 'failed';
/** `flat` means the ellipsoid is in use because Re:Earth could not be reached; it is not a failure of the map. */
export type CesiumTerrainStatus = 'isolated' | 'loading' | 'ready' | 'flat';

export interface CesiumDependency {
  Viewer: new (container: HTMLElement, options: Record<string, unknown>) => CesiumViewer;
  Cartesian3: {
    fromDegrees(lon: number, lat: number, height?: number): unknown;
    fromDegreesArray(coordinates: number[]): unknown[];
  };
  Cartographic: { fromCartesian(position: unknown): { longitude: number; latitude: number } };
  Math: { toDegrees(radians: number): number; toRadians(degrees: number): number };
  Color: { CYAN: unknown; ORANGE: unknown; RED: unknown; YELLOW: unknown; fromCssColorString(css: string): unknown };
  ScreenSpaceEventType: { LEFT_CLICK: unknown; RIGHT_CLICK: unknown };
  PolygonHierarchy: new (positions: unknown[], holes?: unknown[]) => unknown;
  ClassificationType: { TERRAIN: unknown };
  VerticalOrigin: { BOTTOM: unknown };
  LabelStyle: { FILL_AND_OUTLINE: unknown };
  HeightReference: { CLAMP_TO_GROUND: unknown };
  SceneTransforms?: { worldToWindowCoordinates(scene: unknown, position: unknown): { x: number; y: number } | undefined };
  EllipsoidTerrainProvider: new () => unknown;
  OpenStreetMapImageryProvider: new (options: { url: string; credit: string }) => CesiumImageryProvider;
  ArcGisMapServerImageryProvider: { fromUrl(url: string, options?: { credit?: string }): Promise<CesiumImageryProvider> };
  CesiumTerrainProvider: { fromUrl(url: string): Promise<unknown> };
  Credit: new (html: string, showOnScreen?: boolean) => unknown;
  ImageryLayer: new (provider: CesiumImageryProvider) => unknown;
}

export interface CesiumImageryProvider {
  errorEvent?: { addEventListener(callback: (error: unknown) => void): () => void };
};

export interface CesiumCreditDisplay {
  addStaticCredit(credit: unknown): void;
  removeStaticCredit?(credit: unknown): void;
}

export interface CesiumViewer {
  scene: {
    camera: {
      setView(options: { destination: unknown }): void;
      positionCartographic?: { longitude: number; latitude: number; height?: number };
      changed?: { addEventListener(callback: () => void): () => void };
      pickEllipsoid?: (position: { x: number; y: number }, ellipsoid?: unknown) => unknown;
    };
    globe?: { ellipsoid?: unknown };
    frameState?: { creditDisplay?: CesiumCreditDisplay };
    requestRender?: () => void;
    pick?: (position: { x: number; y: number }) => { id?: { id?: string } } | undefined;
  };
  /** Settable on a real Viewer; the adapter assigns the keyless terrain provider here. */
  terrainProvider?: unknown;
  canvas?: HTMLCanvasElement;
  entities: {
    add(entity: Record<string, unknown>): unknown;
    removeById(id: string): boolean;
    removeAll(): void;
    getById?(id: string): unknown;
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
// Esri World Imagery: the keyless satellite basemap God's Eye ships as its
// default. The classic ArcGIS Online tile service answers without a key, but
// Esri requires attribution. Cesium ignores the `credit` option for tiled
// ArcGIS MapServer sources, so the on-screen notice is added as an explicit
// static credit (mirrors God's Eye's mapStackController._syncEsriAttribution).
export const ESRI_WORLD_IMAGERY_URL = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';
export const ESRI_IMAGERY_CREDIT = 'Powered by Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';
export const ESRI_ATTRIBUTION_HTML = '<a href="https://www.esri.com" target="_blank" rel="noopener">Powered by Esri</a>';
// Keyless global ellipsoidal terrain (Re:Earth Terrain / Mapterhorn, CC BY 4.0).
// Fetched lazily after the viewer exists; the flat ellipsoid stays if it fails.
export const REEARTH_TERRAIN_URL = 'https://terrain.reearth.land/cesium-mesh/ellipsoid';
export const REEARTH_TERRAIN_CREDIT = 'Terrain: Re:Earth Terrain / Mapterhorn (CC BY 4.0)';
// Two tile failures on the active Esri provider trigger the OSM fallback; one
// transient error is left to Cesium's own retry, as in God's Eye.
const ESRI_FAILURES_BEFORE_FALLBACK = 2;
// Conflict overlay styling mirrors GlobeMap so 2D/3D read the same. Country
// zones use the canonical country boundary; regional zones are approximate
// areas and are drawn in orange with an explicit label, never as a border.
const CONFLICT_FILL: Record<string, string> = { high: 'rgba(255,40,40,0.25)', medium: 'rgba(255,120,0,0.20)', low: 'rgba(255,200,0,0.15)' };
const CONFLICT_STROKE: Record<string, string> = { high: '#ff3030', medium: '#ff8800', low: '#ffcc00' };
const REGIONAL_FILL = 'rgba(255,120,0,0.18)';
const REGIONAL_STROKE = '#ff9600';
const COUNTRY_HIGHLIGHT_STROKE = '#00e5ff';
const CONFLICT_ENTITY_PREFIX = 'conflict:';
const HIGHLIGHT_ENTITY_PREFIX = 'country-highlight:';

type Ring = number[][];

/** Outer ring + holes of every polygon in a GeoJSON geometry, in [lon, lat] order. */
export function polygonRingSets(geometry: Geometry): Ring[][] {
  if (geometry.type === 'Polygon') return [geometry.coordinates as Ring[]];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates as Ring[][];
  return [];
}

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
  private basemapSource: CesiumBasemapSource | null = null;
  private basemapError: string | null = null;
  /** Human-readable note when the map is usable but not on the preferred provider. */
  private basemapNotice: string | null = null;
  private basemapLayer: unknown = null;
  private removeBasemapErrorListener: (() => void) | null = null;
  private esriCredit: unknown = null;
  private esriCreditShown = false;
  private esriFallbackPending = false;
  private terrainStatus: CesiumTerrainStatus;
  private terrainError: string | null = null;
  private terrainPromise: Promise<void> | null = null;
  private terrainCredit: unknown = null;
  private countriesGeoData: FeatureCollection<Geometry> | null = null;
  private countriesPromise: Promise<void> | null = null;
  private popup: CesiumPopup | null = null;
  private onCountryClick: ((country: CountryClickPayload) => void) | null = null;

  public constructor(container: HTMLElement, initialState: MapContainerState, options: CesiumMapAdapterOptions) {
    this.container = container;
    this.state = { ...initialState, pan: { ...initialState.pan }, layers: { ...initialState.layers } };
    this.options = options;
    this.cesium = options.cesium ?? (Cesium as unknown as CesiumDependency);
    this.basemapStatus = options.enableKeylessBasemap ? 'loading' : 'isolated';
    this.terrainStatus = this.wantsKeylessTerrain() ? 'loading' : 'isolated';
    this.container.classList.add('globe-mode', 'cesium-map-adapter');
    this.container.style.position = 'relative';
  }

  private wantsKeylessTerrain(): boolean {
    return !!this.options.enableKeylessBasemap && this.options.enableKeylessTerrain !== false;
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
      // Dev-only diagnostic seam so browser acceptance scripts can read the
      // adapter's truthful status instead of guessing from pixels.
      if (import.meta.env?.DEV && typeof window !== 'undefined') {
        (window as unknown as { __cesiumMapAdapter?: CesiumMapAdapter }).__cesiumMapAdapter = this;
      }
      if (this.options.enableKeylessBasemap) await this.activateKeylessBasemap();
      // Terrain is deliberately not awaited: Re:Earth's layer.json fetch must
      // not delay readiness, and the flat ellipsoid is a correct interim state.
      if (this.wantsKeylessTerrain()) this.terrainPromise = this.activateKeylessTerrain();
      this.popup = (this.options.createPopup ?? ((container) => new MapPopup(container) as unknown as CesiumPopup))(this.container);
      this.installPicking();
      this.installCameraTracking();
      this.applyCenter(this.state.pan.y, this.state.pan.x, this.state.zoom);
      for (const [prefix, pointSet] of this.pendingPointSets) this.renderPointSet(prefix, pointSet.points, pointSet.color);
      // Country geometry is the same local source the 2D renderers use. Not
      // awaited: the conflicts layer appears once it lands, and a load failure
      // leaves country-mapped zones absent rather than drawing a guessed border.
      this.countriesPromise = this.loadCountryGeometry();
      this.resize();
      this.render();
    } catch (error) {
      this.options.onInitError(error);
      throw error;
    }
  }

  /** Reports whether the adapter has a geographic basemap, which provider is live, and any fallback notice. */
  public getBasemapStatus(): { status: CesiumBasemapStatus; source: CesiumBasemapSource | null; error: string | null; notice: string | null } {
    return { status: this.basemapStatus, source: this.basemapSource, error: this.basemapError, notice: this.basemapNotice };
  }

  /** Reports whether real terrain is in use. `flat` is an honest degraded state, not an init failure. */
  public getTerrainStatus(): { status: CesiumTerrainStatus; error: string | null } {
    return { status: this.terrainStatus, error: this.terrainError };
  }

  /** Resolves once the lazy terrain attempt has settled (ready or flat). Never rejects. */
  public whenTerrainSettled(): Promise<void> {
    return this.terrainPromise ?? Promise.resolve();
  }

  /** Dev/diagnostic access to the underlying viewer. Not part of the MapContainer contract. */
  public getViewerForDiagnostics(): CesiumViewer | null {
    return this.viewer;
  }

  /** Resolves once the country geometry load has settled (loaded or failed). Never rejects. */
  public whenCountriesSettled(): Promise<void> {
    return this.countriesPromise ?? Promise.resolve();
  }

  /** Ids of the conflict entities currently on the globe (diagnostics and tests). */
  public getConflictEntityIds(): string[] {
    return [...this.entityIds].filter((id) => id.startsWith(CONFLICT_ENTITY_PREFIX));
  }

  private async loadCountryGeometry(): Promise<void> {
    try {
      const geojson = await (this.options.loadCountries ?? getCountriesGeoJson)();
      if (this.destroyed) return;
      this.countriesGeoData = geojson;
    } catch (error) {
      console.warn('[CesiumMapAdapter] country geometry unavailable; country-mapped conflict zones stay hidden:', error);
      this.countriesGeoData = null;
    }
    this.renderConflictZones();
  }

  // ─── Conflict zones and country boundaries ────────────────────────────────

  private removeEntitiesWithPrefix(prefix: string): void {
    for (const id of [...this.entityIds]) {
      if (!id.startsWith(prefix)) continue;
      this.viewer?.entities.removeById(id);
      this.entityIds.delete(id);
    }
  }

  private ringToPositions(ring: Ring): unknown[] {
    const flat: number[] = [];
    for (const point of ring) {
      const lon = point[0];
      const lat = point[1];
      if (typeof lon === 'number' && typeof lat === 'number') flat.push(lon, lat);
    }
    return this.cesium.Cartesian3.fromDegreesArray(flat);
  }

  private hierarchyFor(rings: Ring[]): unknown | null {
    const [outer, ...holes] = rings;
    if (!outer || outer.length < 3) return null;
    const holeHierarchies = holes.filter((h) => h.length >= 3).map((h) => new this.cesium.PolygonHierarchy(this.ringToPositions(h)));
    return new this.cesium.PolygonHierarchy(this.ringToPositions(outer), holeHierarchies);
  }

  private addGroundPolygon(id: string, rings: Ring[], fillCss: string, strokeCss: string, extra: Record<string, unknown> = {}): void {
    if (!this.viewer) return;
    const hierarchy = this.hierarchyFor(rings);
    const outer = rings[0];
    if (!hierarchy || !outer) return;
    // Ground-classified polygons conform to the terrain; Cesium draws no outline
    // for them, so the stroke is a separate clamped polyline.
    this.viewer.entities.add({
      id,
      polygon: { hierarchy, material: this.cesium.Color.fromCssColorString(fillCss), classificationType: this.cesium.ClassificationType.TERRAIN },
      ...extra,
    });
    this.entityIds.add(id);
    const strokeId = `${id}:stroke`;
    this.viewer.entities.add({
      id: strokeId,
      polyline: { positions: this.ringToPositions(outer), width: 2, material: this.cesium.Color.fromCssColorString(strokeCss), clampToGround: true },
    });
    this.entityIds.add(strokeId);
  }

  private renderConflictZones(): void {
    if (!this.viewer || this.destroyed) return;
    this.removeEntitiesWithPrefix(CONFLICT_ENTITY_PREFIX);
    if (this.state.layers.conflicts !== true) { this.viewer.scene.requestRender?.(); return; }
    const features: ConflictZoneFeature[] = resolveConflictZoneFeatures(CONFLICT_ZONES, CONFLICT_COUNTRY_ISO, this.countriesGeoData);
    for (const feature of features) {
      const props = feature.properties;
      const regional = props.geometryKind === 'regional';
      const fill = regional ? REGIONAL_FILL : (CONFLICT_FILL[props.intensity ?? 'low'] ?? CONFLICT_FILL.low!);
      const stroke = regional ? REGIONAL_STROKE : (CONFLICT_STROKE[props.intensity ?? 'low'] ?? CONFLICT_STROKE.low!);
      const ringSets = polygonRingSets(feature.geometry);
      ringSets.forEach((rings, index) => {
        const id = `${CONFLICT_ENTITY_PREFIX}${props.id}:${props.countryCode ?? 'regional'}:${index}`;
        this.addGroundPolygon(id, rings, fill, stroke, { properties: { zoneId: props.id, geometryKind: props.geometryKind } });
      });
      if (regional) {
        const zone = CONFLICT_ZONES.find((candidate) => candidate.id === props.id);
        if (zone) {
          const labelId = `${CONFLICT_ENTITY_PREFIX}${props.id}:label`;
          this.viewer.entities.add({
            id: labelId,
            position: this.cesium.Cartesian3.fromDegrees(zone.center[0], zone.center[1]),
            label: {
              text: props.label,
              font: '12px monospace',
              fillColor: this.cesium.Color.fromCssColorString(REGIONAL_STROKE),
              outlineColor: this.cesium.Color.fromCssColorString('rgba(0,0,0,0.85)'),
              outlineWidth: 3,
              style: this.cesium.LabelStyle.FILL_AND_OUTLINE,
              verticalOrigin: this.cesium.VerticalOrigin.BOTTOM,
              heightReference: this.cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          });
          this.entityIds.add(labelId);
        }
      }
    }
    this.viewer.scene.requestRender?.();
  }

  private conflictZoneForEntityId(id: string): ConflictZone | null {
    if (!id.startsWith(CONFLICT_ENTITY_PREFIX)) return null;
    const zoneId = id.slice(CONFLICT_ENTITY_PREFIX.length).split(':')[0];
    return CONFLICT_ZONES.find((zone) => zone.id === zoneId) ?? null;
  }

  private screenPositionFor(lon: number, lat: number, fallback: { x: number; y: number }): { x: number; y: number } {
    const transforms = this.cesium.SceneTransforms;
    if (!transforms || !this.viewer) return fallback;
    try {
      return transforms.worldToWindowCoordinates(this.viewer.scene, this.cesium.Cartesian3.fromDegrees(lon, lat)) ?? fallback;
    } catch {
      return fallback;
    }
  }

  private showConflictPopup(zone: ConflictZone, at: { x: number; y: number }): void {
    if (!this.popup) return;
    const { x, y } = this.screenPositionFor(zone.center[0], zone.center[1], at);
    this.popup.show({ type: 'conflict', data: zone, x, y });
    this.popup.loadConflictHistory?.(zone);
  }

  public triggerConflictClick(id: string): void {
    const zone = CONFLICT_ZONES.find((candidate) => candidate.id === id);
    if (!zone) return;
    this.showConflictPopup(zone, { x: this.container.clientWidth / 2, y: this.container.clientHeight / 2 });
  }

  public setOnCountryClick(callback: (country: CountryClickPayload) => void): void { this.onCountryClick = callback; }

  public fitCountry(code: string): void {
    const bbox = (this.options.countryBbox ?? getCountryBbox)(code);
    if (!bbox) return;
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const span = Math.max(maxLat - minLat, maxLon - minLon);
    // Geographic span → zoom, mirroring GlobeMap's altitude ladder.
    const zoom = span > 60 ? 1.5 : span > 20 ? 3 : span > 8 ? 4 : span > 3 ? 5.5 : 7;
    this.applyCenter((minLat + maxLat) / 2, (minLon + maxLon) / 2, zoom);
  }

  public highlightCountry(code: string): void {
    this.clearCountryHighlight();
    if (!this.viewer || !this.countriesGeoData) return;
    const upper = code.toUpperCase();
    const feature = this.countriesGeoData.features.find((f) => f.properties?.['ISO3166-1-Alpha-2'] === upper);
    if (!feature?.geometry) return;
    polygonRingSets(feature.geometry).forEach((rings, index) => {
      const outer = rings[0];
      if (!outer || outer.length < 3) return;
      const id = `${HIGHLIGHT_ENTITY_PREFIX}${upper}:${index}`;
      this.viewer!.entities.add({
        id,
        polyline: { positions: this.ringToPositions(outer), width: 3, material: this.cesium.Color.fromCssColorString(COUNTRY_HIGHLIGHT_STROKE), clampToGround: true },
      });
      this.entityIds.add(id);
    });
    this.viewer.scene.requestRender?.();
  }

  public clearCountryHighlight(): void {
    this.removeEntitiesWithPrefix(HIGHLIGHT_ENTITY_PREFIX);
    this.viewer?.scene.requestRender?.();
  }

  private async activateKeylessBasemap(): Promise<void> {
    const preferred = this.options.basemap ?? 'esri-imagery';
    try {
      const resolved = await this.resolveBasemapProvider(preferred);
      if (this.destroyed || !this.viewer) return;
      this.installBasemap(resolved.provider, resolved.source);
      this.basemapSource = resolved.source;
      this.basemapNotice = resolved.notice;
      this.basemapStatus = 'ready';
    } catch (error) {
      this.basemapError = error instanceof Error ? error.message : String(error);
      this.basemapStatus = 'failed';
      this.basemapSource = null;
      this.options.onInitError(error);
    }
  }

  /**
   * Esri first, OSM as the truthful fallback. A fallback is reported through
   * `notice`, never hidden. If the preferred provider is OSM there is no
   * further fallback and construction failure surfaces as `failed`.
   */
  private async resolveBasemapProvider(preferred: CesiumBasemapSource): Promise<{ provider: CesiumImageryProvider; source: CesiumBasemapSource; notice: string | null }> {
    if (preferred === 'esri-imagery') {
      try {
        const provider = await this.cesium.ArcGisMapServerImageryProvider.fromUrl(ESRI_WORLD_IMAGERY_URL, { credit: ESRI_IMAGERY_CREDIT });
        return { provider, source: 'esri-imagery', notice: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('[CesiumMapAdapter] Esri World Imagery unavailable, falling back to OSM:', message);
        return { provider: this.createOsmProvider(), source: 'osm', notice: `Esri Satellite is unavailable; using OSM (${message})` };
      }
    }
    return { provider: this.createOsmProvider(), source: 'osm', notice: null };
  }

  private createOsmProvider(): CesiumImageryProvider {
    return new this.cesium.OpenStreetMapImageryProvider({ url: OSM_TILE_URL, credit: OSM_CREDIT });
  }

  private installBasemap(provider: CesiumImageryProvider, source: CesiumBasemapSource): void {
    this.removeBasemap();
    this.basemapLayer = new this.cesium.ImageryLayer(provider);
    this.viewer?.imageryLayers.add(this.basemapLayer, 0);
    this.syncEsriAttribution(source === 'esri-imagery');
    let failures = 0;
    this.removeBasemapErrorListener = provider.errorEvent?.addEventListener((error) => {
      if (this.destroyed) return;
      if (source === 'esri-imagery') {
        // Construction can succeed while tile requests fail (blocked network,
        // service change). Two failures swap to OSM, as God's Eye does.
        const retryCount = Number((error as { timesRetried?: unknown })?.timesRetried);
        failures = Number.isInteger(retryCount) && retryCount >= 0 ? Math.max(failures + 1, retryCount + 1) : failures + 1;
        if (failures < ESRI_FAILURES_BEFORE_FALLBACK || this.esriFallbackPending) return;
        this.esriFallbackPending = true;
        const message = 'Esri Satellite tile requests failed; using OSM';
        console.warn(`[CesiumMapAdapter] ${message}`);
        try {
          this.installBasemap(this.createOsmProvider(), 'osm');
          this.basemapSource = 'osm';
          this.basemapNotice = message;
          this.basemapStatus = 'ready';
        } catch (fallbackError) {
          this.basemapError = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          this.basemapStatus = 'failed';
          this.options.onInitError(fallbackError);
        } finally {
          this.esriFallbackPending = false;
        }
        this.viewer?.scene.requestRender?.();
        return;
      }
      this.basemapError = error instanceof Error ? error.message : String(error);
      this.basemapStatus = 'failed';
      this.options.onInitError(error);
      this.viewer?.scene.requestRender?.();
    }) ?? null;
  }

  private removeBasemap(): void {
    this.removeBasemapErrorListener?.();
    this.removeBasemapErrorListener = null;
    if (this.basemapLayer) this.viewer?.imageryLayers.remove(this.basemapLayer, false);
    this.basemapLayer = null;
  }

  /** Show or hide the on-screen "Powered by Esri" notice with the Esri layer. */
  private syncEsriAttribution(wanted: boolean): void {
    const creditDisplay = this.viewer?.scene.frameState?.creditDisplay;
    if (!creditDisplay || wanted === this.esriCreditShown) return;
    this.esriCredit ??= new this.cesium.Credit(ESRI_ATTRIBUTION_HTML, true);
    try {
      if (wanted) creditDisplay.addStaticCredit(this.esriCredit);
      else creditDisplay.removeStaticCredit?.(this.esriCredit);
      this.esriCreditShown = wanted;
    } catch {
      // A Cesium build without static-credit removal must not break the map.
    }
  }

  private async activateKeylessTerrain(): Promise<void> {
    try {
      const provider = await this.cesium.CesiumTerrainProvider.fromUrl(REEARTH_TERRAIN_URL);
      if (this.destroyed || !this.viewer) return;
      this.viewer.terrainProvider = provider;
      const creditDisplay = this.viewer.scene.frameState?.creditDisplay;
      if (creditDisplay) {
        this.terrainCredit = new this.cesium.Credit(REEARTH_TERRAIN_CREDIT, false);
        creditDisplay.addStaticCredit(this.terrainCredit);
      }
      this.terrainStatus = 'ready';
      this.viewer.scene.requestRender?.();
    } catch (error) {
      // The flat ellipsoid configured at viewer creation is left in place.
      this.terrainError = error instanceof Error ? error.message : String(error);
      this.terrainStatus = 'flat';
      console.warn('[CesiumMapAdapter] Re:Earth terrain unavailable, keeping flat ellipsoid terrain:', this.terrainError);
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
      const country = (this.options.countryAt ?? getCountryAtCoordinates)(lat, lon);
      this.onContextMenu?.({ lat, lon, screenX: position.x, screenY: position.y, countryCode: country?.code, countryName: country?.name });
      return;
    }
    const pickedId = this.viewer.scene.pick?.(position)?.id?.id;
    if (pickedId) {
      const zone = this.conflictZoneForEntityId(pickedId);
      if (zone) { this.showConflictPopup(zone, position); return; }
      // Other picked entities are data markers; their picks are not country clicks.
      return;
    }
    // Bare globe click: resolve the country from the same local geometry the 2D
    // renderers use, so the dashboard's country workflow works in 3D too.
    const country = (this.options.countryAt ?? getCountryAtCoordinates)(lat, lon);
    this.onCountryClick?.({ lat, lon, code: country?.code, name: country?.name });
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
    const conflictsChanged = (this.state.layers.conflicts === true) !== (layers.conflicts === true);
    this.state = { ...this.state, layers: { ...layers } };
    if (conflictsChanged) this.renderConflictZones();
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
    if (layer === 'conflicts') return this.viewer && this.state.layers.conflicts === true && this.getConflictEntityIds().length > 0 ? 'rendered' : 'unsupported';
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
    this.syncEsriAttribution(false);
    if (this.terrainCredit) {
      try { this.viewer?.scene.frameState?.creditDisplay?.removeStaticCredit?.(this.terrainCredit); } catch { /* see syncEsriAttribution */ }
      this.terrainCredit = null;
    }
    this.removeBasemap();
    const handler = this.viewer?.screenSpaceEventHandler;
    handler?.removeInputAction(this.cesium.ScreenSpaceEventType.LEFT_CLICK);
    handler?.removeInputAction(this.cesium.ScreenSpaceEventType.RIGHT_CLICK);
    this.viewer?.entities.removeAll();
    this.viewer?.destroy();
    this.viewer = null;
    this.entityIds.clear();
    try { this.popup?.hide(); } catch { /* popup DOM is discarded with the container */ }
    this.popup = null;
    this.countriesGeoData = null;
    this.container.textContent = '';
    this.container.classList.remove('cesium-map-adapter', 'globe-mode');
    this.onState = null;
    this.onTimeRange = null;
    this.onContextMenu = null;
    this.onCountryClick = null;
  }
}

export default CesiumMapAdapter;
