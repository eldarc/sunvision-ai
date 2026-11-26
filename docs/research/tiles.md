# Building footprints from OpenFreeMap vector tiles (no Overpass)

**Status:** implemented in `web/src/lib/tiles.ts`, unit-tested in `web/src/lib/__tests__/tiles.test.ts`.
**Measured on:** 2026-11-25, OpenFreeMap planet build `20261122_124456_pt` (TileJSON `version` 3.16.0).

The map downloads OpenMapTiles vector tiles from OpenFreeMap. Those tiles contain every
OSM building polygon at z14 with a height attribute, plus the street network. Reading them from the
map (`map.querySourceFeatures`) avoids depending on the public Overpass API, which is often slow or
rate-limited. There are no extra requests, keys or servers, and the data and licence are the same (OSM, ODbL).

Everything below was measured on real tiles. The scripts were run with
`cd api && uv run --with mapbox-vector-tile --with shapely python …` on two z14 tiles around
Amsterdam Herengracht 256 (52.37163, 4.88646): `14/8414/5384`, which holds the building, and its east
neighbour `14/8415/5384`. One z13 tile, `13/4207/2692`, was also measured. The reference data is
the Overpass snapshot bundled with the curated example (`web/public/examples/amsterdam-herengracht/osm.json`).

## 1. Endpoints and CORS

| Resource | URL | Notes |
|---|---|---|
| Style | `https://tiles.openfreemap.org/styles/dark` | `access-control-allow-origin: *`, `cache-control: max-age=86400`. Vector source id **`openmaptiles`** → `url: https://tiles.openfreemap.org/planet` |
| TileJSON | `https://tiles.openfreemap.org/planet` | `tilejson 3.0.0`, `minzoom 0`, **`maxzoom 14`**, `tiles: https://tiles.openfreemap.org/planet/20261122_124456_pt/{z}/{x}/{y}.pbf`. The path is versioned per build, so always resolve it through the TileJSON. CORS `*`. |
| Tile | `…/planet/20261122_124456_pt/14/8414/5384.pbf` | `content-type: application/vnd.mapbox-vector-tile`, CORS `*`, `cache-control: max-age=315360000` (immutable). 914,742 bytes for this dense city-centre tile. |

TileJSON attribution (it must stay visible on the map): *OpenFreeMap © OpenMapTiles, Data from OpenStreetMap*.

## 2. The `building` layer

TileJSON `vector_layers` declares `building` for z13–14 with four fields. The dark style draws it
as a flat `fill` from z12.

| Field | Type | Observed in tile 14/8414/5384 (117 features) |
|---|---|---|
| `render_height` | Number (integer) | on 117/117 |
| `render_min_height` | Number (integer) | on 117/117; 88 are 0 |
| `colour` | String | on 47/117 (e.g. `#bd8161`, `white`) |
| `hide_3d` | Boolean | on 10/117, always `true` when present |

No other OSM tags are present: no `building=*` type, no `building:levels`, no name and no address.

### Features are groups of buildings, not buildings

The 117 features hold **7,470 polygons** (61 MultiPolygon features and 56 Polygon features; the
largest feature has 845 polygons). At z14, OpenFreeMap merges **all buildings in a tile that share
the same attributes** into one MultiPolygon. Herengracht 256 (`relation/3581114`, height 21.3)
is one of 119 polygons in feature `35811090` (`render_height` 22), together with, for example,
`relation/3581109` (height 21.7).

Feature ids are therefore **not stable building identities**:

* Every feature has an id, and ids are unique within a tile. Some ids look like *OSM id × 10 + digit*
  (`35811090` ↔ relation 3581109, `2666973090` ↔ way 266697309). The last digit is 0, 2 or 3,
  and we did not establish the encoding. The id names one member of the group only.
* Across the boundary between tiles 8414 and 8415, **86 of the 87** building pieces that cross it
  carry a different feature id in each tile.

So `tiles.ts` treats every polygon part as its own building. It never merges parts of the same
feature, and it builds its own id from the footprint centroid (`omt/<lat>,<lon>`, 6 decimals).
The feature ids it saw are kept in `tags['sunvision:tile_feature_ids']`.

### `hide_3d`

The 22 `hide_3d` polygons in the tile are almost entirely covered by other (non-hidden) building
polygons with varied heights. For 18 of the 22, 91–100 % of the area is covered. These are the
`building:part` pieces, and the hidden polygon is their outline, which matches the OpenMapTiles
schema. `tiles.ts` drops `hide_3d` outlines by default, so that a building is not counted twice,
and `includeHidden3d: true` keeps them. **Caveat:** for 4 of the 22 outlines, the parts cover only
53–85 %. Dropping those outlines leaves gaps.

## 3. `render_height`: how it is derived and what the default is

We matched 441 OSM building ways from the Overpass snapshot to tile polygons (IoU ≥ 0.8; 332 are
≥ 0.95) and compared the tags:

| OSM tags on the way | n | Rule that reproduces `render_height` |
|---|---|---|
| `height` | 384 | `ceil(height)`, 384/384 (18.3 → 19, 20.1 → 21, 14.3 → 15) |
| `building:levels` only | 9 | `ceil(levels × 3.66)`, 9/9 (2 → 8, 3 → 11, 4 → 15, 5 → 19, 6 → 22) |
| neither | 48 | **5**, 48/48 |

Hence `render_height = ceil(height ?? building:levels × 3.66 ?? 5)`. Plain rounding is ruled out:
it would give 18 for 18.3.

Consequences for sunvision-ai:

* `render_height == 5 && render_min_height == 0` is read as **"OSM has no height"**. `mapHeight`
  is left unset, and `tags['sunvision:height_source'] = 'openmaptiles:default'`. This is ambiguous
  for a real tagged height in (4, 5] m (one way in the sample, `height=4.6`, also became 5). Such
  sheds and kiosks are then treated as unknown height, which is the safe direction.
* Otherwise `mapHeight = render_height`, and `sunvision:height_source = 'openmaptiles:render_height'`.
  This value is rounded **up**. Against the 148 OSM heights in the Herengracht fixture, the tile
  value is +0.00 to +0.90 m higher (mean +0.51 m). A height derived from levels cannot be told apart
  from a tagged height.
* `render_min_height` > 0 is copied to `tags.min_height`, which `obstacles.ts` reads as the base
  of the prism. No `min_height` was tagged in this area, so its rounding (presumably `floor`) was
  not verified.

## 4. How polygons are split across tiles

* Extent 4096, **buffer 64 units** on each side: coordinates run from −64 to 4160. At z14 and 52.37° N,
  1 unit = 0.365 m, so the buffer is 23.3 m. Vertices are quantised to that grid. Neighbouring tiles
  share the same global grid, so an original vertex has identical coordinates in both tiles.
  Clip points on the buffer line are rounded to the grid and are slightly off the original edge.
* Of the 87 polygons in tile 8414 that cross its east edge, all 87 have a polygon with identical
  attributes in tile 8415. **74 are exact duplicates** (IoU > 0.99, the building fits in both buffers)
  and **13 are true splits**, clipped at a buffer line.
* `map.querySourceFeatures` (MapLibre 5.24.1; read in `dist/maplibre-gl-dev.js`) iterates
  `getRenderableIds()`, de-duplicates by **canonical** tile key and returns the **unclipped** tile
  geometry, buffer included. Each result has `feature.tile = {z, x, y}` (and `_x/_y/_z`).
  Renderable ids can include lower-zoom parent tiles retained during zoom transitions.

### Merge strategy used in `footprintsFromTileFeatures`

1. Each polygon part is clipped to **its own tile's exact bounds**, in lon/lat, with Sutherland–Hodgman.
   This drops the buffer duplicates. Afterwards the pieces of a building tile the plane and meet on the tile edge.
   Clipped pieces are dissolved (`unionRings(rings, [])`). This handles a courtyard hole cut by the
   edge and the zero-width bridges that clipping a concave ring can leave.
2. Two pieces are the same building when they come from **edge-adjacent tiles**, have **identical
   attributes** (`render_height`, `render_min_height`, `colour`, `hide_3d`), and **share at least
   0.2 m of boundary on the common tile edge**, with opposite orientation and a 0.3 m tolerance.
3. Without tile information (synthetic input, or GeoJSON sources), there are two fallback rules.
   (a) Identical attributes and an overlap area > max(0.5 m², 1 % of the smaller piece), from
   different features. (b) The **same feature id** and a shared edge ≥ 0.2 m.
4. Groups are unioned with an edge-overlay union. Vertices are first snapped (0.3 m) to absorb grid
   rounding. Opposite coincident edges cancel, and an edge is kept when the point just to its right
   is outside both polygons. Rings come out counter-clockwise (holes clockwise), open, with
   collinear and degenerate vertices removed. Rings under 1 m² are dropped.

Overlap alone is **not** a merge rule across tiles: distinct neighbours that OSM maps with a
slight overlap (1.37 m² in one case here) would be merged. Clipping removes that risk,
because pieces from different tiles can only touch.

### Validation on the real tiles

* **Herengracht 256, radius 150 m:** 308 footprints in 9 ms (Node 22). Compared with the 167 Overpass
  footprints within 120 m, 163 have IoU > 0.9 and 4 have 0.8–0.9 (median 0.959; the tile grid
  limits precision to ~0.37 m). Heights: 148 were taken from `render_height` and 19 detected as
  default, and all 19 have no height in OSM. The target building comes out with its inner
  ring (the OSM relation has one) and `mapHeight` 22. The 3DBAG height is 21.3.
* **Origin on the 8414 | 8415 tile edge, radius 250 m:** 1,017 footprints in 11 ms, 33 stitched from
  pieces. The 25 buildings crossing the edge match a shapely union of their pieces with **IoU ≥ 0.997**
  (median 1.0), and no output ring is invalid. The remaining overlapping output pairs are overlaps
  already present in OSM (145 with different attributes, 30 within a single tile feature).

## 5. Zoom requirement

* Full-detail buildings exist **only in z14 tiles**. In the z13 tile `13/4207/2692`, the building
  layer is **one feature with no attributes** and 708 merged blobs. The blob containing
  Herengracht 256 is ~17,000 m². z13 data is useless for footprints.
* MapLibre requests vector tiles at `floor(zoom + log2(transform.tileSize / source.tileSize))`
  (`coveringZoomLevel`). The default vector `tileSize` is 512, which gives z14 data from map zoom 14.
* `querySourceFeatures` sees **only loaded tiles**, which cover the current viewport, nothing more.
* `loadFootprintsFromMap` therefore requires **map zoom ≥ 15** (`MIN_QUERY_ZOOM`, which leaves a
  margin over the strict 14) and the whole radius on screen. Otherwise it returns
  `complete: false` with warnings, or it jumps the map there first when `ensureView: true` is passed.
  It waits for `idle` (up to 8 s) when tiles are still loading. It keeps only features from the
  highest tile zoom present, which discards retained z13 parents. A 150 m radius at 52° N needs a
  viewport of ≈ 300 m, which a phone screen covers at zoom 15–16.

## 6. The `transportation` layer (streets near a building)

Fields (TileJSON): `class, subclass, brunnel, oneway, ramp, service, access, toll, expressway,
layer, level, indoor, bicycle, foot, horse, mtb_scale, surface, network, official`. **No names.**
Names are in the separate `transportation_name` layer, whose lines are merged by name.

In tile 14/8414/5384 there are 869 features (625 LineString, 69 MultiLineString, and 174 Polygon
+ 1 MultiPolygon for bridge and pier areas). By class: minor 395, path 252, bridge 88, tertiary 53,
service 25, primary 18, busway 14, pier 10, secondary 10, transit 4. Lines that cross tile edges
are split and duplicated in the buffer, like buildings.

Near Herengracht 256, the closest line is the canal-side street (`class=minor`, `oneway=1`,
`surface=paved`) at 18.6 m from the building centroid. `transportation_name` gives its name,
*Herengracht*, at the same distance.

`streetsFromTileFeatures` behaves as follows:

* It keeps line geometries of the classes motorway, trunk, primary, secondary, tertiary, minor,
  service, busway and raceway, plus `path` with subclass pedestrian or living_street.
  `includeAllPaths` also keeps footways and cycleways. Sidewalks mapped as separate footways would
  otherwise pull the camera too close.
* It drops polygons (bridge and pier areas), rail and ferry lines, and exact duplicates.
* It sets `tags.highway = subclass || class`, so the existing `TwinView` styling works, and copies
  a name from `transportation_name` lines of the same class within 3 m.

### Automatic camera

`nearestStreetSide` casts rays along each facade edge's outward normal, from 50 %, then 25 % and
75 % of the edge. It returns the edge whose ray first meets a street centre line, ignoring rays
that pass back through the building or through `others`. `autoCameraForBuilding` stands at
`clamp(2 × distance, 12, 40)` m along that normal and faces the facade midpoint.

For Herengracht 256 it picks the east (canal) facade. The centre line is 2.5 m away, so the camera
goes to 12 m, heading 277°. The real photo in the curated example was taken at heading 273° from
the far side of the canal, 55 m away. **Limitation:** water is not modelled, so in canal cities the
12 m spot can be on the quay edge or the water. The user still has to drag the camera.

## 7. Geocoding without keys (browser, CORS)

Both endpoints were tested with `curl -H 'Origin: http://localhost:5173'` on 2026-11-25:

| Service | Request | CORS | Response |
|---|---|---|---|
| **Photon** (komoot) | `GET https://photon.komoot.io/api?q=…&limit=…` | `Access-Control-Allow-Origin: *`, `Vary: Origin`; preflight `OPTIONS` → 200, `Access-Control-Allow-Methods: GET` | **GeoJSON** `FeatureCollection`; `geometry.coordinates = [lon, lat]`; `properties` has `osm_type` (N/W/R), `osm_id`, `name`, `housenumber`, `street`, `postcode`, `city`, `state`, `country`, `countrycode`. `Cache-Control: max-age=3600`. |
| **Nominatim** (OSMF) | `GET https://nominatim.openstreetmap.org/search?format=jsonv2&q=…` | `access-control-allow-origin: *`; preflight → 204, `access-control-allow-methods: GET,OPTIONS` | JSON array; `lat` and `lon` are **strings**; `display_name`, `osm_type`, `osm_id`, `boundingbox`. |

"Herengracht 256 Amsterdam" returned house-number nodes (256C–E) at 52.37162, 4.88666 from both services.

`geocodeWithFallback(q)` tries Photon first and then Nominatim, with a separate timeout for each
(6 s by default). It throws only when both fail, and an empty array means "no match".
Usage-policy notes:

* **Nominatim** ([usage policy](https://operations.osmfoundation.org/policies/nominatim/)) allows at
  most 1 request/s and **no autocomplete or search-as-you-type**, requires a valid Referer or
  User-Agent (browsers send the Referer; JavaScript cannot set the User-Agent), and requires
  attribution. The helper enforces a ≥ 1 s gap between its Nominatim calls. Callers should geocode
  on submit, not on every keystroke.
* **Photon** (public demo instance) is fair-use, with no published hard rate. It is designed for
  search-as-you-type, but callers should still debounce (≥ 300 ms). The demo server's `lang`
  parameter supports `en`, `de` and `fr` only. `lat`/`lon` bias results towards a location.
* Both endpoints can be overridden: `VITE_PHOTON_URL` and `VITE_GEOCODER_URL`.

## 8. Exported API (`web/src/lib/tiles.ts`)

```ts
footprintsFromTileFeatures(features: TileFeatureLike[], origin: LatLon, opts?: FootprintsFromTilesOptions): Footprint[]
streetsFromTileFeatures(features: TileFeatureLike[], origin: LatLon, opts?: StreetsFromTilesOptions): Street[]
nearestStreetSide(footprint: Pick<Footprint,'ring'|'id'> & {holes?: Vec2[][]}, streets: Street[], opts?: NearestStreetSideOptions): StreetSide | null
autoCameraForBuilding(footprint: Pick<Footprint,'ring'|'id'> & {holes?: Vec2[][]}, streets: Street[], opts?: AutoCameraOptions): AutoCamera
loadFootprintsFromMap(map: maplibregl.Map, origin: LatLon, radiusMeters: number, opts?: LoadFromMapOptions): Promise<MapTileLoad>
geocodeWithFallback(q: string, opts?: GeocodeOptions): Promise<GeocodeHit[]>
unionRings(A: Vec2[][], B: Vec2[][], snap?: number): Vec2[][]
ringArea(r: Vec2[]): number
tileBoundsLonLat(t: {z, x, y}): {w, e, s, n}
```

Footprints have `source: 'osm'`, `tags.building = 'yes'`, `tags['sunvision:source'] = 'openmaptiles'`,
`tags['sunvision:height_source']`, `tags['sunvision:render_height']` and
`tags['sunvision:render_min_height']`. Where they apply, footprints also have `tags.min_height`,
`tags['sunvision:colour']`, `tags['sunvision:merged_pieces']` and `tags['sunvision:tile_feature_ids']`.
`mapLevels` is never set, because the tiles do not carry levels.

## 9. Limitations

* There are no building types, names, addresses or levels. Heights are rounded up and lose about 0.5 m.
* `hide_3d` outlines with incomplete parts leave gaps (§2).
* Buildings that extend beyond the loaded tiles are cut at the edge of the loaded area. Check `complete`.
* Footprint ids depend on geometry. If OSM edits a footprint, its id changes.
* Auto camera placement ignores water and private ground (§6).
