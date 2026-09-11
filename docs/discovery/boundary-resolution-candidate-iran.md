# Boundary-resolution candidate: Iran (proposal only)

**Status: NOT PRODUCTION.** Parent must review the dataset and browser rendering before applying anything. This discovery changes no app source, ISO mapping, or disputed-territory convention.

## Finding

`public/data/countries.geojson` was first added in WorldMonitor commit [`1292f0595f48ae4c10775a9b912ddeb0b1f809ee`](https://github.com/koala73/worldmonitor/commit/1292f0595f48ae4c10775a9b912ddeb0b1f809ee), on 2026-01-27. The file has no embedded source, version, or license metadata. Its checked-in SHA-256 is `195417e48173736983685bd1bfce91c6a8a28a63a7fea6ffa036191f354617b1` and it contains 258 features. The repository history and file content establish the first WorldMonitor commit, but **do not establish a precise upstream dataset/version**. The Iran feature is a single Polygon with 57 points; its coordinates do not exactly match the pinned Natural Earth 110m Iran feature (0 exact point matches), so it must not be represented as a verified Natural Earth 110m copy.

The existing mechanism is an optional per-feature replacement in `src/services/country-geometry.ts`: the base file is loaded first, then features from `https://maps.worldmonitor.app/country-boundary-overrides.geojson` are matched by ISO-2 and replace both rendered and indexed geometry. Existing repository documentation and `scripts/fetch-country-boundary-overrides.mjs` identify the intended source family as Natural Earth Admin 0 Countries 50m. The live override is Pakistan-only in the parent investigation; this candidate does not rely on that service.

## Candidate fixture

`boundary-resolution-candidate-iran.geojson` contains only Natural Earth `ISO_A2=IR` / `ISO_A3=IRN`, preserving the existing country identity. It is a 50m Admin 0 feature from the pinned Natural Earth commit below, not a production runtime file and not an instruction to change political conventions.

- Pinned source commit: `ca96624a56bd078437bca8184e78163e5039ad19`
- Exact source URL: `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/ca96624a56bd078437bca8184e78163e5039ad19/geojson/ne_50m_admin_0_countries.geojson`
- Repository: `https://github.com/nvkelso/natural-earth-vector`
- License/provenance: Natural Earth public domain; [license](https://github.com/nvkelso/natural-earth-vector/blob/master/LICENSE.md)
- Download SHA-256: `3e458fc036ad0a66411f2c1e6cac49c5d7bfb81cb1123bc513b22511a2b7fdeb`
- Candidate SHA-256: `7190c49562a0ad022893bf2f3cbf34f4dc7c15481f829efaf9dd5615da22f030`

## Counts and geographic checks

| Geometry | Base checked-in Iran | NE 110m comparison | Candidate NE 50m | NE 10m comparison |
|---|---:|---:|---:|---:|
| Geometry type | Polygon | Polygon | MultiPolygon | MultiPolygon |
| Polygons | 1 | 1 | 2 | 12 |
| Rings | 1 | 1 | 2 | 12 |
| Points | 57 | 76 | 605 | 2,728 |
| Bounding box `[minLon,minLat,maxLon,maxLat]` | `[44.061372,25.202094,62.753564,39.685279]` | `[44.109225,25.078237,63.316632,39.713003]` | `[44.023242,25.1021,63.305176,39.768555]` | `[44.014863,25.059408,63.319628,39.771527]` |

The candidate passes reproducible checks for `IR`, `IRN`, and `Iran`; all two rings are closed; its longitude bounds are within `(43,64)` and latitude bounds within `(24,41)`; the pinned source has 242 features and the base has 258. The candidate adds no country feature and does not encode any political remapping.

## Reproduction

From the checkout root:

```sh
node docs/discovery/boundary-resolution-candidate-iran.mjs
```

The script fetches only the pinned research source, writes the local fixture, and writes `boundary-resolution-candidate-iran.provenance.json`. It does not edit `src/`, upload anything, or make runtime requests to WorldMonitor. The existing runtime override fetch remains unchanged; parent review is required before any production integration.
