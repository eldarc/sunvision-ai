/**
 * Ray casting against the modelled obstacle scene (prisms, oriented boxes,
 * trees). Exact analytic intersections + a uniform XY grid for acceleration.
 * ENU meters, z up.
 */
import type { Vec2, Vec3 } from '../schema/scene';
import type { BoxObstacle, ObstacleKind, ObstacleScene, PrismObstacle, TreeObstacle } from './types';

type Prim =
  | { type: 'prism'; o: PrismObstacle; bbox: [number, number, number, number] }
  | { type: 'box'; o: BoxObstacle; bbox: [number, number, number, number] }
  | { type: 'tree'; o: TreeObstacle; bbox: [number, number, number, number] };

export interface ObstacleIndex {
  prims: Prim[];
  cellSize: number;
  minX: number;
  minY: number;
  nx: number;
  ny: number;
  cells: Int32Array[]; // per cell, indices into prims
  zTop: number;
  zBottom: number;
  meta: Map<string, { kind: ObstacleKind; label: string }>;
  /** Scratch stamps to avoid re-testing a primitive within one ray. */
  stamp: Uint32Array;
  ray: number;
}

export interface RayHit {
  hit: boolean;
  id?: string;
  kind?: ObstacleKind;
  t?: number;
}

export interface CastOptions {
  /** Obstacle whose hits are ignored when closer than `selfEps`. */
  ignoreId?: string;
  selfEps?: number;
  tMin?: number;
  tMax?: number;
}

const EPS = 1e-9;

function ringBBox(ring: Vec2[]): [number, number, number, number] {
  let a = Infinity,
    b = Infinity,
    c = -Infinity,
    d = -Infinity;
  for (const [x, y] of ring) {
    if (x < a) a = x;
    if (y < b) b = y;
    if (x > c) c = x;
    if (y > d) d = y;
  }
  return [a, b, c, d];
}

function boxCorners(b: BoxObstacle): Vec3[] {
  const out: Vec3[] = [];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) {
        const p: Vec3 = [b.center[0], b.center[1], b.center[2]];
        for (let k = 0; k < 3; k++) {
          p[k] += sx * b.halfSize[0] * b.axes[0][k] + sy * b.halfSize[1] * b.axes[1][k] + sz * b.halfSize[2] * b.axes[2][k];
        }
        out.push(p);
      }
  return out;
}

const finite = (...v: number[]) => v.every(Number.isFinite);
const finiteBBox = (b: readonly number[]) => b.length === 4 && b.every(Number.isFinite) && b[0] <= b[2] && b[1] <= b[3];

export function buildObstacleIndex(scene: ObstacleScene, cellSize = 8): ObstacleIndex {
  const prims: Prim[] = [];
  // Primitives with a non-finite coordinate are skipped: one NaN would make the grid bounds NaN
  // (no cells), and every later ray would throw.
  const meta = new Map<string, { kind: ObstacleKind; label: string }>();
  let zTop = 0;
  let zBottom = 0;
  for (const o of scene.prisms) {
    if (o.ring.length < 3 || !(o.zMax > o.zMin) || !finite(o.zMin, o.zMax)) continue;
    const bbox = ringBBox(o.ring);
    if (!finiteBBox(bbox) || !o.ring.every((p) => finite(p[0], p[1]))) continue;
    prims.push({ type: 'prism', o, bbox });
    meta.set(o.id, { kind: o.kind, label: o.label });
    zTop = Math.max(zTop, o.zMax);
    zBottom = Math.min(zBottom, o.zMin);
  }
  for (const o of scene.boxes) {
    const cs = boxCorners(o);
    if (!cs.every((c) => finite(c[0], c[1], c[2]))) continue;
    const bbox = ringBBox(cs.map((c) => [c[0], c[1]] as Vec2));
    if (!finiteBBox(bbox)) continue;
    prims.push({ type: 'box', o, bbox });
    meta.set(o.id, { kind: o.kind, label: o.label });
    for (const c of cs) {
      zTop = Math.max(zTop, c[2]);
      zBottom = Math.min(zBottom, c[2]);
    }
  }
  for (const o of scene.trees) {
    if (!(o.height > 0) || !Number.isFinite(o.height)) continue;
    const r = Math.max(o.crownRadius, o.trunkRadius);
    const bbox: [number, number, number, number] = [o.position[0] - r, o.position[1] - r, o.position[0] + r, o.position[1] + r];
    if (!finiteBBox(bbox)) continue;
    prims.push({ type: 'tree', o, bbox });
    meta.set(o.id, { kind: o.kind, label: o.label });
    zTop = Math.max(zTop, o.height);
  }
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of prims) {
    minX = Math.min(minX, p.bbox[0]);
    minY = Math.min(minY, p.bbox[1]);
    maxX = Math.max(maxX, p.bbox[2]);
    maxY = Math.max(maxY, p.bbox[3]);
  }
  if (!prims.length) {
    minX = minY = 0;
    maxX = maxY = 1;
  }
  minX -= 1e-3;
  minY -= 1e-3;
  const nx = Math.max(1, Math.ceil((maxX - minX) / cellSize) + 1);
  const ny = Math.max(1, Math.ceil((maxY - minY) / cellSize) + 1);
  const lists: number[][] = Array.from({ length: nx * ny }, () => []);
  prims.forEach((p, i) => {
    const x0 = Math.max(0, Math.floor((p.bbox[0] - minX) / cellSize));
    const y0 = Math.max(0, Math.floor((p.bbox[1] - minY) / cellSize));
    const x1 = Math.min(nx - 1, Math.floor((p.bbox[2] - minX) / cellSize));
    const y1 = Math.min(ny - 1, Math.floor((p.bbox[3] - minY) / cellSize));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) lists[y * nx + x].push(i);
  });
  return {
    prims,
    cellSize,
    minX,
    minY,
    nx,
    ny,
    cells: lists.map((l) => Int32Array.from(l)),
    zTop: zTop + 1e-3,
    zBottom: zBottom - 1e-3,
    meta,
    stamp: new Uint32Array(prims.length),
    ray: 0,
  };
}

// ---------------------------------------------------------------------------
// Primitive intersections: return the smallest t > tMin, or Infinity.

function pointInRing(x: number, y: number, ring: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0],
      yi = ring[i][1],
      xj = ring[j][0],
      yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function intersectPrism(p: PrismObstacle, o: Vec3, d: Vec3, tMin: number): number {
  let best = Infinity;
  const ring = p.ring;
  // Side walls: ray (xy) vs each edge segment.
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const den = d[0] * ey - d[1] * ex;
    if (Math.abs(den) < EPS) continue;
    const ax = a[0] - o[0];
    const ay = a[1] - o[1];
    const t = (ax * ey - ay * ex) / den;
    if (t <= tMin || t >= best) continue;
    const s = (ax * d[1] - ay * d[0]) / den;
    if (s < 0 || s > 1) continue;
    const z = o[2] + t * d[2];
    if (z < p.zMin || z > p.zMax) continue;
    best = t;
  }
  // Caps.
  if (Math.abs(d[2]) > EPS) {
    for (const zc of [p.zMax, p.zMin]) {
      const t = (zc - o[2]) / d[2];
      if (t <= tMin || t >= best) continue;
      if (pointInRing(o[0] + t * d[0], o[1] + t * d[1], ring)) best = t;
    }
  }
  return best;
}

export function intersectBox(b: BoxObstacle, o: Vec3, d: Vec3, tMin: number): number {
  let t0 = -Infinity;
  let t1 = Infinity;
  for (let k = 0; k < 3; k++) {
    const ax = b.axes[k];
    const oc = (o[0] - b.center[0]) * ax[0] + (o[1] - b.center[1]) * ax[1] + (o[2] - b.center[2]) * ax[2];
    const dd = d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2];
    const h = b.halfSize[k];
    if (Math.abs(dd) < EPS) {
      if (oc < -h || oc > h) return Infinity;
      continue;
    }
    let ta = (-h - oc) / dd;
    let tb = (h - oc) / dd;
    if (ta > tb) [ta, tb] = [tb, ta];
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return Infinity;
  }
  if (t1 <= tMin) return Infinity;
  return t0 > tMin ? t0 : tMin; // origin inside box -> immediately blocked
}

export function intersectTree(tr: TreeObstacle, o: Vec3, d: Vec3, tMin: number): number {
  let best = Infinity;
  const r = tr.crownRadius;
  if (r > 0) {
    const cz = Math.max(r, tr.height - r);
    const ox = o[0] - tr.position[0];
    const oy = o[1] - tr.position[1];
    const oz = o[2] - cz;
    const bq = ox * d[0] + oy * d[1] + oz * d[2];
    const c = ox * ox + oy * oy + oz * oz - r * r;
    const disc = bq * bq - c; // |d| = 1
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      const ta = -bq - s;
      const tb = -bq + s;
      if (ta > tMin) best = ta;
      else if (tb > tMin) best = tMin; // starts inside the crown
    }
  }
  const tr0 = tr.trunkRadius;
  if (tr0 > 0) {
    const top = Math.max(0, tr.height - (r > 0 ? r : 0));
    const ox = o[0] - tr.position[0];
    const oy = o[1] - tr.position[1];
    const a = d[0] * d[0] + d[1] * d[1];
    if (a > EPS) {
      const bq = ox * d[0] + oy * d[1];
      const c = ox * ox + oy * oy - tr0 * tr0;
      const disc = bq * bq - a * c;
      if (disc >= 0) {
        const t = (-bq - Math.sqrt(disc)) / a;
        if (t > tMin && t < best) {
          const z = o[2] + t * d[2];
          if (z >= 0 && z <= top) best = t;
        }
      }
    }
  }
  return best;
}

function intersectPrim(p: Prim, o: Vec3, d: Vec3, tMin: number): number {
  switch (p.type) {
    case 'prism':
      return intersectPrism(p.o, o, d, tMin);
    case 'box':
      return intersectBox(p.o, o, d, tMin);
    case 'tree':
      return intersectTree(p.o, o, d, tMin);
  }
}

// ---------------------------------------------------------------------------

function normalize(d: Vec3): Vec3 {
  const l = Math.hypot(d[0], d[1], d[2]);
  return l > 0 ? [d[0] / l, d[1] / l, d[2] / l] : [0, 0, 1];
}

function traverse(index: ObstacleIndex, o: Vec3, dirIn: Vec3, opts: CastOptions, firstOnly: boolean): RayHit {
  // A non-finite origin or direction cannot hit anything (and would index cells[NaN]).
  if (!finite(o[0], o[1], o[2], dirIn[0], dirIn[1], dirIn[2])) return { hit: false };
  const d = normalize(dirIn);
  const tMin = opts.tMin ?? 1e-4;
  const selfEps = opts.selfEps ?? 0.05;
  let tMax = opts.tMax ?? Infinity;
  // Vertical bounds of the scene.
  if (d[2] > EPS) tMax = Math.min(tMax, (index.zTop - o[2]) / d[2]);
  else if (d[2] < -EPS) tMax = Math.min(tMax, (index.zBottom - o[2]) / d[2]);
  else if (o[2] > index.zTop || o[2] < index.zBottom) return { hit: false };
  if (tMax <= tMin || !index.prims.length) return { hit: false };

  const stampId = ++index.ray;
  if (stampId >= 0xfffffff0) {
    index.stamp.fill(0);
    index.ray = 1;
  }
  const cs = index.cellSize;
  // Clip the XY ray to the grid rectangle.
  const gx0 = index.minX;
  const gy0 = index.minY;
  const gx1 = gx0 + index.nx * cs;
  const gy1 = gy0 + index.ny * cs;
  let ta = tMin;
  let tb = tMax;
  for (const [oo, dd, lo, hi] of [
    [o[0], d[0], gx0, gx1],
    [o[1], d[1], gy0, gy1],
  ] as const) {
    if (Math.abs(dd) < EPS) {
      if (oo < lo || oo >= hi) return { hit: false };
    } else {
      let t0 = (lo - oo) / dd;
      let t1 = (hi - oo) / dd;
      if (t0 > t1) [t0, t1] = [t1, t0];
      ta = Math.max(ta, t0);
      tb = Math.min(tb, t1);
    }
  }
  if (!(ta <= tb)) return { hit: false };

  const px = o[0] + ta * d[0];
  const py = o[1] + ta * d[1];
  let cx = Math.min(index.nx - 1, Math.max(0, Math.floor((px - gx0) / cs)));
  let cy = Math.min(index.ny - 1, Math.max(0, Math.floor((py - gy0) / cs)));
  const stepX = d[0] > 0 ? 1 : -1;
  const stepY = d[1] > 0 ? 1 : -1;
  const tDeltaX = Math.abs(d[0]) < EPS ? Infinity : cs / Math.abs(d[0]);
  const tDeltaY = Math.abs(d[1]) < EPS ? Infinity : cs / Math.abs(d[1]);
  let tNextX = Math.abs(d[0]) < EPS ? Infinity : (gx0 + (cx + (stepX > 0 ? 1 : 0)) * cs - o[0]) / d[0];
  let tNextY = Math.abs(d[1]) < EPS ? Infinity : (gy0 + (cy + (stepY > 0 ? 1 : 0)) * cs - o[1]) / d[1];

  let bestT = Infinity;
  let bestPrim = -1;
  let tCellStart = ta;
  for (;;) {
    if (tCellStart > bestT || tCellStart > tb) break;
    const list = index.cells[cy * index.nx + cx];
    if (!list) break; // defensive: never index outside the grid
    for (let k = 0; k < list.length; k++) {
      const pi = list[k];
      if (index.stamp[pi] === stampId) continue;
      index.stamp[pi] = stampId;
      const prim = index.prims[pi];
      const isSelf = opts.ignoreId !== undefined && prim.o.id === opts.ignoreId;
      const t = intersectPrim(prim, o, d, isSelf ? Math.max(tMin, selfEps) : tMin);
      if (t < bestT && t <= tMax) {
        bestT = t;
        bestPrim = pi;
        if (firstOnly) {
          const p = index.prims[bestPrim];
          return { hit: true, id: p.o.id, kind: p.o.kind, t: bestT };
        }
      }
    }
    // Step to the next cell.
    if (tNextX < tNextY) {
      tCellStart = tNextX;
      tNextX += tDeltaX;
      cx += stepX;
      if (cx < 0 || cx >= index.nx) break;
    } else {
      tCellStart = tNextY;
      tNextY += tDeltaY;
      cy += stepY;
      if (cy < 0 || cy >= index.ny) break;
    }
    if (tCellStart === Infinity) break;
  }
  if (bestPrim < 0) return { hit: false };
  const p = index.prims[bestPrim];
  return { hit: true, id: p.o.id, kind: p.o.kind, t: bestT };
}

/** Closest hit along the ray. */
export function castRay(index: ObstacleIndex, origin: Vec3, dir: Vec3, opts: CastOptions = {}): RayHit {
  return traverse(index, origin, dir, opts, false);
}

/** Any hit (early exit) — use for shadow / visibility tests. */
export function anyHit(index: ObstacleIndex, origin: Vec3, dir: Vec3, opts: CastOptions = {}): RayHit {
  return traverse(index, origin, dir, opts, true);
}
