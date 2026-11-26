import { describe, expect, it } from 'vitest';
import { cameraBasis, facadePlane, intersectFacade, intersectGround, pixelToRay, worldToPixel } from '../camera';
import { calibratePitch, calibrateViewCamera, clusterRows, hfovRangeFor, reconstruct, type DepthSampler, type ReconView } from '../reconstruct';
import { buildGeometry, clipRect, floorSunPatches } from '../obstacles';
import { pickSampleWindow, resolvePendingSelection } from '../useSim';
import { inferHfovFromStoreys } from '../align';
import type { CameraParams, Detection, Scene, SceneSettings, Vec2, Vec3 } from '../../schema/scene';
import { defaultSettings } from '../../state/store';
import { buildObstacleIndex, dailyExposure } from '../../engine';

/* ------------------------------------------------------------------ */
/* Synthetic world: a 12 m wide, 18 m tall building whose south facade  */
/* (edge y = 0, outward normal −y) is photographed from 20 m away.      */
/* ------------------------------------------------------------------ */
const W = 1600;
const H = 1200;
const TRUE_H = 18;
const FLOOR_H = 3.2;
const ring: Vec2[] = [
  [-6, 0],
  [6, 0],
  [6, 10],
  [-6, 10],
]; // CCW; edge 0 = south facade

const cam: CameraParams = {
  position: [0, -20],
  height: 1.6,
  heading: 0, // looking north
  pitch: 14,
  roll: 0,
  hfov: 70,
  provenance: { position: 'observed', heading: 'observed', pitch: 'assumed', hfov: 'observed', height: 'assumed' },
};

function synthScene(c: CameraParams = cam): Scene {
  const b = cameraBasis(c, W, H);
  const pl = facadePlane('b1', ring, 0);
  const proj = (p: Vec3) => worldToPixel(b, p)!;
  // Roofline & groundline samples along the facade
  const roofline = [] as { x: number; y: number }[];
  const groundline = [] as { x: number; y: number }[];
  for (let u = 0.5; u < 12; u += 0.5) {
    const top = proj([-6 + u, 0, TRUE_H]);
    const bot = proj([-6 + u, 0, 0]);
    roofline.push({ x: top[0], y: top[1] });
    groundline.push({ x: bot[0], y: bot[1] });
  }
  // 5 rows × 3 windows, 1.2 × 1.6 m, row centres at 1.6 + i·FLOOR_H (first row is ground floor)
  const dets: Detection[] = [];
  for (let r = 0; r < 5; r++)
    for (let k = 0; k < 3; k++) {
      const uc = -6 + 2.5 + k * 3.5;
      const zc = 0.6 + 1.6 + r * FLOOR_H;
      const cs = [proj([uc - 0.6, 0, zc + 0.8]), proj([uc + 0.6, 0, zc + 0.8]), proj([uc + 0.6, 0, zc - 0.8]), proj([uc - 0.6, 0, zc - 0.8])];
      const xs = cs.map((c) => c[0]);
      const ys = cs.map((c) => c[1]);
      dets.push({ id: `w${r}${k}`, cls: 'window', confidence: 0.9, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], polygon: cs, source: 'model' });
    }
  void pl;
  return {
    id: 'synthetic',
    title: 'Synthetic',
    city: 'Testville',
    country: 'NL',
    description: '',
    origin: { lat: 52.37, lon: 4.89 },
    timezone: 'Europe/Amsterdam',
    image: { url: 'x.jpg', width: W, height: H },
    camera: c,
    footprints: [
      { id: 'b1', ring, tags: {}, source: 'osm' },
      // A neighbour across the street (south of the camera), not visible in the photo, height tag 9 m
      { id: 'n1', ring: [[-10, -40], [10, -40], [10, -30], [-10, -30]], tags: { height: '9' }, mapHeight: 9, source: 'osm' },
    ],
    trees: [],
    targetBuildingId: 'b1',
    facadeEdgeIndex: 0,
    visibleBuildingIds: [],
    analysis: { model: { provider: 'manual', modelId: 'synthetic' }, imageWidth: W, imageHeight: H, detections: dets, floorRows: [], roofline, groundline, warnings: [], pipelineVersion: 'test' },
    dataSources: [],
  };
}

const settings: SceneSettings = { ...defaultSettings };

describe('camera model', () => {
  it('pixel→ray→pixel round trip', () => {
    const b = cameraBasis({ ...cam, roll: 3 }, W, H);
    for (const [px, py] of [[10, 20], [800, 600], [1500, 1100]] as const) {
      const d = pixelToRay(b, px, py);
      const p: Vec3 = [b.eye[0] + d[0] * 30, b.eye[1] + d[1] * 30, b.eye[2] + d[2] * 30];
      const q = worldToPixel(b, p)!;
      expect(q[0]).toBeCloseTo(px, 6);
      expect(q[1]).toBeCloseTo(py, 6);
    }
  });
  it('image centre looks along heading/pitch', () => {
    const b = cameraBasis({ ...cam, heading: 90, pitch: 0 }, W, H);
    const d = pixelToRay(b, W / 2, H / 2);
    expect(d[0]).toBeCloseTo(1, 9); // east
    expect(Math.abs(d[1])).toBeLessThan(1e-9);
  });
  it('ray–facade intersection recovers the textbook formula h = h_cam + d·tan(θ)', () => {
    const b = cameraBasis({ ...cam, pitch: 0 }, W, H);
    const pl = facadePlane('b1', ring, 0);
    const theta = (25 * Math.PI) / 180;
    const dir: Vec3 = [0, Math.cos(theta), Math.sin(theta)];
    const hit = intersectFacade(b.eye, dir, pl)!;
    expect(hit.z).toBeCloseTo(1.6 + 20 * Math.tan(theta), 9);
    expect(pl.normal[1]).toBeCloseTo(-1, 9); // south facade faces south
  });
});

describe('vision-first height estimation (synthetic fixture)', () => {
  it('Method B recovers the true height from roofline pixels', () => {
    const r = reconstruct({ scene: synthScene(), camera: cam, detections: synthScene().analysis.detections, settings, overrides: {} });
    const m = r.buildings.b1;
    const b = m.methods!.find((x) => x.method.startsWith('B'))!;
    expect(b.value).toBeCloseTo(TRUE_H, 1);
    expect(b.low).toBeLessThan(TRUE_H);
    expect(b.high).toBeGreaterThan(TRUE_H);
    expect(r.groundResidual!).toBeCloseTo(0, 3);
  });
  it('Method A counts window rows and measures floor height on the facade plane', () => {
    const r = reconstruct({ scene: synthScene(), camera: cam, detections: synthScene().analysis.detections, settings, overrides: {} });
    const m = r.buildings.b1;
    expect(m.floors!.value).toBe(5);
    expect(m.floorHeight!.value).toBeCloseTo(FLOOR_H, 2);
    expect(m.floorHeight!.source).toBe('inferred');
    expect(r.windows).toHaveLength(15);
    for (const w of r.windows) {
      // axis-aligned boxes around perspective trapezoids slightly over-estimate size
      expect(Math.abs(w.width - 1.2)).toBeLessThan(0.15);
      expect(Math.abs(w.height - 1.6)).toBeLessThan(0.15);
    }
  });
  it('fused estimate is inferred, within bounds and close to truth', () => {
    const r = reconstruct({ scene: synthScene(), camera: cam, detections: synthScene().analysis.detections, settings, overrides: {} });
    const h = r.buildings.b1.height;
    expect(h.source).toBe('inferred');
    expect(Math.abs(h.value - TRUE_H)).toBeLessThan(1.0);
    expect(h.low!).toBeLessThanOrEqual(h.value);
    expect(h.high!).toBeGreaterThanOrEqual(h.value);
  });
  it('pitch auto-calibration recovers a mis-set pitch from the ground line', () => {
    const s = synthScene();
    const p = calibratePitch(s, { ...cam, pitch: 4 })!;
    expect(p).toBeCloseTo(cam.pitch, 1);
  });
  it('manual overrides win and are marked manual', () => {
    const s = synthScene();
    const r = reconstruct({ scene: s, camera: cam, detections: s.analysis.detections, settings, overrides: { b1: { height: 25, floors: 7 } } });
    expect(r.buildings.b1.height.value).toBe(25);
    expect(r.buildings.b1.height.source).toBe('manual');
    expect(r.buildings.b1.floors!.value).toBe(7);
  });
  it('buildings not visible in the photo are never labelled as photo reconstructions', () => {
    const s = synthScene();
    const r = reconstruct({ scene: s, camera: cam, detections: s.analysis.detections, settings, overrides: {} });
    expect(r.buildings.n1.reconstructedFrom).toBe('map-tag');
    expect(r.buildings.n1.height.source).toBe('map');
  });
  it('map-only mode ignores the photo entirely', () => {
    const s = synthScene();
    const r = reconstruct({ scene: s, camera: cam, detections: s.analysis.detections, settings: { ...settings, heightMode: 'map-only' }, overrides: {} });
    expect(r.buildings.b1.reconstructedFrom).not.toBe('photo');
  });
});

describe('failure & missing-data paths', () => {
  it('no detections (failed inference / manual mode) → warning, no fabricated windows', () => {
    const s = synthScene();
    s.analysis.detections = [];
    const r = reconstruct({ scene: s, camera: cam, detections: [], settings, overrides: {} });
    expect(r.windows).toHaveLength(0);
    expect(r.warnings.join(' ')).toMatch(/No windows detected/);
    // Roofline still gives a single-method estimate, disclosed as such.
    expect(r.buildings.b1.height.note).toMatch(/Only one estimation method/);
  });
  it('no roofline and no windows → assumed height, flagged', () => {
    const s = synthScene();
    s.analysis.detections = [];
    s.analysis.roofline = [];
    s.analysis.groundline = [];
    const r = reconstruct({ scene: s, camera: cam, detections: [], settings, overrides: {} });
    expect(r.buildings.b1.height.source).toBe('assumed');
    expect(r.groundResidual).toBeNull();
  });
  it('a wrong camera heading makes windows miss the facade and says so', () => {
    const s = synthScene();
    const bad = { ...cam, heading: 120 };
    const r = reconstruct({ scene: s, camera: bad, detections: s.analysis.detections, settings, overrides: {} });
    expect(r.windows.length).toBe(0);
    expect(r.warnings.join(' ')).toMatch(/check camera/);
  });
});

describe('unknown field of view (no focal length)', () => {
  it('infers the FOV from storey spacing, labels it, and gives a sane height', () => {
    const s = synthScene(); // true hfov 70°, true storeys 3.2 m, true height 18 m
    const guess = { ...cam, hfov: 40, provenance: { ...cam.provenance, hfov: 'assumed' as const } };
    const r = inferHfovFromStoreys(s, guess, s.analysis.detections);
    expect(r.changed).toBe(true);
    expect(r.camera.provenance.hfov).toBe('inferred');
    expect(r.note).toMatch(/storeys/);
    // 3.3 m assumed vs 3.2 m true → FOV within a few degrees of the truth
    expect(Math.abs(r.camera.hfov - 70)).toBeLessThan(4);
    const cal = calibrateViewCamera(s, guess, s.analysis.detections);
    const rec = reconstruct({ scene: s, camera: cal.camera, detections: s.analysis.detections, settings, overrides: {} });
    expect(Math.abs(rec.buildings.b1.height.value - 18)).toBeLessThan(2.5);
  });
  it('leaves an observed FOV alone', () => {
    const s = synthScene();
    const r = inferHfovFromStoreys(s, cam, s.analysis.detections);
    expect(r.changed).toBe(false);
  });
});

describe('inconsistent camera scale', () => {
  it('a badly wrong FOV makes window rows implausible → geometry methods set aside, floors method kept', () => {
    const s = synthScene();
    const bad = { ...cam, hfov: 22, provenance: { ...cam.provenance, hfov: 'assumed' as const } };
    const r = reconstruct({ scene: s, camera: bad, detections: s.analysis.detections, settings, overrides: {} });
    const m = r.buildings.b1;
    const a = m.methods!.find((x) => x.method.startsWith('A'))!;
    const b = m.methods!.find((x) => x.method.startsWith('B'));
    expect(a.used).toBe(true);
    if (b) expect(b.used).toBe(false);
    expect(r.warnings.join(' ')).toMatch(/camera scale/);
    // floors are still counted from the photo; height falls back to floors × assumed floor height
    expect(m.floors!.value).toBeGreaterThanOrEqual(4);
    expect(Math.abs(m.height.value - 18)).toBeLessThan(4);
  });
});

describe('primary-photo windows whose rays miss the target', () => {
  it('windows landing on a far building with implausible rows are not placed there (no window above a roof)', () => {
    // The target footprint ends at x = 2 m, but the photo shows a third window column at x ≈ 3.5 m
    // (e.g. a rounded corner the map lacks): those rays pass the target and hit a building 60 m
    // behind it, where the five windows measure ≈ 13 m apart — not storeys.
    const s = synthScene();
    const narrow: Vec2[] = [[-6, 0], [2, 0], [2, 10], [-6, 10]];
    const far: Scene['footprints'][number] = { id: 'far', ring: [[-40, 60], [40, 60], [40, 70], [-40, 70]], tags: {}, source: 'osm' };
    const scene: Scene = { ...s, footprints: [{ ...s.footprints[0], ring: narrow }, s.footprints[1], far], visibleBuildingIds: ['far'] };
    const r = reconstruct({ scene, camera: cam, detections: s.analysis.detections, settings, overrides: {} });
    expect(r.windows.filter((w) => w.buildingId === 'far')).toHaveLength(0);
    expect(r.warnings.join(' ')).toMatch(/5 windows on far not placed: their rows there measure .* implausible for storeys\. Their rays most likely passed the end of the footprint/);
    // the camera is not blamed: the target's rows are fine, so no "calibrate" advice
    expect(r.warnings.join(' ')).not.toMatch(/camera scale|calibrate in the Camera tab/);
    // the target keeps its own windows, and no window sits above a roof
    expect(r.windows.filter((w) => w.buildingId === 'b1')).toHaveLength(10);
    for (const w of r.windows) expect(w.z + w.height / 2).toBeLessThanOrEqual(r.buildings[w.buildingId].height.value + 1e-6);
  });
});

/* ------------------------------------------------------------------ */
/* A taller building far behind the target, inside the facade mask     */
/* (the Vilsonovo case, fixtures/vilsonovo): depth sets it aside.     */
/* ------------------------------------------------------------------ */
const camT: CameraParams = { ...cam, pitch: 20 };
const TOWER_Y = 40; // front face 60 m from the camera: 3× the target facade's 20 m
const TOWER_H = 60;

/**
 * The synthetic target photographed with a tower behind it spanning world x ∈ [x0, x1] at
 * y = TOWER_Y. The facade mask swallows the tower: in the columns where it rises above the
 * target, the detected roofline follows the tower's top. One false "window" sits on the tower.
 */
function towerScene(x0 = -6.75, x1 = 9.75): Scene {
  const s = synthScene(camT);
  const b = cameraBasis(camT, W, H);
  const proj = (p: Vec3) => worldToPixel(b, p)!;
  const k = (TOWER_Y + 20) / 20; // facade column x_f → tower x along the same ray
  s.analysis.roofline = [];
  for (let u = 0.5; u < 12; u += 0.5) {
    const xf = -6 + u;
    const fac = proj([xf, 0, TRUE_H]);
    const tw = xf * k >= x0 && xf * k <= x1 ? proj([xf * k, TOWER_Y, TOWER_H]) : null;
    const p = tw && tw[1] < fac[1] ? tw : fac;
    s.analysis.roofline.push({ x: p[0], y: p[1] });
  }
  const cs = [proj([0.9, TOWER_Y, 57.3]), proj([2.1, TOWER_Y, 57.3]), proj([2.1, TOWER_Y, 55.7]), proj([0.9, TOWER_Y, 55.7])];
  const xs = cs.map((c) => c[0]);
  const ys = cs.map((c) => c[1]);
  s.analysis.detections = [...s.analysis.detections, { id: 'tower-window', cls: 'window', confidence: 0.6, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], polygon: cs, source: 'model' }];
  // the tower is mapped but not one of the photographed buildings (nobody picked it)
  s.footprints = [...s.footprints, { id: 'tower', ring: [[x0, TOWER_Y], [x1, TOWER_Y], [x1, TOWER_Y + 10], [x0, TOWER_Y + 10]], tags: {}, source: 'osm' }];
  return s;
}

/** Exact relative inverse depth 2 / Z (Z along the optical axis): target facade, tower, street, sky 0. */
function towerDepth(x0 = -6.75, x1 = 9.75, towerValue?: number): DepthSampler {
  const b = cameraBasis(camT, W, H);
  const target = facadePlane('b1', ring, 0);
  const tower = facadePlane('tower', [[x0, TOWER_Y], [x1, TOWER_Y], [x1, TOWER_Y + 10], [x0, TOWER_Y + 10]], 0);
  return {
    width: W,
    height: H,
    sample(px, py) {
      const dir = pixelToRay(b, px, py);
      const axial = (t: number) => t * (dir[0] * b.forward[0] + dir[1] * b.forward[1] + dir[2] * b.forward[2]);
      const f = intersectFacade(b.eye, dir, target, 0);
      if (f && f.z >= 0 && f.z <= TRUE_H) return 2 / axial(f.t);
      const t = intersectFacade(b.eye, dir, tower, 0);
      if (t && t.z >= 0 && t.z <= TOWER_H) return towerValue ?? 2 / axial(t.t);
      const g = intersectGround(b.eye, dir);
      if (g) return 2 / axial(Math.hypot(g[0] - b.eye[0], g[1] - b.eye[1], g[2] - b.eye[2]));
      return 0; // sky
    },
  };
}

describe('background behind the facade (depth discontinuities)', () => {
  const run = (s: Scene, depth: DepthSampler | null) => reconstruct({ scene: s, camera: camT, detections: s.analysis.detections, settings, overrides: {}, depth });
  const methodB = (r: ReturnType<typeof reconstruct>) => r.buildings.b1.methods!.find((x) => x.method.startsWith('B'))!;

  it('without a depth map the tower inflates the roofline and adds a false storey (the failure depth guards against)', () => {
    const r = run(towerScene(), null);
    expect(methodB(r).value).toBeGreaterThan(20);
    expect(r.buildings.b1.floors!.value).toBe(6);
    expect(r.windows.filter((w) => w.buildingId === 'b1')).toHaveLength(16);
    expect(r.warnings.join(' ')).not.toMatch(/set aside: the depth map/);
  });

  it('with depth, the roofline over the tower and the window on it are set aside: true height, 5 floors', () => {
    const r = run(towerScene(), towerDepth());
    const m = r.buildings.b1;
    expect(methodB(r).value).toBeCloseTo(TRUE_H, 1);
    expect(methodB(r).detail).toMatch(/^12 roofline samples/);
    expect(Math.abs(m.height.value - TRUE_H)).toBeLessThan(1);
    expect(m.height.source).toBe('inferred');
    expect(m.floors!.value).toBe(5);
    expect(m.floorHeight!.value).toBeCloseTo(FLOOR_H, 2);
    const onB1 = r.windows.filter((w) => w.buildingId === 'b1');
    expect(onB1).toHaveLength(15);
    expect(onB1.some((w) => w.detectionId === 'tower-window')).toBe(false);
    for (const w of onB1) expect(w.z + w.height / 2).toBeLessThan(TRUE_H);
    expect(r.views![0].rooflineBehindFacade).toBe(11);
    expect(r.views![0].windowsBehindFacade).toBe(1);
    expect(r.rooflineHits.filter((h) => h.behind)).toHaveLength(11);
    expect(r.warnings.join(' ')).toMatch(/11 roofline samples and 1 window set aside: the depth map puts them about 3× farther than the facade they project onto/);
  });

  it('nothing is set aside without a building behind (an exact facade depth map)', () => {
    const s = synthScene(camT);
    const r = run(s, towerDepth(1000, 1001));
    const r0 = run(s, null);
    expect(r.views![0].rooflineBehindFacade).toBe(0);
    expect(r.views![0].windowsBehindFacade).toBe(0);
    expect(methodB(r).value).toBe(methodB(r0).value);
    expect(r.windows.map((w) => [w.id, w.z])).toEqual(r0.windows.map((w) => [w.id, w.z]));
    expect(r.warnings.join(' ')).not.toMatch(/set aside: the depth map/);
  });

  it('a single far sample is depth-model or mask noise, not a building: kept', () => {
    // a tower only one roofline sample wide (x_f = 0.5 → x ∈ [0.75, 2.25])
    const s = towerScene(0.75, 2.25);
    const r = run(s, towerDepth(0.75, 2.25));
    expect(r.views![0].rooflineBehindFacade).toBe(0);
    expect(methodB(r).value).toBe(methodB(run(s, null)).value);
  });

  it('samples that read as sky (≥ 10× farther) are not taken for a building behind', () => {
    const s = towerScene();
    const r = run(s, towerDepth(-6.75, 9.75, 0));
    expect(r.views![0].rooflineBehindFacade).toBe(0);
    expect(r.views![0].windowsBehindFacade).toBe(0);
  });

  it('when too little of the roofline would be left, the roofline is kept as it is (windows still checked)', () => {
    const s = towerScene(-40, 40); // the tower rises behind every roofline sample
    const r = run(s, towerDepth(-40, 40));
    expect(r.views![0].rooflineBehindFacade).toBe(0);
    expect(methodB(r).value).toBe(methodB(run(s, null)).value);
    expect(r.views![0].windowsBehindFacade).toBe(1);
    expect(r.warnings.join(' ')).toMatch(/^1 window set aside: the depth map puts it about 3× farther/m);
  });
});

describe('selection → apartment geometry', () => {
  it('selected detections become an apartment volume behind those windows', () => {
    const s = synthScene();
    const r = reconstruct({ scene: s, camera: cam, detections: s.analysis.detections, settings, overrides: {} });
    const ids = ['win-w21', 'win-w22'];
    const g = buildGeometry({ scene: s, recon: r, settings, trees: [], extraBuildings: [], selectedWindowIds: ids, apartment: { depth: 6, ceilingHeight: 2.7, balconyDepth: 0, partitions: 1, margin: 0.5, sillHeight: 0.9 }, detections: s.analysis.detections, camera: cam });
    expect(g.apartment).not.toBeNull();
    expect(g.apartment!.windows.map((w) => w.fw.id).sort()).toEqual(ids);
    expect(g.apartment!.apartment.floor).toBe(2);
    // room lies behind the facade (inside the footprint, y > 0)
    for (const c of g.apartment!.floorCorners) expect(c[1]).toBeGreaterThanOrEqual(-1e-9);
  });
  it('sun patch on the floor only exists when the sun is in front of the facade', () => {
    const s = synthScene();
    const r = reconstruct({ scene: s, camera: cam, detections: s.analysis.detections, settings, overrides: {} });
    const g = buildGeometry({ scene: s, recon: r, settings, trees: [], extraBuildings: [], selectedWindowIds: ['win-w21'], apartment: { depth: 6, ceilingHeight: 2.7, balconyDepth: 0, partitions: 0, margin: 0.5, sillHeight: 0.9 }, detections: s.analysis.detections, camera: cam });
    const southSun: Vec3 = [0, -Math.cos(0.6), Math.sin(0.6)];
    const northSun: Vec3 = [0, Math.cos(0.6), Math.sin(0.6)];
    expect(floorSunPatches(g.apartment!, southSun).length).toBe(1);
    expect(floorSunPatches(g.apartment!, northSun).length).toBe(0);
  });
  it('clipRect clips to the rectangle', () => {
    const p = clipRect([[-1, -1], [3, -1], [3, 3], [-1, 3]], 0, 2, 0, 2);
    const xs = p.map((q) => q[0]);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(2);
  });
});

describe('geometry edits propagate into the simulation', () => {
  it('a hypothetical tall building across the street reduces the apartment’s direct sun', () => {
    const s = synthScene();
    const r = reconstruct({ scene: s, camera: cam, detections: s.analysis.detections, settings, overrides: {} });
    const base = { scene: s, recon: r, settings, trees: [], selectedWindowIds: ['win-w11'], apartment: { depth: 6, ceilingHeight: 2.7, balconyDepth: 0, partitions: 0, margin: 0.5, sillHeight: 0.9 }, detections: s.analysis.detections, camera: cam };
    const ctx = { lat: 52.37, lon: 4.89, tz: 'Europe/Amsterdam' };
    const run = (extra: Parameters<typeof buildGeometry>[0]['extraBuildings']) => {
      const g = buildGeometry({ ...base, extraBuildings: extra });
      return dailyExposure(buildObstacleIndex(g.obstacles), g.apartment!.windows.map((w) => w.spec), '2025-12-21', ctx, 10).aggregate.directMinutes;
    };
    const open = run([]);
    const blocked = run([{ id: 'x', ring: [[-30, -25], [30, -25], [30, -15], [-30, -15]], height: 60, label: 'tower', source: 'manual' }]);
    expect(open).toBeGreaterThan(60);
    expect(blocked).toBeLessThan(open);
  });
  it('balcony overhang above the window reduces summer exposure', () => {
    const s = synthScene();
    const r = reconstruct({ scene: s, camera: cam, detections: s.analysis.detections, settings, overrides: {} });
    const ctx = { lat: 52.37, lon: 4.89, tz: 'Europe/Amsterdam' };
    const run = (bd: number) => {
      const g = buildGeometry({ scene: s, recon: r, settings, trees: [], extraBuildings: [], selectedWindowIds: ['win-w11'], apartment: { depth: 6, ceilingHeight: 2.7, balconyDepth: bd, partitions: 0, margin: 0.5, sillHeight: 0.9 }, detections: s.analysis.detections, camera: cam });
      return dailyExposure(buildObstacleIndex(g.obstacles), g.apartment!.windows.map((w) => w.spec), '2025-06-21', ctx, 10).aggregate.directMinutes;
    };
    expect(run(2.5)).toBeLessThan(run(0));
  });
});

describe('row clustering', () => {
  it('groups by gap', () => {
    const rows = clusterRows([{ id: 'a', z: 1 }, { id: 'b', z: 1.2 }, { id: 'c', z: 4.3 }, { id: 'd', z: 7.5 }, { id: 'e', z: 7.4 }], 1.2);
    expect(rows.map((r) => r.ids.length)).toEqual([2, 1, 2]);
  });
});

/* ------------------------------------------------------------------ */
/* Multi-view: an extra photo of the obstacle across the street        */
/* ------------------------------------------------------------------ */
// n1 (ring [-10,-40] … [-10,-30], map height tag 9 m) is really OBS_H tall. Its north facade
// (edge 2, y = −30, normal +y) is photographed by a second camera standing on the street.
const OBS_H = 15;
const OBS_FLOOR_H = 3.0;
const camX: CameraParams = {
  position: [0, -12],
  height: 1.6,
  heading: 180, // looking south
  pitch: 12,
  roll: 0,
  hfov: 70,
  provenance: { position: 'observed', heading: 'observed', pitch: 'assumed', hfov: 'observed', height: 'assumed' },
};

function extraView(s: Scene, c: CameraParams = camX): ReconView {
  const b = cameraBasis(c, W, H);
  const proj = (p: Vec3) => worldToPixel(b, p)!;
  const roofline: { x: number; y: number }[] = [];
  const groundline: { x: number; y: number }[] = [];
  for (let x = -9; x <= 9; x += 0.5) {
    const top = proj([x, -30, OBS_H]);
    const bot = proj([x, -30, 0]);
    roofline.push({ x: top[0], y: top[1] });
    groundline.push({ x: bot[0], y: bot[1] });
  }
  // 4 rows × 3 windows; ids deliberately collide with the primary photo's ('w00' …)
  const dets: Detection[] = [];
  for (let r = 0; r < 4; r++)
    for (let k = 0; k < 3; k++) {
      const x = -5 + k * 5;
      const zc = 0.6 + 1.6 + r * OBS_FLOOR_H;
      const cs = [proj([x + 0.6, -30, zc + 0.8]), proj([x - 0.6, -30, zc + 0.8]), proj([x - 0.6, -30, zc - 0.8]), proj([x + 0.6, -30, zc - 0.8])];
      const xs = cs.map((q) => q[0]);
      const ys = cs.map((q) => q[1]);
      dets.push({ id: `w${r}${k}`, cls: 'window', confidence: 0.9, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], polygon: cs, source: 'model' });
    }
  return {
    id: 'across',
    label: 'Across the street',
    purpose: 'surroundings',
    image: { url: 'y.jpg', width: W, height: H },
    camera: c,
    detections: dets,
    analysis: { model: { provider: 'manual', modelId: 'synthetic' }, imageWidth: W, imageHeight: H, detections: dets, floorRows: [], roofline, groundline, warnings: [], pipelineVersion: 'test' },
    footprints: s.footprints,
    targetBuildingId: 'n1',
    facadeEdgeIndex: 2,
    visibleBuildingIds: [],
  };
}

/** Exact synthetic inverse depth (affine in 1/Z) for the extra view: obstacle facade, else street. */
function extraDepth(c: CameraParams = camX): DepthSampler {
  const b = cameraBasis(c, W, H);
  const pl = facadePlane('n1', [[-10, -40], [10, -40], [10, -30], [-10, -30]], 2);
  return {
    width: W,
    height: H,
    sample(px, py) {
      const dir = pixelToRay(b, px, py);
      const f = intersectFacade(b.eye, dir, pl, 0);
      if (f && f.z >= 0 && f.z <= OBS_H) return 2 / f.t + 0.1;
      const g = intersectGround(b.eye, dir);
      if (!g) return null;
      return 2 / Math.hypot(g[0] - b.eye[0], g[1] - b.eye[1], g[2] - b.eye[2]) + 0.1;
    },
  };
}

describe('multi-view reconstruction', () => {
  it('an obstacle photographed in an extra view gets a photo height instead of its map tag', () => {
    const s = synthScene();
    const single = reconstruct({ scene: s, camera: cam, detections: s.analysis.detections, settings, overrides: {} });
    expect(single.buildings.n1.reconstructedFrom).toBe('map-tag');
    const v = extraView(s);
    const r = reconstruct({ scene: s, camera: cam, detections: s.analysis.detections, settings, overrides: {}, views: [v] });
    const n1 = r.buildings.n1;
    expect(n1.reconstructedFrom).toBe('photo');
    expect(n1.height.source).toBe('inferred');
    expect(Math.abs(n1.height.value - OBS_H)).toBeLessThan(1.0);
    expect(n1.floors!.value).toBe(4);
    expect(n1.floorHeight!.value).toBeCloseTo(OBS_FLOOR_H, 1);
    // method names carry the view label; the primary photo's methods do not
    const names = n1.methods!.map((m) => m.method);
    expect(names.some((n) => n.startsWith('A') && n.endsWith(' · Across the street'))).toBe(true);
    expect(names.some((n) => n.startsWith('B') && n.endsWith(' · Across the street'))).toBe(true);
    expect(r.buildings.b1.methods!.every((m) => !m.method.includes('Across'))).toBe(true);
    expect(r.buildings.b1.height.value).toBeCloseTo(single.buildings.b1.height.value, 6);
    expect(r.views!.map((x) => x.id)).toEqual(['primary', 'across']);
    expect(r.views![1].measuredBuildingIds).toEqual(['n1']);
  });
  it('a single extra-view method does not override an explicit height tag (the tag is kept as an anchor)', () => {
    // Only method A in the extra view (no roofline, no depth): floors × floor height.
    const s = synthScene();
    const v = extraView(s);
    v.analysis = { ...v.analysis, roofline: [] };
    // A tag far above what the window rows can see (a tower above the last row): the map stands.
    s.footprints.find((f) => f.id === 'n1')!.mapHeight = 40;
    const far = reconstruct({ scene: s, camera: cam, detections: s.analysis.detections, settings, overrides: {}, views: [v] }).buildings.n1;
    expect(far.height.value).toBe(40);
    expect(far.height.source).toBe('map');
    expect(far.methods!.find((m) => m.method.startsWith('A'))!.used).toBe(false);
    expect(far.floors?.source).not.toBe('inferred'); // rows of a rejected view are not storeys
    // A tag close to the photo estimate: fused, the tag weighs in.
    s.footprints.find((f) => f.id === 'n1')!.mapHeight = 16;
    const near = reconstruct({ scene: s, camera: cam, detections: s.analysis.detections, settings, overrides: {}, views: [v] }).buildings.n1;
    const a = near.methods!.find((m) => m.method.startsWith('A'))!;
    expect(a.used).toBe(true);
    expect(near.methods!.some((m) => m.method === 'Map · osm:height' && m.used)).toBe(true);
    expect(near.height.value).toBeGreaterThan(Math.min(a.value, 16) - 1e-9);
    expect(near.height.value).toBeLessThan(Math.max(a.value, 16) + 1e-9);
    expect(near.height.low!).toBeLessThan(near.height.high!);
  });
  it('a photographed building with nothing measurable keeps its map height (vision mode)', () => {
    const s = synthScene();
    const v = extraView(s);
    v.analysis = { ...v.analysis, roofline: [] };
    v.detections = [];
    v.analysis.detections = [];
    const r = reconstruct({ scene: s, camera: cam, detections: s.analysis.detections, settings, overrides: {}, views: [v] });
    expect(r.buildings.n1.height.value).toBe(9);
    expect(r.buildings.n1.height.source).toBe('map');
    expect(r.buildings.n1.height.note).toMatch(/Photographed, but no window rows or roofline/);
  });
  it('places the extra view’s windows with unique ids and their view id', () => {
    const s = synthScene();
    const r = reconstruct({ scene: s, camera: cam, detections: s.analysis.detections, settings, overrides: {}, views: [extraView(s)] });
    const obs = r.windows.filter((w) => w.buildingId === 'n1');
    expect(obs).toHaveLength(12);
    expect(obs.every((w) => w.viewId === 'across' && w.edgeIndex === 2)).toBe(true);
    expect(r.windows.filter((w) => w.viewId === 'primary')).toHaveLength(15);
    expect(new Set(r.windows.map((w) => w.id)).size).toBe(r.windows.length);
    // primary ids keep the 'win-' + detectionId contract
    expect(r.windows.find((w) => w.viewId === 'primary' && w.detectionId === 'w21')!.id).toBe('win-w21');
    for (const w of obs) {
      expect(Math.abs(w.width - 1.2)).toBeLessThan(0.15);
      expect(Math.abs(w.height - 1.6)).toBeLessThan(0.15);
    }
  });
  it('a sceneViews-style list with a primary entry is accepted and the primary entry is not counted twice', () => {
    const s = synthScene();
    const primary: ReconView = { ...s, id: 'primary', label: s.title, purpose: 'primary', camera: cam, detections: s.analysis.detections, visibleBuildingIds: [] };
    const r = reconstruct({ scene: s, camera: cam, detections: s.analysis.detections, settings, overrides: {}, views: [primary, extraView(s)] });
    expect(r.views).toHaveLength(2);
    expect(r.windows).toHaveLength(27);
  });
  it('uses one depth sampler per view (method C for the obstacle comes from the extra view’s depth)', () => {
    const s = synthScene();
    const v = extraView(s);
    const without = reconstruct({ scene: s, camera: cam, detections: s.analysis.detections, settings, overrides: {}, views: [v] });
    expect(without.buildings.n1.methods!.some((m) => m.method.startsWith('C'))).toBe(false);
    const r = reconstruct({ scene: s, camera: cam, detections: s.analysis.detections, settings, overrides: {}, views: [v], depths: { across: extraDepth() } });
    const c = r.buildings.n1.methods!.find((m) => m.method.startsWith('C'))!;
    expect(c.method).toBe('C · calibrated relative depth · Across the street');
    expect(Math.abs(c.value - OBS_H)).toBeLessThan(1.0);
    expect(r.views![1].depthCalibration!.samples).toBeGreaterThanOrEqual(12);
    expect(r.depthCalibration).toBeNull(); // the primary photo has no depth here
  });
  it('a window seen in two photos is placed once (the primary photo wins)', () => {
    const s = synthScene();
    // a second view of the target facade from slightly to the side: same windows as the primary
    const c2: CameraParams = { ...cam, position: [2, -22], heading: -4 };
    const b2 = cameraBasis(c2, W, H);
    const proj = (p: Vec3) => worldToPixel(b2, p)!;
    const dets: Detection[] = [];
    for (let r = 0; r < 5; r++)
      for (let k = 0; k < 3; k++) {
        const uc = -6 + 2.5 + k * 3.5;
        const zc = 0.6 + 1.6 + r * FLOOR_H;
        const cs = [proj([uc - 0.6, 0, zc + 0.8]), proj([uc + 0.6, 0, zc + 0.8]), proj([uc + 0.6, 0, zc - 0.8]), proj([uc - 0.6, 0, zc - 0.8])];
        const xs = cs.map((q) => q[0]);
        const ys = cs.map((q) => q[1]);
        dets.push({ id: `v2-${r}${k}`, cls: 'window', confidence: 0.9, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], source: 'model' });
      }
    const v2: ReconView = { ...s, id: 'side', label: 'Side', purpose: 'surroundings', camera: c2, detections: dets, analysis: { ...s.analysis, detections: dets, roofline: [], groundline: [] }, visibleBuildingIds: [] };
    const r = reconstruct({ scene: s, camera: cam, detections: s.analysis.detections, settings, overrides: {}, views: [v2] });
    expect(r.windows).toHaveLength(15);
    expect(r.views![1].duplicates).toBe(15);
    expect(r.windows.every((w) => w.viewId === 'primary')).toBe(true);
  });
});

describe('alignment integration (lib/align.ts)', () => {
  const jittered = () => {
    const s = synthScene();
    let k = 0;
    // deterministic ±6 px jitter of the boxes (detector noise)
    s.analysis.detections = s.analysis.detections.map((d) => {
      const j = (n: number) => ((((k++ * 7919) % 13) - 6) * n) / 6;
      const [x0, y0, x1, y1] = d.bbox;
      return { ...d, bbox: [x0 + j(6), y0 + j(6), x1 + j(6), y1 + j(6)] as [number, number, number, number], polygon: undefined };
    });
    return s;
  };
  const rowSpread = (ws: { floor: number; z: number }[]) => {
    let worst = 0;
    for (const f of new Set(ws.map((w) => w.floor))) {
      const zs = ws.filter((w) => w.floor === f).map((w) => w.z);
      worst = Math.max(worst, Math.max(...zs) - Math.min(...zs));
    }
    return worst;
  };
  it('regularizes windows onto their storey grid when settings.regularizeWindows', () => {
    const s = jittered();
    const raw = reconstruct({ scene: s, camera: cam, detections: s.analysis.detections, settings: { ...settings, regularizeWindows: false }, overrides: {} });
    const reg = reconstruct({ scene: s, camera: cam, detections: s.analysis.detections, settings: { ...settings, regularizeWindows: true }, overrides: {} });
    expect(raw.windows.some((w) => w.regularized)).toBe(false);
    expect(reg.windows.every((w) => w.regularized)).toBe(true);
    expect(rowSpread(raw.windows)).toBeGreaterThan(0.02);
    expect(rowSpread(reg.windows)).toBeLessThan(1e-9);
    // the height estimate is computed from the raw hits either way
    expect(reg.buildings.b1.height.value).toBeCloseTo(raw.buildings.b1.height.value, 9);
  });
  it('raises a height that would leave a window above the roof, with a note', () => {
    const s = synthScene();
    // one top-floor window only (no method A), and a roofline that is too low (z = 10 m) and
    // only detected on the right half of the facade (the window at x = −3.5 m is outside it)
    const b = cameraBasis(cam, W, H);
    s.analysis.roofline = [];
    for (let u = 6.5; u < 12; u += 0.5) {
      const p = worldToPixel(b, [-6 + u, 0, 10])!;
      s.analysis.roofline.push({ x: p[0], y: p[1] });
    }
    const dets = s.analysis.detections.filter((d) => d.id === 'w40');
    const r = reconstruct({ scene: s, camera: cam, detections: dets, settings, overrides: {} });
    const h = r.buildings.b1.height;
    const top = 0.6 + 1.6 + 4 * FLOOR_H + 0.8;
    expect(h.value).toBeCloseTo(top + 0.3, 1);
    expect(h.low!).toBeGreaterThanOrEqual(h.value - 1e-9);
    expect(h.note).toMatch(/Raised to clear the highest detected window/);
    // a manual height is respected, with a warning
    const m = reconstruct({ scene: s, camera: cam, detections: dets, settings, overrides: { b1: { height: 10 } } });
    expect(m.buildings.b1.height.value).toBe(10);
    expect(m.warnings.join(' ')).toMatch(/above the manual height/);
    // map-only ignores the photo entirely
    const mo = reconstruct({ scene: s, camera: cam, detections: dets, settings: { ...settings, heightMode: 'map-only' }, overrides: {} });
    expect(mo.buildings.b1.height.note ?? '').not.toMatch(/Raised/);
  });
  it('a window lying above the detected roofline of the plane it hits is not placed on it', () => {
    const s = synthScene();
    const b = cameraBasis(cam, W, H);
    s.analysis.roofline = [];
    for (let u = 0.5; u < 12; u += 0.5) {
      const p = worldToPixel(b, [-6 + u, 0, 10])!;
      s.analysis.roofline.push({ x: p[0], y: p[1] });
    }
    const r = reconstruct({ scene: s, camera: cam, detections: s.analysis.detections, settings, overrides: {} });
    // rows 3 and 4 (z ≥ 11.8 m) are above the 10 m roofline in the photo: a building behind
    expect(r.windows).toHaveLength(9);
    expect(r.views![0].windowsAboveRoofline).toBe(6);
    expect(r.warnings.join(' ')).toMatch(/6 windows lie above the detected roofline/);
    expect(Math.max(...r.windows.map((w) => w.z + w.height / 2))).toBeLessThan(10);
  });
  it('ground residual ignores ground-line samples on an awning above windows (plausibleGroundline)', () => {
    const s = synthScene();
    const b = cameraBasis(cam, W, H);
    // lift most of the ground line onto a 3.5 m awning that has ground-floor windows below it:
    // the plain median would put the ground 3.5 m up
    s.analysis.groundline = s.analysis.groundline!.map((p, i) => {
      if (i >= 14) return p;
      const q = worldToPixel(b, [-6 + 0.5 * (i + 1), 0, 3.5])!;
      return { x: q[0], y: q[1] };
    });
    const r = reconstruct({ scene: s, camera: cam, detections: s.analysis.detections, settings, overrides: {} });
    expect(Math.abs(r.groundResidual!)).toBeLessThan(0.05);
  });
  it('hfovRangeFor: explicit range, else [0.5, 1.05] × an EXIF-derived FOV, else none', () => {
    expect(hfovRangeFor({ ...cam, hfovRange: [41.9, 61.6] })).toEqual([41.9, 61.6]);
    expect(hfovRangeFor(cam)).toEqual([35, 73.5]);
    expect(hfovRangeFor({ ...cam, provenance: { ...cam.provenance, hfov: 'assumed' } })).toBeUndefined();
  });
  it('calibrateViewCamera solves an assumed pitch, keeps a good camera and persists the FOV bounds', () => {
    const s = synthScene();
    const c = calibrateViewCamera(s, { ...cam, pitch: 4 });
    expect(c.pitchSolved).toBe(true);
    expect(Math.abs(c.camera.pitch - cam.pitch)).toBeLessThan(0.3);
    expect(c.camera.provenance.pitch).toBe('inferred');
    expect(c.camera.hfovRange).toEqual([35, 73.5]);
    expect(Math.abs(c.camera.hfov - cam.hfov)).toBeLessThan(1);
    // a fully manual camera is never moved
    const manual = { ...cam, provenance: { position: 'manual', heading: 'manual', pitch: 'manual', hfov: 'manual', height: 'manual' } as CameraParams['provenance'] };
    const m = calibrateViewCamera(s, { ...manual, pitch: 10 });
    expect(m.aligned).toBe(false);
    expect(m.camera.pitch).toBe(10);
  });
});

describe('pending selection (landing → sample apartment)', () => {
  const sim = () => {
    const s = synthScene();
    const r = reconstruct({ scene: s, camera: cam, detections: s.analysis.detections, settings, overrides: {} });
    const geo = buildGeometry({ scene: s, recon: r, settings, trees: [], extraBuildings: [], selectedWindowIds: [], apartment: { depth: 6, ceilingHeight: 2.7, balconyDepth: 0, partitions: 1, margin: 0.8, sillHeight: 0.9 }, detections: s.analysis.detections, camera: cam });
    return { s, sim: { geo, index: buildObstacleIndex(geo.obstacles) } };
  };
  it("'auto' picks a mid-floor window near the middle of the target facade", () => {
    const { s, sim: x } = sim();
    const id = pickSampleWindow(x, s, '2025-04-15')!;
    const w = x.geo.windows.find((q) => q.fw.id === id)!.fw;
    expect(w.buildingId).toBe('b1');
    expect(w.edgeIndex).toBe(0);
    expect(w.floor).toBe(2); // median of floors 1–4
    expect(id).toBe('win-w21');
    expect(pickSampleWindow(x, s, '2025-04-15')).toBe(id); // deterministic
  });
  it('a detection id selects its window, a missing one falls back to the sample window', () => {
    const { s, sim: x } = sim();
    expect(resolvePendingSelection('w30', x, s, '2025-04-15')).toEqual({ windowId: 'win-w30', fellBack: false });
    expect(resolvePendingSelection('win-w30', x, s, '2025-04-15')).toEqual({ windowId: 'win-w30', fellBack: false });
    expect(resolvePendingSelection('nope', x, s, '2025-04-15')).toEqual({ windowId: 'win-w21', fellBack: true });
    expect(resolvePendingSelection('auto', x, s, '2025-04-15')).toEqual({ windowId: 'win-w21', fellBack: false });
  });
});
