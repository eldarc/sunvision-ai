/**
 * Vision-first building reconstruction.
 *
 * Inputs: the scene (map footprints + camera + facade analysis) and the user's
 * edits. Outputs per-building height estimates with provenance, and 3D window
 * placements on facade planes.
 *
 * Methods (see docs/RECONSTRUCTION.md):
 *  A  floors × floor-height  — window rows clustered in metric z on the facade plane
 *  B  camera geometry        — roofline pixels → rays → intersection with the OSM facade plane
 *  C  calibrated depth       — relative inverse depth fitted to ground-plane distances, then
 *                              roofline points located along their rays
 *  D  fusion                 — inverse-variance weighting with heuristic σ (NOT calibrated CIs)
 *
 * Before A–C, roofline samples and windows that the (uncalibrated) depth map puts ≥ 2× farther
 * than the facade plane they project onto — a building behind it, inside the facade mask — are
 * set aside with a warning (depthBackground). Without a depth map nothing is set aside.
 *
 * Multi-view: every photograph (the primary one plus `scene.extraViews`, see lib/views.ts)
 * is processed the same way with its own camera, detections and depth map. Methods A–C are
 * run per view and per building (names suffixed with the view label for extra views), then
 * fused per building across all views. Windows of every view are placed in 3D.
 */
import type {
  BuildingModel,
  FacadeAnalysis,
  CameraParams,
  Detection,
  Estimate,
  FacadeWindow,
  Footprint,
  Scene,
  SceneSettings,
  Vec3,
} from '../schema/scene';
import {
  cameraBasis,
  dot,
  facadePlane,
  intersectFacade,
  intersectGround,
  pixelToRay,
  sub,
  type CameraBasis,
  type FacadePlane,
  type PlaneHit,
} from './camera';
import { autoAlignCamera, inferHfovFromStoreys, minHeightFromWindows, plausibleGroundline, regularizeFacadeWindows, windowGrid, type WindowGrid } from './align';
import { obliqueStart, streetPerspective } from './vanishing';

/**
 * The geometric context of one photograph: the scene's footprints plus that
 * photo's image, analysis and depicted buildings. `Scene` satisfies it (primary
 * photo); extra views are adapted with `viewGeometry()` in lib/views.ts.
 */
export interface ViewGeometry {
  footprints: Footprint[];
  targetBuildingId: string;
  facadeEdgeIndex: number;
  visibleBuildingIds?: string[];
  image: { width: number; height: number };
  analysis: FacadeAnalysis;
}

export interface DepthSampler {
  width: number;
  height: number;
  /** Relative inverse depth at image pixel (original image coords), or null. */
  sample(px: number, py: number): number | null;
}

export interface BuildingOverride {
  height?: number;
  floors?: number;
  floorHeight?: number;
}

/**
 * One photograph as reconstruct() consumes it: its geometry plus its current (possibly
 * edited) camera and detections. `ViewInput` from lib/views.ts satisfies it.
 */
export type ReconView = ViewGeometry & {
  id: string; // 'primary' or PhotoView.id
  label: string;
  purpose?: 'primary' | 'surroundings';
  camera: CameraParams;
  detections: Detection[];
};

export interface ReconstructionInput {
  scene: Scene;
  /** Camera of the primary photograph. */
  camera: CameraParams;
  /** Detections of the primary photograph. */
  detections: Detection[];
  settings: SceneSettings;
  overrides: Record<string, BuildingOverride>;
  /** Depth sampler of the primary photograph. */
  depth?: DepthSampler | null;
  /**
   * All photographs of the scene, e.g. `sceneViews(scene, state)` (lib/views.ts). The primary
   * view is always built from `scene` / `camera` / `detections` above, so an entry with id
   * 'primary' is ignored; every other entry is reconstructed as an extra view. Omit for the
   * single-photo reconstruction.
   */
  views?: ReconView[];
  /** One depth sampler per view id. 'primary' falls back to `depth`. */
  depths?: Record<string, DepthSampler | null | undefined>;
}

export interface FacadeHit extends PlaneHit {
  plane: FacadePlane;
}

/** One roofline sample and the facade its ray hits. */
export interface RooflineHit {
  x: number;
  y: number;
  hit: FacadeHit | null;
  /** The depth map puts it far behind that facade (a building behind it): not used for its height. */
  behind?: boolean;
}

export interface ReconstructionResult {
  buildings: Record<string, BuildingModel>;
  windows: FacadeWindow[];
  /** All camera-facing facade planes of photographed buildings. */
  planes: FacadePlane[];
  targetPlane: FacadePlane;
  /** Median z (m) of ground-line samples on the facade; ~0 when the camera is well aligned. */
  groundResidual: number | null;
  /** Roofline samples projected into the world, for overlays and debugging. */
  rooflineHits: RooflineHit[];
  depthCalibration: { alpha: number; beta: number; samples: number; rms: number } | null;
  warnings: string[];
  /** Per-photograph diagnostics, primary first (the top-level fields above are the primary view's). */
  views?: ViewReconstruction[];
}

export interface ViewReconstruction {
  id: string;
  label: string;
  primary: boolean;
  /** Camera-facing facade planes of the buildings this photo depicts. */
  planes: FacadePlane[];
  targetPlane: FacadePlane | null;
  groundResidual: number | null;
  rooflineHits: RooflineHit[];
  depthCalibration: { alpha: number; beta: number; samples: number; rms: number } | null;
  /** Window detections in this photo, how many were placed in 3D, and how many were skipped as already seen in an earlier view. */
  windowsDetected: number;
  windowsPlaced: number;
  duplicates: number;
  /** Windows lying above the detected roofline of the facade they project onto (not placed). */
  windowsAboveRoofline: number;
  /** Windows the depth map puts far behind the facade they project onto (not placed). */
  windowsBehindFacade: number;
  /** Roofline samples the depth map puts far behind the facade they project onto (not used for heights). */
  rooflineBehindFacade: number;
  /** Buildings whose fused height uses at least one method from this photo. */
  measuredBuildingIds: string[];
}

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
  return s[i];
};

/** Camera-facing edges of the photographed buildings. */
export function candidatePlanes(scene: ViewGeometry, cam: CameraParams): FacadePlane[] {
  const ids = new Set([scene.targetBuildingId, ...(scene.visibleBuildingIds ?? [])]);
  const planes: FacadePlane[] = [];
  for (const fp of scene.footprints) {
    if (!ids.has(fp.id)) continue;
    for (let i = 0; i < fp.ring.length; i++) {
      const pl = facadePlane(fp.id, fp.ring, i);
      if (pl.length < 1.5) continue;
      const mid: Vec3 = [(pl.a[0] + pl.b[0]) / 2, (pl.a[1] + pl.b[1]) / 2, 0];
      const toCam = sub([cam.position[0], cam.position[1], 0], mid);
      if (dot(toCam, pl.normal) > 0.5) planes.push(pl);
    }
  }
  return planes;
}

/** First facade plane hit by a pixel ray. */
export function hitFacades(b: CameraBasis, planes: FacadePlane[], px: number, py: number, margin = 0.25): FacadeHit | null {
  const dir = pixelToRay(b, px, py);
  let best: FacadeHit | null = null;
  for (const pl of planes) {
    const h = intersectFacade(b.eye, dir, pl, margin);
    if (h && (!best || h.t < best.t)) best = { ...h, plane: pl };
  }
  return best;
}

/**
 * Facade ground line, extended down through storefronts: RF-DETR labels street-level
 * shops separately from the facade, so the facade mask alone ends on top of the shops.
 */
export function effectiveGroundline(scene: ViewGeometry, detections: Detection[] = scene.analysis.detections): { x: number; y: number }[] {
  const gl = scene.analysis.groundline ?? [];
  const base = detections.filter((d) => (d.cls === 'shop' || d.cls === 'door') && !d.deleted);
  if (!base.length) return gl;
  return gl.map((p) => {
    let y = p.y;
    for (const d of base) {
      const [x0, y0, x1, y1] = d.bbox;
      // the shop must start near the facade's bottom edge (it continues the wall downwards)
      if (p.x >= x0 && p.x <= x1 && y0 <= p.y + 0.02 * scene.image.height && y1 > y) y = y1;
    }
    return { x: p.x, y };
  });
}

/**
 * Median z of the facade ground line on the facade planes. Uses plausibleGroundline()
 * (lib/align.ts): samples sitting on an awning or canopy above a window are dropped.
 */
function groundResidualFor(scene: ViewGeometry, cam: CameraParams, planes: FacadePlane[], detections: Detection[] = scene.analysis.detections): number | null {
  const gl = plausibleGroundline(scene, detections);
  if (!gl.length) return null;
  const b = cameraBasis(cam, scene.image.width, scene.image.height);
  const zs: number[] = [];
  for (const p of gl) {
    const h = hitFacades(b, planes, p.x, p.y);
    if (h) zs.push(h.z);
  }
  return zs.length >= 3 ? median(zs) : null;
}

/**
 * Solve camera pitch so the detected ground line lies on z = 0.
 * Returns the calibrated pitch (deg) or null when no ground line is available.
 */
export function calibratePitch(scene: ViewGeometry, cam: CameraParams, detections: Detection[] = scene.analysis.detections): number | null {
  const planes = candidatePlanes(scene, cam);
  let lo = -25;
  let hi = 45;
  const f = (p: number) => groundResidualFor(scene, { ...cam, pitch: p }, planes, detections);
  // residual decreases monotonically with pitch increase? (pitching up lowers the hit of a fixed pixel) -> bisection
  let rLo = f(lo);
  let rHi = f(hi);
  if (rLo == null || rHi == null || Math.sign(rLo) === Math.sign(rHi)) {
    // fall back to coarse scan
    let best: number | null = null;
    let bestAbs = Infinity;
    for (let p = -25; p <= 45; p += 0.5) {
      const r = f(p);
      if (r != null && Math.abs(r) < bestAbs) {
        bestAbs = Math.abs(r);
        best = p;
      }
    }
    return best != null && bestAbs < 1.5 ? best : null;
  }
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const r = f(mid);
    if (r == null) break;
    if (Math.sign(r) === Math.sign(rLo)) {
      lo = mid;
      rLo = r;
    } else {
      hi = mid;
      rHi = r;
    }
  }
  return (lo + hi) / 2;
}

/** Fit inverse relative depth d ≈ α·(1/Z) + β on ground pixels with known metric distance. */
function calibrateDepth(scene: ViewGeometry, b: CameraBasis, depth: DepthSampler, planes: FacadePlane[], detections: Detection[] = scene.analysis.detections) {
  const W = scene.image.width;
  const H = scene.image.height;
  const xs: number[] = [];
  const ys: number[] = [];
  // Ground samples: pixels below the horizon whose ground hit is in front of every facade.
  const street = detections.filter((d) => d.cls === 'street' && !d.deleted);
  const inStreet = (px: number, py: number) =>
    street.length === 0 || street.some((s) => px >= s.bbox[0] && px <= s.bbox[2] && py >= s.bbox[1] && py <= s.bbox[3]);
  for (let gy = 0.55; gy < 0.995; gy += 0.03) {
    for (let gx = 0.05; gx < 0.96; gx += 0.06) {
      const px = gx * W;
      const py = gy * H;
      if (!inStreet(px, py)) continue;
      const dir = pixelToRay(b, px, py);
      const g = intersectGround(b.eye, dir);
      if (!g) continue;
      const tG = Math.hypot(g[0] - b.eye[0], g[1] - b.eye[1], g[2] - b.eye[2]);
      const fh = hitFacades(b, planes, px, py);
      if (fh && fh.t < tG) continue; // facade in front of this ground point
      if (tG < 2 || tG > 80) continue;
      const d = depth.sample(px, py);
      if (d == null || !isFinite(d)) continue;
      xs.push(1 / tG);
      ys.push(d);
    }
  }
  if (xs.length < 12) return null;
  // least squares y = αx + β
  const n = xs.length;
  const mx = xs.reduce((a, v) => a + v, 0) / n;
  const my = ys.reduce((a, v) => a + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  if (sxx < 1e-12) return null;
  const alpha = sxy / sxx;
  const beta = my - alpha * mx;
  if (alpha <= 0) return null; // inverse depth must grow when closer
  let se = 0;
  for (let i = 0; i < n; i++) se += (ys[i] - (alpha * xs[i] + beta)) ** 2;
  return { alpha, beta, samples: n, rms: Math.sqrt(se / n) };
}

/* ------------------------------------------------------------------------------------------ */
/* Depth discontinuities: background objects behind the photographed facades                   */
/* ------------------------------------------------------------------------------------------ */

/**
 * A roofline sample or window is "behind" the facade plane its ray hits when its depth ratio
 * (see depthBackground) is under this value, i.e. when the depth map puts it at least
 * 1 / 0.5 = 2× farther from the camera than that plane.
 *
 * Why 0.5 (measured on Amsterdam, Paris, NYC, the Vilsonovo fixture and their extra views): windows on their own
 * facade read 0.83–1.20, genuine roofline samples 0.73–1.2 (a pitched roof recedes behind the
 * facade plane; samples at the mask edge mix in some sky), single mixed samples down to 0.61.
 * Things behind: the Vilsonovo (Sarajevo) Parliament tower 0.27–0.33 and the false "window" on it 0.30, the
 * Gare de Lyon tower behind Le Mistral (Paris, extra view) 0.28–0.47 and 6 windows on it 0.36,
 * three windows of a building seen behind the NYC school (extra view) 0.39–0.45. Borderline
 * stretches that are part roof, part something behind (Vilsonovo's right-hand ridge 0.54–0.61,
 * chimneys and roofs behind an Amsterdam gable 0.51–0.57) stay in: at 0.65 (1.5×) they would go,
 * which is not clear-cut. A depth model's affine shift (d = s/Z + β, β ≠ 0) moves ratios too:
 * β > 0 pulls far objects towards 1 (fewer rejections, the safe side).
 */
export const BACKGROUND_DEPTH_RATIO = 0.5;
/**
 * Below this ratio (≥ 10× farther) the depth map reads sky, not a building behind: Depth
 * Anything puts the sky at ≈ 0. Under a roofline sample that is usually a thin roof element
 * (spire, chimney, antenna, railing) the 640-px depth map does not resolve, or a mask edge, so
 * such samples and windows are left as they are.
 */
export const SKY_DEPTH_RATIO = 0.1;

/** Median of a small grid of depth samples (robust to single-pixel noise and mask edges), or null. */
function depthPatch(depth: DepthSampler, x0: number, y0: number, x1: number, y1: number, n: number): number | null {
  const v: number[] = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const d = depth.sample(x0 + ((x1 - x0) * i) / (n - 1), y0 + ((y1 - y0) * j) / (n - 1));
      if (d != null && Number.isFinite(d)) v.push(d);
    }
  return v.length * 2 >= n * n ? median(v) : null;
}

interface DepthBackground {
  /** Indices into the roofline samples that lie on something behind the facade they hit. */
  roof: Set<number>;
  /** Window detections (ids) that lie on something behind the facade they hit. */
  windows: Set<string>;
  /** Their ratios (see depthRatio), for the warning. */
  ratios: number[];
}

/**
 * Background rejection by depth discontinuity. A relative *inverse* depth map (Depth Anything V2:
 * d ≈ s / Z with Z the depth along the optical axis, sky ≈ 0) multiplied by the metric axial depth
 * Zp of the facade-plane hit, d·Zp, is the same constant s for every point that really lies on
 * that plane, whatever its distance or position in the frame. Its reference is the median d·Zp of
 * the windows on the same building (≥ 3; else of all windows in the photo, ≥ 3). For a point on
 * something farther away, at Z > Zp, the ratio d·Zp / reference ≈ Zp / Z falls below 1: under
 * BACKGROUND_DEPTH_RATIO it is set aside (see that constant), unless it reads as sky
 * (SKY_DEPTH_RATIO).
 *
 * Roofline samples are read in a small patch just below the sample (the facade under the roof
 * edge, not the sky above it). A background object occludes a stretch of the roofline, so a
 * sample is set aside only together with an adjacent one (an isolated sample reading sky is a
 * mask or depth edge, not a building), and only while the building keeps ≥ 3 samples and at
 * least a quarter of them in this photo; otherwise none of that building's samples are set aside.
 * Without a depth map, or without enough windows for a reference, nothing is set aside.
 */
function depthBackground(
  depth: DepthSampler,
  b: CameraBasis,
  rooflineHits: { x: number; y: number; hit: FacadeHit | null }[],
  windows: { det: Detection; hit: FacadeHit }[],
): DepthBackground {
  const out: DepthBackground = { roof: new Set(), windows: new Set(), ratios: [] };
  const W = b.width;
  const H = b.height;
  // Depth along the optical axis (what a depth map's disparity is inverse to) of a facade hit.
  const axial = (px: number, py: number, hit: FacadeHit) => hit.t * dot(pixelToRay(b, px, py), b.forward);
  // d·t of each window on the plane its centre ray hits (central half of the box).
  const scaled: { det: Detection; bid: string; s: number }[] = [];
  for (const { det, hit } of windows) {
    const [x0, y0, x1, y1] = det.bbox;
    const dx = (x1 - x0) / 4;
    const dy = (y1 - y0) / 4;
    const d = depthPatch(depth, x0 + dx, y0 + dy, x1 - dx, y1 - dy, 3);
    if (d != null) scaled.push({ det, bid: hit.plane.buildingId, s: d * axial((x0 + x1) / 2, (y0 + y1) / 2, hit) });
  }
  const viewRef = scaled.length >= 3 ? median(scaled.map((w) => w.s)) : NaN;
  const refs = new Map<string, number>();
  for (const bid of new Set(scaled.map((w) => w.bid))) {
    const ss = scaled.filter((w) => w.bid === bid).map((w) => w.s);
    refs.set(bid, ss.length >= 3 ? median(ss) : viewRef);
  }
  const refFor = (bid: string) => {
    const r = refs.get(bid) ?? viewRef;
    return r > 0 && Number.isFinite(r) ? r : null;
  };
  for (const w of scaled) {
    const ref = refFor(w.bid);
    if (ref == null) continue;
    const ratio = w.s / ref;
    if (ratio < BACKGROUND_DEPTH_RATIO && ratio >= SKY_DEPTH_RATIO) {
      out.windows.add(w.det.id);
      out.ratios.push(ratio);
    }
  }
  // Roofline: ratio per sample, then runs of ≥ 2 adjacent samples, then enough left per building.
  const ratio = rooflineHits.map((r) => {
    if (!r.hit || r.y <= 2) return null;
    const ref = refFor(r.hit.plane.buildingId);
    if (ref == null) return null;
    const d = depthPatch(depth, r.x - 0.004 * W, r.y + 0.005 * H, r.x + 0.004 * W, r.y + 0.02 * H, 5);
    return d == null ? null : (d * axial(r.x, r.y, r.hit)) / ref;
  });
  const far = (i: number) => {
    const q = ratio[i];
    return q != null && q < BACKGROUND_DEPTH_RATIO && q >= SKY_DEPTH_RATIO;
  };
  const flagged = ratio.map((_, i) => far(i) && (far(i - 1) || far(i + 1)));
  const total = new Map<string, number>();
  const set = new Map<string, number[]>();
  rooflineHits.forEach((r, i) => {
    if (!r.hit || r.y <= 2) return;
    const bid = r.hit.plane.buildingId;
    total.set(bid, (total.get(bid) ?? 0) + 1);
    if (flagged[i]) (set.get(bid) ?? set.set(bid, []).get(bid)!).push(i);
  });
  for (const [bid, idx] of set) {
    const n = total.get(bid)!;
    const left = n - idx.length;
    if (left < 3 || left * 4 < n) continue; // too little would be left: set none of this building's samples aside
    for (const i of idx) {
      out.roof.add(i);
      out.ratios.push(ratio[i]!);
    }
  }
  return out;
}

/** "N roofline samples and M windows set aside: …" (one line per photo). */
function depthBackgroundWarning(prefix: string, nRoof: number, nWin: number, ratios: number[]): string {
  const parts: string[] = [];
  if (nRoof) parts.push(`${nRoof} roofline sample${nRoof > 1 ? 's' : ''}`);
  if (nWin) parts.push(`${nWin} window${nWin > 1 ? 's' : ''}`);
  const k = median(ratios.map((r) => 1 / Math.max(r, 0.05)));
  const howFar = k >= 10 ? 'more than 10×' : `about ${k < 2.5 ? k.toFixed(1) : Math.round(k)}×`;
  const many = nRoof + nWin > 1;
  let msg = `${prefix}${parts.join(' and ')} set aside: the depth map puts ${many ? 'them' : 'it'} ${howFar} farther than the facade ${many ? 'they project' : 'it projects'} onto (something behind it, such as a taller building further away).`;
  if (nWin) msg += ` ${nWin > 1 ? 'Those windows are' : 'That window is'} not placed and count${nWin > 1 ? '' : 's'} toward no floor.`;
  if (nRoof) msg += ' The roofline height (method B) uses the remaining samples.';
  return msg;
}

function estimate(value: number, low: number, high: number, source: Estimate['source'], method: string, note?: string): Estimate {
  return { value, low: Math.min(low, value), high: Math.max(high, value), source, method, note };
}

export function windowDetections(dets: Detection[]) {
  return dets.filter((d) => d.cls === 'window' && !d.deleted);
}

/** Cluster sorted values into groups separated by gaps larger than `gap`. */
export function clusterRows(values: { id: string; z: number }[], gap: number) {
  const s = [...values].sort((a, b) => a.z - b.z);
  const rows: { z: number; ids: string[]; zs: number[] }[] = [];
  for (const v of s) {
    const last = rows[rows.length - 1];
    if (last && v.z - median(last.zs) < gap) {
      last.ids.push(v.id);
      last.zs.push(v.z);
      last.z = median(last.zs);
    } else rows.push({ z: v.z, ids: [v.id], zs: [v.z] });
  }
  return rows;
}

function mapHeightOf(fp: Footprint, floorH: number): { value: number; method: string } | null {
  if (fp.mapHeight && fp.mapHeight > 0) return { value: fp.mapHeight, method: 'osm:height' };
  if (fp.mapLevels && fp.mapLevels > 0) return { value: fp.mapLevels * floorH + 1, method: 'osm:building:levels×floorHeight' };
  return null;
}

/* ------------------------------------------------------------------------------------------ */
/* Per-view measurement                                                                         */
/* ------------------------------------------------------------------------------------------ */

interface WindowHit {
  det: Detection;
  hit: FacadeHit;
  w: number;
  h: number;
}

interface ViewMeasure {
  view: ReconView;
  primary: boolean;
  /** Appended to method names of extra views. */
  suffix: string;
  /** Prepended to warnings of extra views. */
  prefix: string;
  b: CameraBasis;
  planes: FacadePlane[];
  targetPlane: FacadePlane | null;
  photoIds: Set<string>;
  rooflineHits: RooflineHit[];
  roofZ: Record<string, number[]>;
  roofLo: Record<string, number[]>;
  roofHi: Record<string, number[]>;
  groundResidual: number | null;
  windowsDetected: number;
  windowsAboveRoofline: number;
  windowsBehindFacade: number;
  rooflineBehindFacade: number;
  windowHits: WindowHit[];
  depthCalibration: ReconstructionResult['depthCalibration'];
  depthZ: Record<string, number[]>;
}

/** Roofline (B), ground line, windows and calibrated depth (C) of one photograph. */
function measureView(view: ReconView, primary: boolean, depth: DepthSampler | null | undefined, warnings: string[]): ViewMeasure {
  const camera = view.camera;
  const W = view.image.width;
  const H = view.image.height;
  const prefix = primary ? '' : `${view.label}: `;
  const b = cameraBasis(camera, W, H);
  const planes = candidatePlanes(view, camera);
  const target = view.footprints.find((f) => f.id === view.targetBuildingId);
  const targetPlane = target ? facadePlane(target.id, target.ring, view.facadeEdgeIndex) : null;
  if (targetPlane && !planes.some((p) => p.buildingId === targetPlane.buildingId && p.edgeIndex === targetPlane.edgeIndex)) planes.push(targetPlane);
  const photoIds = new Set([view.targetBuildingId, ...(view.visibleBuildingIds ?? [])]);

  // ---- Method B: roofline rays → facade planes -------------------------------------------
  const roofSamples = view.analysis.roofline ?? [];
  const rooflineHits: ViewMeasure['rooflineHits'] = roofSamples.map((p) => ({ x: p.x, y: p.y, hit: hitFacades(b, planes, p.x, p.y, 0.6) }));
  const wins = windowDetections(view.detections);
  const winCentres = wins.map((d) => ({ det: d, hit: hitFacades(b, planes, (d.bbox[0] + d.bbox[2]) / 2, (d.bbox[1] + d.bbox[3]) / 2, 0.1) }));
  // Depth discontinuities: roofline samples and windows on something far behind the facade their
  // ray hits (a taller building further away inside the facade mask) are set aside. Only with a
  // depth map; without one nothing is set aside.
  const bg = depth ? depthBackground(depth, b, rooflineHits, winCentres.filter((w): w is { det: Detection; hit: FacadeHit } => w.hit != null)) : null;
  for (const i of bg?.roof ?? []) rooflineHits[i].behind = true;
  const roofZ: Record<string, number[]> = {};
  for (const r of rooflineHits) {
    if (!r.hit || r.behind) continue;
    // Ignore samples at the very top image border (roof cut off by the frame).
    if (r.y <= 2) continue;
    (roofZ[r.hit.plane.buildingId] ||= []).push(r.hit.z);
  }
  // Sensitivity: re-run with pitch ±1° (alignment uncertainty) to get bounds.
  const roofZPerturbed = (dp: number) => {
    const bb = cameraBasis({ ...camera, pitch: camera.pitch + dp }, W, H);
    const out: Record<string, number[]> = {};
    for (const [i, p] of roofSamples.entries()) {
      if (p.y <= 2 || bg?.roof.has(i)) continue;
      const h = hitFacades(bb, planes, p.x, p.y, 0.6);
      if (h) (out[h.plane.buildingId] ||= []).push(h.z);
    }
    return out;
  };
  const roofLo = roofZPerturbed(-1);
  const roofHi = roofZPerturbed(+1);
  const groundResidual = groundResidualFor(view, camera, planes, view.detections);
  if (groundResidual != null && Math.abs(groundResidual) > 1.0)
    warnings.push(
      `${prefix}Detected ground line sits ${groundResidual.toFixed(1)} m ${groundResidual > 0 ? 'above' : 'below'} street level — camera pitch/height may be misaligned. Try “Auto-align pitch”.`,
    );

  // ---- Windows → facade planes ------------------------------------------------------------
  // The detected roofline of a plane, as image y per column (uncropped samples only): a window
  // lying entirely above it in the photo is on something behind that facade (a taller building
  // further away), not on it, so it is neither placed nor measured on that plane.
  const roofByPlane = new Map<FacadePlane, { x: number; y: number }[]>();
  for (const r of rooflineHits) {
    if (!r.hit || r.y <= 2 || r.behind) continue;
    (roofByPlane.get(r.hit.plane) ?? roofByPlane.set(r.hit.plane, []).get(r.hit.plane)!).push({ x: r.x, y: r.y });
  }
  for (const pts of roofByPlane.values()) pts.sort((p, q) => p.x - q.x);
  const roofYAt = (pl: FacadePlane, x: number): number | null => {
    const pts = roofByPlane.get(pl);
    if (!pts || pts.length < 3 || x < pts[0].x || x > pts[pts.length - 1].x) return null;
    let i = 1;
    while (i < pts.length - 1 && pts[i].x < x) i++;
    const a = pts[i - 1];
    const c = pts[i];
    return c.x === a.x ? Math.min(a.y, c.y) : a.y + ((c.y - a.y) * (x - a.x)) / (c.x - a.x);
  };
  const windowHits: WindowHit[] = [];
  let aboveRoof = 0;
  for (const { det: d, hit: c } of winCentres) {
    const [x0, y0, x1, y1] = d.bbox;
    if (!c || bg?.windows.has(d.id)) continue;
    const ry = roofYAt(c.plane, (x0 + x1) / 2);
    if (ry != null && y1 < ry - 0.25 * (y1 - y0)) {
      aboveRoof++;
      continue;
    }
    // measure size on the same plane
    const pl = [c.plane];
    const l = hitFacades(b, pl, x0, (y0 + y1) / 2, 50);
    const r = hitFacades(b, pl, x1, (y0 + y1) / 2, 50);
    const t = hitFacades(b, pl, (x0 + x1) / 2, y0, 50);
    const bt = hitFacades(b, pl, (x0 + x1) / 2, y1, 50);
    if (!l || !r || !t || !bt) continue;
    windowHits.push({ det: d, hit: c, w: Math.abs(r.u - l.u), h: Math.abs(t.z - bt.z) });
  }
  if (bg && (bg.roof.size || bg.windows.size)) warnings.push(depthBackgroundWarning(prefix, bg.roof.size, bg.windows.size, bg.ratios));
  if (aboveRoof) warnings.push(`${prefix}${aboveRoof} window${aboveRoof > 1 ? 's lie' : ' lies'} above the detected roofline of the facade ${aboveRoof > 1 ? 'they project' : 'it projects'} onto (a building behind it?) and ${aboveRoof > 1 ? 'were' : 'was'} not placed.`);

  // ---- Depth calibration (Method C) --------------------------------------------------------
  let depthCalibration: ReconstructionResult['depthCalibration'] = null;
  const depthZ: Record<string, number[]> = {};
  if (depth) {
    depthCalibration = calibrateDepth(view, b, depth, planes, view.detections);
    if (depthCalibration) {
      const { alpha, beta } = depthCalibration;
      for (const r of rooflineHits) {
        if (!r.hit || r.y <= 2 || r.behind) continue;
        // sample slightly below the roofline so we read the facade, not the sky
        const d = depth.sample(r.x, r.y + H * 0.01);
        if (d == null) continue;
        const inv = (d - beta) / alpha;
        if (inv <= 1e-3) continue;
        const tD = 1 / inv;
        const dir = pixelToRay(b, r.x, r.y);
        const z = b.eye[2] + tD * dir[2];
        if (z > 0 && z < 300) (depthZ[r.hit.plane.buildingId] ||= []).push(z);
      }
    } else warnings.push(`${prefix}Depth map could not be calibrated against street-level geometry (too few ground samples); depth method skipped.`);
  }

  return {
    view,
    primary,
    suffix: primary ? '' : ` · ${view.label}`,
    prefix,
    b,
    planes,
    targetPlane,
    photoIds,
    rooflineHits,
    roofZ,
    roofLo,
    roofHi,
    groundResidual,
    windowsDetected: wins.length,
    windowsAboveRoofline: aboveRoof,
    windowsBehindFacade: bg?.windows.size ?? 0,
    rooflineBehindFacade: bg?.roof.size ?? 0,
    windowHits,
    depthCalibration,
    depthZ,
  };
}

type Method = NonNullable<BuildingModel['methods']>[number];

/**
 * Warning for a building other than the target whose window rows in the primary photo are
 * implausible as storeys: its windows there are not placed (n > 0), and its geometry-based
 * heights from that photo are set aside. The likelier cause is rays passing the end of the
 * footprint the windows belong to, not a wrong camera (the target's own rows would show that).
 */
function primaryMissWarning(bid: string, n: number, gap: number | undefined): string {
  const rows = gap != null && Number.isFinite(gap) ? `their rows there measure ${gap.toFixed(2)} m apart, implausible for storeys` : 'their rows there are implausible as storeys';
  const head = n > 0 ? `${n} window${n > 1 ? 's' : ''} on ${bid} not placed: ${rows}.` : `Window rows on ${bid} are implausible as storeys${gap != null && Number.isFinite(gap) ? ` (${gap.toFixed(2)} m apart)` : ''}.`;
  return `${head} Their rays most likely passed the end of the footprint they belong to and hit ${bid} behind it; this photo's geometry-based heights for ${bid} are set aside.`;
}

/** Methods A, B and C for one building as seen in one photograph. */
function viewMethods(m: ViewMeasure, fp: Footprint, ov: BuildingOverride, settings: SceneSettings, warnings: string[]) {
  const methods: Method[] = [];
  const camera = m.view.camera;
  let scaleSuspect = false;
  let rowGap: number | undefined;
  let floorH: Estimate = estimate(settings.defaultFloorHeight, settings.defaultFloorHeight - 0.3, settings.defaultFloorHeight + 0.4, 'assumed', 'default-floor-height');
  let floors: Estimate | undefined;
  const from = m.primary ? '' : ` in “${m.view.label}”`;

  // Method A — rows of windows in metric z on this building's facade.
  const mine = m.windowHits.filter((w) => w.hit.plane.buildingId === fp.id);
  if (mine.length >= 2) {
    const medH = median(mine.map((w) => w.h)) || 1.4;
    const rows = clusterRows(
      mine.map((w) => ({ id: w.det.id, z: w.hit.z })),
      Math.max(0.9, medH * 0.75),
    );
    const spacings: number[] = [];
    for (let i = 1; i < rows.length; i++) spacings.push(rows[i].z - rows[i - 1].z);
    const obsFloorH = spacings.length ? median(spacings) : NaN;
    if (spacings.length >= 1 && obsFloorH > 2.4 && obsFloorH < 5.5) {
      floorH = estimate(obsFloorH, quantile(spacings, 0.1), quantile(spacings, 0.9), 'inferred', 'row-spacing-on-facade-plane', `${spacings.length} row gaps measured by ray–plane intersection${from}`);
    } else if (spacings.length) {
      scaleSuspect = true;
      rowGap = obsFloorH;
      // In the primary photo, a building other than the target with such rows is more likely hit by
      // rays that passed the end of the footprint the windows belong to than a sign of a wrong
      // camera: its windows there are not placed, and that warning (in reconstruct) says why.
      if (!(m.primary && fp.id !== m.view.targetBuildingId)) {
        warnings.push(
          `${m.prefix}Window rows on ${fp.id} measure ${obsFloorH.toFixed(2)} m apart through the current camera — implausible for storeys, so the camera scale (FOV, distance or pitch) is probably wrong${camera.provenance.hfov === 'assumed' ? ' (the field of view is only assumed)' : ''}. Geometry-based heights are set aside; calibrate in the Camera tab.`,
        );
      }
    }
    const fh = ov.floorHeight ?? floorH.value;
    if (ov.floorHeight) floorH = estimate(ov.floorHeight, ov.floorHeight, ov.floorHeight, 'manual', 'user');
    // Floors below the lowest observed row (ground-floor shops, doors, occlusion by cars/trees),
    // counted in units of the *measured* row spacing: the ratio is invariant to camera-scale
    // errors (wrong FOV or distance).
    const lowest = rows[0].z;
    const unit = obsFloorH > 0.3 ? obsFloorH : fh;
    const extra = settings.groundFloorExtra * (unit / fh);
    const below = Math.max(0, Math.round((lowest - unit * 0.55 - extra) / unit));
    const nObs = rows.length;
    const nFloors = ov.floors ?? nObs + below;
    floors = estimate(nFloors, nFloors - (below > 0 ? 1 : 0), nFloors + 1, ov.floors ? 'manual' : 'inferred', 'window-rows', `${nObs} window rows observed${from}${below ? `, ${below} floor(s) inferred below the lowest row` : ''}`);
    const hA = nFloors * fh + settings.groundFloorExtra + 0.6;
    methods.push({
      method: 'A · floors × floor height' + m.suffix,
      value: hA,
      low: (nFloors - (below > 0 ? 1 : 0)) * (floorH.low ?? fh) + settings.groundFloorExtra,
      high: (nFloors + 1) * (floorH.high ?? fh) + settings.groundFloorExtra + 1.0,
      weight: 0,
      used: true,
      detail: `${nObs} rows clustered from ${mine.length} windows${from}; floor height ${fh.toFixed(2)} m (${floorH.source}); +${(settings.groundFloorExtra + 0.6).toFixed(1)} m ground-floor/parapet allowance. Upper bound allows one unseen top floor (e.g. a dormer floor behind the roofline).`,
    });
  }
  // Method B — roofline geometry (shares the camera scale with C)
  const zs = m.roofZ[fp.id];
  if (zs && zs.length >= 3) {
    const hB = quantile(zs, 0.75); // upper quartile: highest visible facade edge, robust to dips
    const lo = quantile(m.roofLo[fp.id] ?? zs, 0.75);
    const hi = quantile(m.roofHi[fp.id] ?? zs, 0.75);
    const spread = quantile(zs, 0.9) - quantile(zs, 0.25);
    const dist = median(m.rooflineHits.filter((r) => r.hit?.plane.buildingId === fp.id).map((r) => Math.hypot(r.hit!.point[0] - m.b.eye[0], r.hit!.point[1] - m.b.eye[1])));
    methods.push({
      method: 'B · camera ray ∩ facade plane' + m.suffix,
      value: hB,
      low: Math.min(lo, hi, hB - spread * 0.25) - 0.3,
      high: Math.max(lo, hi, hB + spread * 0.25) + 0.3,
      weight: 0,
      used: true,
      detail: `${zs.length} roofline samples${from} intersected with the OSM facade plane at ≈${dist.toFixed(0)} m; bounds from ±1° pitch and roofline spread. height = camera height + d·tan(elevation) generalised to full ray–plane intersection.`,
    });
  }
  // Method C — calibrated depth
  const dz = m.depthZ[fp.id];
  if (dz && dz.length >= 3 && m.depthCalibration) {
    const hC = quantile(dz, 0.75);
    methods.push({
      method: 'C · calibrated relative depth' + m.suffix,
      value: hC,
      low: quantile(dz, 0.25) - 1,
      high: quantile(dz, 0.95) + 1,
      weight: 0,
      used: true,
      detail: `Relative inverse depth${from} fitted to ${m.depthCalibration.samples} street-level samples (affine 1/Z model, rms ${m.depthCalibration.rms.toFixed(3)}); roofline points located along their rays.`,
    });
  }
  // A camera whose scale contradicts the window rows of this photo invalidates this photo's B and C.
  // For an extra view the floor count is set aside too: its camera is only roughly placed, rows
  // that are implausible as storeys usually mean the windows are not where the camera puts them,
  // and the building has other evidence (the primary photo, other views or the map).
  if (scaleSuspect && methods.some((x) => x.method.startsWith('A'))) {
    for (const x of methods) {
      if (x.method.startsWith('B') || x.method.startsWith('C') || !m.primary) {
        x.used = false;
        x.detail += m.primary && fp.id !== m.view.targetBuildingId
          ? ' — set aside: the window rows this photo puts on this building are implausible as storeys (rays past the end of another footprint?).'
          : ' — set aside: the camera scale is inconsistent with the observed window rows.';
      }
    }
  }
  // Floors (and floor height) only from a photograph that still contributes a used method for
  // this building: rows from a view whose measurements were all set aside are not storeys.
  const anyUsed = methods.some((x) => x.used);
  return {
    methods,
    floorH: anyUsed ? floorH : estimate(settings.defaultFloorHeight, settings.defaultFloorHeight - 0.3, settings.defaultFloorHeight + 0.4, 'assumed', 'default-floor-height'),
    floors: anyUsed ? floors : undefined,
    nWindows: mine.length,
    /** Every measurement of this building in this (extra) view was set aside for camera scale. */
    setAside: scaleSuspect && !m.primary && methods.length > 0 && !anyUsed,
    /** Window rows on this building measured an implausible storey spacing in this view. */
    scaleSuspect,
    /** That implausible median row spacing (m), when scaleSuspect. */
    rowGap,
  };
}

/** The OpenStreetMap height tag kept in the fusion of a building seen only in extra views. */
const MAP_ANCHOR = 'Map · osm:height';
const isMapAnchor = (m: { method: string }) => m.method === MAP_ANCHOR;

/* ------------------------------------------------------------------------------------------ */
/* reconstruct                                                                                  */
/* ------------------------------------------------------------------------------------------ */

export function reconstruct(input: ReconstructionInput): ReconstructionResult {
  const { scene, camera, settings, overrides } = input;
  const warnings: string[] = [];
  const target = scene.footprints.find((f) => f.id === scene.targetBuildingId)!;
  const targetPlane = facadePlane(target.id, target.ring, scene.facadeEdgeIndex);

  // ---- Views: the primary photograph first, then the extra views -----------------------------
  const primaryView: ReconView = {
    id: 'primary',
    label: scene.title,
    purpose: 'primary',
    image: scene.image,
    analysis: scene.analysis,
    footprints: scene.footprints,
    targetBuildingId: scene.targetBuildingId,
    facadeEdgeIndex: scene.facadeEdgeIndex,
    visibleBuildingIds: scene.visibleBuildingIds ?? [],
    camera,
    detections: input.detections,
  };
  const extraViews = (input.views ?? []).filter((v) => v.id !== 'primary' && v.purpose !== 'primary');
  const measures: ViewMeasure[] = [
    measureView(primaryView, true, input.depths?.primary ?? input.depth, warnings),
    ...extraViews.map((v) => measureView({ ...v, footprints: scene.footprints }, false, input.depths?.[v.id], warnings)),
  ];
  const primary = measures[0];

  const useVision = settings.heightMode !== 'map-only';
  const measuredIn = new Map<string, Set<string>>(); // view id → building ids with a used method
  // building id → views whose measurements of it were all set aside (camera scale inconsistent):
  // their windows on it neither measure nor bound its height.
  const setAsideIn = new Map<string, Set<string>>();
  const scaleSuspectIds = new Set<string>();
  // Buildings other than the target whose window rows in the *primary* photo are implausible as
  // storeys (subset of the above) → that median row spacing (m).
  const primaryScaleSuspectIds = new Map<string, number>();
  // Buildings photographed but with nothing measurable on them (for the scene-median note).
  const unmeasured = new Set<string>();
  // building id → view id → that view's used roofline height (method B) for it.
  const roofBIn = new Map<string, Map<string, number>>();

  // ---- Per building ------------------------------------------------------------------------
  const buildings: Record<string, BuildingModel> = {};
  const visionHeights: number[] = [];

  for (const fp of scene.footprints) {
    const ov = overrides[fp.id] ?? {};
    const seenIn = measures.filter((m) => m.photoIds.has(fp.id));
    const isPhoto = seenIn.length > 0 && useVision;
    const methods: Method[] = [];
    const methodView = new Map<Method, string>();
    const mapH = mapHeightOf(fp, settings.defaultFloorHeight);

    let floorH: Estimate = estimate(settings.defaultFloorHeight, settings.defaultFloorHeight - 0.3, settings.defaultFloorHeight + 0.4, 'assumed', 'default-floor-height');
    let floors: Estimate | undefined;
    let floorsView: string | undefined;

    if (isPhoto) {
      // Floors and floor height come from the photo that shows most of this building's windows
      // (ties → the earlier view, i.e. the primary photo).
      let bestN = -1;
      for (const m of seenIn) {
        const r = viewMethods(m, fp, ov, settings, warnings);
        if (r.setAside) (setAsideIn.get(fp.id) ?? setAsideIn.set(fp.id, new Set()).get(fp.id)!).add(m.view.id);
        if (r.scaleSuspect) scaleSuspectIds.add(fp.id);
        if (r.scaleSuspect && m.primary && fp.id !== scene.targetBuildingId) primaryScaleSuspectIds.set(fp.id, r.rowGap ?? NaN);
        for (const x of r.methods) {
          methods.push(x);
          methodView.set(x, m.view.id);
        }
        if (r.floors && r.nWindows > bestN) {
          bestN = r.nWindows;
          floorH = r.floorH;
          floors = r.floors;
          floorsView = m.view.id;
        }
      }
      if (settings.heightMode === 'map-prior' && mapH) {
        methods.push({ method: 'Map prior · ' + mapH.method, value: mapH.value, low: mapH.value - 1.5, high: mapH.value + 1.5, weight: 0, used: true, detail: 'OpenStreetMap tag used as an additional prior (map-prior mode).' });
      }
    }

    // ---- Fusion -------------------------------------------------------------------------
    let height: Estimate;
    let reconstructedFrom: BuildingModel['reconstructedFrom'];
    // Methods that disagree wildly with the median are flagged as unused (geometric inconsistency).
    let anchor: Method | undefined;
    if (methods.length) {
      const live = methods.filter((m) => m.used);
      const med = median(live.map((m) => m.value));
      for (const m of live) {
        if (live.length >= 3 && Math.abs(m.value - med) > Math.max(6, 0.35 * med)) {
          m.used = false;
          m.detail += ' — excluded: inconsistent with the other methods.';
        }
        if (!(m.value > 2 && m.value < 400)) {
          m.used = false;
          m.detail += ' — excluded: implausible value.';
        }
      }
      // Seen only in extra photographs (cameras only roughly placed) and left with at most one
      // photo method: an explicit height tag stays in the fusion as an anchor and is the
      // reference for outliers. One method alone rarely sees the whole building (floors × floor
      // height cannot see a tower above its last window row). Two or more agreeing photo
      // methods still override the tag.
      if (settings.heightMode !== 'map-prior' && mapH?.method === 'osm:height' && !primary.photoIds.has(fp.id) && methods.filter((m) => m.used).length <= 1) {
        anchor = {
          method: MAP_ANCHOR,
          value: mapH.value,
          low: mapH.value - 1.5,
          high: mapH.value + 1.5,
          weight: 0,
          used: true,
          detail: 'Explicit OpenStreetMap height tag, kept as an anchor: this building is measured only in extra photographs, by at most one method.',
        };
        for (const m of methods) {
          if (m.used && Math.abs(m.value - anchor.value) > Math.max(6, 0.35 * anchor.value)) {
            m.used = false;
            m.detail += ' — excluded: inconsistent with the OpenStreetMap height tag.';
          }
        }
        methods.push(anchor);
      }
      // Method C is down-weighted: monocular relative depth is the least constrained.
      const prior = (m: string) => (m.startsWith('C') ? 0.5 : 1);
      let sw = 0;
      let sv = 0;
      let sl = 0;
      let sh = 0;
      for (const m of methods) {
        if (!m.used) continue;
        const sigma = Math.max(0.5, (m.high - m.low) / 2);
        m.weight = prior(m.method) / (sigma * sigma);
        sw += m.weight;
      }
      for (const m of methods) {
        if (!m.used) continue;
        m.weight /= sw || 1;
        sv += m.weight * m.value;
        sl += m.weight * m.low;
        sh += m.weight * m.high;
      }
      const used = methods.filter((m) => m.used);
      if (used.length === 1 && isMapAnchor(used[0]) && mapH) {
        // Every photo measurement was set aside or contradicted the tag: the map height stands.
        height = estimate(mapH.value, mapH.value - 1.5, mapH.value + 1.5, 'map', mapH.method, 'Seen in an extra photograph, but its measurements were set aside or disagreed with the map tag — height from OpenStreetMap.');
        reconstructedFrom = 'map-tag';
      } else if (used.length) {
        const spread = Math.max(...used.map((m) => Math.abs(m.value - sv)));
        const usedViews = new Set(used.map((m) => methodView.get(m)).filter((v): v is string => v != null));
        for (const v of usedViews) (measuredIn.get(v) ?? measuredIn.set(v, new Set()).get(v)!).add(fp.id);
        for (const x of used) {
          const v = methodView.get(x);
          if (v == null || !x.method.startsWith('B')) continue;
          const byView = roofBIn.get(fp.id) ?? roofBIn.set(fp.id, new Map()).get(fp.id)!;
          byView.set(v, Math.max(byView.get(v) ?? -Infinity, x.value));
        }
        const viewsNote = usedViews.size > 1 ? ` Measured in ${usedViews.size} photographs.` : usedViews.size === 1 && !usedViews.has('primary') ? ` Measured in the extra view “${measures.find((m) => usedViews.has(m.view.id))!.view.label}”.` : '';
        height = estimate(
          sv,
          Math.min(sl, sv - spread),
          Math.max(sh, sv + spread),
          'inferred',
          used.length > 1 ? 'fusion' : used[0].method,
          (used.length === 1 ? 'Only one estimation method available for this building — bounds reflect that single method.' : `${used.length} methods fused (inverse-variance, heuristic σ)${anchor?.used ? ', including the OpenStreetMap height tag as an anchor' : ''}.`) + viewsNote,
        );
        reconstructedFrom = 'photo';
        visionHeights.push(sv);
      } else if (mapH && !primary.photoIds.has(fp.id)) {
        // Only seen in extra photos, none of which measured it: keep the map height.
        height = estimate(mapH.value, mapH.value - 1.5, mapH.value + 1.5, 'map', mapH.method, 'Seen in an extra photograph, but its measurements were set aside — height from OpenStreetMap.');
        reconstructedFrom = mapH.method === 'osm:height' ? 'map-tag' : 'map-levels';
      } else {
        height = estimate(12, 8, 20, 'assumed', 'default', 'All photo methods were rejected');
        reconstructedFrom = 'assumed-default';
      }
    } else if (mapH && settings.heightMode !== 'vision') {
      height = estimate(mapH.value, mapH.value - 1, mapH.value + 1, 'map', mapH.method);
      reconstructedFrom = mapH.method === 'osm:height' ? 'map-tag' : 'map-levels';
    } else if (mapH) {
      // Not visible in any photo, or photographed with nothing measurable on it: the map is the
      // only information. Disclosed as such.
      height = estimate(
        mapH.value,
        mapH.value - 1.5,
        mapH.value + 1.5,
        'map',
        mapH.method,
        seenIn.length ? 'Photographed, but no window rows or roofline could be measured on it — height from OpenStreetMap.' : 'Not visible in the photograph — height from OpenStreetMap.',
      );
      reconstructedFrom = mapH.method === 'osm:height' ? 'map-tag' : 'map-levels';
    } else {
      if (seenIn.length) unmeasured.add(fp.id);
      height = estimate(NaN, NaN, NaN, 'assumed', 'scene-median'); // filled below
      reconstructedFrom = 'assumed-default';
    }

    // Fusion may have rejected every method of the photo the floor count came from (outliers,
    // or disagreement with the map tag): its rows are then not trusted as storeys either.
    if (floors && floorsView && !methods.some((x) => x.used && methodView.get(x) === floorsView)) {
      floors = undefined;
      floorH = estimate(settings.defaultFloorHeight, settings.defaultFloorHeight - 0.3, settings.defaultFloorHeight + 0.4, 'assumed', 'default-floor-height');
    }

    if (ov.height != null) {
      height = { value: ov.height, low: ov.height, high: ov.height, source: 'manual', method: 'user', note: 'Manually corrected' };
      reconstructedFrom = 'manual';
    }
    if (!floors) {
      const fh = ov.floorHeight ?? floorH.value;
      if (ov.floorHeight) floorH = estimate(fh, fh, fh, 'manual', 'user');
      if (ov.floors) floors = estimate(ov.floors, ov.floors, ov.floors, 'manual', 'user');
      else if (fp.mapLevels) floors = estimate(fp.mapLevels, fp.mapLevels, fp.mapLevels, 'map', 'osm:building:levels');
    }
    buildings[fp.id] = { id: fp.id, height, floors, floorHeight: floorH, methods: methods.length ? methods : undefined, reconstructedFrom };
  }

  // Unseen buildings without map data: use the scene's vision-derived median, wide bounds.
  const sceneMed = visionHeights.length ? median(visionHeights) : 12;
  for (const m of Object.values(buildings)) {
    if (Number.isNaN(m.height.value)) {
      const note = unmeasured.has(m.id)
        ? 'Photographed, but nothing on it could be measured, and no map height: assumed similar to the measured buildings.'
        : 'Not visible in the photograph and no map height: assumed similar to the photographed buildings.';
      m.height = estimate(sceneMed, sceneMed * 0.6, sceneMed * 1.4, 'assumed', visionHeights.length ? 'scene-median-of-photo-heights' : 'default-12m', note);
    }
  }

  // ---- 3D windows (every view) ------------------------------------------------------------
  const windowsOut: FacadeWindow[] = [];
  const usedIds = new Set<string>();
  const dups: Record<string, number> = {};
  for (const m of measures) {
    const vid = m.view.id;
    dups[vid] = 0;
    for (const w of m.windowHits) {
      const bid = w.hit.plane.buildingId;
      const edge = w.hit.plane.edgeIndex;
      const width = Math.max(0.4, Math.min(w.w, 6));
      const height = Math.max(0.5, Math.min(w.h, 4));
      // The same physical window photographed from another view: keep the earlier view's (primary first).
      if (!m.primary) {
        const seen = windowsOut.some(
          (o) => o.viewId !== vid && o.buildingId === bid && o.edgeIndex === edge && Math.abs(o.u - w.hit.u) < 0.5 * Math.min(o.width, width) && Math.abs(o.z - w.hit.z) < 0.5 * Math.min(o.height, height),
        );
        if (seen) {
          dups[vid]++;
          continue;
        }
      }
      let id = 'win-' + w.det.id;
      if (usedIds.has(id)) id = `win-${vid}-${w.det.id}`;
      usedIds.add(id);
      const bm = buildings[bid];
      const fh = bm.floorHeight?.value ?? settings.defaultFloorHeight;
      windowsOut.push({
        id,
        detectionId: w.det.id,
        viewId: vid,
        buildingId: bid,
        edgeIndex: edge,
        u: w.hit.u,
        z: w.hit.z,
        width,
        height,
        floor: Math.max(0, Math.floor((w.hit.z - settings.groundFloorExtra) / fh)),
        source: w.det.source === 'manual' ? 'manual' : 'observed',
      });
    }
    if (!m.primary && m.windowsDetected && !m.windowHits.length) warnings.push(`${m.prefix}no detected window projects onto a photographed facade — check this view's camera position and heading.`);
  }
  const primaryWins = primary.windowsDetected;
  if (primaryWins && !primary.windowHits.length) warnings.push('No detected window projects onto a photographed facade — check camera position and heading.');
  if (!primaryWins) warnings.push('No windows detected. Add windows manually in the photo panel.');

  // ---- Regularise: snap windows to their storey / column grid (lib/align.ts) ----------------
  // Method A above used the raw hits, so heights are unaffected by the snapping.
  let windows = windowsOut;
  if (settings.regularizeWindows && windowsOut.length) {
    const grid: WindowGrid = { rows: [], cols: [] };
    for (const m of measures) {
      // an oblique street view's rows are linked mutually (lib/align windowGrid, lib/vanishing)
      const g = windowGrid(m.view.detections, { mutualRows: !!streetPerspective(m.view.detections, m.view.image) });
      grid.rows.push(...g.rows);
      grid.cols.push(...g.cols);
    }
    windows = regularizeFacadeWindows(windowsOut, { footprints: scene.footprints, grid });
    for (const w of windows) {
      const fh = buildings[w.buildingId].floorHeight?.value ?? settings.defaultFloorHeight;
      w.floor = Math.max(0, Math.floor((w.z - settings.groundFloorExtra) / fh));
    }
  }

  // ---- No window above a roof: the highest window bounds the height from below ---------------
  if (useVision) {
    // Windows of an extra view (camera only roughly placed) are neither placed nor used as a
    // height bound on a building when
    //  - that view's measurements of the building were all set aside (camera scale inconsistent
    //    with its window rows), or
    //  - they lie above the roofline the same photo measured on it: they are on a building
    //    behind, or that camera is off; the photo contradicts itself, not the height.
    // In the primary photo the windows win: a partially detected roofline is the likelier error.
    // The exception is a building other than the target whose window rows in the primary photo are
    // implausible as storeys (rows metres apart): those rays missed the surface the windows are on
    // (e.g. past the end of a neighbour's footprint onto a building far behind), so they are not
    // placed there. The target keeps its windows: they are what the user came to check.
    const drop = new Set<FacadeWindow>();
    const dropCount = new Map<string, { scale: number; roof: number }>();
    for (const w of windows) {
      const vid = w.viewId ?? 'primary';
      if (vid === 'primary') {
        if (w.buildingId === scene.targetBuildingId || !primaryScaleSuspectIds.has(w.buildingId)) continue;
        drop.add(w);
        const key = `${vid}\u0000${w.buildingId}`;
        (dropCount.get(key) ?? dropCount.set(key, { scale: 0, roof: 0 }).get(key)!).scale++;
        continue;
      }
      const scale = setAsideIn.get(w.buildingId)?.has(vid) ?? false;
      const b = roofBIn.get(w.buildingId)?.get(vid);
      const roof = !scale && b != null && w.z + w.height / 2 > b + 1;
      if (!scale && !roof) continue;
      drop.add(w);
      const key = `${vid}\u0000${w.buildingId}`;
      const c = dropCount.get(key) ?? dropCount.set(key, { scale: 0, roof: 0 }).get(key)!;
      if (scale) c.scale++;
      else c.roof++;
    }
    if (drop.size) {
      windows = windows.filter((w) => !drop.has(w));
      for (const [key, c] of dropCount) {
        const [vid, bid] = key.split('\u0000');
        const mv = measures.find((x) => x.view.id === vid);
        const pre = mv?.prefix ?? '';
        if (c.scale && vid === 'primary') warnings.push(pre + primaryMissWarning(bid, c.scale, primaryScaleSuspectIds.get(bid)));
        else if (c.scale) warnings.push(`${pre}${c.scale} window${c.scale > 1 ? 's' : ''} on ${bid} not placed: this photo's camera scale is inconsistent with its window rows there.`);
        if (c.roof) {
          warnings.push(`${pre}${c.roof} window${c.roof > 1 ? 's lie' : ' lies'} above the roofline this photo measured on ${bid} and ${c.roof > 1 ? 'were' : 'was'} not placed.`);
          if (mv) mv.windowsAboveRoofline += c.roof;
        }
      }
    }
    // A primary-photo building whose rows were set aside but none of whose windows reached this
    // point still gets the explanation (its camera-scale warning was withheld in viewMethods).
    for (const [bid, gap] of primaryScaleSuspectIds) {
      if (!dropCount.has(`primary\u0000${bid}`)) warnings.push(primary.prefix + primaryMissWarning(bid, 0, gap));
    }
    for (const m of Object.values(buildings)) {
      const hMin = minHeightFromWindows(windows, m.id);
      if (hMin == null || hMin <= m.height.value) continue;
      // Window heights measured through a camera whose scale is inconsistent are no evidence.
      if (scaleSuspectIds.has(m.id)) continue;
      if (m.height.source === 'manual') {
        warnings.push(`Windows of ${m.id} reach ${hMin.toFixed(1)} m, above the manual height ${m.height.value.toFixed(1)} m.`);
        continue;
      }
      const prev = m.height;
      // Windows that still fit inside the measured interval are no sign of a camera problem
      // (e.g. a neighbouring bay's top window landing just inside an OSM boundary): raise silently.
      const withinBounds = prev.source !== 'map' && prev.high != null && hMin <= prev.high;
      if (prev.source !== 'assumed' && !withinBounds)
        warnings.push(
          `Windows of ${m.id} reach ${hMin.toFixed(1)} m, above its ${prev.source === 'map' ? 'OpenStreetMap height' : 'measured height'} of ${prev.value.toFixed(1)} m; the height was raised to clear them. Check the camera of the photo that placed those windows.`,
        );
      // The windows are a lower bound: keep the upper uncertainty rather than collapsing the interval.
      const upper = Math.max(1, (prev.high ?? prev.value) - prev.value);
      m.height = {
        ...prev,
        value: hMin,
        low: Math.max(prev.low ?? hMin, hMin),
        high: Math.max(prev.high ?? hMin, hMin + upper),
        source: 'inferred',
        method: 'min-height-from-windows',
        note: `${prev.note ? prev.note + ' ' : ''}Raised to clear the highest detected window (top + 0.3 m; was ${prev.value.toFixed(1)} m, ${prev.source}).`,
      };
      m.reconstructedFrom = 'photo';
    }
  }

  const viewResults: ViewReconstruction[] = measures.map((m) => ({
    id: m.view.id,
    label: m.view.label,
    primary: m.primary,
    planes: m.planes,
    targetPlane: m.targetPlane,
    groundResidual: m.groundResidual,
    rooflineHits: m.rooflineHits,
    depthCalibration: m.depthCalibration,
    windowsDetected: m.windowsDetected,
    windowsPlaced: windows.filter((w) => w.viewId === m.view.id).length,
    duplicates: dups[m.view.id] ?? 0,
    windowsAboveRoofline: m.windowsAboveRoofline,
    windowsBehindFacade: m.windowsBehindFacade,
    rooflineBehindFacade: m.rooflineBehindFacade,
    measuredBuildingIds: [...(measuredIn.get(m.view.id) ?? [])],
  }));

  return {
    buildings,
    windows,
    planes: primary.planes,
    targetPlane,
    groundResidual: primary.groundResidual,
    rooflineHits: primary.rooflineHits,
    depthCalibration: primary.depthCalibration,
    warnings,
    views: viewResults,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Camera calibration on load (pitch from the ground line, then facade regularity)              */
/* ------------------------------------------------------------------------------------------ */

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Plausible horizontal-FOV bounds for auto-alignment: the camera's own `hfovRange`, else
 * [0.5, 1.05] × hfov when the FOV is EXIF-derived (provenance 'observed' or 'inferred'): a crop
 * narrows the FOV and nothing widens it. Undefined (the aligner's wide default) otherwise.
 */
export function hfovRangeFor(cam: CameraParams): [number, number] | undefined {
  if (cam.hfovRange && cam.hfovRange[0] < cam.hfovRange[1]) return cam.hfovRange;
  const pv = cam.provenance.hfov;
  if (pv === 'observed' || pv === 'inferred') return [round1(0.5 * cam.hfov), round1(1.05 * cam.hfov)];
  return undefined;
}

export interface CameraCalibration {
  camera: CameraParams;
  /** Pitch was only assumed and has been solved from the ground line. */
  pitchSolved: boolean;
  /** autoAlignCamera accepted a better camera. */
  aligned: boolean;
  notes: string[];
  /** autoAlignCamera terms (cost, spread0 → spread, …) when it ran. */
  terms?: Record<string, number>;
  /** The photo is an oblique street view and the camera agrees with its vanishing point (lib/vanishing). */
  oblique?: boolean;
  /**
   * Set when the camera was re-initialised from the street vanishing point: the view's facade
   * edge and visible buildings for the new camera (the caller must store them with the camera).
   */
  view?: { facadeEdgeIndex: number; visibleBuildingIds?: string[] };
}

/**
 * What loadScene does to every view's camera:
 *  1. an *assumed* pitch is solved so the facade ground line lies at street level (calibratePitch);
 *  2. autoAlignCamera refines every non-manual parameter from facade regularity, with the FOV
 *     bounded by hfovRangeFor(camera). The aligner only accepts a clearly better camera.
 * The derived hfovRange is persisted on the camera so later re-alignments keep the same bounds.
 */
export function calibrateViewCamera(view0: ViewGeometry, camera: CameraParams, detections: Detection[] = view0.analysis.detections, opts: { align?: boolean } = {}): CameraCalibration {
  let cam: CameraParams = structuredClone(camera);
  const notes: string[] = [];
  let pitchSolved = false;
  // 0. Oblique street view: start heading / pitch (and an assumed position) from the street
  //    vanishing point of the window rows when the camera does not explain it (lib/vanishing).
  const ob = obliqueStart(view0, cam, detections);
  notes.push(...ob.notes);
  let view = view0;
  let viewOut: CameraCalibration['view'];
  if (ob.applied) {
    viewOut = { facadeEdgeIndex: ob.facadeEdgeIndex, visibleBuildingIds: ob.visibleBuildingIds };
    view = { ...view0, ...viewOut };
  }
  cam = structuredClone(ob.camera);
  const oblique = !!ob.perspective;
  if (cam.provenance.pitch === 'assumed') {
    const p = calibratePitch(view, cam, detections);
    if (p != null) {
      const note = `Pitch solved to ${p.toFixed(1)}° so the detected facade ground line lies at street level (was ${cam.pitch}°, assumed).`;
      cam.pitch = round1(p);
      cam.provenance = { ...cam.provenance, pitch: 'inferred' };
      cam.notes = [...(cam.notes ?? []), note];
      notes.push(note);
      pitchSolved = true;
    }
  }
  // No focal length: infer the FOV from storey spacing before anything else uses the scale.
  // Pitch and FOV are coupled (both change where rows land), so alternate until they settle.
  // Not in an oblique street view: there heights scale with the lateral distance from the
  // facade, the FOV barely matters, and storey clustering under a wrong FOV runs to its clamp.
  // (obliqueStart has added the note saying so.)
  if (cam.provenance.hfov === 'assumed' && !oblique) {
    const assumedCam = cam;
    let note: string | null = null;
    let cur = cam;
    for (let it = 0; it < 4; it++) {
      const fov = inferHfovFromStoreys(view, { ...cur, provenance: { ...cur.provenance, hfov: 'assumed' } }, detections);
      if (!fov.changed) break;
      cur = fov.camera;
      note = fov.note;
      if (pitchSolved) {
        const p2 = calibratePitch(view, cur, detections);
        if (p2 != null) cur = { ...cur, pitch: round1(p2) };
      }
    }
    if (note) {
      cam = { ...cur, notes: [...(assumedCam.notes ?? []).filter((n) => !n.startsWith('Field of view inferred')), note] };
      notes.push(note);
    }
  }
  const range = hfovRangeFor(cam);
  if (range && !cam.hfovRange) cam.hfovRange = range;
  let aligned = false;
  let terms: Record<string, number> | undefined;
  if (opts.align !== false) {
    const al = autoAlignCamera({ ...view, camera: cam, detections }, { hfovRange: range, vanishingPoint: ob.constraint });
    terms = al.terms;
    notes.push(...al.notes);
    if (al.changed) {
      cam = al.camera;
      aligned = true;
    }
  }
  return { camera: cam, pitchSolved, aligned, notes, terms, oblique, ...(viewOut ? { view: viewOut } : {}) };
}
