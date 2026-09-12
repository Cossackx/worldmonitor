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
import type {
  MapLayers, NaturalEvent, SocialUnrestEvent, Hotspot, ConflictZone, MilitaryFlight, MilitaryVessel, MilitaryVesselCluster,
  InternetOutage, CyberThreat, UcdpGeoEvent, CableAdvisory, RepairShip, AisDisruptionEvent, AisDensityZone, MilitaryBase,
} from '@/types';
import type { Earthquake } from '@/services/earthquakes';
import type { WeatherAlert } from '@/services/weather';
import type { AirportDelayAlert } from '@/services/aviation';
import type { IranEvent } from '@/services/conflict';
import type { DisplacementFlow } from '@/services/displacement';
import type { ClimateAnomaly } from '@/services/climate';
import type { GpsJamHex } from '@/services/gps-interference';
import type { SatellitePosition } from '@/services/satellites';
import type { RadiationObservation } from '@/services/radiation';
import type { ScenarioVisualState } from '@/config/scenario-templates';
import type { GetChokepointStatusResponse } from '@/services/supply-chain';
import type { ImageryScene } from '@/generated/server/worldmonitor/imagery/v1/service_server';
import type { WebcamEntry, WebcamCluster } from '@/generated/client/worldmonitor/webcam/v1/service_client';
import type { TrafficAnomaly as ProtoTrafficAnomaly, DdosLocationHit } from '@/generated/client/worldmonitor/infrastructure/v1/service_client';
import { CONFLICT_ZONES, INTEL_HOTSPOTS, STRATEGIC_WATERWAYS } from '@/config/geo';
import { getCountryAtCoordinates, getCountryBbox, getCountriesGeoJson } from '@/services/country-geometry';
import { getCachedMilitaryBases, preloadMilitaryBases } from '@/services/military-base-config';
import { GLOBE_MARKER_BUDGET_DESKTOP, GLOBE_MARKER_BUDGET_MOBILE, proximityRank, selectGlobeMarkers, type GlobeMarkerGroup } from '@/utils/globe-marker-budget';
import { isMobileDevice } from '@/utils';
import { CONFLICT_COUNTRY_ISO, resolveConflictZoneFeatures, type ConflictZoneFeature } from '../../shared/conflict-zone-geometry';
import { MapPopup } from './MapPopup';
import { CesiumMapChrome } from './CesiumMapChrome';
import {
  buildAisDisruptionMarkers, buildCableActivityMarkers, buildClimateMarkers, buildConflictZoneMarkers, buildCyberMarkers,
  buildDdosMarkers, buildDisplacementMarkers, buildEarthquakeMarkers, buildFireMarkers, buildFlightDelayMarkers,
  buildGpsJamMarkers, buildHotspotMarkers, buildImagerySceneMarkers, buildIranEventMarkers, buildMilitaryBaseMarkers,
  buildMilitaryFlightMarkers, buildMilitaryVesselMarkers, buildNaturalMarkers, buildNewsLocationMarkers, buildOutageMarkers,
  buildProtestMarkers, buildRadiationMarkers, buildSatelliteMarkers, buildStaticMarkers, buildStaticPaths,
  buildStormPathsAndCones, buildTechEventMarkers, buildTradeRouteArcs, buildTrafficAnomalyMarkers, buildUcdpMarkers,
  buildVesselClusterMarkers, buildWeatherMarkers, buildWebcamMarkers, CII_COLORS,
  type CesiumMarker, type CesiumPath, type CesiumPolygon, type MarkerGroupRecord,
} from './CesiumMarkerLayers';

/**
 * Layers this renderer draws. Parity target is GlobeMap (the globe.gl path):
 * every layer GlobeMap renders is here. Layers GlobeMap itself never drew are
 * listed in CesiumMarkerLayers.ts and stay honestly unsupported.
 */
export const CESIUM_RENDERED_LAYERS = [
  'conflicts', 'hotspots', 'bases', 'nuclear', 'irradiators', 'spaceports', 'military', 'weather', 'natural',
  'radiationWatch', 'economic', 'datacenters', 'waterways', 'minerals', 'flights', 'ais', 'iranAttacks', 'outages',
  'cyberThreats', 'fires', 'protests', 'ucdpEvents', 'displacement', 'climate', 'gpsJamming', 'satellites', 'techEvents',
  'cables', 'pipelines', 'tradeRoutes', 'webcams', 'ciiChoropleth',
] as const satisfies readonly (keyof MapLayers)[];

export const CESIUM_SPIKE_LIMITATIONS = Object.freeze({
  renderedLayers: [...CESIUM_RENDERED_LAYERS, 'earthquakes', 'flash'] as const,
  unsupportedLayers: 'Layers GlobeMap never rendered (sanctions, canada*, startup/cloud/tech-HQ/finance layers, positive/kindness/happiness, speciesRecovery, renewables, resilienceScore, dayNight, mining/commodity, disease, storage, fuel, liveTankers) are preserved as state but have no Cesium entities.',
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
  show(data: { type: string; data: unknown; x: number; y: number }): void;
  loadConflictHistory?(conflict: ConflictZone): void;
  loadWingbitsLiveFlight?(hexCode: string): void;
  setChokepointData?(data: GetChokepointStatusResponse | null): void;
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
  VerticalOrigin: { BOTTOM: unknown; CENTER: unknown };
  HorizontalOrigin: { CENTER: unknown };
  LabelStyle: { FILL_AND_OUTLINE: unknown };
  DistanceDisplayCondition: new (near: number, far: number) => unknown;
  Cartesian2: new (x: number, y: number) => unknown;
  /** Static credit registry; absent from minimal test doubles. */
  CreditDisplay?: { cesiumCredit: unknown };
  HeightReference: { CLAMP_TO_GROUND: unknown; NONE: unknown };
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
const BORDER_ENTITY_PREFIX = 'border:';
/** Slate-400 at ~45%: the same quiet outline DeckGLMap's embed border uses. */
const COUNTRY_BORDER_CSS = '#94a3b873';
/**
 * Regional conflict labels show only once the camera is within this distance
 * of the zone (roughly zoom 3.5 and closer). The 2D renderers never draw these
 * labels at all; they surface the text on hover.
 */
const CONFLICT_LABEL_MAX_DISTANCE_M = 3_000_000;

/** `#rrggbb` → `#rrggbbaa`; any other CSS colour is returned unchanged. */
function withAlpha(css: string, alpha: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(css)) return css;
  return `${css}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
}
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
  /** Marker feeds keyed by group name; each group belongs to one layer toggle. */
  private markerGroups = new Map<string, MarkerGroupRecord>();
  /** Path feeds (cables, pipelines, storm tracks, orbits, trade arcs) keyed by group. */
  private pathGroups = new Map<string, { layer: keyof MapLayers; paths: CesiumPath[] }>();
  /** Polygon feeds (CII, scenario, imagery footprints, forecast cones) keyed by group. */
  private polygonGroups = new Map<string, { layer: keyof MapLayers | 'scenario'; polygons: CesiumPolygon[] }>();
  /** Entity id → marker for click routing. */
  private markerByEntityId = new Map<string, CesiumMarker>();
  private entityCountByLayer = new Map<string, number>();
  private cableFaultIds = new Set<string>();
  private cableDegradedIds = new Set<string>();
  private ciiScores = new Map<string, { score: number; level: string }>();
  private scenarioIso2s: string[] = [];
  private onHotspotClick: ((hotspot: Hotspot) => void) | null = null;
  private tooltipEl: HTMLElement | null = null;
  private basesLoadPending = false;
  private markerTruncation: Record<string, unknown> = {};
  private renderedMarkerCount = 0;
  private renderPaused = false;
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
  private chrome: CesiumMapChrome | null = null;
  private onLayerChangeCb: ((layer: keyof MapLayers, enabled: boolean, source: 'user' | 'programmatic') => void) | null = null;
  private reselectTimer: ReturnType<typeof setTimeout> | null = null;

  public constructor(container: HTMLElement, initialState: MapContainerState, options: CesiumMapAdapterOptions) {
    this.container = container;
    this.state = { ...initialState, pan: { ...initialState.pan }, layers: { ...initialState.layers } };
    this.options = options;
    this.cesium = options.cesium ?? (Cesium as unknown as CesiumDependency);
    this.basemapStatus = options.enableKeylessBasemap ? 'loading' : 'isolated';
    this.terrainStatus = this.wantsKeylessTerrain() ? 'loading' : 'isolated';
    this.container.classList.add('globe-mode', 'cesium-map-adapter');
    this.container.style.position = 'relative';
    // Like DeckGLMap and GlobeMap, the renderer owns its in-pane chrome; it is
    // built synchronously so MapContainer's rehydration (layer callbacks,
    // hidden toggles, loading badges) lands on real DOM before the viewer exists.
    if (options.chrome) {
      this.chrome = new CesiumMapChrome({
        container: this.container,
        getLayers: () => this.state.layers,
        getTimeRange: () => this.state.timeRange,
        onLayerToggled: (layer, enabled) => {
          this.setLayers({ ...this.state.layers, [layer]: enabled });
          this.onLayerChangeCb?.(layer, enabled, 'user');
        },
        onTimeRangeSelected: (range) => this.setTimeRange(range),
        zoomIn: () => this.setZoom(this.state.zoom + 1),
        zoomOut: () => this.setZoom(this.state.zoom - 1),
        resetView: () => this.setView('global'),
      });
    }
  }

  private wantsKeylessTerrain(): boolean {
    return !!this.options.enableKeylessBasemap && this.options.enableKeylessTerrain !== false;
  }

  private createCreditDock(): HTMLElement | null {
    if (!this.options.chrome || typeof document === 'undefined') return null;
    const dock = document.createElement('div');
    dock.className = 'cesium-credit-dock';
    this.container.appendChild(dock);
    return dock;
  }

  public whenReady(): Promise<void> {
    this.initPromise ??= Promise.resolve().then(() => this.initialize());
    return this.initPromise;
  }

  private async initialize(): Promise<void> {
    if (this.destroyed) return;
    try {
      // No Cesium ion asset is ever requested (keyless Esri imagery, Re:Earth
      // terrain), so the default ion logo would misattribute the imagery. The
      // provider credits are registered explicitly by the basemap and terrain
      // activators below.
      if (this.cesium.CreditDisplay) this.cesium.CreditDisplay.cesiumCredit = undefined;
      const creditDock = this.createCreditDock();
      const createViewer = this.options.createViewer ?? ((element, cesium) => new cesium.Viewer(element, {
        animation: false,
        // Credits sit bottom-right, where the 2D basemap attribution lives, so
        // they do not collide with the layer picker at bottom-left.
        ...(creditDock ? { creditContainer: creditDock, creditViewport: element } : {}),
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
      this.ensureStaticLayers();
      this.flushAll();
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
    this.renderCountryBorders();
    this.renderConflictZones();
  }

  /**
   * Every country ring as a quiet ground-clamped polyline. The 2D pane gets
   * its borders from the vector basemap; Esri imagery carries none, so the 3D
   * pane showed outlines only around conflict-mapped countries (2026-09-11
   * default-layout review). Same canonical GeoJSON the 2D renderers use.
   */
  private renderCountryBorders(): void {
    const viewer = this.viewer;
    if (!viewer || this.destroyed) return;
    this.removeEntitiesWithPrefix(BORDER_ENTITY_PREFIX);
    const material = this.cesium.Color.fromCssColorString(COUNTRY_BORDER_CSS);
    (this.countriesGeoData?.features ?? []).forEach((feature, featureIndex) => {
      if (!feature.geometry) return;
      polygonRingSets(feature.geometry).forEach((rings, polygonIndex) => {
        rings.forEach((ring, ringIndex) => {
          if (ring.length < 2) return;
          const id = `${BORDER_ENTITY_PREFIX}${featureIndex}:${polygonIndex}:${ringIndex}`;
          viewer.entities.add({ id, polyline: { positions: this.ringToPositions(ring), width: 1, material, clampToGround: true } });
          this.entityIds.add(id);
        });
      });
    });
    viewer.scene.requestRender?.();
  }

  /** Ids of the country border polylines currently on the globe (diagnostics and tests). */
  public getBorderEntityIds(): string[] {
    return [...this.entityIds].filter((id) => id.startsWith(BORDER_ENTITY_PREFIX));
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

  private addGroundPolygon(id: string, rings: Ring[], fillCss: string, strokeCss: string | null, extra: Record<string, unknown> = {}): void {
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
    if (!strokeCss) return;
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
              horizontalOrigin: this.cesium.HorizontalOrigin.CENTER,
              pixelOffset: new this.cesium.Cartesian2(0, -6),
              heightReference: this.cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              // The 2D renderers surface this text only on hover/popup. Drawing
              // every regional label at world scale stacked six sentences over
              // the Levant (2026-09-11 review), so the label appears only once
              // the camera is within regional range of the zone.
              distanceDisplayCondition: new this.cesium.DistanceDisplayCondition(0, CONFLICT_LABEL_MAX_DISTANCE_M),
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
      this.scheduleMarkerReselect();
    });
  }

  /**
   * Re-run the nearest-first marker budget once the camera settles, so a
   * capped layer follows the view instead of keeping the markers nearest the
   * previous centre (GlobeMap.reselectMarkersForViewport, #5368). Only when
   * something is withheld: an untruncated selection is view-independent.
   */
  private scheduleMarkerReselect(): void {
    if (Object.keys(this.markerTruncation).length === 0) return;
    if (this.reselectTimer) clearTimeout(this.reselectTimer);
    this.reselectTimer = setTimeout(() => {
      this.reselectTimer = null;
      if (!this.destroyed) this.flushMarkers();
    }, 400);
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
    // Border polylines are decoration: a click on one is a bare globe click.
    if (pickedId && !pickedId.startsWith(BORDER_ENTITY_PREFIX)) {
      this.hideTooltip();
      const zone = this.conflictZoneForEntityId(pickedId);
      if (zone) { this.showConflictPopup(zone, position); return; }
      const marker = this.markerByEntityId.get(pickedId);
      if (marker) { this.handleMarkerClick(marker, position); return; }
      // Paths/polygons and other entities are not country clicks.
      return;
    }
    this.hideTooltip();
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
  public setTimeRange(range: TimeRange): void {
    this.state = { ...this.state, timeRange: range };
    this.chrome?.syncTimeRange(range);
    this.onTimeRange?.(range);
  }
  public getTimeRange(): TimeRange { return this.state.timeRange; }
  public setLayers(layers: MapLayers): void {
    const previous = this.state.layers;
    this.state = { ...this.state, layers: { ...layers } };
    this.chrome?.syncLayers(this.state.layers);
    const changed = (Object.keys({ ...previous, ...layers }) as (keyof MapLayers)[]).filter((k) => (previous[k] === true) !== (layers[k] === true));
    if (changed.length === 0) return;
    if (changed.includes('conflicts')) this.renderConflictZones();
    this.ensureStaticLayers();
    this.flushAll();
  }

  public enableLayer(layer: keyof MapLayers): void {
    if (this.state.layers[layer] === true) return;
    this.setLayers({ ...this.state.layers, [layer]: true });
  }

  public onStateChanged(callback: (state: MapContainerState) => void): void { this.onState = callback; }
  public onTimeRangeChanged(callback: (range: TimeRange) => void): void { this.onTimeRange = callback; }
  public setOnLayerChange(callback: (layer: keyof MapLayers, enabled: boolean, source: 'user' | 'programmatic') => void): void { this.onLayerChangeCb = callback; }
  public hideLayerToggle(layer: keyof MapLayers): void { this.chrome?.hideLayerToggle(layer); }
  public setOnMapContextMenu(callback: (payload: { lat: number; lon: number; screenX: number; screenY: number; countryCode?: string; countryName?: string }) => void): void { this.onContextMenu = callback; }
  public setOnHotspotClick(callback: (hotspot: Hotspot) => void): void { this.onHotspotClick = callback; }
  public onHotspotClicked(callback: (hotspot: Hotspot) => void): void { this.onHotspotClick = callback; }
  public setOnAircraftPositionsUpdate(_callback: (positions: never[]) => void): void { /* Civil aircraft streaming is not part of the globe renderers. */ }

  // ─── Marker / path / polygon pipeline ─────────────────────────────────────

  private setGroup(group: string, layer: MarkerGroupRecord['layer'], markers: CesiumMarker[], exempt = false): void {
    this.markerGroups.set(group, { layer, markers, exempt });
    this.flushMarkers();
  }

  private setPaths(group: string, layer: keyof MapLayers, paths: CesiumPath[]): void {
    this.pathGroups.set(group, { layer, paths });
    this.flushPaths();
  }

  /** Bundled datasets that GlobeMap loads on demand when a layer is enabled. */
  private ensureStaticLayers(): void {
    const staticMarkerLayers: (keyof MapLayers)[] = ['nuclear', 'irradiators', 'spaceports', 'economic', 'datacenters', 'waterways', 'minerals'];
    for (const layer of staticMarkerLayers) {
      if (this.state.layers[layer] === true && !this.markerGroups.has(`static:${layer}`)) this.markerGroups.set(`static:${layer}`, { layer, markers: buildStaticMarkers(layer) });
    }
    if (this.state.layers.conflicts === true && !this.markerGroups.has('conflictZones')) this.markerGroups.set('conflictZones', { layer: 'conflicts', markers: buildConflictZoneMarkers() });
    // The dashboard never calls setHotspots; every renderer seeds the bundled
    // intel hotspots itself (GlobeMap does the same in its constructor).
    if (this.state.layers.hotspots === true && !this.markerGroups.has('hotspots')) this.markerGroups.set('hotspots', { layer: 'hotspots', markers: buildHotspotMarkers(INTEL_HOTSPOTS) });
    if (this.state.layers.bases === true && !this.markerGroups.has('bases')) {
      const cached = getCachedMilitaryBases();
      this.markerGroups.set('bases', { layer: 'bases', markers: buildMilitaryBaseMarkers(cached) });
      if (cached.length === 0 && !this.basesLoadPending) {
        this.basesLoadPending = true;
        void preloadMilitaryBases().then((bases: MilitaryBase[]) => {
          this.basesLoadPending = false;
          if (this.destroyed) return;
          this.setGroup('bases', 'bases', buildMilitaryBaseMarkers(bases));
        }).catch((error) => { this.basesLoadPending = false; console.warn('[CesiumMapAdapter] Military base config unavailable:', error); });
      }
    }
    if ((this.state.layers.cables === true || this.state.layers.pipelines === true) && !this.pathGroups.has('cables')) {
      const { cables, pipelines } = buildStaticPaths(this.cableFaultIds, this.cableDegradedIds);
      this.pathGroups.set('cables', { layer: 'cables', paths: cables });
      this.pathGroups.set('pipelines', { layer: 'pipelines', paths: pipelines });
    }
    if (this.state.layers.tradeRoutes === true && !this.pathGroups.has('tradeRoutes')) this.pathGroups.set('tradeRoutes', { layer: 'tradeRoutes', paths: buildTradeRouteArcs() });
  }

  private flushAll(): void {
    this.flushMarkers();
    this.flushPaths();
    this.flushPolygons();
  }

  private layerEnabled(layer: MarkerGroupRecord['layer'] | 'scenario'): boolean {
    if (layer === 'news' || layer === 'flash' || layer === 'scenario') return true;
    return this.state.layers[layer] === true;
  }

  private cssColor(css: string): unknown { return this.cesium.Color.fromCssColorString(css); }

  private markerEntity(entityId: string, m: CesiumMarker): Record<string, unknown> {
    const clamped = m.heightM === undefined;
    const base: Record<string, unknown> = {
      id: entityId,
      position: this.cesium.Cartesian3.fromDegrees(m.lon, m.lat, m.heightM ?? 0),
      properties: { kind: m.kind, layer: true },
    };
    if (m.style.glyph) {
      // A numeric glyph is a count badge (vessel and webcam clusters). GlobeMap
      // draws it inside a tinted ring; without the ring the digits float bare
      // on the imagery (the stray red "21" in the 2026-09-11 review).
      if (/^\d+$/.test(m.style.glyph)) {
        base.point = {
          pixelSize: Math.round(m.style.size * 1.8),
          color: this.cssColor(withAlpha(m.style.color, 0.18)),
          outlineColor: this.cssColor(withAlpha(m.style.color, 0.8)),
          outlineWidth: 2,
          heightReference: clamped ? this.cesium.HeightReference.CLAMP_TO_GROUND : this.cesium.HeightReference.NONE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        };
      }
      base.label = {
        text: m.style.glyph,
        font: `${m.style.size}px sans-serif`,
        fillColor: this.cssColor(m.style.color),
        outlineColor: this.cssColor('rgba(0,0,0,0.85)'),
        outlineWidth: 2,
        style: this.cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: this.cesium.VerticalOrigin.CENTER,
        horizontalOrigin: this.cesium.HorizontalOrigin.CENTER,
        heightReference: clamped ? this.cesium.HeightReference.CLAMP_TO_GROUND : this.cesium.HeightReference.NONE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      };
    } else {
      const fill = m.style.fillAlpha === undefined ? m.style.color : m.style.color.startsWith('#') && m.style.color.length === 7
        ? `${m.style.color}${Math.round(m.style.fillAlpha * 255).toString(16).padStart(2, '0')}`
        : m.style.color;
      base.point = {
        pixelSize: m.style.size,
        color: this.cssColor(fill),
        outlineColor: this.cssColor(m.style.outline ?? 'rgba(255,255,255,0.6)'),
        outlineWidth: m.style.outline ? 2 : 1,
        heightReference: clamped ? this.cesium.HeightReference.CLAMP_TO_GROUND : this.cesium.HeightReference.NONE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      };
    }
    return base;
  }

  private flushMarkers(): void {
    if (!this.viewer || this.destroyed) return;
    this.removeEntitiesWithPrefix('m:');
    this.markerByEntityId.clear();
    for (const key of [...this.entityCountByLayer.keys()]) if (!key.startsWith('poly') && !key.startsWith('path')) this.entityCountByLayer.delete(key);
    const groups: GlobeMarkerGroup<CesiumMarker & { _group: string }>[] = [];
    for (const [group, record] of this.markerGroups) {
      if (!record.markers.length || !this.layerEnabled(record.layer)) continue;
      const markers = record.markers.map((m) => ({ ...m, _group: group }));
      groups.push({ layer: record.layer, markers, exempt: record.exempt, rank: markers.some((m) => m.rank !== undefined) ? (m) => m.rank ?? 0 : undefined });
    }
    // Same budget and nearest-first tie-break as GlobeMap, so truncation is
    // disclosed identically and a capped static layer keeps what the camera sees.
    const nearestFirst = proximityRank<CesiumMarker>({ lat: this.state.pan.y, lng: this.state.pan.x }, (m) => ({ lat: m.lat, lng: m.lon }));
    for (const group of groups) { if (group.exempt) continue; if (group.rank) group.tieBreak = nearestFirst; else group.rank = nearestFirst; }
    const budget = isMobileDevice() ? GLOBE_MARKER_BUDGET_MOBILE : GLOBE_MARKER_BUDGET_DESKTOP;
    const { markers, truncated } = selectGlobeMarkers(groups, budget);
    for (const m of markers) {
      const entityId = `m:${m._group}:${m.id}`;
      if (this.entityIds.has(entityId)) continue;
      this.viewer.entities.add(this.markerEntity(entityId, m));
      this.entityIds.add(entityId);
      this.markerByEntityId.set(entityId, m);
      const layerKey = this.markerGroups.get(m._group)?.layer ?? m._group;
      this.entityCountByLayer.set(layerKey, (this.entityCountByLayer.get(layerKey) ?? 0) + 1);
    }
    this.markerTruncation = truncated;
    this.renderedMarkerCount = markers.length;
    this.chrome?.renderTruncation(truncated);
    this.viewer.scene.requestRender?.();
  }

  private flushPaths(): void {
    if (!this.viewer || this.destroyed) return;
    this.removeEntitiesWithPrefix('p:');
    for (const key of [...this.entityCountByLayer.keys()]) if (key.startsWith('path:')) this.entityCountByLayer.delete(key);
    for (const [group, record] of this.pathGroups) {
      if (!this.layerEnabled(record.layer)) continue;
      for (const path of record.paths) {
        const flat: number[] = [];
        const heights: number[] = [];
        for (const p of path.points) { if (typeof p[0] === 'number' && typeof p[1] === 'number') { flat.push(p[0], p[1]); heights.push((p[2] ?? 0) * 1000); } }
        if (flat.length < 4) continue;
        const positions = path.clampToGround
          ? this.cesium.Cartesian3.fromDegreesArray(flat)
          : flat.reduce<unknown[]>((acc, _v, i) => { if (i % 2 === 0) acc.push(this.cesium.Cartesian3.fromDegrees(flat[i]!, flat[i + 1]!, heights[i / 2])); return acc; }, []);
        const entityId = `p:${group}:${path.id}`;
        this.viewer.entities.add({ id: entityId, name: path.name, polyline: { positions, width: path.width, material: this.cssColor(path.color), clampToGround: path.clampToGround } });
        this.entityIds.add(entityId);
        this.entityCountByLayer.set(`path:${record.layer}`, (this.entityCountByLayer.get(`path:${record.layer}`) ?? 0) + 1);
      }
    }
    this.viewer.scene.requestRender?.();
  }

  private flushPolygons(): void {
    if (!this.viewer || this.destroyed) return;
    this.removeEntitiesWithPrefix('poly:');
    for (const key of [...this.entityCountByLayer.keys()]) if (key.startsWith('poly:')) this.entityCountByLayer.delete(key);
    // Derived polygon groups from country geometry.
    if (this.countriesGeoData) {
      const cii: CesiumPolygon[] = [];
      const scenario: CesiumPolygon[] = [];
      const affected = new Set(this.scenarioIso2s);
      for (const feature of this.countriesGeoData.features) {
        const code = feature.properties?.['ISO3166-1-Alpha-2'];
        if (typeof code !== 'string' || !feature.geometry) continue;
        const score = this.ciiScores.get(code);
        const ringSets = polygonRingSets(feature.geometry);
        if (score) ringSets.forEach((rings, i) => cii.push({ id: `${code}:${i}`, rings, fill: CII_COLORS[score.level] ?? 'rgba(0,0,0,0)', stroke: 'rgba(80,80,80,0.3)', label: `${code} CII ${score.score}/100 (${score.level})` }));
        if (affected.has(code)) ringSets.forEach((rings, i) => scenario.push({ id: `${code}:${i}`, rings, fill: 'rgba(220,60,40,0.3)', stroke: null, label: code }));
      }
      this.polygonGroups.set('cii', { layer: 'ciiChoropleth', polygons: cii });
      this.polygonGroups.set('scenario', { layer: 'scenario', polygons: scenario });
    }
    for (const [group, record] of this.polygonGroups) {
      if (!this.layerEnabled(record.layer)) continue;
      for (const poly of record.polygons) {
        const id = `poly:${group}:${poly.id}`;
        this.addGroundPolygon(id, poly.rings, poly.fill, poly.stroke, { name: poly.label });
        this.entityCountByLayer.set(`poly:${record.layer}`, (this.entityCountByLayer.get(`poly:${record.layer}`) ?? 0) + 1);
      }
    }
    this.viewer.scene.requestRender?.();
  }

  private handleMarkerClick(m: CesiumMarker, position: { x: number; y: number }): void {
    if (m.hotspot) this.onHotspotClick?.(m.hotspot);
    if (m.zoomOnClick) { this.applyCenter(m.lat, m.lon, Math.min(MAX_ZOOM, this.state.zoom + 1.3)); return; }
    if (m.popup && this.popup) {
      const at = this.screenPositionFor(m.lon, m.lat, position);
      this.popup.show({ type: m.popup.type, data: m.popup.data, x: at.x, y: at.y });
      if (m.popup.type === 'conflict') this.popup.loadConflictHistory?.(m.popup.data as ConflictZone);
      if (m.popup.type === 'militaryFlight') { const hex = (m.popup.data as { hexCode?: string }).hexCode; if (hex) this.popup.loadWingbitsLiveFlight?.(hex); }
      return;
    }
    this.showTooltip(m.title, position);
  }

  /** GlobeMap's marker tooltip: a compact text card at the click position. */
  private showTooltip(text: string, position: { x: number; y: number }): void {
    this.hideTooltip();
    if (!text) return;
    const el = document.createElement('div');
    el.className = 'cesium-marker-tooltip';
    el.setAttribute('role', 'tooltip');
    el.style.cssText = 'position:absolute;z-index:1000;max-width:280px;padding:6px 10px;border-radius:3px;background:rgba(10,12,16,0.95);border:1px solid rgba(60,120,60,0.6);color:#d4d4d4;font-family:var(--font-mono, monospace);font-size:11px;line-height:1.4;pointer-events:auto;';
    el.textContent = text;
    el.style.left = `${Math.max(0, position.x + 10)}px`;
    el.style.top = `${Math.max(0, position.y - 10)}px`;
    this.container.appendChild(el);
    this.tooltipEl = el;
  }

  private hideTooltip(): void {
    this.tooltipEl?.remove();
    this.tooltipEl = null;
  }

  // ─── Feed setters (MapContainer contract; names mirror GlobeMap) ──────────

  public setHotspots(items: Hotspot[]): void { this.setGroup('hotspots', 'hotspots', buildHotspotMarkers(items)); }
  public setMilitaryFlights(items: MilitaryFlight[]): void { this.setGroup('flights', 'military', buildMilitaryFlightMarkers(items)); }
  public setMilitaryVessels(vessels: MilitaryVessel[], clusters: MilitaryVesselCluster[] = []): void {
    this.markerGroups.set('vessels', { layer: 'military', markers: buildMilitaryVesselMarkers(vessels) });
    this.setGroup('vesselClusters', 'military', buildVesselClusterMarkers(clusters));
  }
  public setWeatherAlerts(items: WeatherAlert[]): void { this.setGroup('weather', 'weather', buildWeatherMarkers(items)); }
  public setNaturalEvents(items: NaturalEvent[]): void {
    const { paths, cones } = buildStormPathsAndCones(items);
    this.pathGroups.set('storms', { layer: 'natural', paths });
    this.polygonGroups.set('cones', { layer: 'natural', polygons: cones });
    this.setGroup('natural', 'natural', buildNaturalMarkers(items));
    this.flushPaths();
    this.flushPolygons();
  }
  public setEarthquakes(items: Earthquake[]): void { this.setGroup('earthquakes', 'natural', buildEarthquakeMarkers(items)); }
  public setRadiationObservations(items: RadiationObservation[]): void { this.setGroup('radiation', 'radiationWatch', buildRadiationMarkers(items)); }
  public setImageryScenes(scenes: ImageryScene[]): void {
    const { markers, footprints } = buildImagerySceneMarkers(scenes);
    this.polygonGroups.set('imagery', { layer: 'satellites', polygons: footprints });
    this.setGroup('imagery', 'satellites', markers);
    this.flushPolygons();
  }
  public setOutages(items: InternetOutage[]): void { this.setGroup('outages', 'outages', buildOutageMarkers(items)); }
  public setTrafficAnomalies(items: ProtoTrafficAnomaly[]): void { this.setGroup('trafficAnomalies', 'outages', buildTrafficAnomalyMarkers(items)); }
  public setDdosLocations(items: DdosLocationHit[]): void { this.setGroup('ddos', 'outages', buildDdosMarkers(items)); }
  public setAisData(disruptions: AisDisruptionEvent[], _density: AisDensityZone[]): void { this.setGroup('ais', 'ais', buildAisDisruptionMarkers(disruptions)); }
  public setCableActivity(advisories: CableAdvisory[], repairShips: RepairShip[]): void {
    const built = buildCableActivityMarkers(advisories, repairShips);
    this.cableFaultIds = built.faultIds;
    this.cableDegradedIds = built.degradedIds;
    this.markerGroups.set('cableAdvisories', { layer: 'cables', markers: built.advisories });
    this.setGroup('repairShips', 'cables', built.ships);
    if (this.pathGroups.has('cables')) { const { cables } = buildStaticPaths(this.cableFaultIds, this.cableDegradedIds); this.setPaths('cables', 'cables', cables); }
  }
  public setCableHealth(_m: unknown): void { /* GlobeMap ignores this too; fault/degraded state comes from advisories. */ }
  public setProtests(items: SocialUnrestEvent[]): void { this.setGroup('protests', 'protests', buildProtestMarkers(items)); }
  public setFlightDelays(items: AirportDelayAlert[]): void {
    const { delays, notams } = buildFlightDelayMarkers(items);
    this.markerGroups.set('flightDelays', { layer: 'flights', markers: delays });
    this.setGroup('notams', 'flights', notams);
  }
  public setNewsLocations(items: Array<{ lat: number; lon: number; title: string; threatLevel: string; timestamp?: Date }>): void { this.setGroup('news', 'news', buildNewsLocationMarkers(items), true); }
  public setCyberThreats(items: CyberThreat[]): void { this.setGroup('cyber', 'cyberThreats', buildCyberMarkers(items)); }
  public setIranEvents(items: IranEvent[]): void { this.setGroup('iran', 'iranAttacks', buildIranEventMarkers(items)); }
  public setFires(items: Array<{ lat: number; lon: number; brightness: number; region: string; [key: string]: unknown }>): void { this.setGroup('fires', 'fires', buildFireMarkers(items)); }
  public setWebcams(items: Array<WebcamEntry | WebcamCluster>): void { this.setGroup('webcams', 'webcams', buildWebcamMarkers(items)); }
  public setUcdpEvents(items: UcdpGeoEvent[]): void { this.setGroup('ucdp', 'ucdpEvents', buildUcdpMarkers(items)); }
  public setDisplacementFlows(items: DisplacementFlow[]): void { this.setGroup('displacement', 'displacement', buildDisplacementMarkers(items)); }
  public setClimateAnomalies(items: ClimateAnomaly[]): void { this.setGroup('climate', 'climate', buildClimateMarkers(items)); }
  public setGpsJamming(items: GpsJamHex[]): void { this.setGroup('gpsJamming', 'gpsJamming', buildGpsJamMarkers(items)); }
  public setSatellites(positions: SatellitePosition[]): void {
    const { markers, orbits } = buildSatelliteMarkers(positions);
    this.pathGroups.set('orbits', { layer: 'satellites', paths: orbits });
    this.setGroup('satellites', 'satellites', markers);
    this.flushPaths();
  }
  public setTechEvents(items: Array<{ id: string; title: string; lat: number; lng: number; country: string; daysUntil: number; [key: string]: unknown }>): void { this.setGroup('tech', 'techEvents', buildTechEventMarkers(items)); }
  public setCIIScores(scores: Array<{ code: string; score: number; level: string }>): void {
    this.ciiScores = new Map(scores.map((s) => [s.code, { score: s.score, level: s.level }]));
    this.flushPolygons();
  }
  public setScenarioState(state: ScenarioVisualState | null): void {
    this.scenarioIso2s = state?.affectedIso2s ?? [];
    this.flushPolygons();
  }
  public setChokepointData(data: GetChokepointStatusResponse | null): void { this.popup?.setChokepointData?.(data); }
  public openChokepoint(id: string): void {
    const waterway = STRATEGIC_WATERWAYS.find((w) => w.id === id || w.chokepointId === id);
    if (!waterway) return;
    this.applyCenter(waterway.lat, waterway.lon, 5);
    this.popup?.show({ type: 'waterway', data: waterway, x: this.container.clientWidth / 2, y: this.container.clientHeight / 2 });
  }
  public setRenderPaused(paused: boolean): void {
    this.renderPaused = paused;
    if (this.viewer && 'useDefaultRenderLoop' in this.viewer) (this.viewer as { useDefaultRenderLoop?: boolean }).useDefaultRenderLoop = !paused;
  }
  public setLayerLoading(layer: keyof MapLayers, loading: boolean): void { this.chrome?.setLayerLoading(layer, loading); }
  public setLayerReady(layer: keyof MapLayers, hasData: boolean): void { this.chrome?.setLayerReady(layer, hasData); }

  /** Marker budget outcome, for diagnostics parity with GlobeMap. */
  public getMarkerLoad(): { rendered: number; truncated: Record<string, unknown>; paused: boolean } {
    return { rendered: this.renderedMarkerCount, truncated: this.markerTruncation, paused: this.renderPaused };
  }

  public getLayerStatus(layer: keyof MapLayers): 'rendered' | 'unsupported' {
    if (!(CESIUM_SPIKE_LIMITATIONS.renderedLayers as readonly string[]).includes(layer)) return 'unsupported';
    if (!this.viewer || this.state.layers[layer] !== true) return 'unsupported';
    if (layer === 'conflicts' && this.getConflictEntityIds().length > 0) return 'rendered';
    const count = (this.entityCountByLayer.get(layer) ?? 0) + (this.entityCountByLayer.get(`path:${layer}`) ?? 0) + (this.entityCountByLayer.get(`poly:${layer}`) ?? 0);
    return count > 0 ? 'rendered' : 'unsupported';
  }

  public flashLocation(lat: number, lon: number, durationMs = 1500): void {
    this.setGroup('flash', 'flash', [{ id: 'active', kind: 'flash', lat, lon, title: '', style: { color: '#00e5ff', size: 12, outline: '#00e5ff', fillAlpha: 0.35 } }], true);
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => { if (!this.destroyed) this.setGroup('flash', 'flash', [], true); }, durationMs);
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.flashTimer) clearTimeout(this.flashTimer);
    if (this.reselectTimer) clearTimeout(this.reselectTimer);
    this.chrome?.destroy();
    this.chrome = null;
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
    this.markerByEntityId.clear();
    this.entityCountByLayer.clear();
    this.hideTooltip();
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
