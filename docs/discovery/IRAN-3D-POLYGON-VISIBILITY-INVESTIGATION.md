# Iran 3D polygon visibility investigation

Status: isolated; test-only evidence. No production source or dataset was changed by this investigation.

## Reproduction and signal

`iran-globe-polygon-visibility.mjs` loads `border-isolated.html` through the already-running local Vite server. The page loads the same checked-in `IR` feature from `/data/countries.geojson`, uses the same globe.gl polygon API, and fixes the camera at Iran. The diagnostic renders an empty globe, then the loaded polygon in three variants. It computes pixel deltas against the identical empty frame; a visible polygon must differ by more than 2,000 pixels.

Run:

```sh
GEV_URL=http://127.0.0.1:4187 node docs/discovery/iran-globe-polygon-visibility.mjs
```

Output: `docs/discovery/iran-globe-polygon-visibility.out/report.json` and four PNG frames.

## Pinned browser regression proof

`e2e/iran-globe-polygon-winding.spec.ts` promotes the isolated diagnostic to a deterministic Playwright regression test. It fixes the viewport at 1200×900 and uses the checked-in `IR` feature from `/data/countries.geojson` at the Iran-centred camera supplied by `border-isolated.html`. For each run it renders an empty globe, the normalized polygon, and the old unconditional-reversal control, then decodes the screenshots and compares pixels above an RGB delta of 24.

Run:

```sh
npx playwright test e2e/iran-globe-polygon-winding.spec.ts --project=chromium
```

The test asserts all of the following without a machine-specific golden image:

- normalized geometry changes more than 2,000 pixels but stays inside a 600×550 local bounding box;
- the old unconditional reversal also changes more than 2,000 pixels but spans more than 1,000×700 pixels, demonstrating the visible complement;
- the test uses the actual `globe.gl` polygon API and the same normalization utility as `GlobeMap`.

The standalone script remains useful for writing PNG/JSON diagnostics, but the Playwright spec is the retained regression gate.

## Deterministic result

The test ran on 2026-09-11 against `http://127.0.0.1:4187` with the 57-point, one-ring `IR` polygon whose coordinate bounds are `[44.061372, 25.202094, 62.753564, 39.685279]`.

| Variant | Pixels different from empty globe | Delta bounds | Result |
|---|---:|---|---|
| Existing candidate normalization, altitude 0.006 | 76,472 | `x=434,y=262,w=373,h=343` | visible Iran-sized overlay |
| Exact reversal used by the base path | 113,711 | `x=0,y=82,w=1200,h=818` | complementary/globe-wide mesh fragments |
| Existing candidate normalization, surface altitude 0 | 71,280 | `x=436,y=264,w=369,h=339` | visible; height is not required for visibility |

The normalized frame has a visible magenta/cyan diagnostic overlay south of the Caspian Sea and north/east of the Persian Gulf — the expected Iran location. The reversed frame produces broad fragmented coverage across the visible globe, not an Iran polygon.

## Root cause

The base `GlobeMap.getReversedRing()` unconditionally reversed every ring before sending it to globe.gl. For the loaded Iran exterior, that inverts d3/globe.gl's spherical small-area interpretation: the renderer treats the complement as the filled region. In normal low-alpha conflict styling, the intended local country outline can therefore appear absent, clipped, or misleadingly displaced even though the country GeoJSON has loaded correctly.

This is a renderer-input winding fault, not a latitude/longitude swap, failed geometry load, image-texture registration issue, altitude issue, or dataset-resolution issue.

## Minimal corrective path

Keep the existing candidate test-only until reviewed. The smallest corrective change is only the winding normalization at the existing globe-renderer seam:

1. Replace the unconditional `ring.map((r) => [...r].reverse())` in `GlobeMap.getReversedRing()` with `normalizeGlobePolygonRings(ring)`.
2. Preserve source GeoJSON immutability and normalize exterior/hole winding according to d3's spherical small-area convention.
3. Do not replace `countries.geojson`, translate coordinates, change altitude to compensate, or alter country-boundary policy.

The present uncommitted candidate already expresses this path through `src/utils/globe-polygon-winding.ts` and the single call-site replacement in `GlobeMap.ts`; it was not altered here.

## Required regression proof before any integration

1. Retain the unit regression `tests/globe-polygon-winding.test.mts`: Iran must contain `[53,32]`, exclude `[-127,-32]`, preserve small-area regional rings, and retain hole winding.
2. Promote the deterministic renderer diagnostic to a CI-safe browser test or keep an equivalent isolated page. It must render an empty frame and the normalized Iran frame at a pinned camera and assert:
   - normalized pixels differ from empty by more than 2,000;
   - changed-pixel bounds are local, not full-canvas;
   - the explicitly reversed control has either full-canvas/complement behavior or is rejected by a geometry-area assertion.
3. Add a real GlobeMap integration assertion that the conflicts layer waits for `countriesGeoData` and publishes an `IR` country polygon after the data load. This is separate from winding and prevents confusing a missing data-load event with a renderer fault.
4. Capture a real 3D conflict-layer frame with Iran centered and verify that the color/outline follows the normalized local geometry. Do not use unrelated dashboard screenshots as this acceptance proof.

## Checks run

```text
node --check docs/discovery/iran-globe-polygon-visibility.mjs                 PASS
GEV_URL=http://127.0.0.1:4187 node docs/discovery/iran-globe-polygon-visibility.mjs  PASS
node --import tsx --test tests/globe-polygon-winding.test.mts                 PASS (3/3)
npx biome check docs/discovery/iran-globe-polygon-visibility.mjs             PASS
git diff --check                                                              PASS (existing line-ending warnings only)
```
