# Border/fill runtime reproduction

## Result

The red diagonal over western Pakistan is **not a Pakistan national-boundary highlight**. It is the intentional regional `pak_afghan` conflict-area polygon from `shared/geo-data.ts`, retained as an approximate conflict area rather than attributed to Pakistan's national geometry.

The relevant paths are:

1. `CONFLICT_ZONES` comes from `shared/geo-data.ts`.
2. `pak_afghan` is a regional polygon spanning the Pakistan–Afghanistan border area.
3. `resolveConflictZoneFeatures()` preserves that polygon and marks it `geometryKind: 'regional'`.
4. Whole-country zones such as `iran` use only matching local country GeoJSON. If that geometry is unavailable, the zone is omitted until the authoritative source loads; its configured outline is not used as a national fallback.
5. Regional overlays are rendered with the existing conflict treatment but an orange approximate-area fill/outline and an explicit `approximate conflict area` label.

Therefore the diagonal shape is a regional conflict-area overlay, not a Pakistan border claim. It must not be interpreted as evidence about the Pakistan national boundary or as a live conflict fact.

## Exact 3D comparison

`GlobeMap.flushPolygons()` uses the same local `/data/countries.geojson` country source when available. For `iran`, it selects ISO `IR`, expands `Polygon`/`MultiPolygon` rings, reverses every ring once through `getReversedRing()`, and sends those rings to globe.gl. The globe accessor is:

```ts
polygonGeoJsonGeometry(d => ({ type: 'Polygon', coordinates: d.coords }))
```

Conflict altitude is `0.006` for `high` intensity. CII altitude is `0.002`. The earth texture (`/textures/earth-topo-bathy.jpg`) is only the globe surface image; it does not provide polygon geometry or determine the fill. `GlobeMap.highlightCountry()` and `clearCountryHighlight()` are currently no-ops, so a country-focus action changes the view but does not add a separate highlight polygon.

## Diagnostic script

Run from the checkout root while the private server is listening on port 4187:

```bash
node docs/discovery/country-fill-runtime-geometry.mjs
```

Optional:

```bash
GEV_URL=http://127.0.0.1:4187/ CHROME_CHANNEL=chrome node docs/discovery/country-fill-runtime-geometry.mjs
```

The script:

- opens the live app in normal 2D mode;
- records actual visible mode buttons, layer controls, canvases, map DOM, renderer-like globals, console/page errors, and screenshots;
- activates the visible `conflicts` checkbox only if it is off;
- attempts Iran focus through a discovered visible search control rather than assuming a private method or global;
- fetches and records the actual runtime `IR` and `PK` feature types, bboxes, ring counts, and signed ring areas from `/data/countries.geojson`;
- attempts the visible 3D control and captures a separate 3D state/screenshot when the app accepts the switch;
- writes artifacts beside the script under `docs/discovery/country-fill-runtime-geometry.out/`.

The script uses the installed repository `playwright` package and defaults to the installed Chrome channel because the bundled Playwright browser is not installed in this checkout.

## Live run evidence

The script was run against `http://127.0.0.1:4187/` with Chrome headless. It completed and captured 2D screenshots/state plus a 3D-attempt artifact. Runtime country data reported:

| ISO | runtime type | bbox `[minLon,minLat,maxLon,maxLat]` | rings | first-ring signed area |
|---|---|---|---:|---:|
| IR | Polygon | `[44.061372,25.202094,62.753564,39.685279]` | 1 | `155.85450813948978` |
| PK | Polygon | `[60.844379,23.803453,77.048971,37.021669]` | 1 | `81.77727573831476` |

The live DOM confirmed the normal 2D renderer (`#mapContainer.deckgl-mode` with a MapLibre/deck canvas) and the conflicts control was already checked. The attempt to switch 3D did not leave the visible mode active in this run, so there is no claim that a globe frame was captured; the artifact records that fact for the parent to reproduce.

The console also showed an unrelated local-dev CORS failure for `https://maps.worldmonitor.app/country-boundary-overrides.geojson`, plus expected missing/503 upstream data warnings. That boundary-overrides failure is worth checking separately, but it does not by itself prove the country GeoJSON fallback was selected.

## Next decisive check

Use the script's screenshot and runtime artifact on the affected checkout. If the red shape matches the approximate `shared/geo-data.ts` Iran polygon while `/data/countries.geojson` is present, instrument only the diagnostic (or add a temporary parent-owned debug hook) to record whether `countriesGeoJsonData` was populated before `buildAllConflictZoneFeatures()`. If it was absent, the minimal fix is to defer/refresh the conflict layer after country geometry loads; do not change border coordinates or winding based on the screenshot alone.

No app source was changed by this investigation.
