import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HEIGHT_SOURCE_DEFAULT,
  HEIGHT_SOURCE_RENDER,
  HEIGHT_SOURCE_TAG,
  autoCameraForBuilding,
  footprintsFromTileFeatures,
  geocodeWithFallback,
  nearestStreetSide,
  streetClassPenalty,
  ringArea,
  streetsFromTileFeatures,
  unionRings,
  type Street,
  type TileFeatureLike,
} from '../tiles';
import { enuToLonLat } from '../../engine/geo';
import type { LatLon, Vec2 } from '../../schema/scene';

/* Synthetic tile features, built in ENU metres and converted to lon/lat like MapLibre returns them. */
const origin: LatLon = { lat: 52.37163, lon: 4.88646 };
const ll = (p: Vec2): number[] => {
  const g = enuToLonLat(origin, p);
  return [g.lon, g.lat];
};
const closed = (r: Vec2[]) => [...r, r[0]].map(ll);
const poly = (outer: Vec2[], holes: Vec2[][] = [], extra: Partial<TileFeatureLike> = {}, props: Record<string, unknown> = { render_height: 22, render_min_height: 0 }): TileFeatureLike => ({
  type: 'Feature',
  properties: props,
  geometry: { type: 'Polygon', coordinates: [closed(outer), ...holes.map(closed)] },
  ...extra,
});
const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];
const areaOf = (r: Vec2[]) => ringArea(r);
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/* For tiled tests the origin sits on the z14 tile edge x = 8415 (ENU x = 0): tile A is west, tile B east. */
const originB: LatLon = { lat: 52.37163, lon: (8415 / 16384) * 360 - 180 };
const llB = (p: Vec2): number[] => {
  const g = enuToLonLat(originB, p);
  return [g.lon, g.lat];
};
const TA = { z: 14, x: 8414, y: 5384 };
const TB = { z: 14, x: 8415, y: 5384 };
const tiled = (tile: typeof TA, outers: Vec2[][], holes: Vec2[][][] = [], id: number | null = null, props: Record<string, unknown> = { render_height: 22, render_min_height: 0 }): TileFeatureLike => ({
  id,
  tile,
  properties: props,
  geometry: { type: 'MultiPolygon', coordinates: outers.map((o, i) => [[...o, o[0]].map(llB), ...(holes[i] ?? []).map((h) => [...h, h[0]].map(llB))]) },
});

describe('footprintsFromTileFeatures: buildings split at tile boundaries', () => {
  it('stitches the two buffered pieces of a building that crosses a tile edge', () => {
    // 40 × 10 m building across x = 0; each tile carries it 5 m into its buffer. Feature ids differ (OpenFreeMap).
    const fps = footprintsFromTileFeatures([tiled(TA, [rect(-20, 0, 5, 10)], [], 111), tiled(TB, [rect(-5, 0, 20, 10)], [], 999)], originB);
    expect(fps).toHaveLength(1);
    const fp = fps[0];
    expect(fp.ring).toHaveLength(4); // the cut vertices are gone
    expect(near(areaOf(fp.ring), 400, 0.5)).toBe(true);
    expect(areaOf(fp.ring)).toBeGreaterThan(0); // CCW
    expect(fp.ring[0]).not.toEqual(fp.ring[fp.ring.length - 1]); // open ring
    expect(fp.tags['sunvision:merged_pieces']).toBe('2');
    expect(fp.tags['sunvision:tile_feature_ids']).toBe('111;999');
  });

  it('tolerates buffer clip points that were rounded off the original edge', () => {
    const a: Vec2[] = [
      [-20, 0],
      [5, 0],
      [5, 10.15],
      [-20, 10],
    ];
    const fps = footprintsFromTileFeatures([tiled(TA, [a]), tiled(TB, [rect(-5, 0, 20, 10)])], originB);
    expect(fps).toHaveLength(1);
    expect(fps[0].ring.length).toBeLessThanOrEqual(5);
    expect(near(areaOf(fps[0].ring), 400, 2)).toBe(true);
  });

  it('collapses the duplicate copies that overlapping tile buffers produce', () => {
    const r = rect(-3, -3, 3, 3);
    const fps = footprintsFromTileFeatures([tiled(TA, [r]), tiled(TB, [r])], originB);
    expect(fps).toHaveLength(1);
    expect(near(areaOf(fps[0].ring), 36, 0.05)).toBe(true);
    const west = rect(-30, 0, -20, 10); // entirely in tile A, but inside tile B's buffer
    expect(footprintsFromTileFeatures([tiled(TA, [west]), tiled(TB, [west])], originB)).toHaveLength(1);
  });

  it('does not merge distinct buildings that overlap slightly in OSM', () => {
    // P and Q overlap by 0.5 m (a mapping error) and have the same height; Q crosses the tile edge.
    const P = rect(-20, 0, -2, 10);
    const Q = rect(-2.5, 0, 10, 10);
    const fps = footprintsFromTileFeatures([tiled(TA, [P, Q]), tiled(TB, [P, Q])], originB);
    expect(fps).toHaveLength(2);
    expect(fps.map((f) => Math.round(areaOf(f.ring))).sort((x, y) => x - y)).toEqual([125, 180]);
  });

  it('rebuilds a courtyard from two pieces cut through it', () => {
    // 20 × 20 block with a 4 × 4 courtyard at [-2,2]×[8,12]; each tile has a 2 m buffer.
    const left: Vec2[] = [
      [-10, 0],
      [2, 0],
      [2, 8],
      [-2, 8],
      [-2, 12],
      [2, 12],
      [2, 20],
      [-10, 20],
    ];
    const right: Vec2[] = [
      [-2, 0],
      [10, 0],
      [10, 20],
      [-2, 20],
      [-2, 12],
      [2, 12],
      [2, 8],
      [-2, 8],
    ];
    const fps = footprintsFromTileFeatures([tiled(TA, [left]), tiled(TB, [right])], originB);
    expect(fps).toHaveLength(1);
    expect(fps[0].ring).toHaveLength(4);
    expect(near(areaOf(fps[0].ring), 400, 0.5)).toBe(true);
    expect(fps[0].holes).toHaveLength(1);
    expect(near(areaOf(fps[0].holes![0]), -16, 0.1)).toBe(true); // clockwise hole
  });

  it('keeps an inner ring (hole) that the tile edge cuts through', () => {
    const outer = rect(-10, 0, 10, 20);
    const hole = rect(-2, 8, 2, 12).slice().reverse();
    const fps = footprintsFromTileFeatures([tiled(TA, [outer], [[hole]]), tiled(TB, [outer], [[hole]])], originB);
    expect(fps).toHaveLength(1);
    expect(near(areaOf(fps[0].ring), 400, 0.5)).toBe(true);
    expect(fps[0].holes).toHaveLength(1);
    expect(near(areaOf(fps[0].holes![0]), -16, 0.1)).toBe(true);
  });

  it('merges overlapping pieces without tile information', () => {
    const fps = footprintsFromTileFeatures([poly(rect(-20, 0, 5, 10), [], { id: 1 }), poly(rect(-5, 0, 20, 10), [], { id: 2 })], origin);
    expect(fps).toHaveLength(1);
    expect(near(areaOf(fps[0].ring), 400, 0.5)).toBe(true);
  });

  it('keeps neighbouring houses with the same height separate (shared party wall, no overlap)', () => {
    const fps = footprintsFromTileFeatures([poly(rect(0, 0, 6, 12)), poly(rect(6, 0, 12, 12))], origin);
    expect(fps).toHaveLength(2);
  });

  it('keeps the parts of one MultiPolygon feature separate (OpenFreeMap groups unrelated buildings)', () => {
    const f: TileFeatureLike = {
      id: 5,
      properties: { render_height: 15, render_min_height: 0 },
      geometry: { type: 'MultiPolygon', coordinates: [[closed(rect(0, 0, 6, 12))], [closed(rect(6, 0, 12, 12))], [closed(rect(30, 0, 40, 10))]] },
    };
    expect(footprintsFromTileFeatures([f], origin)).toHaveLength(3);
  });

  it('merges unbuffered pieces that touch along the tile edge only when they share a feature id', () => {
    const same = footprintsFromTileFeatures([poly(rect(-10, 0, 0, 8), [], { id: 42 }), poly(rect(0, 0, 10, 8), [], { id: 42 })], origin);
    expect(same).toHaveLength(1);
    expect(near(areaOf(same[0].ring), 160, 0.1)).toBe(true);
    const diff = footprintsFromTileFeatures([poly(rect(-10, 0, 0, 8), [], { id: 42 }), poly(rect(0, 0, 10, 8), [], { id: 43 })], origin);
    expect(diff).toHaveLength(2);
  });

  it('does not merge pieces with different attributes (e.g. outline vs. part)', () => {
    const a = poly(rect(-20, 0, 5, 10), [], {}, { render_height: 22, render_min_height: 0 });
    const b = poly(rect(-5, 0, 20, 10), [], {}, { render_height: 19, render_min_height: 0 });
    expect(footprintsFromTileFeatures([a, b], origin)).toHaveLength(2);
  });

  it('normalises clockwise input to CCW and drops degenerate rings', () => {
    const cw = rect(0, 0, 5, 5).slice().reverse();
    const tiny = rect(50, 50, 50.5, 50.5); // 0.25 m²
    const line: Vec2[] = [
      [100, 0],
      [110, 0],
      [120, 0],
    ];
    const fps = footprintsFromTileFeatures([poly(cw), poly(tiny), poly(line)], origin);
    expect(fps).toHaveLength(1);
    expect(areaOf(fps[0].ring)).toBeGreaterThan(0);
  });

  it('skips hide_3d outlines unless asked', () => {
    const f = poly(rect(0, 0, 5, 5), [], {}, { render_height: 30, render_min_height: 0, hide_3d: true });
    expect(footprintsFromTileFeatures([f], origin)).toHaveLength(0);
    expect(footprintsFromTileFeatures([f], origin, { includeHidden3d: true })).toHaveLength(1);
  });
});

describe('footprintsFromTileFeatures: heights', () => {
  it('treats render_height 5 / min 0 as the OpenMapTiles default (no mapHeight)', () => {
    const [fp] = footprintsFromTileFeatures([poly(rect(0, 0, 5, 5), [], {}, { render_height: 5, render_min_height: 0 })], origin);
    expect(fp.mapHeight).toBeUndefined();
    expect(fp.tags[HEIGHT_SOURCE_TAG]).toBe(HEIGHT_SOURCE_DEFAULT);
    expect(fp.tags['sunvision:render_height']).toBe('5');
  });

  it('uses other render_height values as mapHeight and keeps the base height', () => {
    const [a] = footprintsFromTileFeatures([poly(rect(0, 0, 5, 5), [], {}, { render_height: 22, render_min_height: 0 })], origin);
    expect(a.mapHeight).toBe(22);
    expect(a.tags[HEIGHT_SOURCE_TAG]).toBe(HEIGHT_SOURCE_RENDER);
    expect(a.tags.min_height).toBeUndefined();
    const [b] = footprintsFromTileFeatures([poly(rect(0, 0, 5, 5), [], {}, { render_height: 5, render_min_height: 3, colour: '#bd8161' })], origin);
    expect(b.mapHeight).toBe(5); // a 2 m slab on a 3 m base is not the default
    expect(b.tags.min_height).toBe('3');
    expect(b.tags['sunvision:colour']).toBe('#bd8161');
  });

  it('gives stable, unique ids from the footprint position', () => {
    const fs = [poly(rect(0, 0, 5, 5)), poly(rect(20, 0, 25, 5))];
    const a = footprintsFromTileFeatures(fs, origin).map((f) => f.id);
    const b = footprintsFromTileFeatures(fs.slice().reverse(), origin).map((f) => f.id);
    expect(new Set(a).size).toBe(2);
    expect(a.slice().sort()).toEqual(b.slice().sort());
    expect(a[0]).toMatch(/^omt\/52\.\d{6},4\.\d{6}$/);
  });
});

describe('unionRings', () => {
  it('returns the outer outline of two overlapping squares', () => {
    const u = unionRings([rect(0, 0, 10, 10)], [rect(5, 5, 15, 15)]);
    expect(u).toHaveLength(1);
    expect(near(ringArea(u[0]), 175, 1e-6)).toBe(true);
    expect(u[0]).toHaveLength(8);
  });
});

/* Streets and camera placement: 12 × 10 m building, south facade (edge 0) on y = 0. */
const building = { id: 'b', ring: rect(-6, 0, 6, 10) };
const street = (id: string, y: number): Street => ({
  id,
  line: [
    [-60, y],
    [60, y],
  ],
  tags: { highway: 'residential' },
});

describe('streetsFromTileFeatures', () => {
  it('keeps street lines, drops railways, areas and footways, and copies names', () => {
    const line = (coords: Vec2[], props: Record<string, unknown>, id: number): TileFeatureLike => ({ id, properties: props, geometry: { type: 'LineString', coordinates: coords.map(ll) } });
    const feats: TileFeatureLike[] = [
      line([[-50, -8], [50, -8]], { class: 'minor', oneway: 1 }, 1),
      line([[-50, -8], [50, -8]], { class: 'minor', oneway: 1 }, 2), // duplicate from a neighbouring tile
      line([[-50, -20], [50, -20]], { class: 'rail' }, 3),
      line([[-50, -2], [50, -2]], { class: 'path', subclass: 'footway' }, 4),
      line([[-50, 30], [50, 30]], { class: 'path', subclass: 'pedestrian' }, 5),
      { id: 6, properties: { class: 'bridge' }, geometry: { type: 'Polygon', coordinates: [closed(rect(0, -30, 5, -25))] } },
    ];
    const names: TileFeatureLike[] = [line([[-70, -8], [70, -8]], { class: 'minor', name: 'Herengracht' }, 7)];
    const s = streetsFromTileFeatures(feats, origin, { nameFeatures: names });
    expect(s.map((x) => x.tags.highway).sort()).toEqual(['minor', 'pedestrian']);
    const minor = s.find((x) => x.tags.class === 'minor')!;
    expect(minor.tags.name).toBe('Herengracht');
    expect(minor.tags.oneway).toBe('1');
    expect(near(minor.line[0][1], -8, 0.01)).toBe(true);
  });
});

describe('nearestStreetSide', () => {
  it('finds the facade that faces the closest street', () => {
    const s = nearestStreetSide(building, [street('far', 30), street('near', -8)]);
    expect(s).not.toBeNull();
    expect(s!.edgeIndex).toBe(0);
    expect(s!.streetId).toBe('near');
    expect(near(s!.distanceToCenterline, 8, 1e-6)).toBe(true);
  });

  it('picks the back facade when that street is closer', () => {
    const s = nearestStreetSide(building, [street('front', -15), street('back', 14)]);
    expect(s!.edgeIndex).toBe(2); // edge (6,10)->(-6,10), faces north
    expect(near(s!.distanceToCenterline, 4, 1e-6)).toBe(true);
  });

  it('ignores a street hidden behind another building', () => {
    const blocker = { id: 'x', ring: rect(-10, -6, 10, -3) };
    const s = nearestStreetSide(building, [street('hidden', -8), street('back', 20)], { others: [blocker] });
    expect(s!.streetId).toBe('back');
  });

  it('returns null without streets in front of the building', () => {
    expect(nearestStreetSide(building, [])).toBeNull();
  });

  it('by default the nearest street wins whatever its class (frontal photos: a house fronting a lane, a main road behind)', () => {
    const lane: Street = { id: 'lane', line: [[-60, -6], [60, -6]], tags: { class: 'minor' } };
    const main: Street = { id: 'main', line: [[-60, 23], [60, 23]], tags: { class: 'secondary' } };
    const s = nearestStreetSide(building, [lane, main]);
    expect(s!.streetId).toBe('lane');
    expect(s!.edgeIndex).toBe(0);
    expect(autoCameraForBuilding(building, [lane, main]).facadeEdgeIndex).toBe(0);
  });

  it('with classPenalty prefers a main street to a nearer minor one (oblique street views)', () => {
    const main: Street = { id: 'main', line: [[-60, -12], [60, -12]], tags: { class: 'secondary' } };
    const lane: Street = { id: 'lane', line: [[-60, 15], [60, 15]], tags: { class: 'minor' } };
    expect(nearestStreetSide(building, [main, lane])!.streetId).toBe('lane'); // 5 m < 12 m without the penalty
    const s = nearestStreetSide(building, [main, lane], { classPenalty: true });
    expect(s!.streetId).toBe('main'); // 12 m vs 5 m + 10 m penalty
    expect(s!.edgeIndex).toBe(0);
    expect(near(s!.distanceToCenterline, 12, 1e-6)).toBe(true);
    // a main street far away does not beat a lane right in front
    const farMain: Street = { id: 'far', line: [[-60, -40], [60, -40]], tags: { class: 'primary' } };
    expect(nearestStreetSide(building, [farMain, lane], { classPenalty: true })!.streetId).toBe('lane');
    expect(streetClassPenalty({ tags: { highway: 'residential' } })).toBe(10);
    expect(streetClassPenalty({ tags: { class: 'primary' } })).toBe(0);
    expect(streetClassPenalty({ tags: {} })).toBe(0);
  });
});

describe('autoCameraForBuilding', () => {
  it('stands across the street, 2 × the centre-line distance away, looking at the facade', () => {
    const c = autoCameraForBuilding(building, [street('s', -8)]);
    expect(c.basis).toBe('street');
    expect(c.facadeEdgeIndex).toBe(0);
    expect(c.distance).toBeCloseTo(16, 6);
    expect(c.position[0]).toBeCloseTo(0, 6);
    expect(c.position[1]).toBeCloseTo(-16, 6);
    expect(c.heading).toBeCloseTo(0, 6); // looking north at the south facade
  });

  it('clamps the distance to [12, 40] m', () => {
    expect(autoCameraForBuilding(building, [street('s', -3)]).distance).toBe(12);
    expect(autoCameraForBuilding(building, [street('s', -30)]).distance).toBe(40);
  });

  it('works for a rotated facade (east-facing)', () => {
    const c = autoCameraForBuilding(building, [{ id: 'e', line: [[16, -50], [16, 50]], tags: {} }]);
    expect(c.facadeEdgeIndex).toBe(1); // (6,0)->(6,10)
    expect(c.position[0]).toBeCloseTo(6 + 20, 6);
    expect(c.position[1]).toBeCloseTo(5, 6);
    expect(c.heading).toBeCloseTo(270, 6); // looking west
  });

  it('falls back to the longest edge when no street is found', () => {
    const c = autoCameraForBuilding(building, []);
    expect(c.basis).toBe('longest-edge');
    expect(c.distance).toBe(12);
  });
});

describe('geocodeWithFallback', () => {
  afterEach(() => vi.unstubAllGlobals());
  const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

  it('parses Photon GeoJSON', async () => {
    const fetchMock = vi.fn(() =>
      json({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [4.8866, 52.3716] }, properties: { osm_type: 'N', osm_id: 1, street: 'Herengracht', housenumber: '256', postcode: '1016 BV', city: 'Amsterdam', country: 'Nederland' } }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await geocodeWithFallback('Herengracht 256');
    expect(r).toEqual([{ label: 'Herengracht 256, 1016 BV Amsterdam, Nederland', lat: 52.3716, lon: 4.8866, provider: 'photon', osmId: 'node/1' }]);
    expect(String(fetchMock.mock.calls[0]).startsWith('https://photon.komoot.io/api?q=Herengracht+256')).toBe(true);
  });

  it('falls back to Nominatim when Photon fails', async () => {
    const fetchMock = vi.fn((url: string) => (url.includes('photon') ? json({ message: 'busy' }, 503) : json([{ display_name: 'Herengracht 256, Amsterdam', lat: '52.37', lon: '4.88', osm_type: 'way', osm_id: 7 }])));
    vi.stubGlobal('fetch', fetchMock);
    const r = await geocodeWithFallback('Herengracht 256', { timeoutMs: 1000 });
    expect(r).toEqual([{ label: 'Herengracht 256, Amsterdam', lat: 52.37, lon: 4.88, provider: 'nominatim', osmId: 'way/7' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws when both providers fail', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('network down'))));
    await expect(geocodeWithFallback('x', { timeoutMs: 500 })).rejects.toThrow(/Photon.*Nominatim/);
  });
});
