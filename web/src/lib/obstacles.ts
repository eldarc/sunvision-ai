/**
 * Turns the reconstruction (footprints + estimated heights + windows + edits)
 * into the pure-data obstacle scene and window specs used by the solar engine
 * and the 3D view. Single source of truth: what you see is what is simulated.
 */
import type { Apartment, Detection, ExtraBuilding, FacadeWindow, Scene, SceneSettings, Tree, Vec2, Vec3 } from '../schema/scene';
import type { BoxObstacle, ObstacleScene, PrismObstacle, TreeObstacle, WindowSpec } from '../engine/types';
import { cameraBasis, facadePlane, type FacadePlane } from './camera';
import { hitFacades, type ReconView, type ReconstructionResult } from './reconstruct';
import type { ApartmentParams } from '../state/store';
import type { CameraParams } from '../schema/scene';

export interface PlacedWindow {
  fw: FacadeWindow;
  spec: WindowSpec;
  plane: FacadePlane;
  /** Corners in world space: bl, br, tr, tl. */
  corners: [Vec3, Vec3, Vec3, Vec3];
}

export interface ApartmentGeometry {
  apartment: Apartment;
  plane: FacadePlane;
  u0: number;
  u1: number;
  zFloor: number;
  /** Corners of the room floor in world space (facade-left, facade-right, back-right, back-left). */
  floorCorners: [Vec3, Vec3, Vec3, Vec3];
  windows: PlacedWindow[];
}

export interface SimGeometry {
  obstacles: ObstacleScene;
  windows: PlacedWindow[];
  apartment: ApartmentGeometry | null;
  /** Height actually used for each building in this scenario. */
  heights: Record<string, number>;
  balconies: BoxObstacle[];
}

const edgeDir = (pl: FacadePlane): Vec3 => [(pl.b[0] - pl.a[0]) / pl.length, (pl.b[1] - pl.a[1]) / pl.length, 0];

export function facadePoint(pl: FacadePlane, u: number, z: number, out = 0): Vec3 {
  const e = edgeDir(pl);
  return [pl.a[0] + e[0] * u + pl.normal[0] * out, pl.a[1] + e[1] * u + pl.normal[1] * out, z];
}

export function placeWindow(fw: FacadeWindow, pl: FacadePlane): PlacedWindow {
  const e = edgeDir(pl);
  const c = facadePoint(pl, fw.u, fw.z);
  const hw = fw.width / 2;
  const hh = fw.height / 2;
  return {
    fw,
    plane: pl,
    spec: { id: fw.id, center: c, normal: pl.normal, uAxis: e, width: fw.width, height: fw.height, ownerId: fw.buildingId },
    corners: [facadePoint(pl, fw.u - hw, fw.z - hh), facadePoint(pl, fw.u + hw, fw.z - hh), facadePoint(pl, fw.u + hw, fw.z + hh), facadePoint(pl, fw.u - hw, fw.z + hh)],
  };
}

export function scenarioHeight(est: { value: number; low?: number; high?: number; source: string }, scenario: SceneSettings['scenario']) {
  if (est.source === 'manual') return est.value;
  if (scenario === 'low') return est.low ?? est.value;
  if (scenario === 'high') return est.high ?? est.value;
  return est.value;
}

export interface GeometryInput {
  scene: Scene;
  recon: ReconstructionResult;
  settings: SceneSettings;
  trees: Tree[];
  extraBuildings: ExtraBuilding[];
  selectedWindowIds: string[];
  apartment: ApartmentParams;
  detections: Detection[];
  camera: CameraParams;
  /**
   * All photographs (sceneViews() in lib/views.ts). Balconies observed in extra views are
   * placed with that view's camera and facade planes; the primary photo always uses
   * `camera` / `detections` above.
   */
  views?: ReconView[];
}

export function buildGeometry(inp: GeometryInput): SimGeometry {
  const { scene, recon, settings } = inp;
  const prisms: PrismObstacle[] = [];
  const heights: Record<string, number> = {};
  for (const fp of scene.footprints) {
    const m = recon.buildings[fp.id];
    const isTarget = fp.id === scene.targetBuildingId;
    // The target building itself is always modelled at its best estimate (we are evaluating its windows);
    // scenario low/high applies to the surrounding obstacles.
    const h = isTarget ? m.height.value : scenarioHeight(m.height, settings.scenario);
    heights[fp.id] = h;
    if (!isTarget && !settings.showNeighbors) continue;
    const minH = Number(fp.tags['min_height'] ?? 0) || 0;
    prisms.push({ id: fp.id, kind: isTarget ? 'target-building' : 'building', label: fp.tags['name'] || fp.tags['addr:street'] ? `${fp.tags['addr:street'] ?? ''} ${fp.tags['addr:housenumber'] ?? ''}`.trim() || fp.tags['name'] : fp.id, ring: fp.ring, zMin: minH, zMax: Math.max(h, minH + 1) });
  }
  for (const xb of inp.extraBuildings) {
    prisms.push({ id: xb.id, kind: 'hypothetical', label: xb.label, ring: xb.ring, zMin: 0, zMax: xb.height });
    heights[xb.id] = xb.height;
  }

  const treeScale = settings.scenario === 'low' ? 0.75 : settings.scenario === 'high' ? 1.25 : 1;
  const trees: TreeObstacle[] = settings.showTrees
    ? inp.trees
        .filter((t) => t.enabled)
        .map((t) => ({ id: t.id, kind: 'tree' as const, label: `Tree (${t.source})`, position: t.position, height: t.height * treeScale, crownRadius: t.crownRadius * treeScale, trunkRadius: 0.25 }))
    : [];

  // Windows
  const planeOf = new Map<string, FacadePlane>();
  const getPlane = (bid: string, edge: number) => {
    const k = bid + '#' + edge;
    if (!planeOf.has(k)) {
      const fp = scene.footprints.find((f) => f.id === bid)!;
      planeOf.set(k, facadePlane(bid, fp.ring, edge));
    }
    return planeOf.get(k)!;
  };
  // A window with a non-finite coordinate (degenerate image or camera) cannot be placed: drop it
  // rather than hand the ray caster a NaN.
  const windows = recon.windows
    .map((fw) => placeWindow(fw, getPlane(fw.buildingId, fw.edgeIndex)))
    .filter((w) => [...w.spec.center, ...w.spec.normal, w.spec.width, w.spec.height].every(Number.isFinite));

  // Balconies observed in the photo (balcony-fence detections projected onto facade planes).
  const balconies: BoxObstacle[] = [];
  if (settings.showBalconies) {
    const sources: { camera: CameraParams; image: { width: number; height: number }; detections: Detection[]; planes: FacadePlane[]; label: string }[] = [
      { camera: inp.camera, image: scene.image, detections: inp.detections, planes: recon.planes, label: '' },
    ];
    for (const v of inp.views ?? []) {
      if (v.id === 'primary' || v.purpose === 'primary') continue;
      const planes = recon.views?.find((r) => r.id === v.id)?.planes;
      if (planes?.length) sources.push({ camera: v.camera, image: v.image, detections: v.detections, planes, label: v.label });
    }
    const seenIds = new Set<string>();
    for (const src of sources) {
      const b = cameraBasis(src.camera, src.image.width, src.image.height);
      for (const d of src.detections) {
        if (d.cls !== 'balcony-fence' || d.deleted) continue;
        if (seenIds.has(d.id)) continue;
        seenIds.add(d.id);
        const [x0, y0, x1, y1] = d.bbox;
        const c = hitFacades(b, src.planes, (x0 + x1) / 2, y1, 0.3);
        if (!c) continue;
        const l = hitFacades(b, [c.plane], x0, y1, 50);
        const r = hitFacades(b, [c.plane], x1, y1, 50);
        if (!l || !r) continue;
        const width = Math.min(20, Math.abs(r.u - l.u));
        if (!(width >= 0.8)) continue; // also drops NaN widths
        const depth = 1.0; // assumed protrusion (not observable from a frontal photo without depth)
        const u = (l.u + r.u) / 2;
        const slabZ = c.z; // fence bottom = balcony slab level
        const e = edgeDir(c.plane);
        const center = facadePoint(c.plane, u, slabZ - 0.1, depth / 2);
        balconies.push({ id: 'balc-' + d.id, kind: 'balcony', label: `Balcony (observed${src.label ? ` in “${src.label}”` : ''}, assumed 1.0 m deep)`, center, axes: [e, c.plane.normal, [0, 0, 1]], halfSize: [width / 2, depth / 2, 0.12] });
      }
    }
  }

  // Apartment
  let apartment: ApartmentGeometry | null = null;
  const sel = windows.filter((w) => inp.selectedWindowIds.includes(w.fw.id));
  if (sel.length) {
    const base = sel[0];
    const same = sel.filter((w) => w.fw.buildingId === base.fw.buildingId && w.fw.edgeIndex === base.fw.edgeIndex);
    const pl = base.plane;
    const ap = inp.apartment;
    const u0 = Math.max(0, Math.min(...same.map((w) => w.fw.u - w.fw.width / 2)) - ap.margin);
    const u1 = Math.min(pl.length, Math.max(...same.map((w) => w.fw.u + w.fw.width / 2)) + ap.margin);
    const bm = recon.buildings[base.fw.buildingId];
    const fh = bm.floorHeight?.value ?? settings.defaultFloorHeight;
    void fh;
    const floor = Math.min(...same.map((w) => w.fw.floor));
    const lowestSill = Math.min(...same.map((w) => w.fw.z - w.fw.height / 2));
    const highestHead = Math.max(...same.map((w) => w.fw.z + w.fw.height / 2));
    // The room floor follows the observed windows (sill height is an editable assumption),
    // and the ceiling never cuts through a window.
    const zFloor = Math.max(0, lowestSill - (ap.sillHeight ?? 0.9));
    const ceilingHeight = Math.max(ap.ceilingHeight, highestHead - zFloor + 0.2);
    const depth = ap.depth;
    const fc: [Vec3, Vec3, Vec3, Vec3] = [facadePoint(pl, u0, zFloor), facadePoint(pl, u1, zFloor), facadePoint(pl, u1, zFloor, -depth), facadePoint(pl, u0, zFloor, -depth)];
    apartment = {
      apartment: { id: 'apt-1', name: 'Hypothetical apartment', windowIds: same.map((w) => w.fw.id), depth, width: u1 - u0, ceilingHeight, floor, balconyDepth: ap.balconyDepth, partitions: ap.partitions },
      plane: pl,
      u0,
      u1,
      zFloor,
      floorCorners: fc,
      windows: same,
    };
    if (ap.balconyDepth > 0) {
      const topZ = Math.max(...same.map((w) => w.fw.z + w.fw.height / 2)) + 0.35;
      const e = edgeDir(pl);
      balconies.push({
        id: 'balc-user',
        kind: 'balcony',
        label: `Balcony/overhang above apartment (${ap.balconyDepth.toFixed(1)} m, what-if)`,
        center: facadePoint(pl, (u0 + u1) / 2, topZ, ap.balconyDepth / 2),
        axes: [e, pl.normal, [0, 0, 1]],
        halfSize: [(u1 - u0) / 2, ap.balconyDepth / 2, 0.1],
      });
    }
  }

  return { obstacles: { prisms, boxes: balconies, trees }, windows, apartment, heights, balconies };
}

/** Sutherland–Hodgman clip of a polygon (2D) against an axis-aligned rectangle. */
export function clipRect(poly: Vec2[], x0: number, x1: number, y0: number, y1: number): Vec2[] {
  const clip = (pts: Vec2[], inside: (p: Vec2) => boolean, inter: (a: Vec2, b: Vec2) => Vec2) => {
    const out: Vec2[] = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i];
      const prev = pts[(i + pts.length - 1) % pts.length];
      const ci = inside(cur);
      const pi = inside(prev);
      if (ci) {
        if (!pi) out.push(inter(prev, cur));
        out.push(cur);
      } else if (pi) out.push(inter(prev, cur));
    }
    return out;
  };
  const ix = (x: number) => (a: Vec2, b: Vec2): Vec2 => [x, a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0])];
  const iy = (y: number) => (a: Vec2, b: Vec2): Vec2 => [a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]), y];
  let p = poly;
  p = clip(p, (q) => q[0] >= x0, ix(x0));
  if (p.length) p = clip(p, (q) => q[0] <= x1, ix(x1));
  if (p.length) p = clip(p, (q) => q[1] >= y0, iy(y0));
  if (p.length) p = clip(p, (q) => q[1] <= y1, iy(y1));
  return p;
}

/**
 * Sunlight patch on the apartment floor cast through each window (geometric projection
 * along the sun direction), clipped to the room. Returned in world space.
 */
export function floorSunPatches(apt: ApartmentGeometry, sunDir: Vec3): Vec3[][] {
  if (sunDir[2] <= 0.01) return [];
  const pl = apt.plane;
  const e = edgeDir(pl);
  const n = pl.normal;
  if (sunDir[0] * n[0] + sunDir[1] * n[1] <= 0) return [];
  const toLocal = (p: Vec3): Vec2 => {
    const dx = p[0] - pl.a[0];
    const dy = p[1] - pl.a[1];
    return [dx * e[0] + dy * e[1], -(dx * n[0] + dy * n[1])]; // (u, depth into room)
  };
  const out: Vec3[][] = [];
  for (const w of apt.windows) {
    const proj = w.corners.map((c) => {
      const s = (c[2] - apt.zFloor) / sunDir[2];
      return toLocal([c[0] - sunDir[0] * s, c[1] - sunDir[1] * s, apt.zFloor]);
    });
    const clipped = clipRect(proj, apt.u0, apt.u1, 0, apt.apartment.depth);
    if (clipped.length >= 3) out.push(clipped.map(([u, d]) => facadePoint(pl, u, apt.zFloor + 0.01, -d)));
  }
  return out;
}
