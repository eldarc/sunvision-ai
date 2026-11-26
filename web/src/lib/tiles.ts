/**
 * Building footprints and streets from the vector tiles the map already renders
 * (OpenFreeMap, OpenMapTiles schema). No Overpass query is needed.
 *
 * Research notes, evidence and caveats are in docs/research/tiles.md. In short:
 *  - Tiles are clipped with a buffer (64 of 4096 units at z14), so a building that
 *    crosses a tile edge comes back as overlapping pieces, one per tile, and buildings
 *    near an edge come back as exact duplicates.
 *  - At z14, OpenFreeMap merges all buildings of a tile that share the same attributes
 *    into one MultiPolygon. The feature id then belongs to one member only, and it is
 *    usually different in the neighbouring tile. Feature ids are therefore NOT building
 *    identities, and each polygon part is treated as its own building.
 *  - render_height = ceil(height) or ceil(building:levels × 3.66), else 5.
 *    A value of 5 (with render_min_height 0) is treated as "no height in OSM".
 *
 * Everything here is pure and unit-tested, except `loadFootprintsFromMap` (the
 * MapLibre adapter) and `geocodeWithFallback` (network).
 */
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Footprint, LatLon, Vec2 } from '../schema/scene';
import { bearingOf, enuToLonLat, lonLatToEnu } from '../engine/geo';

/* ------------------------------------------------------------------ */
/* Types and constants                                                 */
/* ------------------------------------------------------------------ */

/** A GeoJSON-like feature, as returned by `map.querySourceFeatures` (lon/lat coordinates). */
export interface TileFeatureLike {
  type?: string;
  id?: number | string | null;
  properties?: Record<string, unknown> | null;
  geometry: { type: string; coordinates: unknown } | null;
  /** Canonical tile of the feature. MapLibre sets this on querySourceFeatures results. */
  tile?: { z: number; x: number; y: number };
  _z?: number;
  _x?: number;
  _y?: number;
}

export interface Street {
  id: string;
  line: Vec2[];
  tags: Record<string, string>;
}

/** OpenMapTiles' render_height when OSM has neither height nor building:levels. */
export const OMT_DEFAULT_RENDER_HEIGHT = 5;
/** OpenMapTiles' metres per building level when only building:levels is tagged. */
export const OMT_LEVEL_HEIGHT = 3.66;
/** Tag that records where `Footprint.mapHeight` came from. */
export const HEIGHT_SOURCE_TAG = 'sunvision:height_source';
export const HEIGHT_SOURCE_RENDER = 'openmaptiles:render_height';
export const HEIGHT_SOURCE_DEFAULT = 'openmaptiles:default';
/** Minimum map zoom at which the map has the z14 (full-detail) building tiles loaded. */
export const MIN_QUERY_ZOOM = 15;

/** Street classes used by default (OpenMapTiles `transportation.class`). */
export const DEFAULT_STREET_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'busway', 'raceway'];
/** `path` subclasses kept by default: places where people stand to take a photo of a facade. */
export const DEFAULT_PATH_SUBCLASSES = ['pedestrian', 'living_street'];

export interface FootprintsFromTilesOptions {
  /** Drop parts whose bounding box lies further than this from the origin (cheap pre-filter). */
  radiusMeters?: number;
  /** Keep building outlines that OpenMapTiles marks hide_3d (their building:part pieces are also in the tile). Default false. */
  includeHidden3d?: boolean;
  /** Rings smaller than this (m²) are dropped. Default 1. */
  minArea?: number;
  /**
   * Vertices of two pieces closer than this (m) are snapped together before merging. Tile
   * coordinates are quantised to 1/4096 of a tile (≈ 0.37 m at z14 and 52° N), and the
   * buffer clip points are rounded to that grid. Default 0.3.
   */
  snapMeters?: number;
}

/* ------------------------------------------------------------------ */
/* Small planar helpers (ENU metres)                                   */
/* ------------------------------------------------------------------ */

type Ring = Vec2[];

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const cross = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Signed area (m²), positive for counter-clockwise rings. */
export function ringArea(r: Ring): number {
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    const b = r[(i + 1) % r.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): { q: Vec2; t: number; d: number } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  const q: Vec2 = [a[0] + ab[0] * t, a[1] + ab[1] * t];
  return { q, t, d: dist(p, q) };
}

function pointInRings(p: Vec2, rings: Ring[]): boolean {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i];
      const [xj, yj] = r[j];
      if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Remove duplicate and (nearly) collinear vertices; returns an open ring. */
function cleanRing(r: Ring, tol = 1e-3): Ring {
  let pts = r.slice();
  if (pts.length > 1 && dist(pts[0], pts[pts.length - 1]) < 1e-9) pts.pop();
  let changed = true;
  while (changed && pts.length >= 3) {
    changed = false;
    const out: Ring = [];
    for (let i = 0; i < pts.length; i++) {
      const prev = out.length ? out[out.length - 1] : pts[pts.length - 1];
      const cur = pts[i];
      const next = pts[(i + 1) % pts.length];
      if (dist(prev, cur) < 1e-6) {
        changed = true;
        continue;
      }
      const base = dist(prev, next);
      // Height of `cur` over the line prev→next, and spikes (cur folds back onto the line).
      const h = base > 1e-9 ? Math.abs(cross(sub(next, prev), sub(cur, prev))) / base : dist(prev, cur);
      if (h < tol) {
        changed = true;
        continue;
      }
      out.push(cur);
    }
    if (out.length >= 2 && dist(out[0], out[out.length - 1]) < 1e-6) {
      out.pop();
      changed = true;
    }
    pts = out;
  }
  return pts;
}

interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
function bboxOf(rings: Ring[]): BBox {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const r of rings)
    for (const [x, y] of r) {
      if (x < b.minX) b.minX = x;
      if (y < b.minY) b.minY = y;
      if (x > b.maxX) b.maxX = x;
      if (y > b.maxY) b.maxY = y;
    }
  return b;
}
const bboxTouch = (a: BBox, b: BBox, m: number) => a.minX <= b.maxX + m && b.minX <= a.maxX + m && a.minY <= b.maxY + m && b.minY <= a.maxY + m;

/* ------------------------------------------------------------------ */
/* Polygon union (rings: outer CCW, holes CW)                          */
/* ------------------------------------------------------------------ */

/** Move vertices of `a` onto nearby vertices or edges of `b` (snap rounding across pieces). */
function snapTo(a: Ring[], b: Ring[], tol: number): Ring[] {
  const bv = b.flat();
  return a.map((r) =>
    r.map((p) => {
      let best: Vec2 | null = null;
      let bd = tol;
      for (const q of bv) {
        const d = dist(p, q);
        if (d <= bd) {
          bd = d;
          best = q;
        }
      }
      if (best) return [best[0], best[1]] as Vec2;
      for (const rb of b)
        for (let i = 0; i < rb.length; i++) {
          const c = closestOnSegment(p, rb[i], rb[(i + 1) % rb.length]);
          if (c.d <= bd) {
            bd = c.d;
            best = c.q;
          }
        }
      return best ? ([best[0], best[1]] as Vec2) : p;
    }),
  );
}

interface Seg {
  a: Vec2;
  b: Vec2;
}
const EPS = 1e-6;

function segmentsOf(rings: Ring[]): Seg[] {
  const out: Seg[] = [];
  for (const r of rings) for (let i = 0; i < r.length; i++) out.push({ a: r[i], b: r[(i + 1) % r.length] });
  return out;
}

/** Split every edge at every crossing with, and every vertex lying on, any other edge. */
function splitAll(S: Seg[]): Seg[] {
  const cuts: { t: number; p: Vec2 }[][] = S.map(() => []);
  for (let i = 0; i < S.length; i++) {
    const { a: p, b: p2 } = S[i];
    const r = sub(p2, p);
    const lr = Math.hypot(r[0], r[1]);
    for (let j = i + 1; j < S.length; j++) {
      const { a: q, b: q2 } = S[j];
      if (Math.max(p[0], p2[0]) < Math.min(q[0], q2[0]) - EPS || Math.max(q[0], q2[0]) < Math.min(p[0], p2[0]) - EPS) continue;
      if (Math.max(p[1], p2[1]) < Math.min(q[1], q2[1]) - EPS || Math.max(q[1], q2[1]) < Math.min(p[1], p2[1]) - EPS) continue;
      const s = sub(q2, q);
      const den = cross(r, s);
      const ls = Math.hypot(s[0], s[1]);
      if (Math.abs(den) > 1e-9 * lr * ls) {
        const t = cross(sub(q, p), s) / den;
        const u = cross(sub(q, p), r) / den;
        if (t > 0 && t < 1 && u > 0 && u < 1) {
          const x: Vec2 = [p[0] + r[0] * t, p[1] + r[1] * t];
          cuts[i].push({ t, p: x });
          cuts[j].push({ t: u, p: x });
        }
      }
      // Endpoints lying on the other segment (collinear overlaps and T-junctions).
      for (const v of [q, q2]) {
        const c = closestOnSegment(v, p, p2);
        if (c.d < EPS) cuts[i].push({ t: c.t, p: v });
      }
      for (const v of [p, p2]) {
        const c = closestOnSegment(v, q, q2);
        if (c.d < EPS) cuts[j].push({ t: c.t, p: v });
      }
    }
  }
  const out: Seg[] = [];
  S.forEach((s, i) => {
    const pts = [{ t: 0, p: s.a }, ...cuts[i].filter((c) => c.t > 0 && c.t < 1), { t: 1, p: s.b }].sort((x, y) => x.t - y.t);
    for (let k = 0; k + 1 < pts.length; k++) if (dist(pts[k].p, pts[k + 1].p) > EPS) out.push({ a: pts[k].p, b: pts[k + 1].p });
  });
  return out;
}

/** Link directed edges (given as vertex ids) into closed rings, taking the right-most turn at shared vertices. */
function chain(verts: Vec2[], edges: [number, number][]): Ring[] {
  const E = edges.map(([s, t]) => ({ s, t, used: false }));
  const out = new Map<number, number[]>();
  E.forEach((e, i) => out.set(e.s, [...(out.get(e.s) ?? []), i]));
  const rings: Ring[] = [];
  for (let k = 0; k < E.length; k++) {
    if (E[k].used) continue;
    const ring: Ring = [];
    let cur = k;
    for (let guard = 0; guard <= E.length; guard++) {
      const e = E[cur];
      e.used = true;
      ring.push(verts[e.s]);
      if (e.t === E[k].s) break;
      const din = sub(verts[e.t], verts[e.s]);
      const cands = (out.get(e.t) ?? []).filter((i) => !E[i].used);
      if (!cands.length) break;
      const turn = (i: number) => {
        const d = sub(verts[E[i].t], verts[E[i].s]);
        return Math.atan2(cross(din, d), dot(din, d));
      };
      cands.sort((x, y) => turn(x) - turn(y));
      cur = cands[0];
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

/**
 * Union of two polygons given as rings (outer counter-clockwise, holes clockwise; the region is
 * always on the left of an edge). Returns rings with the same convention. Vertices of `A` within
 * `snap` metres of `B` are snapped onto it first, which absorbs tile-grid rounding.
 *
 * Edge overlay: all edges are split against each other, coincident opposite edges cancel
 * (a wall shared by two pieces, or a hole touching a cut), and an edge is kept when the point
 * just to its right lies outside both polygons. `unionRings(A, [])` dissolves a single polygon
 * whose rings touch (e.g. a clipped courtyard).
 */
export function unionRings(A: Ring[], B: Ring[], snap = 0.3): Ring[] {
  const A2 = B.length ? snapTo(A, B, snap) : A;
  const segs = splitAll([...segmentsOf(A2), ...segmentsOf(B)]);
  // Merge vertices (exact up to float noise after snapping and splitting).
  const verts: Vec2[] = [];
  const vid = (p: Vec2) => {
    for (let i = 0; i < verts.length; i++) if (Math.abs(verts[i][0] - p[0]) < 1e-5 && Math.abs(verts[i][1] - p[1]) < 1e-5) return i;
    verts.push(p);
    return verts.length - 1;
  };
  const net = new Map<string, number>(); // "lo,hi" -> (#lo→hi) − (#hi→lo)
  for (const s of segs) {
    const u = vid(s.a);
    const v = vid(s.b);
    if (u === v) continue;
    const k = u < v ? `${u},${v}` : `${v},${u}`;
    net.set(k, (net.get(k) ?? 0) + (u < v ? 1 : -1));
  }
  const keep: [number, number][] = [];
  for (const [k, n] of net) {
    if (n === 0) continue;
    const [lo, hi] = k.split(',').map(Number);
    const [s, t] = n > 0 ? [lo, hi] : [hi, lo];
    const a = verts[s];
    const b = verts[t];
    const d = sub(b, a);
    const l = Math.hypot(d[0], d[1]);
    const probe: Vec2 = [(a[0] + b[0]) / 2 + (d[1] / l) * 1e-4, (a[1] + b[1]) / 2 - (d[0] / l) * 1e-4];
    // Region is on the left; the edge is on the union boundary when its right side is empty.
    if (!pointInRings(probe, A2) && !pointInRings(probe, B)) keep.push([s, t]);
  }
  return chain(verts, keep)
    .map((r) => cleanRing(r))
    .filter((r) => r.length >= 3 && Math.abs(ringArea(r)) > 1e-6);
}

const totalArea = (rings: Ring[]) => rings.reduce((s, r) => s + ringArea(r), 0);

/** Group rings into polygons: each outer (CCW) ring with the holes (CW) that lie inside it. */
function groupPolygons(rings: Ring[]): { outer: Ring; holes: Ring[] }[] {
  const outers = rings.filter((r) => ringArea(r) > 0).sort((a, b) => ringArea(a) - ringArea(b));
  const polys = outers.map((outer) => ({ outer, holes: [] as Ring[] }));
  for (const h of rings.filter((r) => ringArea(r) < 0)) {
    const host = polys.find((p) => pointInRings(h[0], [p.outer]) || pointInRings(centroidOf(h), [p.outer]));
    if (host) host.holes.push(h);
  }
  return polys;
}

function centroidOf(r: Ring): Vec2 {
  let x = 0;
  let y = 0;
  for (const p of r) {
    x += p[0];
    y += p[1];
  }
  return [x / r.length, y / r.length];
}

/* ------------------------------------------------------------------ */
/* Building footprints from tile features                              */
/* ------------------------------------------------------------------ */

interface Piece {
  rings: Ring[]; // ENU, [0] = outer CCW, rest = holes CW
  props: Record<string, unknown>;
  key: string; // attributes that pieces of the same building always share
  featureIndex: number;
  fid: string | null;
  tile: { z: number; x: number; y: number } | null;
  bbox: BBox;
  area: number;
}

function tileOf(f: TileFeatureLike): Piece['tile'] {
  if (f.tile) return f.tile;
  if (typeof f._z === 'number' && typeof f._x === 'number' && typeof f._y === 'number') return { z: f._z, x: f._x, y: f._y };
  return null;
}

function polygonsOf(g: TileFeatureLike['geometry']): number[][][][] {
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates as number[][][]];
  if (g.type === 'MultiPolygon') return g.coordinates as number[][][][];
  return [];
}

function linesOf(g: TileFeatureLike['geometry']): number[][][] {
  if (!g) return [];
  if (g.type === 'LineString') return [g.coordinates as number[][]];
  if (g.type === 'MultiLineString') return g.coordinates as number[][][];
  return [];
}

const truthy = (v: unknown) => v === true || v === 'true' || v === 1;

/** Approximate metres per degree, used only for cheap pre-filtering. */
function degScale(origin: LatLon): { mx: number; my: number } {
  return { mx: 111320 * Math.cos((origin.lat * Math.PI) / 180), my: 110574 };
}

function lonLatBBoxNear(coords: number[][][], origin: LatLon, radius: number): boolean {
  const { mx, my } = degScale(origin);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of coords[0] ?? []) {
    const x = (c[0] - origin.lon) * mx;
    const y = (c[1] - origin.lat) * my;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const dx = Math.max(minX, 0, -maxX);
  const dy = Math.max(minY, 0, -maxY);
  return Math.hypot(dx, dy) <= radius * 1.1 + 5;
}

interface LonLatBox {
  w: number;
  e: number;
  s: number;
  n: number;
}

/** Lon/lat bounds of a slippy-map tile. */
export function tileBoundsLonLat(t: { z: number; x: number; y: number }): LonLatBox {
  const n = 2 ** t.z;
  const lat = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return { w: (t.x / n) * 360 - 180, e: ((t.x + 1) / n) * 360 - 180, n: lat(t.y), s: lat(t.y + 1) };
}

/** Sutherland–Hodgman clip of an (open or closed) lon/lat ring to a box. */
function clipToBox(ring: number[][], b: LonLatBox): number[][] {
  let pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring.slice();
  const planes: [number, number, boolean][] = [
    [0, b.w, true],
    [0, b.e, false],
    [1, b.s, true],
    [1, b.n, false],
  ];
  for (const [axis, v, keepAbove] of planes) {
    if (!pts.length) break;
    const inside = (p: number[]) => (keepAbove ? p[axis] >= v : p[axis] <= v);
    const cut = (p: number[], q: number[]) => {
      const t = (v - p[axis]) / (q[axis] - p[axis]);
      const o = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
      o[axis] = v;
      return o;
    };
    const out: number[][] = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i];
      const prev = pts[(i + pts.length - 1) % pts.length];
      if (inside(cur)) {
        if (!inside(prev)) out.push(cut(prev, cur));
        out.push(cur);
      } else if (inside(prev)) out.push(cut(prev, cur));
    }
    pts = out;
  }
  return pts;
}

/** ENU segment of the boundary shared by two edge-adjacent tiles, or null. */
function sharedTileEdge(a: NonNullable<Piece['tile']>, b: NonNullable<Piece['tile']>, origin: LatLon): [Vec2, Vec2] | null {
  if (a.z !== b.z) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) + Math.abs(dy) !== 1) return null;
  const n = 2 ** a.z;
  const lon = (x: number) => (x / n) * 360 - 180;
  const lat = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  if (dx !== 0) {
    const X = Math.max(a.x, b.x);
    return [lonLatToEnu(origin, { lon: lon(X), lat: lat(a.y) }), lonLatToEnu(origin, { lon: lon(X), lat: lat(a.y + 1) })];
  }
  const Y = Math.max(a.y, b.y);
  return [lonLatToEnu(origin, { lon: lon(a.x), lat: lat(Y) }), lonLatToEnu(origin, { lon: lon(a.x + 1), lat: lat(Y) })];
}

/** Length of boundary that two pieces share with opposite orientation (i.e. they touch along it). */
function sharedEdgeLength(p: Piece, q: Piece, tol: number, line: [Vec2, Vec2] | null): number {
  let len = 0;
  const lineDist = (v: Vec2) => {
    if (!line) return 0;
    const d = sub(line[1], line[0]);
    return Math.abs(cross(d, sub(v, line[0]))) / Math.hypot(d[0], d[1]);
  };
  for (const ra of p.rings)
    for (let i = 0; i < ra.length; i++) {
      const a0 = ra[i];
      const a1 = ra[(i + 1) % ra.length];
      const da = sub(a1, a0);
      const la = Math.hypot(da[0], da[1]);
      if (la < 1e-6) continue;
      if (line && (lineDist(a0) > tol || lineDist(a1) > tol)) continue;
      for (const rb of q.rings)
        for (let j = 0; j < rb.length; j++) {
          const b0 = rb[j];
          const b1 = rb[(j + 1) % rb.length];
          const db = sub(b1, b0);
          if (dot(da, db) >= 0) continue;
          // Both endpoints of b close to the line of a?
          const off0 = Math.abs(cross(da, sub(b0, a0))) / la;
          const off1 = Math.abs(cross(da, sub(b1, a0))) / la;
          if (off0 > tol || off1 > tol) continue;
          const t0 = dot(sub(b0, a0), da) / la;
          const t1 = dot(sub(b1, a0), da) / la;
          const lo = Math.max(0, Math.min(t0, t1));
          const hi = Math.min(la, Math.max(t0, t1));
          if (hi > lo) len += hi - lo;
        }
    }
  return len;
}

/**
 * Convert OpenMapTiles `building` features (from `map.querySourceFeatures(source, {sourceLayer: 'building'})`)
 * into Sunvision footprints in ENU metres around `origin`.
 *
 * - Every Polygon / MultiPolygon part is a separate building (OpenFreeMap merges unrelated
 *   buildings with identical attributes into one MultiPolygon per tile).
 * - Pieces of one building split across tiles are merged: pieces with identical attributes
 *   from different features (or tiles) whose areas overlap (tile buffers overlap), or that
 *   share a feature id and touch along an edge (unbuffered tiles; when both tiles are known
 *   the shared edge must lie on their common tile boundary).
 * - Rings are counter-clockwise, open, cleaned of collinear vertices; tiny rings are dropped.
 * - `mapHeight` is set from render_height unless it is the OpenMapTiles default (5 m, min 0);
 *   the decision is recorded in `tags['sunvision:height_source']`.
 */
export function footprintsFromTileFeatures(features: TileFeatureLike[], origin: LatLon, opts: FootprintsFromTilesOptions = {}): Footprint[] {
  const minArea = opts.minArea ?? 1;
  const snap = opts.snapMeters ?? 0.3;
  const pieces: Piece[] = [];
  features.forEach((f, featureIndex) => {
    const props = f.properties ?? {};
    if (!opts.includeHidden3d && truthy(props.hide_3d)) return;
    const key = JSON.stringify([props.render_height ?? null, props.render_min_height ?? null, props.colour ?? null, truthy(props.hide_3d)]);
    const fid = f.id === undefined || f.id === null ? null : String(f.id);
    const tile = tileOf(f);
    const box = tile ? tileBoundsLonLat(tile) : null;
    for (const poly of polygonsOf(f.geometry)) {
      if (!poly.length) continue;
      if (opts.radiusMeters != null && !lonLatBBoxNear(poly, origin, opts.radiusMeters)) continue;
      // Clip to the tile's own bounds: drops buffer duplicates and leaves pieces that meet on the tile edge.
      let clipped = false;
      let rings: Ring[] = [];
      poly.forEach((coords0, k) => {
        let coords = coords0;
        if (box && coords0.some((c) => c[0] < box.w || c[0] > box.e || c[1] < box.s || c[1] > box.n)) {
          coords = clipToBox(coords0, box);
          clipped = true;
        }
        if (coords.length < 3) return;
        let r = cleanRing(coords.map((c) => lonLatToEnu(origin, { lon: c[0], lat: c[1] })));
        if (r.length < 3 || Math.abs(ringArea(r)) < 1e-3) return;
        // GeoJSON: first ring is the outer ring, the rest are holes.
        if ((k === 0 && ringArea(r) < 0) || (k > 0 && ringArea(r) > 0)) r = r.slice().reverse();
        if (k === 0 || rings.length) rings.push(r);
      });
      if (!rings.length) continue;
      // A clipped courtyard touches the cut, and clipping a concave ring can leave zero-width bridges.
      const parts = clipped ? groupPolygons(unionRings(rings, [])).map((p) => [p.outer, ...p.holes]) : [rings];
      for (rings of parts) {
        if (!clipped && ringArea(rings[0]) < minArea) continue;
        pieces.push({ rings, props, key, featureIndex, fid, tile, bbox: bboxOf(rings), area: totalArea(rings) });
      }
    }
  });

  // Union-find over pieces that belong to the same building.
  const parent = pieces.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const byKey = new Map<string, number[]>();
  pieces.forEach((p, i) => byKey.set(p.key, [...(byKey.get(p.key) ?? []), i]));
  for (const idx of byKey.values()) {
    for (let a = 0; a < idx.length; a++)
      for (let b = a + 1; b < idx.length; b++) {
        const p = pieces[idx[a]];
        const q = pieces[idx[b]];
        if (p.featureIndex === q.featureIndex) continue; // parts of one feature are different buildings
        const sameTile = p.tile && q.tile && p.tile.z === q.tile.z && p.tile.x === q.tile.x && p.tile.y === q.tile.y;
        if (sameTile) continue; // within one tile, one building is one part
        if (!bboxTouch(p.bbox, q.bbox, snap)) continue;
        if (find(idx[a]) === find(idx[b])) continue;
        let merge = false;
        if (p.tile && q.tile) {
          // Both clipped to their tiles: the same building continues across the shared tile edge.
          const line = sharedTileEdge(p.tile, q.tile, origin);
          merge = !!line && sharedEdgeLength(p, q, snap, line) > 0.2;
        } else {
          // No tile information: overlapping pieces (buffers), or touching pieces with the same id.
          const overlap = p.area + q.area - totalArea(unionRings(p.rings, q.rings, snap));
          if (overlap > Math.max(0.5, 0.01 * Math.min(p.area, q.area))) merge = true;
          else if (p.fid !== null && p.fid === q.fid) merge = sharedEdgeLength(p, q, snap, null) > 0.2;
        }
        if (merge) parent[find(idx[a])] = find(idx[b]);
      }
  }

  const groups = new Map<number, number[]>();
  pieces.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));
  const out: Footprint[] = [];
  const usedIds = new Map<string, number>();
  for (const members of groups.values()) {
    let rings: Ring[];
    if (members.length === 1) rings = pieces[members[0]].rings;
    else {
      // Grow the union piece by piece, always adding a piece that touches the current union.
      const todo = members.slice().sort((a, b) => pieces[b].area - pieces[a].area);
      rings = pieces[todo.shift()!].rings;
      let guard = todo.length * todo.length + 1;
      while (todo.length && guard-- > 0) {
        const bb = bboxOf(rings);
        const k = todo.findIndex((i) => bboxTouch(bb, pieces[i].bbox, snap));
        const i = todo.splice(k < 0 ? 0 : k, 1)[0];
        rings = unionRings(rings, pieces[i].rings, snap);
      }
    }
    const p0 = pieces[members[0]];
    for (const poly of groupPolygons(rings)) {
      if (ringArea(poly.outer) < minArea) continue;
      out.push(toFootprint(poly.outer, poly.holes, p0.props, members.map((m) => pieces[m]), origin, usedIds));
    }
  }
  return out;
}

function toFootprint(outer: Ring, holes: Ring[], props: Record<string, unknown>, members: Piece[], origin: LatLon, usedIds: Map<string, number>): Footprint {
  const rh = Number(props.render_height);
  const rmh = Number(props.render_min_height) || 0;
  const tags: Record<string, string> = { building: 'yes', 'sunvision:source': 'openmaptiles' };
  let mapHeight: number | undefined;
  if (!Number.isFinite(rh)) tags[HEIGHT_SOURCE_TAG] = 'none';
  else if (rh === OMT_DEFAULT_RENDER_HEIGHT && rmh === 0) tags[HEIGHT_SOURCE_TAG] = HEIGHT_SOURCE_DEFAULT;
  else {
    mapHeight = rh;
    tags[HEIGHT_SOURCE_TAG] = HEIGHT_SOURCE_RENDER;
  }
  if (Number.isFinite(rh)) tags['sunvision:render_height'] = String(rh);
  tags['sunvision:render_min_height'] = String(rmh);
  if (rmh > 0) tags.min_height = String(rmh); // read by obstacles.ts as the prism base
  if (typeof props.colour === 'string') tags['sunvision:colour'] = props.colour;
  if (truthy(props.hide_3d)) tags['sunvision:hide_3d'] = 'true';
  const fids = [...new Set(members.map((m) => m.fid).filter((x): x is string => x !== null))];
  if (fids.length) tags['sunvision:tile_feature_ids'] = fids.join(';');
  if (members.length > 1) tags['sunvision:merged_pieces'] = String(members.length);
  // Feature ids are not building identities, so the id is derived from the centroid position.
  const c = enuToLonLat(origin, polygonCentroid(outer));
  let id = `omt/${c.lat.toFixed(6)},${c.lon.toFixed(6)}`;
  const n = usedIds.get(id) ?? 0;
  usedIds.set(id, n + 1);
  if (n) id += `#${n}`;
  const fp: Footprint = { id, ring: outer, tags, source: 'osm' };
  if (holes.length) fp.holes = holes;
  if (mapHeight !== undefined) fp.mapHeight = mapHeight;
  return fp;
}

function polygonCentroid(r: Ring): Vec2 {
  const a = ringArea(r);
  if (Math.abs(a) < 1e-9) return centroidOf(r);
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i];
    const q = r[(i + 1) % r.length];
    const k = p[0] * q[1] - q[0] * p[1];
    cx += (p[0] + q[0]) * k;
    cy += (p[1] + q[1]) * k;
  }
  return [cx / (6 * a), cy / (6 * a)];
}

/* ------------------------------------------------------------------ */
/* Streets                                                             */
/* ------------------------------------------------------------------ */

export interface StreetsFromTilesOptions {
  /** OpenMapTiles classes to keep. Default DEFAULT_STREET_CLASSES. */
  classes?: string[];
  /** `path` subclasses to keep. Default DEFAULT_PATH_SUBCLASSES. Pass [] to drop all paths. */
  pathSubclasses?: string[];
  /** Also keep every `path` (footways, cycleways, steps...). Default false. */
  includeAllPaths?: boolean;
  /** Features of the `transportation_name` layer; names are copied onto streets within 3 m. */
  nameFeatures?: TileFeatureLike[];
  radiusMeters?: number;
}

/**
 * Street centre lines from the OpenMapTiles `transportation` layer, in ENU metres.
 * Polygons (bridge/pier areas) and railways are dropped. The transportation layer has no
 * names; pass the `transportation_name` features to copy names over.
 */
export function streetsFromTileFeatures(features: TileFeatureLike[], origin: LatLon, opts: StreetsFromTilesOptions = {}): Street[] {
  const classes = new Set(opts.classes ?? DEFAULT_STREET_CLASSES);
  const pathSub = new Set(opts.pathSubclasses ?? DEFAULT_PATH_SUBCLASSES);
  const names = (opts.nameFeatures ?? []).flatMap((f) =>
    linesOf(f.geometry).map((l) => ({ line: l.map((c) => lonLatToEnu(origin, { lon: c[0], lat: c[1] })), props: f.properties ?? {} })),
  );
  const out: Street[] = [];
  const seen = new Set<string>();
  features.forEach((f, fi) => {
    const p = f.properties ?? {};
    const cls = typeof p.class === 'string' ? p.class : '';
    const subclass = typeof p.subclass === 'string' ? p.subclass : '';
    const keep = classes.has(cls) || (cls === 'path' && (opts.includeAllPaths || pathSub.has(subclass)));
    if (!keep) return;
    linesOf(f.geometry).forEach((coords, li) => {
      if (coords.length < 2) return;
      if (opts.radiusMeters != null && !lonLatBBoxNear([coords], origin, opts.radiusMeters)) return;
      const line = coords.map((c) => lonLatToEnu(origin, { lon: c[0], lat: c[1] }));
      // Exact duplicates come from overlapping tile buffers.
      const sig = line.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
      if (seen.has(sig)) return;
      seen.add(sig);
      const tags: Record<string, string> = { highway: subclass || cls, class: cls, 'sunvision:source': 'openmaptiles' };
      for (const k of ['subclass', 'brunnel', 'oneway', 'surface', 'layer', 'service', 'access']) if (p[k] !== undefined && p[k] !== null) tags[k] = String(p[k]);
      const name = nameFor(line, cls, names);
      if (name) tags.name = name;
      const t = tileOf(f);
      out.push({ id: `omt-street/${f.id ?? `f${fi}`}/${li}${t ? `@${t.z}/${t.x}/${t.y}` : ''}`, line, tags });
    });
  });
  return out;
}

function nameFor(line: Vec2[], cls: string, names: { line: Vec2[]; props: Record<string, unknown> }[]): string | undefined {
  if (!names.length) return undefined;
  const probe = pointAlong(line, 0.5);
  let best: string | undefined;
  let bd = 3;
  for (const n of names) {
    if (n.props.class !== undefined && n.props.class !== cls) continue;
    const d = distToPolyline(probe, n.line).d;
    if (d < bd && typeof n.props.name === 'string') {
      bd = d;
      best = n.props.name;
    }
  }
  return best;
}

function pointAlong(line: Vec2[], frac: number): Vec2 {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += dist(line[i - 1], line[i]);
  let target = total * frac;
  for (let i = 1; i < line.length; i++) {
    const l = dist(line[i - 1], line[i]);
    if (target <= l && l > 0) {
      const t = target / l;
      return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t];
    }
    target -= l;
  }
  return line[line.length - 1];
}

function distToPolyline(p: Vec2, line: Vec2[]): { d: number; q: Vec2 } {
  let best = { d: Infinity, q: line[0] };
  for (let i = 1; i < line.length; i++) {
    const c = closestOnSegment(p, line[i - 1], line[i]);
    if (c.d < best.d) best = { d: c.d, q: c.q };
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Facade facing a street, and automatic camera placement              */
/* ------------------------------------------------------------------ */

/** Outward unit normal of edge a→b of a counter-clockwise ring (points to the right of the edge). */
function outwardNormal(a: Vec2, b: Vec2): Vec2 {
  const d = sub(b, a);
  const l = Math.hypot(d[0], d[1]) || 1;
  return [d[1] / l, -d[0] / l];
}

/** Distance along the ray o + t·dir (t > 0) to the first crossing with segment a–b, or Infinity. */
function raySegment(o: Vec2, dir: Vec2, a: Vec2, b: Vec2): number {
  const s = sub(b, a);
  const den = cross(dir, s);
  if (Math.abs(den) < 1e-12) return Infinity;
  const ao = sub(a, o);
  const t = cross(ao, s) / den;
  const u = cross(ao, dir) / den;
  return t > 1e-6 && u >= 0 && u <= 1 ? t : Infinity;
}

function rayRings(o: Vec2, dir: Vec2, rings: Ring[]): number {
  let best = Infinity;
  for (const r of rings) for (let i = 0; i < r.length; i++) best = Math.min(best, raySegment(o, dir, r[i], r[(i + 1) % r.length]));
  return best;
}

export interface NearestStreetSideOptions {
  /** Ignore streets further than this along the facade normal (m). Default 80. */
  maxDistance?: number;
  /** Ignore facade edges shorter than this (m). Default 2. */
  minEdgeLength?: number;
  /** Other buildings; a street hidden behind one of them does not count. */
  others?: Pick<Footprint, 'ring' | 'id'>[];
  /**
   * Add STREET_CLASS_PENALTY to a lesser street's distance. Off by default: for a frontal photo
   * the nearest street is the best guess (a house's front door is usually on its nearest street,
   * even when a main road runs behind it). lib/vanishing turns it on for an oblique street view,
   * which is taken along a street with room to look down it.
   */
  classPenalty?: boolean;
}

/**
 * Extra "distance" (m) added to a street of a lesser class when choosing the facade an oblique
 * street photo most likely shows (nearestStreetSide `classPenalty`): such photos are taken along
 * main streets, where there is room to look down the street, so a secondary street 12 m away
 * beats a minor one 5 m away. Streets without a known class (OSM `highway` values included) get
 * the matching penalty, unknown 0.
 */
export const STREET_CLASS_PENALTY: Record<string, number> = {
  motorway: 0,
  trunk: 0,
  primary: 0,
  secondary: 0,
  tertiary: 2,
  busway: 4,
  minor: 10,
  residential: 10,
  unclassified: 10,
  living_street: 12,
  pedestrian: 12,
  service: 15,
  track: 20,
  raceway: 20,
  path: 15,
};

/** STREET_CLASS_PENALTY of a street (by its OpenMapTiles `class`, else its OSM `highway`). */
export function streetClassPenalty(s: Pick<Street, 'tags'>): number {
  const c = s.tags.class ?? s.tags.highway ?? '';
  const base = c.replace(/_link$/, '');
  return STREET_CLASS_PENALTY[base] ?? 0;
}

export interface StreetSide {
  edgeIndex: number;
  /** Distance from the facade (along its outward normal) to the street centre line, in metres. */
  distanceToCenterline: number;
  streetId: string;
}

/**
 * The facade edge of `footprint` that faces the closest street: rays are cast along each
 * edge's outward normal (from 3 points along the edge) and the shortest unobstructed hit on
 * a street centre line wins; with `classPenalty` a lesser street counts as further away by its
 * STREET_CLASS_PENALTY (a minor street 5 m away loses to a secondary one 12 m away). Edge i runs from ring[i] to ring[i+1]. Returns null when no
 * street is in front of any edge.
 */
export function nearestStreetSide(footprint: Pick<Footprint, 'ring' | 'id'> & { holes?: Vec2[][] }, streets: Street[], opts: NearestStreetSideOptions = {}): StreetSide | null {
  const maxD = opts.maxDistance ?? 80;
  const minLen = opts.minEdgeLength ?? 2;
  const ring = footprint.ring;
  const own: Ring[] = [ring, ...(footprint.holes ?? [])];
  const others = (opts.others ?? []).filter((o) => o.id !== footprint.id).map((o) => o.ring);
  let best: (StreetSide & { score: number }) | null = null;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const len = dist(a, b);
    if (len < minLen) continue;
    const n = outwardNormal(a, b);
    for (const s of streets) {
      // Use the mid-point first; quarter points catch streets that only cover part of a facade.
      let hit = Infinity;
      for (const f of [0.5, 0.25, 0.75]) {
        const o: Vec2 = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
        let t = Infinity;
        for (let k = 1; k < s.line.length; k++) t = Math.min(t, raySegment(o, n, s.line[k - 1], s.line[k]));
        if (!(t <= maxD)) continue;
        if (rayRings(o, n, own) < t) continue; // the ray re-enters the building itself
        if (others.some((r) => rayRings(o, n, [r]) < t)) continue; // another building is in the way
        hit = t;
        break;
      }
      if (!Number.isFinite(hit)) continue;
      // Shortest distance (plus the street-class penalty when asked) wins; among near-equal distances,
      // prefer the longer facade.
      const score = hit + (opts.classPenalty ? streetClassPenalty(s) : 0) - Math.min(len, 20) * 0.01;
      if (!best || score < best.score) best = { edgeIndex: i, distanceToCenterline: hit, streetId: s.id, score };
    }
  }
  return best ? { edgeIndex: best.edgeIndex, distanceToCenterline: best.distanceToCenterline, streetId: best.streetId } : null;
}

export interface AutoCameraOptions extends NearestStreetSideOptions {
  /** Minimum camera distance from the facade (m). Default 12. */
  minDistance?: number;
  /** Maximum camera distance from the facade (m). Default 40. */
  maxCameraDistance?: number;
  /** Camera distance = factor × distance to the street centre line, before clamping. Default 2. */
  factor?: number;
}

export interface AutoCamera {
  /** ENU ground position of the camera. */
  position: Vec2;
  /** Compass heading (deg clockwise from north) from the camera to the facade midpoint. */
  heading: number;
  facadeEdgeIndex: number;
  /** Distance from the facade midpoint to the camera (m). */
  distance: number;
  /** 'street': placed across the nearest street; 'longest-edge': no street found, longest edge used. */
  basis: 'street' | 'longest-edge';
  streetId?: string;
  distanceToCenterline?: number;
}

/**
 * Place a camera across the street from the facade that faces the nearest street, looking
 * at the facade midpoint: distance = clamp(factor × distance to the street centre line,
 * minDistance, maxCameraDistance) = clamp(2d, 12, 40) by default.
 */
export function autoCameraForBuilding(footprint: Pick<Footprint, 'ring' | 'id'> & { holes?: Vec2[][] }, streets: Street[], opts: AutoCameraOptions = {}): AutoCamera {
  const minD = opts.minDistance ?? 12;
  const maxD = opts.maxCameraDistance ?? 40;
  const factor = opts.factor ?? 2;
  const ring = footprint.ring;
  const side = nearestStreetSide(footprint, streets, opts);
  let edge: number;
  let d: number;
  if (side) {
    edge = side.edgeIndex;
    d = Math.min(maxD, Math.max(minD, factor * side.distanceToCenterline));
  } else {
    edge = 0;
    let best = -1;
    for (let i = 0; i < ring.length; i++) {
      const l = dist(ring[i], ring[(i + 1) % ring.length]);
      if (l > best) {
        best = l;
        edge = i;
      }
    }
    d = minD;
  }
  const a = ring[edge];
  const b = ring[(edge + 1) % ring.length];
  const n = outwardNormal(a, b);
  const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const position: Vec2 = [mid[0] + n[0] * d, mid[1] + n[1] * d];
  const res: AutoCamera = { position, heading: bearingOf(-n[0], -n[1]), facadeEdgeIndex: edge, distance: d, basis: side ? 'street' : 'longest-edge' };
  if (side) {
    res.streetId = side.streetId;
    res.distanceToCenterline = side.distanceToCenterline;
  }
  return res;
}

/* ------------------------------------------------------------------ */
/* MapLibre adapter                                                    */
/* ------------------------------------------------------------------ */

export interface LoadFromMapOptions {
  /** Vector source id. Default: the source of the first style layer with source-layer 'building'. */
  sourceId?: string;
  /** Wait for tiles to finish loading (ms). Default 8000; 0 disables waiting. */
  waitMs?: number;
  /** If the map is zoomed out or the radius is off-screen, jump the map to the origin first. Default false. */
  ensureView?: boolean;
  includeStreets?: boolean;
  footprintOptions?: FootprintsFromTilesOptions;
  streetOptions?: StreetsFromTilesOptions;
}

export interface MapTileLoad {
  footprints: Footprint[];
  streets: Street[];
  /** Zoom of the tiles the features came from (null when nothing was loaded). */
  tileZoom: number | null;
  /** False when the radius was not fully covered by loaded full-detail tiles. */
  complete: boolean;
  warnings: string[];
}

/**
 * Read building footprints (and streets) around `origin` from the vector tiles a MapLibre
 * map has already loaded.
 *
 * `querySourceFeatures` only sees tiles that are currently loaded, i.e. tiles covering the
 * visible viewport. Full-detail buildings exist only in z14 tiles (OpenFreeMap's max zoom);
 * z13 tiles hold merged, simplified blocks. The map must therefore be at zoom ≥ 15 with the
 * whole radius on screen, or `ensureView: true` must be passed so the map jumps there first.
 * Features from lower-zoom tiles that MapLibre keeps during transitions are discarded.
 */
export async function loadFootprintsFromMap(map: MapLibreMap, origin: LatLon, radiusMeters: number, opts: LoadFromMapOptions = {}): Promise<MapTileLoad> {
  const warnings: string[] = [];
  const style = map.getStyle();
  const buildingLayer = style?.layers?.find((l) => (l as { 'source-layer'?: string })['source-layer'] === 'building') as { source?: string } | undefined;
  const sourceId = opts.sourceId ?? buildingLayer?.source ?? 'openmaptiles';
  const src = map.getSource(sourceId) as { maxzoom?: number } | undefined;
  if (!src) throw new Error(`Map has no source "${sourceId}" with a building layer.`);
  const maxZoom = typeof src.maxzoom === 'number' ? Math.min(src.maxzoom, 14) : 14;

  const covers = () => {
    const b = map.getBounds();
    const { mx, my } = degScale(origin);
    const dLon = radiusMeters / mx;
    const dLat = radiusMeters / my;
    return b.getWest() <= origin.lon - dLon && b.getEast() >= origin.lon + dLon && b.getSouth() <= origin.lat - dLat && b.getNorth() >= origin.lat + dLat;
  };
  if (opts.ensureView && (map.getZoom() < MIN_QUERY_ZOOM || !covers())) {
    map.jumpTo({ center: [origin.lon, origin.lat], zoom: Math.max(MIN_QUERY_ZOOM, map.getZoom()) });
  }
  const waitMs = opts.waitMs ?? 8000;
  if (waitMs > 0 && !map.areTilesLoaded()) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(done, waitMs);
      function done() {
        clearTimeout(t);
        map.off('idle', done);
        resolve();
      }
      map.on('idle', done);
    });
    if (!map.areTilesLoaded()) warnings.push('Some map tiles were still loading; results may be incomplete.');
  }
  let complete = true;
  if (map.getZoom() < MIN_QUERY_ZOOM) {
    complete = false;
    warnings.push(`Map zoom ${map.getZoom().toFixed(1)} < ${MIN_QUERY_ZOOM}: zoom in to load full-detail building tiles.`);
  }
  if (!covers()) {
    complete = false;
    warnings.push(`The ${radiusMeters} m radius is not fully on screen; buildings outside the loaded tiles are missing.`);
  }

  const fullDetail = (fs: TileFeatureLike[]) => {
    const z = (f: TileFeatureLike) => tileOf(f)?.z ?? maxZoom;
    const top = fs.reduce((m, f) => Math.max(m, z(f)), -1);
    return { feats: fs.filter((f) => z(f) === top), top: top < 0 ? null : top };
  };
  const raw = map.querySourceFeatures(sourceId, { sourceLayer: 'building' }) as unknown as TileFeatureLike[];
  const { feats, top } = fullDetail(raw);
  if (top !== null && top < maxZoom) {
    complete = false;
    warnings.push(`Only z${top} building tiles are loaded (merged, simplified); zoom in to ≥ ${MIN_QUERY_ZOOM}.`);
  }
  const footprints = footprintsFromTileFeatures(feats, origin, { radiusMeters, ...opts.footprintOptions }).filter((fp) => ringDistance([0, 0], fp.ring) <= radiusMeters);

  let streets: Street[] = [];
  if (opts.includeStreets !== false) {
    const tr = fullDetail(map.querySourceFeatures(sourceId, { sourceLayer: 'transportation' }) as unknown as TileFeatureLike[]).feats;
    const names = fullDetail(map.querySourceFeatures(sourceId, { sourceLayer: 'transportation_name' }) as unknown as TileFeatureLike[]).feats;
    streets = streetsFromTileFeatures(tr, origin, { radiusMeters, nameFeatures: names, ...opts.streetOptions });
  }
  return { footprints, streets, tileZoom: top, complete, warnings };
}

/** Distance from p to a polygon (0 when inside). */
function ringDistance(p: Vec2, ring: Ring): number {
  if (pointInRings(p, [ring])) return 0;
  return distToPolyline(p, [...ring, ring[0]]).d;
}

/* ------------------------------------------------------------------ */
/* Geocoding without keys: Photon (komoot), then Nominatim             */
/* ------------------------------------------------------------------ */

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
export const PHOTON_URL = env.VITE_PHOTON_URL ?? 'https://photon.komoot.io/api';
export const NOMINATIM_URL = env.VITE_GEOCODER_URL ?? 'https://nominatim.openstreetmap.org/search';

export interface GeocodeHit {
  label: string;
  lat: number;
  lon: number;
  provider: 'photon' | 'nominatim';
  /** 'way/123', 'node/123' or 'relation/123' when the geocoder reports it. */
  osmId?: string;
}

export interface GeocodeOptions {
  signal?: AbortSignal;
  /** Per-provider timeout (ms). Default 6000. */
  timeoutMs?: number;
  limit?: number;
  /** Preferred language, e.g. 'en'. Photon supports en, de, fr (others fall back to local names). */
  lang?: string;
  /** Bias results towards this point (Photon only). */
  near?: LatLon;
}

let lastNominatimCall = 0;
const OSM_TYPE: Record<string, string> = { N: 'node', W: 'way', R: 'relation', node: 'node', way: 'way', relation: 'relation' };

async function fetchJson(url: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new Error(ctl.signal.aborted ? 'timed out' : e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: Record<string, string | number | undefined>;
}

function photonLabel(p: Record<string, string | number | undefined>): string {
  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  const town = [p.postcode, p.city ?? p.town ?? p.village ?? p.locality].filter(Boolean).join(' ');
  const parts = [p.name, street, town, p.state, p.country].filter((x) => x !== undefined && x !== '').map(String);
  return parts.filter((x, i) => parts.indexOf(x) === i).join(', ');
}

/**
 * Forward geocoding from the browser without an API key. Tries Photon (komoot; GeoJSON,
 * CORS `*`, suitable for search-as-you-type) first, then Nominatim (CORS `*`; usage policy:
 * at most 1 request/s, no autocomplete, attribution required). Each provider gets its own
 * timeout. Throws only when both fail; an empty array means "no match".
 */
export async function geocodeWithFallback(q: string, opts: GeocodeOptions = {}): Promise<GeocodeHit[]> {
  const query = q.trim();
  if (!query) return [];
  const timeoutMs = opts.timeoutMs ?? 6000;
  const limit = opts.limit ?? 6;
  const errors: string[] = [];
  try {
    const u = new URL(PHOTON_URL);
    u.searchParams.set('q', query);
    u.searchParams.set('limit', String(limit));
    if (opts.lang && ['en', 'de', 'fr'].includes(opts.lang)) u.searchParams.set('lang', opts.lang);
    if (opts.near) {
      u.searchParams.set('lat', String(opts.near.lat));
      u.searchParams.set('lon', String(opts.near.lon));
    }
    const j = (await fetchJson(u.toString(), timeoutMs, opts.signal)) as { features?: PhotonFeature[] };
    const hits: GeocodeHit[] = [];
    for (const f of j.features ?? []) {
      const c = f.geometry?.coordinates;
      if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
      const p = f.properties ?? {};
      const hit: GeocodeHit = { label: photonLabel(p) || `${c[1].toFixed(5)}, ${c[0].toFixed(5)}`, lat: c[1], lon: c[0], provider: 'photon' };
      if (p.osm_type && p.osm_id !== undefined && OSM_TYPE[String(p.osm_type)]) hit.osmId = `${OSM_TYPE[String(p.osm_type)]}/${p.osm_id}`;
      hits.push(hit);
    }
    if (hits.length) return hits;
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    errors.push(`Photon: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const wait = lastNominatimCall + 1000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastNominatimCall = Date.now();
    const u = new URL(NOMINATIM_URL);
    u.searchParams.set('format', 'jsonv2');
    u.searchParams.set('limit', String(limit));
    u.searchParams.set('q', query);
    if (opts.lang) u.searchParams.set('accept-language', opts.lang);
    const j = (await fetchJson(u.toString(), timeoutMs, opts.signal)) as { display_name?: string; lat?: string; lon?: string; osm_type?: string; osm_id?: number }[];
    return (Array.isArray(j) ? j : [])
      .map((x) => {
        const hit: GeocodeHit = { label: x.display_name ?? '', lat: Number(x.lat), lon: Number(x.lon), provider: 'nominatim' };
        if (x.osm_type && x.osm_id !== undefined && OSM_TYPE[x.osm_type]) hit.osmId = `${OSM_TYPE[x.osm_type]}/${x.osm_id}`;
        return hit;
      })
      .filter((h) => Number.isFinite(h.lat) && Number.isFinite(h.lon));
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    errors.push(`Nominatim: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (errors.length === 2) throw new Error(`Address search failed (${errors.join('; ')}).`);
  return [];
}
