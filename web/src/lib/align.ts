/**
 * Camera alignment and facade-window regularisation.
 *
 * Three tools, all pure TypeScript, deterministic and dependency-free
 * (see docs/research/alignment.md for the measurements behind them):
 *
 *  autoAlignCamera            self-calibration from facade regularity: windows that
 *                             share an image row share a world height, windows in an
 *                             image column share a position along the facade, windows
 *                             are rectangles of consistent size and the facade meets
 *                             the street at z = 0. Nelder–Mead with restarts over the
 *                             camera parameters that are not 'manual'.
 *  solveFromCorrespondences   least-squares resection from picked footprint vertices
 *                             (port of scripts/solve_camera.py): ground points use the
 *                             full 2D residual, 'vertical' points only the horizontal
 *                             one with their height free. No building height is used.
 *  regularizeFacadeWindows    snaps 3D windows to their facade's row/column grid.
 *  minHeightFromWindows       lower bound for a building's height from its windows.
 *
 * Conventions are those of lib/camera.ts (ENU metres, heading clockwise from north).
 */
import type { AlignPoint, CameraParams, Detection, FacadeWindow, Footprint, Provenance, Vec2, Vec3 } from '../schema/scene';
import { cameraBasis, facadePlane, intersectFacade, pixelToRay, type CameraBasis, type FacadePlane } from './camera';
import { candidatePlanes, effectiveGroundline, type ViewGeometry } from './reconstruct';

/* ------------------------------------------------------------------------------------------ */
/* Types                                                                                        */
/* ------------------------------------------------------------------------------------------ */

export type AlignView = ViewGeometry & { camera: CameraParams; detections: Detection[] };

export interface AlignResult {
  camera: CameraParams;
  /** True when the returned camera differs from the input camera. */
  changed: boolean;
  /** Objective at the input camera (data terms only; the prior is 0 there). */
  cost0: number;
  /** Objective at the returned camera (data terms + prior). */
  cost: number;
  /** Individual terms at the returned camera (and `<term>0` at the input camera). */
  terms: Record<string, number>;
  /** Human-readable explanation of what changed and why. */
  notes: string[];
}

/** Camera parameters the auto-aligner can move. Position is split along / across the target facade. */
export type AlignParam = 'pitch' | 'roll' | 'hfov' | 'heading' | 'posNormal' | 'posAlong';
export const ALIGN_PARAMS: AlignParam[] = ['pitch', 'roll', 'hfov', 'heading', 'posNormal', 'posAlong'];

export interface AutoAlignOptions {
  /** Parameters to optimise. Default: every parameter whose provenance is not 'manual'. */
  free?: AlignParam[];
  /** Also free parameters whose provenance is 'manual' (diagnostics only; the UI should never do this). */
  includeManual?: boolean;
  /** Weights of the cost terms. */
  weights?: Partial<Record<'ground' | 'rows' | 'cols' | 'rect' | 'size' | 'coverage' | 'prior' | 'points' | 'vp', number>>;
  /**
   * Oblique street view (lib/vanishing obliqueStart): the measured street vanishing point and the
   * horizontal world direction that vanishes there. Adds an angular term (σ `sigmaDeg`, default 1°)
   * and makes the metric scale prior act on the lateral distance alone (in an oblique view heights
   * scale with the distance from the facade, not with the FOV).
   */
  vanishingPoint?: { x: number; y: number; dir: Vec2; sigmaDeg?: number };
  /** Minimum relative cost improvement to accept the new camera (default 0.05 = 5 %). */
  minImprovement?: number;
  /** Hard bounds on the horizontal FOV, e.g. from the EXIF focal length of a possibly cropped image. */
  hfovRange?: [number, number];
  /**
   * Picked correspondences added as a reprojection term (default: camera.alignment.points).
   * Lets a resected camera be refined jointly with facade regularity.
   */
  points?: AlignPoint[];
  /** Picking accuracy of `points` in pixels (σ of the reprojection term, default 15). */
  pointSigmaPx?: number;
  /**
   * Besides the cost, the metric misalignment of the windows (row-z spread + column-u spread,
   * metres, see diagnoseWindows) must drop by at least this much (default 0.05 m) and by 20 %.
   * Stops the optimiser from "improving" photos whose windows are already aligned to a few cm.
   */
  minSpreadGain?: number;
  /** Nelder–Mead restarts (default 3) and evaluations per run (default 350). */
  restarts?: number;
  maxEvals?: number;
}

/* ------------------------------------------------------------------------------------------ */
/* Small numeric helpers                                                                        */
/* ------------------------------------------------------------------------------------------ */

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mad(xs: number[]): number {
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

/** Truncated Cauchy loss: quadratic near 0, logarithmic in the tails, flat beyond 4σ. */
const RHO_CAP = Math.log(1 + 16);
function rho(x: number): number {
  return Math.min(Math.log(1 + x * x), RHO_CAP);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const windowsOf = (dets: Detection[]) => dets.filter((d) => d.cls === 'window' && !d.deleted);

/* ------------------------------------------------------------------------------------------ */
/* Image-space window grid (camera independent)                                                */
/* ------------------------------------------------------------------------------------------ */

export interface WindowGrid {
  /** Groups of detection ids that lie on one image row (chained left → right). */
  rows: string[][];
  /** Groups of detection ids that lie on one image column (chained top → bottom). */
  cols: string[][];
}

function unionFind(n: number) {
  const p = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (p[i] === i ? i : (p[i] = find(p[i])));
  return {
    union: (a: number, b: number) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) p[Math.max(ra, rb)] = Math.min(ra, rb);
    },
    groups: () => {
      const g = new Map<number, number[]>();
      for (let i = 0; i < n; i++) {
        const r = find(i);
        if (!g.has(r)) g.set(r, []);
        g.get(r)!.push(i);
      }
      return [...g.values()];
    },
  };
}

/**
 * Rows and columns of windows found by chaining nearest neighbours in the image.
 * Two windows are row neighbours when their vertical extents overlap by ≥ 45 % of the
 * smaller one, their heights are similar and the horizontal gap is at most ~3 window
 * widths (tolerates a missing window). Columns are the transpose. Chaining (rather than
 * clustering on a global y) follows the slanted rows of an oblique facade and the
 * converging columns of an upward-pitched photo, and does not depend on the camera.
 */
export function windowGrid(detections: Detection[], opts: { mutualRows?: boolean } = {}): WindowGrid {
  const ws = windowsOf(detections);
  const n = ws.length;
  const box = ws.map((d) => {
    const [x0, y0, x1, y1] = d.bbox;
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  });
  const rowsUF = unionFind(n);
  const colsUF = unionFind(n);
  // opts.mutualRows (oblique street views): row neighbours are linked only when each is the
  // other's best. With the default one-sided "best neighbour to the right" chaining, the last
  // visible window of a storey whose near windows are cut off by the frame (a facade receding on
  // the right of an oblique photo) links down to the bigger near windows of the storey below and
  // merges several storeys into one row; mutual linking does not depend on the image direction.
  // A row step steeper than 50° is then a stack of tall boxes (column-like), not a row.
  const mutual = !!opts.mutualRows;
  const rowLink = (a: (typeof box)[number], b: (typeof box)[number]) => {
    // b to the right of a; returns the gap, or Infinity when they are not row neighbours
    if (!(b.cx > a.cx)) return Infinity;
    const ov = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    const hr = b.h / a.h;
    const gap = b.x0 - a.x1;
    const steep = mutual && Math.abs(b.cy - a.cy) > 1.19 * (b.cx - a.cx);
    return ov >= 0.45 * Math.min(a.h, b.h) && hr > 0.6 && hr < 1.67 && !steep && gap > -0.5 * Math.min(a.w, b.w) && gap < 3 * Math.max(a.w, b.w) ? gap : Infinity;
  };
  const bestRight = new Array<number>(n).fill(-1);
  const bestLeft = new Array<number>(n).fill(-1);
  {
    const gR = new Array<number>(n).fill(Infinity);
    const gL = new Array<number>(n).fill(Infinity);
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const g = rowLink(box[i], box[j]);
        if (g < gR[i]) {
          gR[i] = g;
          bestRight[i] = j;
        }
        if (g < gL[j]) {
          gL[j] = g;
          bestLeft[j] = i;
        }
      }
  }
  for (let i = 0; i < n; i++) {
    const a = box[i];
    let bestC = -1;
    let bestCGap = Infinity;
    if (bestRight[i] >= 0 && (!mutual || bestLeft[bestRight[i]] === i)) rowsUF.union(i, bestRight[i]);
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const b = box[j];
      // column neighbour below
      if (b.cy > a.cy) {
        const ov = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const wr = b.w / a.w;
        const gap = b.y0 - a.y1;
        if (ov >= 0.4 * Math.min(a.w, b.w) && wr > 0.6 && wr < 1.67 && gap > -0.5 * Math.min(a.h, b.h) && gap < 2.5 * Math.max(a.h, b.h) && gap < bestCGap) {
          bestCGap = gap;
          bestC = j;
        }
      }
    }
    if (bestC >= 0) colsUF.union(i, bestC);
  }
  const ids = (g: number[]) => g.map((k) => ws[k].id);
  return {
    rows: rowsUF.groups().filter((g) => g.length >= 2).map(ids),
    cols: colsUF.groups().filter((g) => g.length >= 2).map(ids),
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Measuring windows on facade planes                                                          */
/* ------------------------------------------------------------------------------------------ */

export interface MeasuredWindow {
  id: string; // detection id
  plane: FacadePlane;
  /** Centre position along the edge (m) and height above ground (m). */
  u: number;
  z: number;
  /** Width / height measured on the plane (same method as reconstruct()). */
  w: number;
  h: number;
  /** Ray length to the centre (m). */
  t: number;
  /**
   * Shape skew of the segmentation outline on the plane (dimensionless):
   * [left edge, right edge] = Δu / height and [top edge, bottom edge] = Δz / width.
   * All four are 0 for a perfectly rectified rectangle. Empty when no polygon.
   */
  skew: number[];
}

/** The facade planes used for a view: camera-facing edges of photographed buildings + the target facade. */
export function viewPlanes(view: ViewGeometry, cam: CameraParams): FacadePlane[] {
  const planes = candidatePlanes(view, cam);
  const target = view.footprints.find((f) => f.id === view.targetBuildingId);
  if (target && !planes.some((p) => p.buildingId === target.id && p.edgeIndex === view.facadeEdgeIndex)) {
    planes.push(facadePlane(target.id, target.ring, view.facadeEdgeIndex));
  }
  return planes;
}

function firstHit(b: CameraBasis, planes: FacadePlane[], px: number, py: number, margin: number) {
  const dir = pixelToRay(b, px, py);
  let best: { t: number; u: number; z: number; plane: FacadePlane } | null = null;
  for (const pl of planes) {
    const h = intersectFacade(b.eye, dir, pl, margin);
    if (h && (!best || h.t < best.t)) best = { t: h.t, u: h.u, z: h.z, plane: pl };
  }
  return best;
}

function onPlane(b: CameraBasis, pl: FacadePlane, px: number, py: number) {
  return intersectFacade(b.eye, pixelToRay(b, px, py), pl, 1e6);
}

/** Corners of a (roughly quadrilateral) outline: TL, TR, BR, BL by extreme diagonal projections. */
function quadCorners(poly: Vec2[]): [Vec2, Vec2, Vec2, Vec2] | null {
  if (poly.length < 4) return null;
  let tl = poly[0];
  let tr = poly[0];
  let br = poly[0];
  let bl = poly[0];
  for (const p of poly) {
    if (p[0] + p[1] < tl[0] + tl[1]) tl = p;
    if (p[0] + p[1] > br[0] + br[1]) br = p;
    if (p[0] - p[1] > tr[0] - tr[1]) tr = p;
    if (p[0] - p[1] < bl[0] - bl[1]) bl = p;
  }
  return [tl, tr, br, bl];
}

/**
 * Project every window detection onto the nearest camera-facing facade plane, exactly
 * like reconstruct() does (centre ray → first plane; edges measured on that plane).
 */
export function measureWindows(view: ViewGeometry, cam: CameraParams, detections: Detection[], planes = viewPlanes(view, cam)) {
  const b = cameraBasis(cam, view.image.width, view.image.height);
  const hits: MeasuredWindow[] = [];
  const missed: string[] = [];
  for (const d of windowsOf(detections)) {
    const [x0, y0, x1, y1] = d.bbox;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const c = firstHit(b, planes, cx, cy, 0.1);
    if (!c) {
      missed.push(d.id);
      continue;
    }
    const l = onPlane(b, c.plane, x0, cy);
    const r = onPlane(b, c.plane, x1, cy);
    const t = onPlane(b, c.plane, cx, y0);
    const bt = onPlane(b, c.plane, cx, y1);
    if (!l || !r || !t || !bt) {
      missed.push(d.id);
      continue;
    }
    const w = Math.abs(r.u - l.u);
    const h = Math.abs(t.z - bt.z);
    const skew: number[] = [];
    const q = d.polygon ? quadCorners(d.polygon) : null;
    if (q && w > 0.05 && h > 0.05) {
      const P = q.map((p) => onPlane(b, c.plane, p[0], p[1]));
      if (P.every(Boolean)) {
        const [TL, TR, BR, BL] = P as NonNullable<(typeof P)[number]>[];
        skew.push((TL.u - BL.u) / h, (TR.u - BR.u) / h, (TL.z - TR.z) / w, (BL.z - BR.z) / w);
      }
    }
    hits.push({ id: d.id, plane: c.plane, u: c.u, z: c.z, w, h, t: c.t, skew });
  }
  return { hits, missed };
}

/* ------------------------------------------------------------------------------------------ */
/* Regularity cost                                                                              */
/* ------------------------------------------------------------------------------------------ */

const DEFAULT_WEIGHTS = { ground: 1, rows: 1, cols: 1, rect: 0.5, size: 0.5, coverage: 2, prior: 0.05, points: 1, vp: 1 };

/** Residual scales (σ) of the cost terms. Row/column residuals are relative to the median window size, so they are scale-free. */
const SIG = { ground: 0.4 /* m */, row: 0.08 /* × window height */, col: 0.08 /* × window width */, rect: 0.08, size: 0.08 };

export interface RegularityContext {
  view: ViewGeometry;
  detections: Detection[];
  grid: WindowGrid;
  groundline: { x: number; y: number }[];
}

export function regularityContext(view: ViewGeometry, detections: Detection[], opts: { mutualRows?: boolean } = {}): RegularityContext {
  return { view, detections, grid: windowGrid(detections, opts), groundline: plausibleGroundline(view, detections) };
}

/**
 * effectiveGroundline() without the samples that cannot be street level: a sample with a
 * window ending below it nearby (within ~1.5 window widths) sits on an awning, a canopy
 * or a shop sign, not on the pavement (Paris: the facade mask ends on the café awning,
 * above the entresol windows).
 */
export function plausibleGroundline(view: ViewGeometry, detections: Detection[] = view.analysis.detections) {
  const ws = windowsOf(detections).map((d) => d.bbox);
  return effectiveGroundline(view, detections).filter((p) => {
    for (const [x0, y0, x1, y1] of ws) {
      const w = x1 - x0;
      if (p.x < x0 - 1.5 * w || p.x > x1 + 1.5 * w) continue;
      if (y1 > p.y + 0.25 * (y1 - y0)) return false;
    }
    return true;
  });
}

const planeKey = (p: FacadePlane) => `${p.buildingId}#${p.edgeIndex}`;

/**
 * Facade-regularity cost of a camera (lower is better). Every term is a mean of a robust
 * loss, so terms are comparable across photos:
 *   ground   – facade ground line on z = 0                  (σ 0.4 m)
 *   rows     – windows of an image row share z on the same building (σ 8 % of window height)
 *   cols     – windows of an image column share u on the same plane  (σ 8 % of window width)
 *   rect     – segmentation outlines rectify to rectangles   (σ 0.08)
 *   size     – heights consistent along rows, widths along columns (log ratio, σ 0.08)
 *   coverage – fraction of windows that miss every facade plane
 */
export function regularityCost(ctx: RegularityContext, cam: CameraParams, weights: Partial<typeof DEFAULT_WEIGHTS> = {}) {
  const wt = { ...DEFAULT_WEIGHTS, ...weights };
  const { view } = ctx;
  const planes = viewPlanes(view, cam);
  const { hits, missed } = measureWindows(view, cam, ctx.detections, planes);
  const byId = new Map(hits.map((h) => [h.id, h]));
  const terms: Record<string, number> = {};

  // (i) ground line
  const b = cameraBasis(cam, view.image.width, view.image.height);
  let gs = 0;
  let gn = 0;
  for (const p of ctx.groundline) {
    const h = firstHit(b, planes, p.x, p.y, 0.25);
    gs += h ? rho(h.z / SIG.ground) : RHO_CAP;
    gn++;
  }
  terms.ground = gn ? gs / gn : 0;

  // (ii) rows share z (per building), (iv) heights consistent along rows
  let rs = 0;
  let rn = 0;
  let ss = 0;
  let sn = 0;
  for (const row of ctx.grid.rows) {
    const groups = new Map<string, MeasuredWindow[]>();
    for (const id of row) {
      const h = byId.get(id);
      if (h) (groups.get(h.plane.buildingId) ?? groups.set(h.plane.buildingId, []).get(h.plane.buildingId)!).push(h);
    }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const mz = median(g.map((m) => m.z));
      const mh = median(g.map((m) => m.h)) || 1;
      for (const m of g) {
        rs += rho((m.z - mz) / mh / SIG.row);
        ss += rho(Math.log(m.h / mh) / SIG.size);
      }
      rn += g.length;
      sn += g.length;
    }
  }
  terms.rows = rn ? rs / rn : 0;

  // (iii) columns share u (per plane), (iv) widths consistent along columns
  let cs = 0;
  let cn = 0;
  for (const col of ctx.grid.cols) {
    const groups = new Map<string, MeasuredWindow[]>();
    for (const id of col) {
      const h = byId.get(id);
      if (h) {
        const k = planeKey(h.plane);
        (groups.get(k) ?? groups.set(k, []).get(k)!).push(h);
      }
    }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const mu = median(g.map((m) => m.u));
      const mw = median(g.map((m) => m.w)) || 1;
      for (const m of g) {
        cs += rho((m.u - mu) / mw / SIG.col);
        ss += rho(Math.log(m.w / mw) / SIG.size);
      }
      cn += g.length;
      sn += g.length;
    }
  }
  terms.cols = cn ? cs / cn : 0;
  terms.size = sn ? ss / sn : 0;

  // (iv) rectangles
  let qs = 0;
  let qn = 0;
  for (const m of hits) for (const s of m.skew) {
    qs += rho(s / SIG.rect);
    qn++;
  }
  terms.rect = qn ? qs / qn : 0;

  const total = hits.length + missed.length;
  terms.coverage = total ? missed.length / total : 0;

  const cost =
    wt.ground * terms.ground + wt.rows * terms.rows + wt.cols * terms.cols + wt.rect * terms.rect + wt.size * terms.size + wt.coverage * terms.coverage;
  return { cost, terms, hits, missed };
}

/* ------------------------------------------------------------------------------------------ */
/* Field of view from storey spacing (only when the FOV is unknown)                             */
/* ------------------------------------------------------------------------------------------ */

/** Typical residential floor-to-floor height used ONLY when a photo has no focal length. */
export const TYPICAL_STOREY_M = 3.3;

/**
 * With no focal length in the metadata the FOV is a guess, and every metric height on the
 * facade scales with tan(hfov / 2) (the camera position comes from the map). Regularity
 * cannot see that scale, so this picks the FOV at which the target's window rows are
 * TYPICAL_STOREY_M apart. The result is labelled 'inferred' and the note states the
 * assumption; heights then carry roughly ±15 % from it. Returns the input unchanged when
 * the FOV is not 'assumed' or fewer than two rows of windows are visible.
 */
export function inferHfovFromStoreys(
  view: ViewGeometry,
  cam: CameraParams,
  detections: Detection[],
  storey = TYPICAL_STOREY_M,
): { camera: CameraParams; changed: boolean; note: string | null } {
  if (cam.provenance.hfov !== 'assumed') return { camera: cam, changed: false, note: null };
  let c = cam;
  let spacing = NaN;
  for (let it = 0; it < 6; it++) {
    const { hits } = measureWindows(view, c, detections);
    const t = hits.filter((h) => h.plane.buildingId === view.targetBuildingId);
    if (t.length < 4) return { camera: cam, changed: false, note: null };
    const mh = median(t.map((h) => h.h)) || 1;
    const rows = cluster1D(
      t.map((h, i) => ({ i, v: h.z })),
      Math.max(0.3, 0.75 * mh),
    );
    const centers = rows.filter((g) => g.length >= 1).map((g) => median(g.map((i) => t[i].z))).sort((a, b) => a - b);
    if (centers.length < 2) return { camera: cam, changed: false, note: null };
    const gaps: number[] = [];
    for (let i = 1; i < centers.length; i++) gaps.push(centers[i] - centers[i - 1]);
    spacing = median(gaps);
    if (!(spacing > 0.05)) return { camera: cam, changed: false, note: null };
    const k = storey / spacing;
    if (Math.abs(k - 1) < 0.005) break;
    const tanNew = Math.tan((c.hfov * Math.PI) / 360) * k;
    const hfov = clamp((2 * Math.atan(tanNew) * 180) / Math.PI, 15, 110);
    if (Math.abs(hfov - c.hfov) < 0.05) break;
    c = { ...c, hfov };
  }
  if (Math.abs(c.hfov - cam.hfov) < 0.2) return { camera: cam, changed: false, note: null };
  const note = `Field of view inferred as ${fmt(c.hfov)}° (was ${fmt(cam.hfov)}°, assumed): the photo has no focal length, so the scale is set by assuming its window rows are ~${storey} m storeys apart. Heights inherit this assumption (about ±15 %).`;
  const out: CameraParams = {
    ...c,
    hfov: Math.round(c.hfov * 10) / 10,
    hfovRange: [Math.round(c.hfov * 0.85 * 10) / 10, Math.round(c.hfov * 1.15 * 10) / 10],
    provenance: { ...c.provenance, hfov: 'inferred' },
    notes: [...(cam.notes ?? []).filter((n) => !n.startsWith('Field of view inferred')), note],
  };
  return { camera: out, changed: true, note };
}

/* ------------------------------------------------------------------------------------------ */
/* Nelder–Mead (bounded by clamping), deterministic                                            */
/* ------------------------------------------------------------------------------------------ */

function nelderMead(f: (x: number[]) => number, x0: number[], step: number[], maxEvals: number) {
  const n = x0.length;
  let evals = 0;
  const F = (x: number[]) => {
    evals++;
    return f(x);
  };
  let simplex: { x: number[]; v: number }[] = [{ x: [...x0], v: F(x0) }];
  for (let i = 0; i < n; i++) {
    const x = [...x0];
    x[i] += step[i];
    simplex.push({ x, v: F(x) });
  }
  while (evals < maxEvals) {
    simplex.sort((a, b) => a.v - b.v);
    const best = simplex[0];
    const worst = simplex[n];
    const spread = Math.abs(worst.v - best.v);
    if (spread < 1e-7 * (1 + Math.abs(best.v))) {
      let size = 0;
      for (let i = 1; i <= n; i++) for (let k = 0; k < n; k++) size = Math.max(size, Math.abs(simplex[i].x[k] - best.x[k]) / (step[k] || 1));
      if (size < 1e-3) break;
    }
    const c = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) c[k] += simplex[i].x[k] / n;
    const at = (t: number) => c.map((ck, k) => ck + t * (worst.x[k] - ck));
    const xr = at(-1);
    const vr = F(xr);
    if (vr < best.v) {
      const xe = at(-2);
      const ve = F(xe);
      simplex[n] = ve < vr ? { x: xe, v: ve } : { x: xr, v: vr };
    } else if (vr < simplex[n - 1].v) {
      simplex[n] = { x: xr, v: vr };
    } else {
      const outside = vr < worst.v;
      const xc = at(outside ? -0.5 : 0.5);
      const vc = F(xc);
      if (vc < (outside ? vr : worst.v)) simplex[n] = { x: xc, v: vc };
      else {
        simplex = simplex.map((s, i) => {
          if (i === 0) return s;
          const x = s.x.map((xk, k) => best.x[k] + 0.5 * (xk - best.x[k]));
          return { x, v: F(x) };
        });
      }
    }
  }
  simplex.sort((a, b) => a.v - b.v);
  return { x: simplex[0].x, v: simplex[0].v, evals };
}

/* ------------------------------------------------------------------------------------------ */
/* autoAlignCamera                                                                              */
/* ------------------------------------------------------------------------------------------ */

const BOUNDS: Record<AlignParam, { lo: number; hi: number; relative: boolean }> = {
  pitch: { lo: -20, hi: 50, relative: false },
  roll: { lo: -10, hi: 10, relative: false },
  hfov: { lo: 20, hi: 110, relative: false },
  heading: { lo: -25, hi: 25, relative: true },
  posNormal: { lo: -25, hi: 25, relative: true },
  posAlong: { lo: -25, hi: 25, relative: true },
};

/** Prior σ per provenance ('manual' params are not free, so they have no σ). */
const PRIOR_SIGMA: Record<AlignParam, Record<Exclude<Provenance, 'manual'>, number>> = {
  pitch: { observed: 1.5, inferred: 4, map: 4, assumed: 12 },
  roll: { observed: 1, inferred: 2, map: 2, assumed: 4 },
  hfov: { observed: 2, inferred: 5, map: 5, assumed: 20 },
  heading: { observed: 4, inferred: 6, map: 6, assumed: 15 },
  posNormal: { observed: 4, inferred: 6, map: 6, assumed: 12 },
  posAlong: { observed: 4, inferred: 6, map: 6, assumed: 12 },
};

/** σ of log(image scale on the target facade) per provenance (see the scale prior in autoAlignCamera). */
const SCALE_SIGMA: Record<Provenance, number> = { manual: 0.03, observed: 0.05, inferred: 0.1, map: 0.1, assumed: 0.3 };

function distToTarget(view: ViewGeometry, cam: CameraParams) {
  const fp = view.footprints.find((f) => f.id === view.targetBuildingId);
  if (!fp) return 20;
  const pl = facadePlane(fp.id, fp.ring, view.facadeEdgeIndex);
  return Math.abs((cam.position[0] - pl.a[0]) * pl.normal[0] + (cam.position[1] - pl.a[1]) * pl.normal[1]);
}

/** Initial simplex steps (parameter units). */
const STEP: Record<AlignParam, number> = { pitch: 3, roll: 1.5, hfov: 6, heading: 3, posNormal: 3, posAlong: 3 };

/** Provenance governing each optimisable parameter (roll has none of its own and follows pitch). */
export function paramProvenance(cam: CameraParams, p: AlignParam): Provenance {
  switch (p) {
    case 'pitch':
    case 'roll':
      return cam.provenance.pitch;
    case 'hfov':
      return cam.provenance.hfov;
    case 'heading':
      return cam.provenance.heading;
    default:
      return cam.provenance.position;
  }
}

function facadeFrame(view: ViewGeometry) {
  const fp = view.footprints.find((f) => f.id === view.targetBuildingId);
  if (!fp) return { n: [0, 1] as Vec2, t: [1, 0] as Vec2 };
  const pl = facadePlane(fp.id, fp.ring, view.facadeEdgeIndex);
  return { n: [pl.normal[0], pl.normal[1]] as Vec2, t: [(pl.b[0] - pl.a[0]) / pl.length, (pl.b[1] - pl.a[1]) / pl.length] as Vec2 };
}

function applyParams(cam0: CameraParams, free: AlignParam[], x: number[], frame: { n: Vec2; t: Vec2 }): CameraParams {
  const c: CameraParams = { ...cam0, position: [...cam0.position] as Vec2 };
  let dn = 0;
  let dt = 0;
  free.forEach((p, i) => {
    const v = x[i];
    if (p === 'pitch') c.pitch = v;
    else if (p === 'roll') c.roll = v;
    else if (p === 'hfov') c.hfov = v;
    else if (p === 'heading') c.heading = cam0.heading + v;
    else if (p === 'posNormal') dn = v;
    else dt = v;
  });
  c.position = [cam0.position[0] + dn * frame.n[0] + dt * frame.t[0], cam0.position[1] + dn * frame.n[1] + dt * frame.t[1]];
  return c;
}

function initialValue(cam: CameraParams, p: AlignParam) {
  if (p === 'pitch') return cam.pitch;
  if (p === 'roll') return cam.roll;
  if (p === 'hfov') return cam.hfov;
  return 0; // heading and position are optimised as offsets
}

/** Bounds in optimiser units (heading and position are offsets from the initial camera). */
const boundsFor = (p: AlignParam) => BOUNDS[p];

const fmt = (v: number, d = 1) => (Math.round(v * 10 ** d) / 10 ** d).toFixed(d);

/**
 * Self-calibrate the camera from facade regularity. Only parameters whose provenance is
 * not 'manual' move (unless `opts.free`/`includeManual` say otherwise). Returns the input
 * camera unchanged (changed = false) when the cost does not improve by `minImprovement`.
 */
export function autoAlignCamera(view: AlignView, opts: AutoAlignOptions = {}): AlignResult {
  const cam0 = view.camera;
  const wt = { ...DEFAULT_WEIGHTS, ...opts.weights };
  // Oblique street view: rows by mutual neighbours (see windowGrid), as the vanishing point was measured.
  const ctx = regularityContext(view, view.detections, { mutualRows: !!opts.vanishingPoint });
  // In an oblique street view without a ground line nothing in the cost observes the lateral
  // distance (every regularity term is scale-free and the vanishing point fixes only directions),
  // yet heights scale with it: keep it where the map put it instead of letting noise move it.
  const pinLateral = !!opts.vanishingPoint && !opts.free && ctx.groundline.length < 3;
  const free = (opts.free ?? ALIGN_PARAMS).filter((p) => (opts.includeManual || opts.free || paramProvenance(cam0, p) !== 'manual') && !(pinLateral && p === 'posNormal'));
  const base0 = regularityCost(ctx, cam0, wt);
  // Optional correspondence term (refines a resected camera jointly with regularity).
  const pts = resolvePoints(view, opts.points ?? cam0.alignment?.points ?? []);
  const sigPx = opts.pointSigmaPx ?? 15;
  const pointsCost = (c: CameraParams) => {
    if (!pts.length) return 0;
    const r = pointResiduals(c, view.image.width, view.image.height, pts);
    return (wt.points * r.reduce((a, v) => a + rho(v / sigPx), 0)) / r.length;
  };
  // Optional street vanishing-point term (oblique street views).
  const vpc = opts.vanishingPoint;
  const vpCost = (c: CameraParams) => {
    if (!vpc) return 0;
    const b = cameraBasis(c, view.image.width, view.image.height);
    const r = pixelToRay(b, vpc.x, vpc.y);
    const l = Math.hypot(vpc.dir[0], vpc.dir[1]) || 1;
    const ang = (Math.acos(clamp((r[0] * vpc.dir[0] + r[1] * vpc.dir[1]) / l, -1, 1)) * 180) / Math.PI;
    return wt.vp * rho(ang / (vpc.sigmaDeg ?? 1));
  };
  const pts0Cost = pointsCost(cam0) + vpCost(cam0);
  const baseTerms: Record<string, number> = { ...base0.terms };
  if (pts.length) baseTerms.points = pointsCost(cam0);
  if (vpc) baseTerms.vp = vpCost(cam0);
  const base = { ...base0, cost: base0.cost + pts0Cost, terms: baseTerms };
  const terms0 = Object.fromEntries(Object.entries(base.terms).map(([k, v]) => [k + '0', v]));
  const nWin = base.hits.length + base.missed.length;
  if (!free.length || nWin < 4) {
    return {
      camera: cam0,
      changed: false,
      cost0: base.cost,
      cost: base.cost,
      terms: { ...base.terms, ...terms0, prior: 0 },
      notes: [!free.length ? 'All camera parameters are manual; auto-alignment left them unchanged.' : 'Too few windows to self-calibrate from facade regularity.'],
    };
  }
  const frame = facadeFrame(view);
  const x0 = free.map((p) => initialValue(cam0, p));
  const lo = free.map((p) => (p === 'hfov' && opts.hfovRange ? Math.max(BOUNDS.hfov.lo, opts.hfovRange[0]) : boundsFor(p).lo));
  const hi = free.map((p) => (p === 'hfov' && opts.hfovRange ? Math.min(BOUNDS.hfov.hi, opts.hfovRange[1]) : boundsFor(p).hi));
  const sig = free.map((p) => {
    const pv = paramProvenance(cam0, p);
    return pv === 'manual' ? PRIOR_SIGMA[p].observed / 2 : PRIOR_SIGMA[p][pv];
  });
  // Metric scale prior. Every regularity term except the ground line is scale-free, and a
  // near-frontal photo barely separates FOV from distance, so the optimiser could trade one
  // for the other and silently rescale the building. The image scale on the target facade,
  // s = distance × tan(hfov / 2), is therefore kept close to the input camera's value with a
  // σ set by the weaker of the position / hfov provenances.
  // In an oblique street view the scale is the lateral distance alone (heights ∝ d / cos α).
  const scaleOf = (c: CameraParams) => Math.max(0.5, distToTarget(view, c)) * (vpc ? 1 : Math.tan((c.hfov * Math.PI) / 360));
  const s0 = scaleOf(cam0);
  const scaleFree = vpc ? free.includes('posNormal') : free.includes('hfov') || free.includes('posNormal');
  const sigScale = Math.max(SCALE_SIGMA[cam0.provenance.position], SCALE_SIGMA[cam0.provenance.hfov]);
  const prior = (x: number[], c: CameraParams) => {
    let s = 0;
    for (let i = 0; i < x.length; i++) s += ((x[i] - x0[i]) / sig[i]) ** 2;
    if (scaleFree) s += (Math.log(scaleOf(c) / s0) / sigScale) ** 2;
    return wt.prior * s;
  };
  const objective = (x: number[]) => {
    let pen = 0;
    const xc = x.map((v, i) => {
      const c = clamp(v, lo[i], hi[i]);
      pen += Math.abs(v - c);
      return c;
    });
    const c = applyParams(cam0, free, xc, frame);
    return regularityCost(ctx, c, wt).cost + pointsCost(c) + vpCost(c) + prior(xc, c) + 10 * pen;
  };
  const maxEvals = opts.maxEvals ?? 350;
  const restarts = opts.restarts ?? 3;
  const step = free.map((p) => STEP[p]);
  let best = nelderMead(objective, x0, step, maxEvals);
  for (let r = 1; r < restarts; r++) {
    const shrink = 1 / (r + 1);
    const next = nelderMead(objective, best.x, step.map((s, i) => s * shrink * (i % 2 === r % 2 ? 1 : -1)), maxEvals);
    if (next.v < best.v - 1e-9) best = next;
    else break;
  }
  const xb = best.x.map((v, i) => clamp(v, lo[i], hi[i]));
  const camB = applyParams(cam0, free, xb, frame);
  const fin0 = regularityCost(ctx, camB, wt);
  const ptsB = pointsCost(camB) + vpCost(camB);
  const finTerms: Record<string, number> = { ...fin0.terms };
  if (pts.length) finTerms.points = pointsCost(camB);
  if (vpc) finTerms.vp = vpCost(camB);
  const fin = { ...fin0, terms: finTerms };
  const priorB = prior(xb, camB);
  const costB = fin0.cost + ptsB + priorB;
  const minImp = opts.minImprovement ?? 0.05;
  const improvement = base.cost > 0 ? (base.cost - costB) / base.cost : 0;
  const d0 = diagnoseWindows(view, cam0, view.detections);
  const d1 = diagnoseWindows(view, camB, view.detections);
  const spread0 = d0.rowZSpread + d0.colUSpread;
  const spread = d1.rowZSpread + d1.colUSpread;
  const terms = { ...fin.terms, ...terms0, prior: priorB, improvement, spread0, spread };
  const minGain = opts.minSpreadGain ?? 0.05;
  const unchanged = (note: string): AlignResult => ({
    camera: cam0,
    changed: false,
    cost0: base.cost,
    cost: base.cost,
    terms: { ...base.terms, ...terms0, prior: 0, improvement, spread0, spread: spread0, candidateCost: costB, candidateSpread: spread },
    notes: [note],
  });
  if (!(improvement >= minImp)) {
    return unchanged(`Facade regularity improved by only ${fmt(improvement * 100)} % (< ${fmt(minImp * 100, 0)} %); camera left unchanged.`);
  }
  if (!(spread0 - spread >= minGain && spread <= 0.8 * spread0)) {
    return unchanged(`Windows already line up within ${fmt(spread0 * 100, 0)} cm (best candidate ${fmt(spread * 100, 0)} cm); camera left unchanged.`);
  }

  // Describe the change and update provenance.
  const notes: string[] = [];
  const changes: string[] = [];
  const prov = { ...cam0.provenance };
  const thr: Record<AlignParam, number> = { pitch: 0.1, roll: 0.1, hfov: 0.2, heading: 0.2, posNormal: 0.2, posAlong: 0.2 };
  free.forEach((p, i) => {
    const d = xb[i] - x0[i];
    if (Math.abs(d) < thr[p]) return;
    if (p === 'pitch') changes.push(`pitch ${fmt(cam0.pitch)}° → ${fmt(camB.pitch)}°`);
    else if (p === 'roll') changes.push(`roll ${fmt(cam0.roll)}° → ${fmt(camB.roll)}°`);
    else if (p === 'hfov') changes.push(`hfov ${fmt(cam0.hfov)}° → ${fmt(camB.hfov)}°`);
    else if (p === 'heading') changes.push(`heading ${fmt(cam0.heading)}° → ${fmt(camB.heading)}°`);
    else if (p === 'posNormal') changes.push(`moved ${fmt(Math.abs(d))} m ${d > 0 ? 'away from' : 'towards'} the facade`);
    else changes.push(`moved ${fmt(Math.abs(d))} m along the facade`);
    const key = p === 'roll' ? 'pitch' : p === 'posNormal' || p === 'posAlong' ? 'position' : p;
    prov[key as keyof CameraParams['provenance']] = 'inferred';
  });
  const out: CameraParams = { ...camB, provenance: prov };
  if (!changes.length) return unchanged('Camera already consistent with the facade grid.');
  const summary = `Auto-aligned from facade regularity: ${changes.join(', ')} (cost ${fmt(base.cost, 2)} → ${fmt(costB, 2)}; windows line up within ${fmt(spread * 100, 0)} cm instead of ${fmt(spread0 * 100, 0)} cm).`;
  notes.push(summary);
  const explain: [string, string][] = [
    ['rows', 'window rows level in 3D'],
    ['cols', 'window columns vertical in 3D'],
    ['ground', 'facade ground line at street level'],
    ['rect', 'window outlines rectangular'],
    ['points', 'picked correspondences'],
    ['vp', 'street vanishing point'],
  ];
  for (const [k, label] of explain) {
    const a = base.terms[k];
    const b = fin.terms[k];
    if (a > 0 && b < a * 0.8) notes.push(`${label}: residual ${fmt(a, 2)} → ${fmt(b, 2)}`);
  }
  out.notes = [...(cam0.notes ?? []).filter((n) => !n.startsWith('Auto-aligned from facade regularity')), summary];
  return { camera: out, changed: true, cost0: base.cost, cost: costB, terms, notes };
}

/* ------------------------------------------------------------------------------------------ */
/* solveFromCorrespondences (camera resection)                                                  */
/* ------------------------------------------------------------------------------------------ */

export interface ResectionOptions {
  /** Bounds on the horizontal FOV (e.g. from EXIF focal length of a cropped image). Default [25, 100]. */
  hfovRange?: [number, number];
  /** Max distance (m) the solution may move from the initial position (default 40). */
  maxShift?: number;
  /** Max heading change (deg, default 30). */
  maxHeading?: number;
}

type ResKey = 'x' | 'y' | 'heading' | 'pitch' | 'roll' | 'hfov';

function project(cam: CameraParams, W: number, H: number, p: Vec3): Vec2 | null {
  const b = cameraBasis(cam, W, H);
  const d: Vec3 = [p[0] - b.eye[0], p[1] - b.eye[1], p[2] - b.eye[2]];
  const z = d[0] * b.forward[0] + d[1] * b.forward[1] + d[2] * b.forward[2];
  if (z <= 1e-6) return null;
  const x = d[0] * b.right[0] + d[1] * b.right[1] + d[2] * b.right[2];
  const y = d[0] * b.up[0] + d[1] * b.up[1] + d[2] * b.up[2];
  return [W / 2 + (x / z) * b.focalPx, H / 2 - (y / z) * b.focalPx];
}

/**
 * Horizontal residual of a vertical-edge point: find the height z at which the vertical
 * line through (vx, vy) projects to row py (closed form), then compare columns.
 */
function verticalResidual(cam: CameraParams, W: number, H: number, v: Vec2, px: Vec2): number | null {
  const b = cameraBasis(cam, W, H);
  const d0: Vec3 = [v[0] - b.eye[0], v[1] - b.eye[1], -b.eye[2]];
  const A = d0[0] * b.up[0] + d0[1] * b.up[1] + d0[2] * b.up[2];
  const Bu = b.up[2];
  const C = d0[0] * b.forward[0] + d0[1] * b.forward[1] + d0[2] * b.forward[2];
  const D = b.forward[2];
  const k = (H / 2 - px[1]) / b.focalPx;
  const den = Bu - k * D;
  if (Math.abs(den) < 1e-9) return null;
  const z = clamp((k * C - A) / den, -5, 300);
  const q = project(cam, W, H, [v[0], v[1], z]);
  return q ? q[0] - px[0] : null;
}

type ResolvedPoint = AlignPoint & { v: Vec2 };

function resolvePoints(view: ViewGeometry, points: AlignPoint[]): ResolvedPoint[] {
  const fpById = new Map<string, Footprint>(view.footprints.map((f) => [f.id, f]));
  const out: ResolvedPoint[] = [];
  for (const p of points) {
    const ring = fpById.get(p.buildingId)?.ring;
    if (!ring || !ring.length) continue;
    out.push({ ...p, v: ring[((p.vertex % ring.length) + ring.length) % ring.length] });
  }
  return out;
}

/** Reprojection residuals (px): 2 per ground point, 1 (horizontal, height free) per vertical point. */
function pointResiduals(c: CameraParams, W: number, H: number, pts: ResolvedPoint[], miss = 2000): number[] {
  const out: number[] = [];
  for (const p of pts) {
    if (p.kind === 'ground') {
      const q = project(c, W, H, [p.v[0], p.v[1], 0]);
      if (q) out.push(q[0] - p.px[0], q[1] - p.px[1]);
      else out.push(miss, miss);
    } else out.push(verticalResidual(c, W, H, p.v, p.px) ?? miss);
  }
  return out;
}

function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/** Bounded Levenberg–Marquardt with forward-difference Jacobian (scaled variables). */
function levenbergMarquardt(res: (x: number[]) => number[], x0: number[], lo: number[], hi: number[], scale: number[], iters = 80) {
  const n = x0.length;
  let x = x0.map((v, i) => clamp(v, lo[i], hi[i]));
  let r = res(x);
  let ss = r.reduce((a, v) => a + v * v, 0);
  let lambda = 1e-2;
  for (let it = 0; it < iters; it++) {
    const J: number[][] = r.map(() => new Array(n).fill(0));
    for (let k = 0; k < n; k++) {
      const h = 1e-4 * scale[k];
      const xp = [...x];
      xp[k] = x[k] + h <= hi[k] ? x[k] + h : x[k] - h;
      const dh = xp[k] - x[k];
      const rp = res(xp);
      for (let i = 0; i < r.length; i++) J[i][k] = ((rp[i] - r[i]) / dh) * scale[k]; // derivative w.r.t. scaled var
    }
    const JtJ = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, c) => J.reduce((s, row) => s + row[a] * row[c], 0)));
    const Jtr = Array.from({ length: n }, (_, a) => J.reduce((s, row, i) => s + row[a] * r[i], 0));
    let improved = false;
    for (let tries = 0; tries < 10; tries++) {
      const Am = JtJ.map((row, a) => row.map((v, c) => (a === c ? v + lambda * (v + 1e-6) : v)));
      const step = solveLinear(Am, Jtr.map((v) => -v));
      if (!step) {
        lambda *= 10;
        continue;
      }
      const xn = x.map((v, k) => clamp(v + step[k] * scale[k], lo[k], hi[k]));
      const rn = res(xn);
      const sn = rn.reduce((a, v) => a + v * v, 0);
      if (sn < ss) {
        const rel = (ss - sn) / (ss + 1e-12);
        x = xn;
        r = rn;
        ss = sn;
        lambda = Math.max(1e-7, lambda / 3);
        improved = true;
        if (rel < 1e-10) return { x, ss, r };
        break;
      }
      lambda *= 4;
    }
    if (!improved) break;
  }
  return { x, ss, r };
}

/**
 * Least-squares camera resection from picked correspondences between image pixels and
 * footprint vertices (port of scripts/solve_camera.py). Camera height is fixed. With
 * fewer than 6 equations (ground point = 2, vertical point = 1) position is kept fixed,
 * with fewer than 4 only heading and pitch are solved. A weak prior toward the initial
 * camera keeps degenerate configurations well-posed. Changed params become 'manual'.
 */
export function solveFromCorrespondences(view: AlignView, points: AlignPoint[], opts: ResectionOptions = {}): AlignResult {
  const cam0 = view.camera;
  const W = view.image.width;
  const H = view.image.height;
  const pts = resolvePoints(view, points);
  const nEq = pts.reduce((s, p) => s + (p.kind === 'ground' ? 2 : 1), 0);
  const keys: ResKey[] = nEq >= 6 ? ['x', 'y', 'heading', 'pitch', 'roll', 'hfov'] : nEq >= 4 ? ['heading', 'pitch', 'roll', 'hfov'] : nEq >= 2 ? ['heading', 'pitch'] : [];
  const toCam = (x: number[]): CameraParams => {
    const c: CameraParams = { ...cam0, position: [...cam0.position] as Vec2 };
    keys.forEach((k, i) => {
      if (k === 'x') c.position[0] = x[i];
      else if (k === 'y') c.position[1] = x[i];
      else c[k] = x[i];
    });
    return c;
  };
  const dataRes = (c: CameraParams) => pointResiduals(c, W, H, pts);
  const rmsOf = (r: number[]) => (r.length ? Math.sqrt(r.reduce((a, v) => a + v * v, 0) / r.length) : 0);
  const r0 = dataRes(cam0);
  const rms0 = rmsOf(r0);
  if (!keys.length) {
    return { camera: cam0, changed: false, cost0: rms0, cost: rms0, terms: { rms0, rms: rms0, points: pts.length }, notes: ['Need at least one ground point or two vertical points to solve the camera.'] };
  }
  const shift = opts.maxShift ?? 40;
  const dh = opts.maxHeading ?? 30;
  const fr = opts.hfovRange ?? [25, 100];
  const val = (k: ResKey) => (k === 'x' ? cam0.position[0] : k === 'y' ? cam0.position[1] : cam0[k]);
  const x0 = keys.map(val);
  const lo = keys.map((k) => (k === 'x' || k === 'y' ? val(k) - shift : k === 'heading' ? cam0.heading - dh : k === 'pitch' ? -20 : k === 'roll' ? -10 : fr[0]));
  const hi = keys.map((k) => (k === 'x' || k === 'y' ? val(k) + shift : k === 'heading' ? cam0.heading + dh : k === 'pitch' ? 50 : k === 'roll' ? 10 : fr[1]));
  const scale = keys.map((k) => (k === 'x' || k === 'y' ? 5 : k === 'roll' ? 2 : k === 'hfov' ? 10 : 5));
  // weak prior: 1 px of residual per (20 m | 20° | 30° hfov) of deviation
  const priorSig = keys.map((k) => (k === 'x' || k === 'y' ? 20 : k === 'hfov' ? 30 : 20));
  const res = (x: number[]) => [...dataRes(toCam(x)), ...x.map((v, i) => (v - x0[i]) / priorSig[i])];

  let best: { x: number[]; ss: number } | null = null;
  const starts: number[][] = [x0];
  const hfIdx = keys.indexOf('hfov');
  if (hfIdx >= 0) for (let i = 0; i < 4; i++) {
    const s = [...x0];
    s[hfIdx] = fr[0] + 0.5 + ((fr[1] - fr[0] - 1) * i) / 3;
    starts.push(s);
  }
  for (const s of starts) {
    const sol = levenbergMarquardt(res, s, lo, hi, scale);
    if (!best || sol.ss < best.ss) best = sol;
  }
  const camB = toCam(best!.x);
  const rB = dataRes(camB);
  const rms = rmsOf(rB);
  const nGround = pts.filter((p) => p.kind === 'ground').length;
  const nVert = pts.length - nGround;
  if (!(rms < rms0 - 1e-6)) {
    return { camera: cam0, changed: false, cost0: rms0, cost: rms0, terms: { rms0, rms: rms0, points: pts.length, equations: nEq }, notes: ['The picked points are already matched as well as the camera model allows; camera unchanged.'] };
  }
  const prov = { ...cam0.provenance };
  const changes: string[] = [];
  keys.forEach((k, i) => {
    const d = best!.x[i] - x0[i];
    if (Math.abs(d) < 1e-3) return;
    if (k === 'x' || k === 'y') prov.position = 'manual';
    else if (k === 'roll') prov.pitch = 'manual';
    else prov[k] = 'manual';
    if (k !== 'x' && k !== 'y') changes.push(`${k} ${fmt(x0[i])}° → ${fmt(best!.x[i])}°`);
  });
  const moved = Math.hypot(camB.position[0] - cam0.position[0], camB.position[1] - cam0.position[1]);
  if (moved > 0.05) changes.push(`position moved ${fmt(moved)} m`);
  const summary = `Resected from ${nGround} ground + ${nVert} vertical-edge correspondences; rms ${fmt(rms0)} → ${fmt(rms)} px (${changes.join(', ')}). No building height was used.`;
  const out: CameraParams = {
    ...camB,
    provenance: prov,
    notes: [...(cam0.notes ?? []).filter((n) => !n.startsWith('Resected from')), summary],
    alignment: { points, rms, method: keys.length === 6 ? 'resection-6dof' : `resection-${keys.join('+')}` },
  };
  const notes = [summary];
  if (nEq < 6) notes.push(`Only ${nEq} equations: ${keys.length === 4 ? 'position kept fixed' : 'only heading and pitch solved'}. Pick more points (ground contacts constrain position and FOV).`);
  if (rms > 25) notes.push(`Residual ${fmt(rms)} px is large: a pick may be on the wrong vertex, or the footprint differs from the photographed building.`);
  return { camera: out, changed: true, cost0: rms0, cost: rms, terms: { rms0, rms, points: pts.length, equations: nEq, ...perKindRms(rB, pts) }, notes };
}

function perKindRms(r: number[], pts: { kind: AlignPoint['kind'] }[]) {
  let i = 0;
  let sg = 0;
  let ng = 0;
  let sv = 0;
  let nv = 0;
  for (const p of pts) {
    if (p.kind === 'ground') {
      sg += r[i] ** 2 + r[i + 1] ** 2;
      ng += 2;
      i += 2;
    } else {
      sv += r[i] ** 2;
      nv++;
      i++;
    }
  }
  return { rmsGround: ng ? Math.sqrt(sg / ng) : 0, rmsVertical: nv ? Math.sqrt(sv / nv) : 0 };
}

/* ------------------------------------------------------------------------------------------ */
/* regularizeFacadeWindows                                                                      */
/* ------------------------------------------------------------------------------------------ */

export interface RegularizeOptions {
  /** Maximum displacement of a window centre (m). Default 0.6. */
  maxMove?: number;
  /** Footprints, to know each facade's length; windows centred outside [0, length] are dropped. */
  footprints?: Footprint[];
  /** Explicit facade lengths, keyed `${buildingId}#${edgeIndex}` (overrides footprints). */
  facadeLengths?: Record<string, number>;
  /** Keep windows with source 'manual' where the user put them (they still inform the grid). Default true. */
  keepManual?: boolean;
  /** Merge windows that coincide after snapping (duplicate detections). Default true. */
  dedupe?: boolean;
  /**
   * Optional image-space grid (windowGrid(detections)): rows/columns of detection ids.
   * When given, windows of one image row on one facade form a row even if a residual camera
   * tilt spreads their z; windows not covered by the grid fall back to z / u clustering.
   */
  grid?: WindowGrid;
}

/**
 * Clusters from an image-space grid (restricted to `idx`), with the remaining windows attached
 * to the nearest cluster within `gap` or clustered among themselves.
 */
function clusterWithGrid(idx: number[], value: (i: number) => number, detId: (i: number) => string | undefined, groups: string[][] | undefined, gap: number): number[][] {
  if (!groups?.length) return cluster1D(idx.map((i) => ({ i, v: value(i) })), gap);
  const groupOf = new Map<string, number>();
  groups.forEach((g, k) => g.forEach((id) => groupOf.set(id, k)));
  const byGroup = new Map<number, number[]>();
  const rest: number[] = [];
  for (const i of idx) {
    const d = detId(i);
    const k = d != null ? groupOf.get(d) : undefined;
    if (k == null) rest.push(i);
    else (byGroup.get(k) ?? byGroup.set(k, []).get(k)!).push(i);
  }
  const clusters = [...byGroup.values()];
  const leftovers: number[] = [];
  for (const i of rest) {
    let best = -1;
    let bestD = gap;
    clusters.forEach((c, k) => {
      const d = Math.abs(median(c.map(value)) - value(i));
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    });
    if (best >= 0) clusters[best].push(i);
    else leftovers.push(i);
  }
  return [...clusters, ...cluster1D(leftovers.map((i) => ({ i, v: value(i) })), gap)];
}

/** 1D clustering of sorted values by gaps (robust to missing members). */
function cluster1D(items: { i: number; v: number }[], gap: number): number[][] {
  const s = [...items].sort((a, b) => a.v - b.v);
  const out: { idx: number[]; vs: number[] }[] = [];
  for (const it of s) {
    const last = out[out.length - 1];
    if (last && it.v - median(last.vs) < gap) {
      last.idx.push(it.i);
      last.vs.push(it.v);
    } else out.push({ idx: [it.i], vs: [it.v] });
  }
  return out.map((c) => c.idx);
}

/**
 * Snap 3D windows to their building's storey grid and their facade's column grid:
 *  - rows (storeys) are clustered on z per building, across all its facades, since floors are
 *    level around a corner; z → row median, height → row median;
 *  - columns are clustered on u per facade (buildingId + edgeIndex); u → column median (only
 *    for columns of ≥ 2 windows), width → column median (row median for singletons);
 *  - with `opts.grid`, image-space rows/columns define membership (robust to residual tilt).
 * A coordinate is snapped only when it moves ≤ maxMove, and the centre never moves more than
 * maxMove in total, so a misdetection is never dragged across the facade. Windows centred
 * outside their facade are dropped; windows overhanging an end are pulled in. Windows of a
 * building with ≥ 2 windows carry `regularized: true` (manual ones are left as drawn).
 */
export function regularizeFacadeWindows(windows: FacadeWindow[], opts: RegularizeOptions = {}): FacadeWindow[] {
  const maxMove = opts.maxMove ?? 0.6;
  const keepManual = opts.keepManual ?? true;
  const lengths: Record<string, number> = {};
  for (const fp of opts.footprints ?? []) for (let i = 0; i < fp.ring.length; i++) {
    const a = fp.ring[i];
    const b = fp.ring[(i + 1) % fp.ring.length];
    lengths[`${fp.id}#${i}`] = Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  Object.assign(lengths, opts.facadeLengths ?? {});
  const out: (FacadeWindow | null)[] = windows.map((w) => ({ ...w }));
  const detId = (i: number) => windows[i].detectionId;
  const groupBy = (idx: number[], key: (w: FacadeWindow) => string) => {
    const g = new Map<string, number[]>();
    for (const i of idx) {
      const k = key(windows[i]);
      (g.get(k) ?? g.set(k, []).get(k)!).push(i);
    }
    return g;
  };
  const planeOf = (w: FacadeWindow) => `${w.buildingId}#${w.edgeIndex}`;

  // 1. drop windows centred outside their facade
  const live = windows.map((_, i) => i).filter((i) => {
    const len = lengths[planeOf(windows[i])];
    if (len != null && (windows[i].u < 0 || windows[i].u > len)) {
      out[i] = null;
      return false;
    }
    return true;
  });
  const movable = (i: number) => !(keepManual && windows[i].source === 'manual');

  // 2. storeys per building: z and height
  const rowOf = new Map<number, number[]>();
  for (const idx of groupBy(live, (w) => w.buildingId).values()) {
    if (idx.length < 2) continue;
    const mh = median(idx.map((i) => windows[i].height));
    const rows = clusterWithGrid(idx, (i) => windows[i].z, detId, opts.grid?.rows, Math.max(0.6, 0.5 * mh));
    for (const r of rows) {
      for (const i of r) rowOf.set(i, r);
      const z = median(r.map((i) => windows[i].z));
      const h = median(r.map((i) => windows[i].height));
      for (const i of r) {
        if (!movable(i)) continue;
        const w = out[i]!;
        if (r.length >= 2 && Math.abs(z - w.z) <= maxMove) w.z = z;
        if (r.length >= 2 && Math.abs(h - w.height) <= maxMove) w.height = h;
        w.regularized = true;
      }
    }
  }

  // 3. columns per facade: u and width; keep windows inside the facade; cap; dedupe
  for (const [key, idx] of groupBy(live, planeOf)) {
    const len = lengths[key];
    if (idx.length >= 2) {
      const mw = median(idx.map((i) => windows[i].width));
      const cols = clusterWithGrid(idx, (i) => windows[i].u, detId, opts.grid?.cols, Math.max(0.5, 0.6 * mw));
      for (const c of cols) {
        const u = median(c.map((i) => windows[i].u));
        const cw = median(c.map((k) => windows[k].width));
        for (const i of c) {
          if (!movable(i)) continue;
          const w = out[i]!;
          if (c.length >= 2 && Math.abs(u - w.u) <= maxMove) w.u = u;
          const row = rowOf.get(i)?.filter((k) => planeOf(windows[k]) === key);
          const width = c.length >= 2 || !row || row.length < 2 ? cw : median(row.map((k) => windows[k].width));
          if (Math.abs(width - w.width) <= maxMove) w.width = width;
          w.regularized = true;
        }
      }
    }
    for (const i of idx) {
      if (!movable(i)) continue;
      const w = out[i]!;
      if (len != null) {
        if (w.width > len) w.width = len;
        const over = Math.max(0, w.u + w.width / 2 - len) - Math.max(0, w.width / 2 - w.u);
        if (over > 0) w.u -= Math.min(over, maxMove);
        else if (over < 0) w.u += Math.min(-over, maxMove);
        if (w.u < w.width / 2 || w.u > len - w.width / 2) w.width = Math.max(0.3, 2 * Math.min(w.u, len - w.u));
      }
      // hard cap on the total displacement of the centre (row + column snap + pull-in)
      const du = w.u - windows[i].u;
      const dz = w.z - windows[i].z;
      const d = Math.hypot(du, dz);
      if (d > maxMove) {
        w.u = windows[i].u + (du * maxMove) / d;
        w.z = windows[i].z + (dz * maxMove) / d;
      }
    }
    // merge duplicates (two detections of the same window); a manual window wins
    if (opts.dedupe ?? true) {
      const kept: number[] = [];
      for (const i of idx) {
        const w = out[i];
        if (!w) continue;
        const dup = kept.find((k) => {
          const o = out[k]!;
          return Math.abs(o.u - w.u) < 0.35 * Math.min(o.width, w.width) && Math.abs(o.z - w.z) < 0.35 * Math.min(o.height, w.height);
        });
        if (dup == null) kept.push(i);
        else if (w.source === 'manual' && out[dup]!.source !== 'manual') {
          out[dup] = null;
          kept[kept.indexOf(dup)] = i;
        } else out[i] = null;
      }
    }
  }
  return out.filter(Boolean) as FacadeWindow[];
}

/* ------------------------------------------------------------------------------------------ */
/* minHeightFromWindows                                                                         */
/* ------------------------------------------------------------------------------------------ */

/** Top of the highest window of a building + 0.3 m (lintel/parapet), or null without windows. */
export function minHeightFromWindows(windows: FacadeWindow[], buildingId: string): number | null {
  let top = -Infinity;
  for (const w of windows) if (w.buildingId === buildingId) top = Math.max(top, w.z + w.height / 2);
  return Number.isFinite(top) ? top + 0.3 : null;
}

/* ------------------------------------------------------------------------------------------ */
/* Diagnostics                                                                                  */
/* ------------------------------------------------------------------------------------------ */

export interface WindowDiagnostics {
  windows: number;
  missed: number;
  perPlane: Record<string, number>;
  /** Robust spread (1.4826 × MAD, m) of z within image rows on the same building, pooled. */
  rowZSpread: number;
  /** Robust spread (m) of u within image columns on the same plane, pooled. */
  colUSpread: number;
  /** Median |skew| of the rectified outlines (0 = rectangles). */
  medianAbsSkew: number;
  width: { p10: number; p50: number; p90: number };
  height: { p10: number; p50: number; p90: number };
  /** Windows whose top lies above the given building height. */
  aboveRoof: number;
  /**
   * Per-detection box noise, camera-free: robust residual (1.4826 × MAD) of window centres
   * about a straight line fitted through each image row segment on one plane (a world row is
   * a straight image line under any pinhole camera). In pixels, and converted to metres at
   * each window's distance (t / focal).
   */
  boxNoisePx: number;
  boxNoiseM: number;
  rows: number;
  cols: number;
}

const q = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
};

/** Numbers behind docs/research/alignment.md: how regular the 3D windows of a view are. */
export function diagnoseWindows(view: ViewGeometry, cam: CameraParams, detections: Detection[], heights: Record<string, number> = {}, opts: { mutualRows?: boolean } = {}): WindowDiagnostics {
  const grid = windowGrid(detections, opts);
  const { hits, missed } = measureWindows(view, cam, detections);
  const byId = new Map(hits.map((h) => [h.id, h]));
  const perPlane: Record<string, number> = {};
  for (const h of hits) perPlane[planeKey(h.plane)] = (perPlane[planeKey(h.plane)] ?? 0) + 1;
  const devZ: number[] = [];
  for (const row of grid.rows) {
    const g = new Map<string, number[]>();
    for (const id of row) {
      const h = byId.get(id);
      if (h) (g.get(h.plane.buildingId) ?? g.set(h.plane.buildingId, []).get(h.plane.buildingId)!).push(h.z);
    }
    for (const zs of g.values()) if (zs.length >= 2) {
      const m = median(zs);
      for (const z of zs) devZ.push(z - m);
    }
  }
  const devU: number[] = [];
  for (const col of grid.cols) {
    const g = new Map<string, number[]>();
    for (const id of col) {
      const h = byId.get(id);
      if (h) (g.get(planeKey(h.plane)) ?? g.set(planeKey(h.plane), []).get(planeKey(h.plane))!).push(h.u);
    }
    for (const us of g.values()) if (us.length >= 2) {
      const m = median(us);
      for (const u of us) devU.push(u - m);
    }
  }
  const detById = new Map(detections.map((d) => [d.id, d]));
  const focal = cameraBasis(cam, view.image.width, view.image.height).focalPx;
  const resPx: number[] = [];
  const resM: number[] = [];
  for (const row of grid.rows) {
    const g = new Map<string, MeasuredWindow[]>();
    for (const id of row) {
      const h = byId.get(id);
      if (h) (g.get(planeKey(h.plane)) ?? g.set(planeKey(h.plane), []).get(planeKey(h.plane))!).push(h);
    }
    for (const seg of g.values()) {
      if (seg.length < 3) continue;
      const pts = seg.map((h) => {
        const [x0, y0, x1, y1] = detById.get(h.id)!.bbox;
        return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, t: h.t };
      });
      const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
      const my = pts.reduce((a, p) => a + p.y, 0) / pts.length;
      let sxy = 0;
      let sxx = 0;
      for (const p of pts) {
        sxy += (p.x - mx) * (p.y - my);
        sxx += (p.x - mx) ** 2;
      }
      const slope = sxx > 1e-9 ? sxy / sxx : 0;
      // n−2 degrees of freedom: scale residuals so a 3-point fit is not optimistic
      const dof = Math.sqrt(pts.length / (pts.length - 2));
      for (const p of pts) {
        const r = (p.y - (my + slope * (p.x - mx))) * dof;
        resPx.push(r);
        resM.push((r * p.t) / focal);
      }
    }
  }
  const skews = hits.flatMap((h) => h.skew.map(Math.abs));
  const ws = hits.map((h) => h.w);
  const hs = hits.map((h) => h.h);
  let above = 0;
  for (const h of hits) {
    const H = heights[h.plane.buildingId];
    if (H != null && h.z + h.h / 2 > H) above++;
  }
  return {
    windows: hits.length,
    missed: missed.length,
    perPlane,
    rowZSpread: 1.4826 * mad(devZ) || 0,
    colUSpread: 1.4826 * mad(devU) || 0,
    medianAbsSkew: median(skews),
    width: { p10: q(ws, 0.1), p50: q(ws, 0.5), p90: q(ws, 0.9) },
    height: { p10: q(hs, 0.1), p50: q(hs, 0.5), p90: q(hs, 0.9) },
    aboveRoof: above,
    boxNoisePx: resPx.length ? 1.4826 * median(resPx.map(Math.abs)) : NaN,
    boxNoiseM: resM.length ? 1.4826 * median(resM.map(Math.abs)) : NaN,
    rows: grid.rows.length,
    cols: grid.cols.length,
  };
}
