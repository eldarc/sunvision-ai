/**
 * Robustness of the oblique street-view start (lib/vanishing.ts) beyond the oblique.test.ts street,
 * with KNOWN ground truth. Cases covered:
 *  - the facade receding on the RIGHT of a close, wide-angle photo: the frame cuts off the near
 *    windows of the upper storeys, so one-sided row chaining would merge several storeys into one
 *    "row" (a wrong vanishing point);
 *  - a wide-angle photo tilted up to include the roof (tall boxes near the frame edge);
 *  - no opposite street wall in the map (the lateral-distance fallback);
 *  - a terraced street whose neighbours' windows recede in the same rows (the along-street
 *    position is not observed: the camera notes must say so);
 *  - a manual pitch/roll is never overwritten.
 *
 * World: facades on y = 0 facing south; the picked building 0–30 m (ground floor 3.3 m, then 5
 * storeys of 3.2 m with 10 window columns: 19.3 m), neighbours either side, an opposite street
 * wall `opp` metres away with a secondary street half-way, a minor lane behind the block. The
 * camera stands `d` = opp − 3 m out (so the map's "opposite wall minus 3 m pavement" is right) and
 * the photo carries a 35 mm-equivalent focal length (EXIF), as phone photos do.
 */
import { describe, expect, it } from 'vitest';
import type { CameraParams, Detection, FacadeAnalysis, Footprint, LatLon, Vec2, Vec3 } from '../../schema/scene';
import { cameraBasis, facadePlane, worldToPixel } from '../camera';
import { alignTileScene, buildTileScene, hfovFromFocal35, placeCamera, type TileSceneInput } from '../tileBuildings';
import type { Street } from '../tiles';
import { prepareScene, defaultSettings } from '../../state/store';
import { reconstruct } from '../reconstruct';
import { sceneViews } from '../views';
import { obliqueStart, streetPerspective, vanishingPixel, recedingDirection } from '../vanishing';

const ORIGIN: LatLon = { lat: 48.137, lon: 11.575 };
const W = 4000;
const H = 3000;
const GROUND = 3.3;
const STOREY = 3.2;
const STOREYS = 5;
const TRUE_HEIGHT = GROUND + STOREYS * STOREY; // 19.3 m

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];
const fp = (id: string, ring: Vec2[], h: number): Footprint => ({ id, ring, tags: { building: 'yes', 'sunvision:source': 'openmaptiles', 'sunvision:render_height': String(h) }, source: 'osm' });
const TARGET = fp('omt/target', rect(0, 0, 30, 15), 15);

function world(opp: number, withOpposite = true) {
  const footprints: Footprint[] = [
    TARGET,
    fp('omt/west', rect(-40, 0, 0, 15), 12),
    fp('omt/east', rect(30, 0, 70, 15), 12),
    fp('omt/far-west', rect(-90, 0, -40, 15), 12),
    fp('omt/far-east', rect(70, 0, 120, 15), 12),
  ];
  if (withOpposite) footprints.push(fp('omt/south-1', rect(-90, -opp - 15, 10, -opp), 12), fp('omt/south-2', rect(10, -opp - 15, 120, -opp), 12));
  const streets: Street[] = [
    { id: 'main', line: [[-200, -opp / 2], [200, -opp / 2]], tags: { class: 'secondary', highway: 'secondary', name: 'Main Street' } },
    { id: 'back', line: [[-200, 19], [200, 19]], tags: { class: 'minor', highway: 'minor', name: 'Back Lane' } },
  ];
  return { footprints, streets };
}

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

/** 35 mm-equivalent focal length that gives `hfov` on this frame (inverse of hfovFromFocal35). */
function focal35For(hfov: number) {
  let lo = 5;
  let hi = 300;
  for (let i = 0; i < 60; i++) {
    const m = (lo + hi) / 2;
    if (hfovFromFocal35(m, W, H) > hfov) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

interface Truth {
  /** Facade side in the photo, angle of the optical axis from the facade normal (deg), lateral distance (m). */
  side: 'right' | 'left';
  ob: number;
  d: number;
  hfov: number;
  pitch: number;
  /** How far the camera stands beyond the end of the facade it looks along (m). */
  along?: number;
  /** Neighbour facades carry windows in their own storey layout (terraced street). */
  neighbourWindows?: boolean;
}

function trueCamera(t: Truth): CameraParams {
  const heading = t.side === 'right' ? 360 - t.ob : t.ob;
  const x = t.side === 'right' ? 30 + (t.along ?? 6) : -(t.along ?? 6);
  return {
    position: [x, -t.d],
    height: 1.5,
    heading,
    pitch: t.pitch,
    roll: 0,
    hfov: t.hfov,
    provenance: { position: 'manual', heading: 'manual', pitch: 'manual', hfov: 'manual', height: 'manual' },
  };
}

function render(t: Truth, opp: number, seed = 11) {
  const cam = trueCamera(t);
  const b = cameraBasis(cam, W, H);
  const rnd = rng(seed);
  const noise = () => (rnd() - 0.5) * 6; // ±3 px
  const inside = (p: Vec2 | null): p is Vec2 => !!p && p[0] >= 0 && p[0] <= W && p[1] >= 0 && p[1] <= H;
  const dets: Detection[] = [];
  const targetIds: string[] = [];
  const neighbourIds: string[] = [];
  const add = (id: string, u: number, y: number, z0: number, ww: number, wh: number, facing: 1 | -1) => {
    const corners: Vec3[] = [
      [u - ww / 2, y, z0 + wh],
      [u + ww / 2, y, z0 + wh],
      [u + ww / 2, y, z0],
      [u - ww / 2, y, z0],
    ];
    void facing;
    const px = corners.map((c) => worldToPixel(b, c));
    if (!px.every(inside)) return false;
    const q = (px as Vec2[]).map((p) => [p[0] + noise(), p[1] + noise()] as Vec2);
    dets.push({ id, cls: 'window', confidence: 0.9, bbox: [Math.min(...q.map((p) => p[0])), Math.min(...q.map((p) => p[1])), Math.max(...q.map((p) => p[0])), Math.max(...q.map((p) => p[1]))], source: 'model' });
    return true;
  };
  for (let k = 0; k < STOREYS; k++)
    for (let j = 0; j < 10; j++) {
      const id = `t-${k}-${j}`;
      if (add(id, 1.5 + 3 * j, 0, GROUND + k * STOREY + 0.8, 1.2, 1.6, 1)) targetIds.push(id);
    }
  if (t.neighbourWindows) {
    // neighbours: ground floor 4 m, 4 storeys of 3.0 m, windows every 2.6 m
    for (const [x0, x1] of [[-40, 0], [30, 70]] as const)
      for (let k = 0; k < 4; k++)
        for (let u = x0 + 1.3; u < x1 - 0.6; u += 2.6) {
          const id = `n-${x0}-${k}-${u.toFixed(1)}`;
          if (add(id, u, 0, 4 + k * 3.0 + 0.8, 1.1, 1.5, 1)) neighbourIds.push(id);
        }
  }
  // Opposite wall: two rows, 26–58 m ahead
  const ahead = t.side === 'right' ? -1 : 1;
  for (let k = 0; k < 2; k++)
    for (let s = 26; s <= 58; s += 4) add(`o-${k}-${s}`, cam.position[0] + ahead * s, -opp, 4 + 3.2 * k, 1.2, 1.5, -1);
  const analysis: FacadeAnalysis = {
    model: { provider: 'none', modelId: 'synthetic' },
    imageWidth: W,
    imageHeight: H,
    detections: dets,
    floorRows: [],
    roofline: [],
    groundline: [],
    warnings: [],
    pipelineVersion: 'synthetic',
  };
  return { analysis, targetIds, neighbourIds, cam };
}

function run(t: Truth, opts: { opp?: number; withOpposite?: boolean; exif?: boolean; seed?: number } = {}) {
  const opp = opts.opp ?? t.d + 3;
  const { footprints, streets } = world(opp, opts.withOpposite ?? true);
  const { analysis, targetIds, neighbourIds, cam: trueCam } = render(t, opp, opts.seed);
  const camera = placeCamera(TARGET, footprints, streets, {});
  const input: TileSceneInput = {
    id: 'synthetic',
    title: 'synthetic.jpg',
    image: { url: 'synthetic:photo', width: W, height: H, exif: opts.exif === false ? {} : { focalLength35mm: focal35For(t.hfov) } },
    analysis,
    frameOrigin: ORIGIN,
    footprints,
    streets,
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
  const b = recon.buildings[TARGET.id];
  const onTarget = recon.windows.filter((w) => targetIds.includes(w.detectionId) && w.buildingId === TARGET.id).length;
  const neighbourOnTarget = recon.windows.filter((w) => neighbourIds.includes(w.detectionId) && w.buildingId === TARGET.id).length;
  return { analysis, prepared, cam, trueCam, b, onTarget, targetIds, neighbourIds, neighbourOnTarget, ms, input };
}

const angDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

function report(name: string, r: ReturnType<typeof run>) {
  console.log(
    `${name}: heading ${r.cam.heading.toFixed(1)}° (truth ${r.trueCam.heading}°), pitch ${r.cam.pitch.toFixed(1)}°, hfov ${r.cam.hfov.toFixed(1)}°; ` +
      `floors ${r.b.floors?.value} × ${r.b.floorHeight?.value.toFixed(2)} m, height ${r.b.height.value.toFixed(2)} m (truth ${TRUE_HEIGHT}); ` +
      `target windows on target ${r.onTarget}/${r.targetIds.length}; ${r.ms.toFixed(0)} ms`,
  );
}

/** Close, wide-angle photos: the near windows of the upper storeys are cut off by the frame. */
const CROPPED: Truth[] = [
  { side: 'right', ob: 70, d: 10, hfov: 70, pitch: 2 },
  { side: 'right', ob: 65, d: 10, hfov: 70, pitch: 2 },
  { side: 'right', ob: 75, d: 10, hfov: 60, pitch: 2 },
  { side: 'right', ob: 60, d: 13, hfov: 65, pitch: 2 },
  { side: 'left', ob: 70, d: 10, hfov: 70, pitch: 2 },
  { side: 'left', ob: 65, d: 10, hfov: 70, pitch: 2 },
];

describe('oblique start: facade on either side with the upper storeys cropped (EXIF focal length)', () => {
  for (const t of CROPPED) {
    const name = `facade on the ${t.side}, ${t.ob}° from the normal, ${t.d} m out, hfov ${t.hfov}°`;
    it(name, () => {
      const r = run(t);
      report(name, r);
      // The upper storeys really are cropped near the camera (otherwise the case tests nothing).
      expect(r.targetIds.length).toBeLessThan(STOREYS * 10);
      const p = streetPerspective(r.analysis.detections, { width: W, height: H });
      expect(p, 'recognised as an oblique street view').not.toBeNull();
      expect(p!.facadeSide).toBe(t.side);
      const pl = facadePlane(TARGET.id, TARGET.ring, 0);
      const truthVp = vanishingPixel(r.trueCam, { width: W, height: H }, recedingDirection(pl, t.side))!;
      expect(Math.hypot(p!.vp.x - truthVp[0], p!.vp.y - truthVp[1]), 'measured vanishing point near the true one').toBeLessThan(0.05 * W);
      expect(angDiff(r.cam.heading, r.trueCam.heading)).toBeLessThan(5);
      expect(Math.abs(r.b.height.value - TRUE_HEIGHT) / TRUE_HEIGHT).toBeLessThan(0.15);
      expect(r.onTarget / r.targetIds.length).toBeGreaterThanOrEqual(0.8);
      expect(r.ms).toBeLessThan(2000);
    });
  }
});

describe('oblique start: other generalisation cases', () => {
  it('a wide-angle photo tilted up to include the roof (hfov 70°, pitch 10°) is still recognised and solved', () => {
    for (const side of ['left', 'right'] as const) {
      const t: Truth = { side, ob: 70, d: 14, hfov: 70, pitch: 10 };
      const r = run(t);
      report(`tilted up, facade on the ${side}`, r);
      expect(streetPerspective(r.analysis.detections, { width: W, height: H })).not.toBeNull();
      expect(angDiff(r.cam.heading, r.trueCam.heading)).toBeLessThan(5);
      expect(Math.abs(r.b.height.value - TRUE_HEIGHT) / TRUE_HEIGHT).toBeLessThan(0.15);
    }
  });

  it('without an opposite wall in the map the camera stands on the pavement in front of the opposite facade line', () => {
    // street centre line 6.5 m out → opposite facade line 13 m → camera 13 − 3 = 10 m (the truth)
    const t: Truth = { side: 'right', ob: 70, d: 10, hfov: 65, pitch: 2 };
    const r = run(t, { opp: 13, withOpposite: false });
    report('no opposite wall', r);
    const pl = facadePlane(TARGET.id, r.prepared.footprints.find((f) => f.id === TARGET.id)!.ring, r.prepared.facadeEdgeIndex);
    const lateral = Math.abs((r.cam.position[0] - pl.a[0]) * pl.normal[0] + (r.cam.position[1] - pl.a[1]) * pl.normal[1]);
    expect(lateral).toBeGreaterThan(8.5);
    expect(lateral).toBeLessThan(11.5);
    expect(Math.abs(r.b.height.value - TRUE_HEIGHT) / TRUE_HEIGHT).toBeLessThan(0.15);
    expect((r.cam.notes ?? []).join(' ')).toMatch(/no opposite wall in the map/);
  });

  it('a terraced street whose neighbours have windows too: the camera notes say the along-street position is a guess', () => {
    const t: Truth = { side: 'right', ob: 70, d: 14, hfov: 65, pitch: 2, along: 25, neighbourWindows: true };
    const r = run(t);
    report('terraced street', r);
    console.log(`  neighbour windows on the target: ${r.neighbourOnTarget}/${r.neighbourIds.length}`);
    expect(angDiff(r.cam.heading, r.trueCam.heading)).toBeLessThan(5);
    expect((r.cam.notes ?? []).some((n) => /where along the street the camera stood is a guess/.test(n))).toBe(true);
  });

  it('a manual pitch and roll are kept (only heading and position come from the vanishing point)', () => {
    const t: Truth = { side: 'right', ob: 70, d: 14, hfov: 65, pitch: 2 };
    const { input } = run(t);
    const s = buildTileScene(input);
    const cam0: CameraParams = { ...s.camera, pitch: 3, roll: 1.5, provenance: { ...s.camera.provenance, pitch: 'manual' } };
    const ob = obliqueStart(s, cam0);
    expect(ob.applied).toBe(true);
    expect(ob.camera.pitch).toBe(3);
    expect(ob.camera.roll).toBe(1.5);
    expect(ob.camera.provenance.pitch).toBe('manual');
    expect(ob.camera.provenance.heading).toBe('inferred');
    const aligned = alignTileScene({ ...s, camera: cam0 });
    expect(aligned.scene.camera.pitch).toBe(3);
    expect(aligned.scene.camera.roll).toBe(1.5);
    expect(aligned.scene.camera.provenance.pitch).toBe('manual');
    const prepared = prepareScene(aligned.scene);
    expect(prepared.camera.pitch).toBe(3);
    expect(prepared.camera.roll).toBe(1.5);
    expect(prepared.camera.provenance.pitch).toBe('manual');
  });

  it('a manual heading the rows contradict is kept, and the camera notes (shown in the Inspector) say so', () => {
    const t: Truth = { side: 'right', ob: 70, d: 14, hfov: 65, pitch: 2 };
    const { input } = run(t);
    const s = buildTileScene(input);
    const cam0: CameraParams = { ...s.camera, provenance: { ...s.camera.provenance, heading: 'manual' } };
    const ob = obliqueStart(s, cam0);
    expect(ob.applied).toBe(false);
    expect(ob.camera.heading).toBe(cam0.heading);
    expect((ob.camera.notes ?? []).some((n) => /camera kept/.test(n))).toBe(true);
    // re-running does not stack the note
    const again = obliqueStart(s, ob.camera);
    expect((again.camera.notes ?? []).filter((n) => /camera kept/.test(n))).toHaveLength(1);
  });
});
