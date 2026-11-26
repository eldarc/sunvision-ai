/**
 * Generalisation guard for oblique street photos (lib/vanishing.ts), with KNOWN ground truth.
 *
 * A synthetic street: a row of footprints on the north side (facades on y = 0, facing south), the
 * picked building in the middle (30 m wide, a 4.5 m ground floor without windows, then 4 storeys
 * of 3.6 m with 12 window columns: 18.9 m tall), an opposite street wall 20 m away, a secondary
 * street between them and a minor street behind the block. The windows (and, in the "masks"
 * variant, their outlines, the facade ground line and roofline) are rendered through a known
 * camera into pixel boxes with ±2 px of deterministic noise. The photo has no EXIF, so the app
 * assumes a 60° FOV (the truth is 55°) and a 1.6 m lens height (the truth is 1.5 m); the camera
 * stands 16.5 m from the facade while the map suggests 17 m (20 m wall − 3 m pavement).
 *
 * The same pipeline as the upload flow then runs from the default automatic camera (placeCamera,
 * no GPS, no side chip): buildTileScene → alignTileScene → prepareScene → reconstruct.
 */
import { describe, expect, it } from 'vitest';
import type { CameraParams, Detection, FacadeAnalysis, Footprint, LatLon, Vec2, Vec3 } from '../../schema/scene';
import { cameraBasis, worldToPixel } from '../camera';
import { alignTileScene, buildTileScene, placeCamera, type TileSceneInput } from '../tileBuildings';
import type { Street } from '../tiles';
import { prepareScene, defaultSettings } from '../../state/store';
import { reconstruct } from '../reconstruct';
import { sceneViews } from '../views';
import { alongPosition, obliqueStart, recedingDirection, streetPerspective, vanishingAngleError, vanishingPointFromRows } from '../vanishing';
import { facadePlane } from '../camera';

const ORIGIN: LatLon = { lat: 48.137, lon: 11.575 };
const W = 2000;
const H = 1500;
const STOREY = 3.6;
const GROUND = 4.5;
const STOREYS = 4;
const TRUE_HEIGHT = GROUND + STOREYS * STOREY; // 18.9 m

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];
const fp = (id: string, ring: Vec2[], h: number): Footprint => ({ id, ring, tags: { building: 'yes', 'sunvision:source': 'openmaptiles', 'sunvision:render_height': String(h) }, source: 'osm' });

const TARGET = fp('omt/target', rect(0, 0, 30, 15), 15);
const FOOTPRINTS: Footprint[] = [
  TARGET,
  fp('omt/west', rect(-40, 0, 0, 15), 12),
  fp('omt/east', rect(30, 0, 70, 15), 12),
  fp('omt/far-west', rect(-90, 0, -40, 15), 12),
  fp('omt/far-east', rect(70, 0, 120, 15), 12),
  fp('omt/south-1', rect(-90, -35, 10, -20), 12),
  fp('omt/south-2', rect(10, -35, 120, -20), 12),
];
const STREETS: Street[] = [
  { id: 'main', line: [[-200, -10], [200, -10]], tags: { class: 'secondary', highway: 'secondary', name: 'Main Street' } },
  { id: 'back', line: [[-200, 19], [200, 19]], tags: { class: 'minor', highway: 'minor', name: 'Back Lane' } },
];

/** Deterministic noise (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Truth {
  position: Vec2;
  heading: number;
  pitch: number;
  hfov: number;
  height: number;
}

/** Render the windows (target facade, opposite wall) and facade lines through the true camera. */
function render(truth: Truth, opts: { masks: boolean; seed?: number }): { analysis: FacadeAnalysis; targetIds: string[]; oppositeIds: string[] } {
  const cam: CameraParams = {
    position: truth.position,
    height: truth.height,
    heading: truth.heading,
    pitch: truth.pitch,
    roll: 0,
    hfov: truth.hfov,
    provenance: { position: 'manual', heading: 'manual', pitch: 'manual', hfov: 'manual', height: 'manual' },
  };
  const b = cameraBasis(cam, W, H);
  const rnd = rng(opts.seed ?? 7);
  const noise = () => (rnd() - 0.5) * 4; // ±2 px
  const inside = (p: Vec2 | null): p is Vec2 => !!p && p[0] >= 0 && p[0] <= W && p[1] >= 0 && p[1] <= H;
  const dets: Detection[] = [];
  const targetIds: string[] = [];
  const oppositeIds: string[] = [];
  const addWindow = (id: string, corners: Vec3[]) => {
    const px = corners.map((c) => worldToPixel(b, c));
    if (!px.every(inside)) return false;
    const q = (px as Vec2[]).map((p) => [p[0] + noise(), p[1] + noise()] as Vec2);
    const xs = q.map((p) => p[0]);
    const ys = q.map((p) => p[1]);
    dets.push({
      id,
      cls: 'window',
      confidence: 0.9,
      bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      ...(opts.masks ? { polygon: q } : {}),
      source: 'model',
    });
    return true;
  };
  // Target: 4 storeys × 12 columns, windows 1.2 × 1.6 m, sills 0.9 m above each floor.
  for (let k = 0; k < STOREYS; k++)
    for (let j = 0; j < 12; j++) {
      const z0 = GROUND + k * STOREY + 0.9;
      const u = 1.25 + 2.5 * j;
      const id = `t-${k}-${j}`;
      if (addWindow(id, [[u - 0.6, 0, z0 + 1.6], [u + 0.6, 0, z0 + 1.6], [u + 0.6, 0, z0], [u - 0.6, 0, z0]])) targetIds.push(id);
    }
  // Opposite street wall (y = −20, facing north): two rows of windows.
  // (a stretch 26–58 m ahead of the camera, as in a real photo: the near part is out of frame)
  const ahead = Math.sign(Math.sin((truth.heading * Math.PI) / 180)) || 1;
  for (let k = 0; k < 2; k++)
    for (let s = 26; s <= 58; s += 4) {
      const x = truth.position[0] + ahead * s;
      const z0 = 4 + 3.2 * k;
      const id = `o-${k}-${x}`;
      if (addWindow(id, [[x + 0.6, -20, z0 + 1.5], [x - 0.6, -20, z0 + 1.5], [x - 0.6, -20, z0], [x + 0.6, -20, z0]])) oppositeIds.push(id);
    }
  // Facade box of the target and (masks) its ground line and roofline.
  const fc = ([[0, 0, 0], [30, 0, 0], [30, 0, TRUE_HEIGHT], [0, 0, TRUE_HEIGHT]] as Vec3[]).map((c) => worldToPixel(b, c)).filter((p): p is Vec2 => !!p);
  if (fc.length)
    dets.push({
      id: 'facade-0',
      cls: 'facade',
      confidence: 0.9,
      bbox: [Math.max(0, Math.min(...fc.map((p) => p[0]))), Math.max(0, Math.min(...fc.map((p) => p[1]))), Math.min(W, Math.max(...fc.map((p) => p[0]))), Math.min(H, Math.max(...fc.map((p) => p[1])))],
      source: 'model',
    });
  const groundline: { x: number; y: number }[] = [];
  const roofline: { x: number; y: number }[] = [];
  if (opts.masks) {
    for (let x = 0.5; x < 30; x += 0.5) {
      const g = worldToPixel(b, [x, 0, 0]);
      const r = worldToPixel(b, [x, 0, TRUE_HEIGHT]);
      if (inside(g)) groundline.push({ x: g[0], y: g[1] + noise() });
      if (inside(r)) roofline.push({ x: r[0], y: r[1] + noise() });
    }
  }
  return {
    analysis: {
      model: { provider: 'none', modelId: 'synthetic' },
      imageWidth: W,
      imageHeight: H,
      detections: dets,
      floorRows: [],
      roofline,
      groundline,
      warnings: [],
      pipelineVersion: 'synthetic',
    },
    targetIds,
    oppositeIds,
  };
}

/** The quick-upload pipeline from the default automatic camera (no GPS, no side chip). */
function runPipeline(analysis: FacadeAnalysis) {
  const camera = placeCamera(TARGET, FOOTPRINTS, STREETS, {});
  const input: TileSceneInput = {
    id: 'synthetic',
    title: 'synthetic.jpg',
    image: { url: 'synthetic:photo', width: W, height: H, exif: {} },
    analysis,
    frameOrigin: ORIGIN,
    footprints: FOOTPRINTS,
    streets: STREETS,
    targetId: TARGET.id,
    camera,
    osm: null,
    retrieved: '2026-11-25',
  };
  const t0 = performance.now();
  const aligned = alignTileScene(buildTileScene(input));
  const prepared = prepareScene(aligned.scene);
  const ms = performance.now() - t0;
  const cam = prepared.camera;
  const views = sceneViews(prepared, { camera: cam, detections: analysis.detections, viewCameras: {}, viewDetections: {} });
  const recon = reconstruct({ scene: prepared, camera: cam, detections: analysis.detections, settings: defaultSettings, overrides: {}, depth: null, views, depths: { primary: null } });
  return { prepared, cam, recon, ms, auto: camera };
}

const angDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

interface Case {
  name: string;
  truth: Truth;
  masks: boolean;
}

// Headings: the facade (north side, y = 0) faces 180°; looking 0° is frontal.
const OBLIQUE: Case[] = [
  { name: 'facade on the right, 70° from the facade normal, no masks', truth: { position: [50, -16.5], heading: 290, pitch: 2, hfov: 55, height: 1.5 }, masks: false },
  { name: 'facade on the right, 70° from the facade normal, with masks', truth: { position: [50, -16.5], heading: 290, pitch: 2, hfov: 55, height: 1.5 }, masks: true },
  { name: 'facade on the left, 70° from the facade normal, no masks', truth: { position: [-20, -16.5], heading: 70, pitch: 2, hfov: 55, height: 1.5 }, masks: false },
  { name: 'facade on the left, 65° from the facade normal, with masks', truth: { position: [-22, -16.5], heading: 65, pitch: 3, hfov: 55, height: 1.5 }, masks: true },
  { name: 'facade on the right, 75° from the facade normal, no masks', truth: { position: [55, -16.5], heading: 285, pitch: 1, hfov: 55, height: 1.5 }, masks: false },
  // 35° from the normal: the near upper windows are out of frame (19 m facade, 16.5 m away), so fewer windows.
  { name: 'moderately oblique: 35° from the facade normal, facade on the right, with masks', truth: { position: [40, -16.5], heading: 325, pitch: 10, hfov: 55, height: 1.5 }, masks: true },
  { name: 'moderately oblique: 35° from the facade normal, facade on the right, no masks', truth: { position: [40, -16.5], heading: 325, pitch: 10, hfov: 55, height: 1.5 }, masks: false },
];

describe('oblique street photos with known ground truth (synthetic)', () => {
  for (const c of OBLIQUE) {
    it(c.name, () => {
      const { analysis, targetIds, oppositeIds } = render(c.truth, { masks: c.masks });
      expect(targetIds.length).toBeGreaterThanOrEqual(20);
      const persp = streetPerspective(analysis.detections, { width: W, height: H });
      expect(persp, 'the photo is recognised as an oblique street view').not.toBeNull();
      const { prepared, cam, recon, ms } = runPipeline(analysis);
      const b = recon.buildings[TARGET.id];
      const onTarget = recon.windows.filter((w) => targetIds.includes(w.detectionId) && w.buildingId === TARGET.id).length;
      const oppOnTarget = recon.windows.filter((w) => oppositeIds.includes(w.detectionId) && w.buildingId === TARGET.id).length;
      const facade = facadePlane(TARGET.id, prepared.footprints.find((f) => f.id === TARGET.id)!.ring, prepared.facadeEdgeIndex);
      const lateral = Math.abs((cam.position[0] - facade.a[0]) * facade.normal[0] + (cam.position[1] - facade.a[1]) * facade.normal[1]);
      console.log(
        `${c.name}: heading ${cam.heading.toFixed(1)}° (truth ${c.truth.heading}°), pitch ${cam.pitch.toFixed(1)}° roll ${cam.roll.toFixed(1)}° hfov ${cam.hfov.toFixed(1)}°, ` +
          `lateral ${lateral.toFixed(1)} m (truth 16.5); floors ${b.floors?.value}, floor height ${b.floorHeight?.value.toFixed(2)} m (truth ${STOREY}), height ${b.height.value.toFixed(2)} m (truth ${TRUE_HEIGHT}) ${b.height.method}; ` +
          `target windows on target ${onTarget}/${targetIds.length}, opposite on target ${oppOnTarget}/${oppositeIds.length}; ${ms.toFixed(0)} ms`,
      );
      expect(angDiff(cam.heading, c.truth.heading)).toBeLessThan(5);
      expect(Math.abs(facade.normal[1] + 1)).toBeLessThan(1e-6); // the street facade (faces south)
      expect(Math.abs((b.floorHeight?.value ?? 0) - STOREY) / STOREY).toBeLessThan(0.1);
      expect(Math.abs(b.height.value - TRUE_HEIGHT) / TRUE_HEIGHT).toBeLessThan(0.12);
      expect(onTarget / targetIds.length).toBeGreaterThanOrEqual(0.9);
      expect(oppOnTarget).toBe(0);
      // Honest provenance: directions inferred, position assumed/inferred, never observed.
      expect(cam.provenance.heading).toBe('inferred');
      expect(['assumed', 'inferred']).toContain(cam.provenance.position);
      expect(cam.provenance.hfov).not.toBe('observed');
      expect((cam.notes ?? []).some((n) => n.startsWith('Oblique street view'))).toBe(true);
      expect(ms).toBeLessThan(1500);
    });
  }

  it('a frontal photo stays frontal (no vanishing point, the frontal pipeline applies)', () => {
    const truth: Truth = { position: [15, -16.5], heading: 0, pitch: 10, hfov: 55, height: 1.5 };
    const { analysis } = render(truth, { masks: true });
    const v = vanishingPointFromRows(analysis.detections);
    expect(v === null || v.parallel || Math.abs(v.x - W / 2) > 1.5 * W).toBe(true);
    expect(streetPerspective(analysis.detections, { width: W, height: H })).toBeNull();
    const { cam, auto } = runPipeline(analysis);
    expect((cam.notes ?? []).some((n) => n.startsWith('Oblique street view'))).toBe(false);
    // The frontal pipeline applies: the automatic camera faces the nearest street's facade
    // (here the back lane, 4 m away; the street-class preference is only for oblique views).
    expect(auto.heading).toBeCloseTo(180, 0);
    expect(angDiff(cam.heading, auto.heading)).toBeLessThan(5);
  });

  it('a slightly turned frontal photo (15° from the facade normal) is not treated as oblique', () => {
    const truth: Truth = { position: [20, -16.5], heading: 345, pitch: 8, hfov: 55, height: 1.5 };
    const { analysis } = render(truth, { masks: true });
    expect(streetPerspective(analysis.detections, { width: W, height: H })).toBeNull();
  });
});

describe('oblique start: what is never overridden', () => {
  const truth: Truth = { position: [50, -16.5], heading: 290, pitch: 2, hfov: 55, height: 1.5 };
  const { analysis } = render(truth, { masks: false });
  const sceneInput = (): TileSceneInput => ({
    id: 's',
    title: 's.jpg',
    image: { url: 'synthetic:photo', width: W, height: H, exif: {} },
    analysis,
    frameOrigin: ORIGIN,
    footprints: FOOTPRINTS,
    streets: STREETS,
    targetId: TARGET.id,
    camera: placeCamera(TARGET, FOOTPRINTS, STREETS, {}),
    osm: null,
    retrieved: '2026-11-25',
  });
  const scene = () => buildTileScene(sceneInput());

  it('a manual heading is kept (with a note), the camera is not re-initialised', () => {
    const s = scene();
    const cam = { ...s.camera, provenance: { ...s.camera.provenance, heading: 'manual' as const } };
    const ob = obliqueStart(s, cam);
    expect(ob.applied).toBe(false);
    expect(ob.camera.heading).toBe(cam.heading);
    expect(ob.notes.join(' ')).toMatch(/camera kept/);
  });

  it('an observed (GPS) position is kept; only heading and pitch come from the vanishing point', () => {
    const gps: Vec2 = [truth.position[0] + 3, truth.position[1] - 2];
    const s = buildTileScene({ ...sceneInput(), camera: placeCamera(TARGET, FOOTPRINTS, STREETS, { gps }) });
    const cam = s.camera;
    expect(cam.provenance.position).toBe('observed');
    const ob = obliqueStart(s, cam);
    expect(ob.applied).toBe(true);
    expect(ob.camera.position).toEqual(cam.position); // the GPS point, in the scene frame
    expect(ob.camera.provenance.position).toBe('observed');
    expect(ob.camera.provenance.heading).toBe('inferred');
  });

  it('is idempotent: a camera that already explains the vanishing point is left alone', () => {
    const s = scene();
    const first = obliqueStart(s, s.camera);
    expect(first.applied).toBe(true);
    const again = obliqueStart({ ...s, facadeEdgeIndex: first.facadeEdgeIndex, visibleBuildingIds: first.visibleBuildingIds }, first.camera);
    expect(again.applied).toBe(false);
    expect(again.perspective).not.toBeNull();
    expect(again.camera.heading).toBe(first.camera.heading);
  });
});

describe('vanishing helpers', () => {
  it('measures the street vanishing point of the rows within a degree of the true one', () => {
    const truth: Truth = { position: [50, -16.5], heading: 290, pitch: 2, hfov: 55, height: 1.5 };
    const { analysis } = render(truth, { masks: false });
    const p = streetPerspective(analysis.detections, { width: W, height: H })!;
    expect(p.facadeSide).toBe('right');
    const cam: CameraParams = { position: truth.position, height: 1.5, heading: 290, pitch: 2, roll: 0, hfov: 55, provenance: { position: 'manual', heading: 'manual', pitch: 'manual', hfov: 'manual', height: 'manual' } };
    const dir = recedingDirection(facadePlane(TARGET.id, TARGET.ring, 0), 'right');
    expect(dir[0]).toBeCloseTo(-1, 6); // west: the north-side facade recedes on the right when looking west
    expect(vanishingAngleError(cam, { width: W, height: H }, p.vp, dir)).toBeLessThan(1);
  });

  it('alongPosition: the middle of the positions where the facade spans the most windows', () => {
    expect(alongPosition([15, 30, 50], 80)).toBeCloseTo(7.5, 0); // c ∈ [−15, 30]
    expect(alongPosition([15, 30, 50], 40)).toBeCloseTo(-12.5, 0); // c ∈ [−15, −10]
    const c = alongPosition([10, 12, 14, 60], 10);
    expect([10, 12, 14].filter((s) => c + s >= 0 && c + s <= 10)).toHaveLength(3);
  });
});
