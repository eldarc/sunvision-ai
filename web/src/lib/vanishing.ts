/**
 * Oblique street photos: the street vanishing point of the window rows, and a camera started from it.
 *
 * A photo taken along a street (the facade receding towards a vanishing point inside the frame)
 * defeats a frontal start camera: the facade-regularity aligner only searches ±25° of heading
 * around its start, and with a wrong heading the storey-spacing FOV inference blows the FOV up to
 * its clamp. The strongest cue in such a photo is camera independent: the window rows of the
 * receding facade converge to one point. From it:
 *
 *   heading  = bearing of the facade line + atan((cx − xv)·cos(pitch) / f)        (inferred)
 *   pitch    = atan((yv − cy) / f)                                                 (inferred)
 *
 * For a level camera a facade line at height z has slope κ = (y − yv) / (x − xv) about the
 * vanishing point with z − h = −κ·d / cos α (d the camera's lateral distance from the facade,
 * α the angle between the optical axis and the facade, h the lens height). Heights therefore
 * scale with d, and the FOV only enters through cos α: in an oblique view the FOV is not the
 * scale lever, the lateral distance is. Without a GPS fix that distance comes from the map (the
 * opposite street wall minus an assumed pavement, else twice the distance to the street centre
 * line) and is labelled 'assumed'.
 *
 * Everything here is pure and deterministic; see lib/__tests__/vanishing.test.ts,
 * lib/__tests__/oblique.test.ts and lib/__tests__/vanishingExamples.test.ts.
 */
import type { CameraParams, Detection, Footprint, Provenance, Vec2, Vec3 } from '../schema/scene';
import { cameraBasis, facadePlane, focalFromHfov, pixelToRay, worldToPixel, type FacadePlane } from './camera';
import { diagnoseWindows, measureWindows, regularityContext, regularityCost, windowGrid } from './align';
import type { ViewGeometry } from './reconstruct';
import { firstHit, pointInRing } from './sceneBuilder';
import { bearingOf } from '../engine/geo';
import { nearestStreetSide, type Street } from './tiles';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const norm360 = (d: number) => ((d % 360) + 360) % 360;
/** Signed difference a − b of two bearings, in (−180, 180]. */
const angleDiff = (a: number, b: number) => {
  const d = norm360(a - b);
  return d > 180 ? d - 360 : d;
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};
const windowsOf = (dets: Detection[]) => dets.filter((d) => d.cls === 'window' && !d.deleted);

/* ------------------------------------------------------------------------------------------ */
/* Vanishing point of the window rows (camera independent)                                     */
/* ------------------------------------------------------------------------------------------ */

export interface RowVanishingPoint {
  /** Image position of the common point of the window rows (px). Infinite when the rows are parallel. */
  x: number;
  y: number;
  /** Rows used (the rows that agree on the point). */
  rows: number;
  /** Rms angle between each row and the direction from its centre to the point (deg). */
  rmsDeg: number;
  /** Spread of the row directions (deg): ≈ 0 for a frontal photo. */
  spreadDeg: number;
  /** The rows are parallel within noise (frontal photo: the vanishing point is at infinity). */
  parallel: boolean;
  /** Fewest windows in a row used (a two-row point always fits exactly, so it needs longer rows). */
  minRowWindows: number;
  /** Share of the row weight that agrees on the point (rows dropped as inconsistent make up the rest). */
  inlierShare: number;
}

interface RowLine {
  a: number;
  b: number;
  c: number;
  w: number;
  n: number;
  cx: number;
  cy: number;
  dx: number;
  dy: number;
}

function intersectLines(lines: RowLine[]) {
  let A11 = 0;
  let A12 = 0;
  let A22 = 0;
  let B1 = 0;
  let B2 = 0;
  for (const l of lines) {
    A11 += l.w * l.a * l.a;
    A12 += l.w * l.a * l.b;
    A22 += l.w * l.b * l.b;
    B1 -= l.w * l.a * l.c;
    B2 -= l.w * l.b * l.c;
  }
  const det = A11 * A22 - A12 * A12;
  const scale = Math.max(A11 * A22, 1e-12);
  if (Math.abs(det) < 1e-9 * scale) return null;
  return { x: (B1 * A22 - B2 * A12) / det, y: (A11 * B2 - A12 * B1) / det };
}

/** Angle (deg) between each row and the direction from its centre to (x, y). */
function rowAngles(lines: RowLine[], x: number, y: number) {
  return lines.map((l) => {
    const vx = x - l.cx;
    const vy = y - l.cy;
    const c = Math.abs(vx * l.dx + vy * l.dy) / (Math.hypot(vx, vy) || 1);
    return Math.acos(Math.min(1, c)) * R2D;
  });
}

/** A row agrees with a candidate point when its direction is within this angle of it (deg). */
const ROW_INLIER_DEG = 3;
/** Rows steeper than this (deg from the image horizontal) are stacks of boxes, not rows. */
const MAX_ROW_TILT_DEG = 50;

/** One total-least-squares line per window row (rows of ≥ 2 windows that are straight and not steep). */
function rowLines(detections: Detection[]): RowLine[] {
  const ws = new Map(windowsOf(detections).map((d) => [d.id, d]));
  const lines: RowLine[] = [];
  for (const row of windowGrid(detections, { mutualRows: true }).rows) {
    const ds = row.map((id) => ws.get(id)!).filter(Boolean);
    const pts = ds.map((d) => [(d.bbox[0] + d.bbox[2]) / 2, (d.bbox[1] + d.bbox[3]) / 2]);
    if (pts.length < 2) continue;
    const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (const [x, y] of pts) {
      sxx += (x - mx) ** 2;
      sxy += (x - mx) * (y - my);
      syy += (y - my) ** 2;
    }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    let dx = Math.cos(th);
    let dy = Math.sin(th);
    if (dx < 0) {
      dx = -dx;
      dy = -dy;
    }
    if (Math.abs(Math.atan2(dy, dx)) * R2D > MAX_ROW_TILT_DEG) continue;
    const span = Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0]));
    if (span < 1) continue;
    // Straight rows only: a chain that wanders between storeys is not one row.
    if (pts.length >= 3) {
      const res = Math.sqrt(pts.reduce((s, [x, y]) => s + (-dy * (x - mx) + dx * (y - my)) ** 2, 0) / pts.length);
      const hs = ds.map((d) => d.bbox[3] - d.bbox[1]).sort((a, b) => a - b);
      if (res > 0.3 * hs[Math.floor(hs.length / 2)]) continue;
    }
    lines.push({ a: -dy, b: dx, c: dy * mx - dx * my, w: (pts.length - 1) * span, n: pts.length, cx: mx, cy: my, dx, dy });
  }
  return lines;
}

/**
 * The common point of the detected window rows, camera independent. Rows come from
 * lib/align `windowGrid` with mutual-neighbour linking (independent of the image direction);
 * steep or crooked chains are dropped. One total-least-squares line per row through the
 * window-box centres (weight (n − 1) × horizontal span); the point is found robustly: every
 * pairwise intersection is a candidate, the one most row weight agrees with (within
 * ROW_INLIER_DEG) wins, and it is refined by weighted least squares over the agreeing rows.
 * Rows that disagree are dropped (`inlierShare` says how much weight that was).
 * Returns null with fewer than two usable rows.
 */
export function vanishingPointFromRows(detections: Detection[]): RowVanishingPoint | null {
  const all = rowLines(detections);
  if (all.length < 2) return null;
  const totalW = all.reduce((s, l) => s + l.w, 0);
  const spreadOf = (ls: RowLine[]) => {
    const dirs = ls.map((l) => Math.atan2(l.dy, l.dx) * R2D);
    return Math.max(...dirs) - Math.min(...dirs);
  };
  const result = (ls: RowLine[], p: { x: number; y: number } | null): RowVanishingPoint => {
    const spreadDeg = spreadOf(ls);
    const minRowWindows = Math.min(...ls.map((l) => l.n));
    const inlierShare = ls.reduce((s, l) => s + l.w, 0) / totalW;
    if (!p) return { x: Infinity, y: Infinity, rows: ls.length, rmsDeg: 0, spreadDeg, parallel: true, minRowWindows, inlierShare };
    const e = rowAngles(ls, p.x, p.y);
    const rms = Math.sqrt(e.reduce((s, v) => s + v * v, 0) / e.length);
    return { x: p.x, y: p.y, rows: ls.length, rmsDeg: rms, spreadDeg, parallel: spreadDeg < 3, minRowWindows, inlierShare };
  };
  // Parallel rows (a frontal photo): no finite point to look for.
  if (spreadOf(all) < 3) return result(all, intersectLines(all));
  // Candidates: pairwise intersections; score = row weight within ROW_INLIER_DEG.
  let best: { ls: RowLine[]; score: number; rms: number } | null = null;
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++) {
      const p = intersectLines([all[i], all[j]]);
      if (!p) continue;
      const e = rowAngles(all, p.x, p.y);
      const ls = all.filter((_, k) => e[k] < ROW_INLIER_DEG);
      const score = ls.reduce((s, l) => s + l.w, 0);
      const rms = Math.sqrt(e.filter((v) => v < ROW_INLIER_DEG).reduce((s, v) => s + v * v, 0) / Math.max(1, ls.length));
      if (!best || score > best.score * (1 + 1e-9) || (Math.abs(score - best.score) <= best.score * 1e-9 && rms < best.rms)) best = { ls, score, rms };
    }
  if (!best || best.ls.length < 2) return result(all, intersectLines(all));
  // Refine on the agreeing rows (re-select them against the refined point, twice).
  let ls = best.ls;
  let p = intersectLines(ls);
  for (let it = 0; it < 2 && p; it++) {
    const e = rowAngles(all, p.x, p.y);
    const next = all.filter((_, k) => e[k] < ROW_INLIER_DEG);
    if (next.length < 2) break;
    const q = intersectLines(next);
    if (!q) break;
    ls = next;
    p = q;
  }
  return result(ls, p);
}

/* ------------------------------------------------------------------------------------------ */
/* Oblique street view                                                                          */
/* ------------------------------------------------------------------------------------------ */

/** When a photo counts as an oblique street view (see streetPerspective). */
export const OBLIQUE_GATE = {
  /** Rows of ≥ 2 windows that agree on the point. */
  minRows: 2,
  /** With only two rows (which always meet exactly) each needs at least this many windows. */
  minWindowsTwoRows: 3,
  /** Share of the row weight that must agree on the point. */
  minInlierShare: 0.5,
  /** Rms angle of the rows about the point (deg). */
  maxRmsDeg: 6,
  /** The rows must converge visibly (deg): parallel rows are a frontal photo. */
  minSpreadDeg: 3,
  /** |xv − cx| below this many image widths (a far-away point is a near-frontal photo). */
  maxOffsetWidths: 1.5,
  /** |yv − cy| below this many image heights (the point is a horizon point, not a vertical one). */
  maxOffsetHeights: 1,
  /**
   * Share of the windows on the receding facade's side of the point (a majority; obliqueStart
   * also tries the other side when it has windows, so an opposite wall with many windows does
   * not decide the side alone).
   */
  minSideShare: 0.5,
};

export interface StreetPerspective {
  /** Street (facade-row) vanishing point in image pixels. */
  vp: { x: number; y: number };
  rows: number;
  rmsDeg: number;
  spreadDeg: number;
  /** Side of the vanishing point the receding facade is on (where most windows are). */
  facadeSide: 'right' | 'left';
  /** Windows on the receding facade's side of the point / on the other side (the opposite street wall). */
  facadeWindowIds: string[];
  otherWindowIds: string[];
}

/**
 * The photo's street vanishing point when it is an oblique street view (OBLIQUE_GATE), else null.
 * Frontal photos (parallel rows, a far-away point) and inconsistent row sets return null, so
 * they go through the frontal pipeline.
 */
export function streetPerspective(detections: Detection[], image: { width: number; height: number }): StreetPerspective | null {
  const v = vanishingPointFromRows(detections);
  if (!v || v.parallel || !Number.isFinite(v.x) || !Number.isFinite(v.y)) return null;
  const g = OBLIQUE_GATE;
  if (v.rows < g.minRows || v.rmsDeg > g.maxRmsDeg || v.spreadDeg < g.minSpreadDeg) return null;
  if (v.rows === 2 && v.minRowWindows < g.minWindowsTwoRows) return null;
  if (v.inlierShare < g.minInlierShare) return null;
  if (Math.abs(v.x - image.width / 2) > g.maxOffsetWidths * image.width) return null;
  if (Math.abs(v.y - image.height / 2) > g.maxOffsetHeights * image.height) return null;
  const ws = windowsOf(detections);
  const right = ws.filter((d) => (d.bbox[0] + d.bbox[2]) / 2 > v.x);
  const left = ws.filter((d) => (d.bbox[0] + d.bbox[2]) / 2 <= v.x);
  const side: 'right' | 'left' = right.length >= left.length ? 'right' : 'left';
  const mine = side === 'right' ? right : left;
  if (mine.length < g.minSideShare * ws.length) return null;
  return {
    vp: { x: v.x, y: v.y },
    rows: v.rows,
    rmsDeg: v.rmsDeg,
    spreadDeg: v.spreadDeg,
    facadeSide: side,
    facadeWindowIds: mine.map((d) => d.id),
    otherWindowIds: (side === 'right' ? left : right).map((d) => d.id),
  };
}

/**
 * Horizontal unit direction along a facade plane, oriented so that the facade is on `side` of a
 * viewer looking along it (the direction that recedes towards the vanishing point).
 */
export function recedingDirection(pl: Pick<FacadePlane, 'normal'>, side: 'right' | 'left'): Vec2 {
  const n = pl.normal;
  return side === 'right' ? [n[1], -n[0]] : [-n[1], n[0]];
}

/** Where a horizontal world direction vanishes in the photo (null when it points behind the camera). */
export function vanishingPixel(cam: CameraParams, image: { width: number; height: number }, dir: Vec2): Vec2 | null {
  const b = cameraBasis(cam, image.width, image.height);
  const far: Vec3 = [b.eye[0] + dir[0] * 1e6, b.eye[1] + dir[1] * 1e6, b.eye[2]];
  return worldToPixel(b, far);
}

/** Angle (deg) between the ray through image point `vp` and the horizontal world direction `dir`. */
export function vanishingAngleError(cam: CameraParams, image: { width: number; height: number }, vp: { x: number; y: number }, dir: Vec2): number {
  const b = cameraBasis(cam, image.width, image.height);
  const r = pixelToRay(b, vp.x, vp.y);
  const l = Math.hypot(dir[0], dir[1]) || 1;
  const c = (r[0] * dir[0] + r[1] * dir[1]) / l;
  return Math.acos(clamp(c, -1, 1)) * R2D;
}

/* ------------------------------------------------------------------------------------------ */
/* Camera from the vanishing point                                                              */
/* ------------------------------------------------------------------------------------------ */

/** Pavement assumed between the camera and the opposite street wall (m). */
export const ASSUMED_PAVEMENT_M = 3;
/** Lateral camera distance limits (m). */
export const LATERAL_RANGE: [number, number] = [6, 30];
/** A start camera whose predicted street vanishing point is off by more than this (deg) is re-initialised. */
export const VP_REINIT_DEG = 8;

/** Edges of `ring` collinear with edge `i` (short jogs < 2 m pass), as one straight facade run. */
function facadeRun(ring: Vec2[], i: number) {
  const n = ring.length;
  const a = ring[i];
  const b = ring[(i + 1) % n];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const t: Vec2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  const off = (p: Vec2) => Math.abs((p[0] - a[0]) * t[1] - (p[1] - a[1]) * t[0]);
  const along = (p: Vec2) => (p[0] - a[0]) * t[0] + (p[1] - a[1]) * t[1];
  const edges = [i];
  const ok = (k: number) => {
    const p = ring[k % n];
    const q = ring[(k + 1) % n];
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (l < 2) return off(p) < 2 && off(q) < 2;
    const dirOk = Math.abs((q[0] - p[0]) * t[0] + (q[1] - p[1]) * t[1]) / l > Math.cos(12 * D2R) && (q[0] - p[0]) * t[0] + (q[1] - p[1]) * t[1] > 0;
    return dirOk && off(p) < 2 && off(q) < 2;
  };
  for (let k = 1; k < n - 1; k++) {
    const j = (i + k) % n;
    if (!ok(j)) break;
    edges.push(j);
  }
  for (let k = 1; k < n - 1; k++) {
    const j = (i - k + n) % n;
    if (edges.includes(j) || !ok(j)) break;
    edges.push(j);
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const e of edges) for (const p of [ring[e], ring[(e + 1) % n]]) {
    lo = Math.min(lo, along(p));
    hi = Math.max(hi, along(p));
  }
  return { edges, a: [a[0] + t[0] * lo, a[1] + t[1] * lo] as Vec2, t, length: hi - lo };
}

/**
 * Distance from facade point p along its outward normal n to the first edge of another footprint
 * (Infinity when none within 80 m). The ray starts 0.5 m out, so the collinear facades of the
 * neighbours in the same row (and party walls at a junction) are not hit at t ≈ 0.
 */
function wallDistance(p: Vec2, n: Vec2, others: Footprint[]): number {
  const h = firstHit(others, [p[0] + n[0] * 0.5, p[1] + n[1] * 0.5], bearingOf(n[0], n[1]));
  return h && h.t < 79.5 ? h.t + 0.5 : Infinity;
}

/** Distance from p along n to the first street centre line (Infinity when none within 60 m). */
function streetDistance(p: Vec2, n: Vec2, roads: { line: Vec2[] }[]): number {
  let best = Infinity;
  for (const r of roads)
    for (let k = 1; k < r.line.length; k++) {
      const a = r.line[k - 1];
      const b = r.line[k];
      const ex = b[0] - a[0];
      const ey = b[1] - a[1];
      const den = n[0] * ey - n[1] * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((a[0] - p[0]) * ey - (a[1] - p[1]) * ex) / den;
      const u = ((a[0] - p[0]) * n[1] - (a[1] - p[1]) * n[0]) / den;
      if (t > 0.5 && t < 60 && u >= 0 && u <= 1) best = Math.min(best, t);
    }
  return best;
}

/** Buildings the camera sees (first footprint hit across the FOV, within 120 m), as buildTileScene does. */
export function visibleBuildings(footprints: Footprint[], targetId: string, position: Vec2, heading: number, hfov: number): string[] {
  const out = new Set<string>();
  for (let a = -hfov / 2; a <= hfov / 2 + 1e-9; a += hfov / 24) {
    const hit = firstHit(footprints, position, heading + a);
    if (hit && hit.t < 120 && hit.fp.id !== targetId) out.add(hit.fp.id);
  }
  return [...out];
}

/**
 * Camera position along a facade run of length L (0 = abeam its near end, + towards the far
 * end) such that the run spans as many windows as possible, the windows lying `s` metres ahead
 * of the camera along the street. Every position in the widest range that achieves that count is
 * equally consistent with the photo, so the middle of the range is used (the least-biased guess).
 */
export function alongPosition(s: number[], L: number): number {
  if (!s.length) return 0;
  const lo = Math.min(...s.map((v) => -v));
  const hi = Math.max(...s.map((v) => L - v));
  const step = Math.max(0.25, (hi - lo) / 400);
  let bestN = -1;
  let runs: [number, number][] = [];
  let cur: [number, number] | null = null;
  for (let c = lo; c <= hi + 1e-9; c += step) {
    let k = 0;
    for (const v of s) if (c + v >= -1e-6 && c + v <= L + 1e-6) k++;
    if (k > bestN) {
      bestN = k;
      runs = [];
      cur = null;
    }
    if (k === bestN) {
      if (cur) cur[1] = c;
      else {
        cur = [c, c];
        runs.push(cur);
      }
    } else cur = null;
  }
  const best = runs.reduce((a, r) => (r[1] - r[0] > a[1] - a[0] ? r : a), runs[0] ?? [0, 0]);
  return (best[0] + best[1]) / 2;
}

export interface PerspectiveCamera {
  camera: CameraParams;
  facadeEdgeIndex: number;
  visibleBuildingIds: string[];
  /** Lateral distance from the facade (m) and where it came from. */
  lateral: number;
  lateralBasis: 'kept' | 'opposite-wall' | 'street' | 'default';
  notes: string[];
}

/**
 * Start camera of an oblique street view, for the facade the view targets: heading and pitch from
 * the vanishing point (inferred); the position (unless observed or manual) at the lateral
 * distance from the map, along the street where the facade spans the receding windows
 * (the middle of the positions that do), labelled assumed. The FOV and lens height are kept.
 */
export function cameraFromPerspective(view: ViewGeometry, cam: CameraParams, p: StreetPerspective): PerspectiveCamera | null {
  const target = view.footprints.find((f) => f.id === view.targetBuildingId);
  if (!target || target.ring.length < 3) return null;
  const W = view.image.width;
  const H = view.image.height;
  const pl = facadePlane(target.id, target.ring, view.facadeEdgeIndex);
  const n: Vec2 = [pl.normal[0], pl.normal[1]];
  const dir = recedingDirection(pl, p.facadeSide);
  const dirBearing = bearingOf(dir[0], dir[1]);
  const f = focalFromHfov(W, cam.hfov);
  // A manual or observed pitch (and its roll) is kept: only heading and position are re-started.
  const keepPitch = FIXED.includes(cam.provenance.pitch);
  const pitch = keepPitch ? cam.pitch : clamp(Math.atan((p.vp.y - H / 2) / f) * R2D, -20, 40);
  const cp = Math.cos(pitch * D2R);
  const delta = Math.atan(((p.vp.x - W / 2) * cp) / f) * R2D; // azimuth of the vanishing point right of the axis
  const heading = norm360(dirBearing - delta);
  const r1 = (v: number) => Math.round(v * 10) / 10;

  const notes: string[] = [];
  const sideWord = p.facadeSide === 'right' ? 'right' : 'left';
  notes.push(
    `Oblique street view: the ${p.rows} window rows converge to a vanishing point at (${Math.round(p.vp.x)}, ${Math.round(p.vp.y)}) px (rms ${r1(p.rmsDeg)}°), with the facade receding on the ${sideWord}. ` +
      (keepPitch
        ? `Heading ${r1(heading)}° inferred from it (camera looks along the facade, which runs to ${Math.round(dirBearing)}°); pitch ${r1(pitch)}° and roll kept (${cam.provenance.pitch}).`
        : `Heading ${r1(heading)}° and pitch ${r1(pitch)}° inferred from it (camera looks along the facade, which runs to ${Math.round(dirBearing)}°).`),
  );
  // Without a focal length the heading leans on the assumed FOV once the point is far off-centre.
  if (cam.provenance.hfov === 'assumed' && Math.abs(p.vp.x - W / 2) > 0.7 * W)
    notes.push(
      `The vanishing point lies far outside the frame and the photo has no focal length, so this heading depends on the assumed ${cam.hfov}° field of view and may be several degrees off; heights may be off accordingly.`,
    );

  let position: Vec2 = [cam.position[0], cam.position[1]];
  let lateral = (cam.position[0] - pl.a[0]) * n[0] + (cam.position[1] - pl.a[1]) * n[1];
  let lateralBasis: PerspectiveCamera['lateralBasis'] = 'kept';
  const keepPos = cam.provenance.position === 'observed' || cam.provenance.position === 'manual';
  if (!keepPos) {
    const run = facadeRun(target.ring, view.facadeEdgeIndex);
    // the run's start along `dir` (near end) and its length
    const sgn = run.t[0] * dir[0] + run.t[1] * dir[1] >= 0 ? 1 : -1;
    const near: Vec2 = sgn > 0 ? run.a : [run.a[0] + run.t[0] * run.length, run.a[1] + run.t[1] * run.length];
    const L = run.length;
    const others = view.footprints.filter((o) => o.id !== target.id);
    const roads = (view as { roads?: { line: Vec2[] }[] }).roads ?? [];
    // Window rays: angle from the receding direction towards the facade side, from the image x.
    const byId = new Map(windowsOf(view.analysis.detections).map((d) => [d.id, d]));
    const phis: number[] = [];
    for (const id of p.facadeWindowIds) {
      const d = byId.get(id);
      if (!d) continue;
      const x = (d.bbox[0] + d.bbox[2]) / 2;
      const beta = Math.atan(((x - W / 2) * cp) / f) * R2D;
      const phi = p.facadeSide === 'right' ? beta - delta : delta - beta;
      if (phi > 0.5 && phi < 89) phis.push(phi);
    }
    // Lateral distance from the map (median over the stretch of street the receding windows
    // cover, so a side-street mouth or a jog does not decide it) and the along-street position
    // (the facade must span the windows), solved together: they depend on each other.
    let sc = 0;
    let d = 15;
    let mapDist = 15;
    let span: [number, number] = [0, L];
    const medianOf = (xs: number[]) => quantile(xs, 0.5);
    for (let it = 0; it < 3; it++) {
      const u0 = clamp(span[0], 0, L);
      const u1 = clamp(span[1], 0, L);
      const [a0, a1] = u1 - u0 >= 5 ? [u0, u1] : [0, L];
      const walls: number[] = [];
      const streets: number[] = [];
      for (let k = 0; k <= 8; k++) {
        const u = a0 + ((a1 - a0) * k) / 8;
        const base: Vec2 = [near[0] + dir[0] * u, near[1] + dir[1] * u];
        const w = wallDistance(base, n, others);
        if (w < 60) walls.push(w);
        const st = streetDistance(base, n, roads);
        if (Number.isFinite(st)) streets.push(st);
      }
      if (walls.length >= 3) {
        const wall = medianOf(walls);
        d = clamp(wall - ASSUMED_PAVEMENT_M, Math.min(LATERAL_RANGE[0], wall - 1.5), LATERAL_RANGE[1]);
        lateralBasis = 'opposite-wall';
        mapDist = wall;
      } else if (streets.length >= 3) {
        const street = medianOf(streets);
        // no opposite wall in the map: assume a symmetric street (the opposite facade line twice
        // the centre-line distance away) and the same pavement in front of it as above
        d = clamp(2 * street - ASSUMED_PAVEMENT_M, LATERAL_RANGE[0], LATERAL_RANGE[1]);
        lateralBasis = 'street';
        mapDist = street;
      } else {
        const cur = (cam.position[0] - pl.a[0]) * n[0] + (cam.position[1] - pl.a[1]) * n[1];
        d = cur >= LATERAL_RANGE[0] && cur <= LATERAL_RANGE[1] ? cur : 15;
        lateralBasis = 'default';
        mapDist = d;
      }
      if (!phis.length) break;
      const s = phis.map((ph) => d / Math.tan(ph * D2R));
      sc = alongPosition(s, L);
      span = [sc + quantile(s, 0.1), sc + quantile(s, 0.9)];
    }
    // The receding windows reach along more street than the picked facade is long: some are on
    // the neighbours, and which stretch is the picked building is not observed.
    const sAll = phis.map((ph) => d / Math.tan(ph * D2R));
    const reach = sAll.length >= 2 ? quantile(sAll, 0.95) - quantile(sAll, 0.05) : 0;
    const alongUncertain = reach > 1.2 * L + 2;
    const at = (dd: number): Vec2 => [near[0] + dir[0] * sc + n[0] * dd, near[1] + dir[1] * sc + n[1] * dd];
    let dd = d;
    while (dd > 2 && view.footprints.some((o) => pointInRing(at(dd), o.ring))) dd -= 0.5;
    position = at(dd);
    const wallTxt =
      lateralBasis === 'opposite-wall'
        ? `the opposite street wall is ${r1(mapDist)} m away in the map, minus an assumed ${ASSUMED_PAVEMENT_M} m pavement`
        : lateralBasis === 'street'
          ? `no opposite wall in the map: twice the ${r1(mapDist)} m to the street centre line, minus an assumed ${ASSUMED_PAVEMENT_M} m pavement`
          : 'no opposite wall or street in the map; distance kept/assumed';
    const alongTxt = Math.abs(sc) < 0.5 ? 'abeam the near end of the facade' : sc < 0 ? `${r1(-sc)} m before the near end of the facade` : `${r1(sc)} m along the facade from its near end`;
    notes.push(
      `Camera position assumed ${r1(dd)} m out from the facade (${wallTxt}), ${alongTxt}, so the receding windows fall on it. ` +
        `In an oblique view heights scale with this distance (not with the field of view); lens height ${cam.height} m (${cam.provenance.height}).`,
    );
    if (alongUncertain)
      notes.push(
        `The receding windows reach along about ${Math.round(reach)} m of street, more than this ${Math.round(L)} m facade: some belong to the neighbours, and where along the street the camera stood is a guess. Windows may be assigned to the wrong building; drag the camera dot to where you stood.`,
      );
    lateral = dd;
  } else {
    notes.push(`Camera position kept (${cam.provenance.position}); only the viewing direction${keepPitch ? '' : ' and pitch'} come${keepPitch ? 's' : ''} from the vanishing point.`);
  }

  const camera: CameraParams = {
    ...cam,
    position,
    heading: r1(heading),
    pitch: keepPitch ? cam.pitch : r1(pitch),
    roll: keepPitch ? cam.roll : 0,
    provenance: {
      ...cam.provenance,
      position: keepPos ? cam.provenance.position : 'assumed',
      heading: 'inferred',
      pitch: keepPitch ? cam.provenance.pitch : 'inferred',
    },
    notes: [...replaceStartNotes(cam.notes ?? []), ...notes],
  };
  const visibleBuildingIds = visibleBuildings(view.footprints, target.id, position, camera.heading, camera.hfov);
  // The target edge most windows land on becomes the facade (a run can be several edges).
  const v2: ViewGeometry = { ...view, visibleBuildingIds };
  const counts = new Map<number, number>();
  for (const h of measureWindows(v2, camera, view.analysis.detections).hits) if (h.plane.buildingId === target.id) counts.set(h.plane.edgeIndex, (counts.get(h.plane.edgeIndex) ?? 0) + 1);
  let facadeEdgeIndex = view.facadeEdgeIndex;
  let bestN = counts.get(facadeEdgeIndex) ?? 0;
  for (const [e, c] of counts) if (c > bestN) {
    bestN = c;
    facadeEdgeIndex = e;
  }
  return { camera, facadeEdgeIndex, visibleBuildingIds, lateral, lateralBasis, notes };
}

/**
 * The start camera's placement notes that no longer hold once the camera looks along the street
 * ("camera assumed 15 m in front of the facade …") are replaced by one that says what happened;
 * earlier notes of this module are dropped (they are re-added).
 */
function replaceStartNotes(notes: string[]): string[] {
  const out: string[] = [];
  for (const n of notes) {
    if (n.startsWith('Oblique street view') || n.startsWith('Camera position assumed') || n.startsWith('Camera position kept') || n.startsWith('Start camera replaced')) continue;
    if (/m in front of (the|it)\b/.test(n) && /assumed/.test(n)) {
      const side = /^You picked the ([\w-]+) facade/.exec(n);
      out.push(
        side
          ? `Start camera replaced: you picked the ${side[1]} facade, and the photo looks along it rather than straight at it, so the camera was placed along the street from the photo's perspective.`
          : 'Start camera replaced: the photo looks along the street rather than straight at the facade, so the camera was placed along the street from the photo\'s perspective.',
      );
      continue;
    }
    out.push(n);
  }
  return out;
}

/** Note on the FOV of an oblique street view whose FOV is only assumed (see calibrateViewCamera). */
export const OBLIQUE_FOV_NOTE = (hfov: number) =>
  `Field of view not inferred from storey spacing: in this oblique street view heights depend on the camera's distance from the facade (from the map, assumed), not on the field of view (${hfov}°, assumed; facade regularity may still refine it).`;

function withFovNote(cam: CameraParams): CameraParams {
  if (cam.provenance.hfov !== 'assumed') return cam;
  return { ...cam, notes: [...(cam.notes ?? []).filter((n) => !n.startsWith('Field of view not inferred')), OBLIQUE_FOV_NOTE(cam.hfov)] };
}

/* ------------------------------------------------------------------------------------------ */
/* The step every camera solve starts with                                                      */
/* ------------------------------------------------------------------------------------------ */

export interface VanishingConstraint {
  x: number;
  y: number;
  /** Horizontal world direction that vanishes at (x, y). */
  dir: Vec2;
  /** σ of the angular residual (deg). */
  sigmaDeg?: number;
}

export interface ObliqueStart {
  camera: CameraParams;
  /** Facade edge / visible buildings for the returned camera (equal to the input's when nothing changed). */
  facadeEdgeIndex: number;
  visibleBuildingIds: string[] | undefined;
  /** The camera was re-initialised from the vanishing point. */
  applied: boolean;
  /** Non-null when the photo is an oblique street view and the returned camera agrees with it. */
  perspective: StreetPerspective | null;
  /** Vanishing-point term for autoAlignCamera (set with `perspective`). */
  constraint?: VanishingConstraint;
  notes: string[];
}

const FIXED: Provenance[] = ['manual', 'observed'];

/** A camera note saying why the start camera was kept (shown in the Inspector, replaced on re-runs). */
const KEPT_PREFIX = 'The window rows converge to a vanishing point';
function withKeptNote(cam: CameraParams, note: string): CameraParams {
  return { ...cam, notes: [...(cam.notes ?? []).filter((n) => !n.startsWith(KEPT_PREFIX)), note] };
}

/** The same perspective with the facade on the other side of the vanishing point (the minority windows). */
function otherSide(p: StreetPerspective): StreetPerspective {
  return { ...p, facadeSide: p.facadeSide === 'right' ? 'left' : 'right', facadeWindowIds: p.otherWindowIds, otherWindowIds: p.facadeWindowIds };
}

/**
 * Facade edge of the target an oblique street view most likely looks along: the one facing the
 * nearest street with lesser streets counted further away (lib/tiles nearestStreetSide with
 * `classPenalty`). Null without streets in the view.
 */
function mainStreetEdge(view: ViewGeometry, target: Footprint): { edge: number; street?: { name?: string; cls?: string } } | null {
  const roads = (view as { roads?: Street[] }).roads ?? [];
  if (!roads.length) return null;
  const side = nearestStreetSide(target, roads, { others: view.footprints.filter((f) => f.id !== target.id), classPenalty: true });
  if (!side) return null;
  const st = roads.find((r) => r.id === side.streetId);
  return { edge: side.edgeIndex, street: { name: st?.tags.name, cls: st?.tags.class ?? st?.tags.highway } };
}

/** Windows of the rows' facade side that a camera puts on the target. */
function targetHits(view: ViewGeometry, cam: CameraParams, detections: Detection[]) {
  return measureWindows(view, cam, detections).hits.filter((h) => h.plane.buildingId === view.targetBuildingId).length;
}

/**
 * Oblique street views only (streetPerspective): when the camera's predicted street vanishing
 * point is more than VP_REINIT_DEG off the measured one and its heading is neither manual nor
 * observed, re-initialise it from the vanishing point (cameraFromPerspective; a manual or
 * observed pitch and position are kept). Candidates:
 *  - the view's facade, and, when nobody chose the facade (heading and position assumed), the
 *    target facade on the main street (nearestStreetSide with the street-class penalty), first;
 *  - the facade on the side of the vanishing point most windows are on, and (with ≥ 4 windows
 *    there) on the other side.
 * A candidate must explain the windows better than the start camera (lower facade-regularity
 * cost, no larger within-row height spread, at least 80 % as many of the receding facade's windows
 * on a facade, some on the target); of
 * those the first is kept unless a later one is clearly better (cost lower by 15 %).
 * Frontal photos and cameras that already agree with the photo pass through unchanged
 * (idempotent). When the camera is kept although the rows disagree with it, the camera notes say so.
 */
export function obliqueStart(view: ViewGeometry, cam: CameraParams, detections: Detection[] = view.analysis.detections): ObliqueStart {
  const same: ObliqueStart = { camera: cam, facadeEdgeIndex: view.facadeEdgeIndex, visibleBuildingIds: view.visibleBuildingIds, applied: false, perspective: null, notes: [] };
  const p = streetPerspective(detections, view.image);
  const target = view.footprints.find((f) => f.id === view.targetBuildingId);
  if (!p || !target) return same;
  const live: ViewGeometry = { ...view, analysis: { ...view.analysis, detections } };
  const constraintFor = (v: ViewGeometry, pp: StreetPerspective): VanishingConstraint => {
    const pl = facadePlane(target.id, target.ring, v.facadeEdgeIndex);
    return { x: pp.vp.x, y: pp.vp.y, dir: recedingDirection(pl, pp.facadeSide), sigmaDeg: 1 };
  };
  const c0 = constraintFor(view, p);
  const err0 = vanishingAngleError(cam, view.image, p.vp, c0.dir);
  if (err0 <= VP_REINIT_DEG) {
    const agreed = cam.notes?.some((n) => n.startsWith(KEPT_PREFIX)) ? { ...cam, notes: cam.notes!.filter((n) => !n.startsWith(KEPT_PREFIX)) } : cam;
    return { ...same, camera: withFovNote(agreed), perspective: p, constraint: c0 };
  }
  const vpTxt = `(${Math.round(p.vp.x)}, ${Math.round(p.vp.y)}) px`;
  if (FIXED.includes(cam.provenance.heading)) {
    const note = `${KEPT_PREFIX} ${vpTxt} that this ${cam.provenance.heading} viewing direction does not explain (${Math.round(err0)}° off); camera kept. If the photo looks along the street, check that the camera dot stands in front of the photographed facade (not past its corner) and that the direction follows the street.`;
    return { ...same, camera: withKeptNote(cam, note), notes: [note] };
  }

  // Candidate facades (main-street facade first when nobody chose one) × facade sides.
  const edges: { edge: number; note?: string }[] = [];
  const facadeFree = cam.provenance.heading === 'assumed' && !FIXED.includes(cam.provenance.position);
  if (facadeFree) {
    const m = mainStreetEdge(live, target);
    if (m && !facadeRun(target.ring, view.facadeEdgeIndex).edges.includes(m.edge)) {
      const st = m.street?.name ? `${m.street.name}${m.street.cls ? ` (${m.street.cls})` : ''}` : 'the main street';
      edges.push({
        edge: m.edge,
        note: `Facade assumed to be the one on ${st}: the photo looks along a street, and such views are taken along main streets rather than lanes.`,
      });
    }
  }
  edges.push({ edge: view.facadeEdgeIndex });
  const sides = p.otherWindowIds.length >= 4 ? [p, otherSide(p)] : [p];

  const ctxOpts = { mutualRows: true };
  const r0 = regularityCost(regularityContext(live, detections, ctxOpts), cam);
  const s0 = diagnoseWindows(live, cam, detections, {}, ctxOpts).rowZSpread;
  let best: { init: PerspectiveCamera; v1: ViewGeometry; pp: StreetPerspective; cost: number; note?: string } | null = null;
  let firstReject: string | null = null;
  for (const e of edges)
    for (const pp of sides) {
      const ve: ViewGeometry = { ...live, facadeEdgeIndex: e.edge };
      const init = cameraFromPerspective(ve, cam, pp);
      if (!init) continue;
      const v1: ViewGeometry = { ...ve, facadeEdgeIndex: init.facadeEdgeIndex, visibleBuildingIds: init.visibleBuildingIds };
      const r1 = regularityCost(regularityContext(v1, detections, ctxOpts), init.camera);
      const s1 = diagnoseWindows(v1, init.camera, detections, {}, ctxOpts).rowZSpread;
      // Windows of the receding facade that land on a facade: the other side's windows (the
      // opposite street wall) may rightly land on nothing when the map lacks that wall.
      const mine = new Set(pp.facadeWindowIds);
      const h0 = r0.hits.filter((h) => mine.has(h.id)).length;
      const h1 = r1.hits.filter((h) => mine.has(h.id)).length;
      const ok = r1.cost < r0.cost && s1 <= s0 && h1 >= 0.8 * h0 && targetHits(v1, init.camera, detections) > 0;
      if (!ok) {
        firstReject ??= `regularity ${r0.cost.toFixed(2)} → ${r1.cost.toFixed(2)}, row spread ${s0.toFixed(2)} → ${s1.toFixed(2)} m`;
        continue;
      }
      if (!best || r1.cost < 0.85 * best.cost) best = { init, v1, pp, cost: r1.cost, note: e.note };
    }
  if (!best) {
    const note = `${KEPT_PREFIX} ${vpTxt}, but a camera looking along the facade did not explain the windows better${firstReject ? ` (${firstReject})` : ''}; start camera kept. Check the camera direction.`;
    return { ...same, camera: withKeptNote(cam, note), notes: [note] };
  }
  const extra = best.note ? [best.note] : [];
  const camera = withFovNote({ ...best.init.camera, notes: [...(best.init.camera.notes ?? []).filter((n) => !n.startsWith(KEPT_PREFIX) && !n.startsWith('Facade assumed to be the one on')), ...extra] });
  return {
    camera,
    facadeEdgeIndex: best.init.facadeEdgeIndex,
    visibleBuildingIds: best.init.visibleBuildingIds,
    applied: true,
    perspective: best.pp,
    constraint: constraintFor(best.v1, best.pp),
    notes: [...best.init.notes, ...extra],
  };
}
