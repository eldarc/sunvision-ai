/**
 * Alignment & regularisation (lib/align.ts).
 * Synthetic tests use exact ground truth; the fixture test only reports numbers
 * (console.table) for docs/research/alignment.md and asserts sanity, not tuned values.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AlignPoint, CameraParams, Detection, FacadeAnalysis, FacadeWindow, Scene, Vec2, Vec3 } from '../../schema/scene';
import { cameraBasis, worldToPixel } from '../camera';
import { calibratePitch, reconstruct } from '../reconstruct';
import { defaultSettings } from '../../state/store';
import {
  autoAlignCamera,
  diagnoseWindows,
  minHeightFromWindows,
  regularizeFacadeWindows,
  solveFromCorrespondences,
  windowGrid,
  type AlignView,
} from '../align';

/* ------------------------------------------------------------------ */
/* Synthetic corner building: 12 m (west) × 16 m (south) footprint,     */
/* 20 m tall, 5 storeys of 1.2 × 1.8 m windows, photographed obliquely  */
/* from the south-west so both facades are visible.                     */
/* ------------------------------------------------------------------ */
const W = 2000;
const H = 1500;
const ring: Vec2[] = [
  [0, 0],
  [16, 0],
  [16, 12],
  [0, 12],
]; // CCW; edge 0 = south facade, edge 3 = west facade ((0,12) → (0,0))

const TRUE: CameraParams = {
  position: [-14, -18],
  height: 1.6,
  heading: 38,
  pitch: 18,
  roll: 0.8,
  hfov: 60,
  provenance: { position: 'observed', heading: 'observed', pitch: 'assumed', hfov: 'assumed', height: 'assumed' },
};

/** Deterministic pseudo-random noise in [-1, 1]. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 2 ** 32) * 2 - 1;
  };
}

function synthView(cam: CameraParams, truth: CameraParams = TRUE, pxNoise = 0): AlignView {
  const b = cameraBasis(truth, W, H);
  const rnd = lcg(7);
  const proj = (p: Vec3) => worldToPixel(b, p)!;
  const P = (edge: number, u: number, z: number): Vec3 => {
    const a = ring[edge];
    const e = ring[(edge + 1) % 4];
    const L = Math.hypot(e[0] - a[0], e[1] - a[1]);
    return [a[0] + ((e[0] - a[0]) * u) / L, a[1] + ((e[1] - a[1]) * u) / L, z];
  };
  const dets: Detection[] = [];
  const facades: [number, number[]][] = [
    [3, [2, 4.7, 7.4, 10.1]],
    [0, [2, 5, 8, 11, 14]],
  ];
  for (const [edge, us] of facades)
    for (let f = 0; f < 5; f++)
      for (const u of us) {
        const z = 2.5 + 3.2 * f;
        const cs: Vec2[] = [
          proj(P(edge, u - 0.6, z + 0.9)),
          proj(P(edge, u + 0.6, z + 0.9)),
          proj(P(edge, u + 0.6, z - 0.9)),
          proj(P(edge, u - 0.6, z - 0.9)),
        ].map((p) => [p[0] + pxNoise * rnd(), p[1] + pxNoise * rnd()] as Vec2);
        const xs = cs.map((p) => p[0]);
        const ys = cs.map((p) => p[1]);
        dets.push({ id: `e${edge}f${f}u${u}`, cls: 'window', confidence: 0.9, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], polygon: cs, source: 'model' });
      }
  const groundline: { x: number; y: number }[] = [];
  for (let u = 0.5; u < 12; u += 0.5) {
    const p = proj(P(3, u, 0));
    groundline.push({ x: p[0], y: p[1] });
  }
  for (let u = 0.5; u < 16; u += 0.5) {
    const p = proj(P(0, u, 0));
    groundline.push({ x: p[0], y: p[1] });
  }
  groundline.sort((a, c) => a.x - c.x);
  const analysis: FacadeAnalysis = { model: { provider: 'manual', modelId: 'synthetic' }, imageWidth: W, imageHeight: H, detections: dets, floorRows: [], groundline, warnings: [], pipelineVersion: 'test' };
  return {
    footprints: [{ id: 'b1', ring, tags: {}, source: 'osm' }],
    targetBuildingId: 'b1',
    facadeEdgeIndex: 0,
    visibleBuildingIds: [],
    image: { width: W, height: H },
    analysis,
    camera: cam,
    detections: dets,
  };
}

describe('window grid (image space)', () => {
  it('chains slanted rows and converging columns of an oblique corner view', () => {
    const v = synthView(TRUE);
    const g = windowGrid(v.detections);
    // 5 storeys; each row may span both facades (same storey) → 5 rows
    expect(g.rows.length).toBe(5);
    for (const r of g.rows) expect(r.length).toBe(9);
    expect(g.cols.length).toBe(9);
    for (const c of g.cols) expect(c.length).toBe(5);
  });
});

describe('autoAlignCamera', () => {
  it('is (near) a fixed point at the true camera', () => {
    const v = synthView(TRUE);
    const r = autoAlignCamera(v);
    expect(r.cost0).toBeLessThan(0.05);
    expect(Math.abs(r.camera.pitch - TRUE.pitch)).toBeLessThan(0.5);
    expect(Math.abs(r.camera.hfov - TRUE.hfov)).toBeLessThan(1.5);
  });

  for (const pxNoise of [0, 3]) {
    it(`recovers pitch, roll and hfov perturbed from the truth (box noise ±${pxNoise} px)`, () => {
      const start: CameraParams = { ...TRUE, pitch: TRUE.pitch + 5, roll: TRUE.roll - 2.5, hfov: TRUE.hfov + 10 };
      const v = synthView(start, TRUE, pxNoise);
      const t0 = performance.now();
      const r = autoAlignCamera(v);
      const ms = performance.now() - t0;
      expect(r.changed).toBe(true);
      expect(r.cost).toBeLessThan(r.cost0 * 0.5);
      const err0 = { pitch: 5, roll: 2.5, hfov: 10 };
      const err = { pitch: Math.abs(r.camera.pitch - TRUE.pitch), roll: Math.abs(r.camera.roll - TRUE.roll), hfov: Math.abs(r.camera.hfov - TRUE.hfov) };
      // eslint-disable-next-line no-console
      console.log(`auto-align synthetic (noise ${pxNoise}px): ${ms.toFixed(0)} ms`, err, r.notes[0]);
      expect(err.pitch).toBeLessThan(err0.pitch * 0.3);
      expect(err.roll).toBeLessThan(err0.roll * 0.3);
      expect(err.hfov).toBeLessThan(err0.hfov * 0.3);
      expect(r.camera.provenance.pitch).toBe('inferred');
      expect(r.camera.provenance.hfov).toBe('inferred');
      expect(r.camera.notes?.some((n) => n.includes('facade regularity'))).toBe(true);
      expect(ms).toBeLessThan(1500); // typically well under 300 ms; generous for CI
    });
  }

  it('never moves manual parameters', () => {
    const start: CameraParams = { ...TRUE, pitch: TRUE.pitch + 5, provenance: { position: 'manual', heading: 'manual', pitch: 'manual', hfov: 'manual', height: 'assumed' } };
    const r = autoAlignCamera(synthView(start));
    expect(r.changed).toBe(false);
    expect(r.camera).toBe(start);
  });
});

describe('solveFromCorrespondences', () => {
  const pts = (): AlignPoint[] => {
    const b = cameraBasis(TRUE, W, H);
    const out: AlignPoint[] = [];
    for (const v of [3, 0, 1]) {
      const [x, y] = ring[v];
      const g = worldToPixel(b, [x, y, 0])!;
      const t = worldToPixel(b, [x, y, 15])!;
      out.push({ id: `g${v}`, px: g, buildingId: 'b1', vertex: v, kind: 'ground', source: 'manual' });
      out.push({ id: `v${v}`, px: t, buildingId: 'b1', vertex: v, kind: 'vertical', source: 'manual' });
    }
    return out;
  };
  it('recovers a known pose from 3 ground + 3 vertical-edge points', () => {
    const start: CameraParams = { ...TRUE, position: [-11, -20], heading: 44, pitch: 12, roll: -1.5, hfov: 72 };
    const r = solveFromCorrespondences(synthView(start), pts(), { hfovRange: [30, 90] });
    expect(r.changed).toBe(true);
    expect(r.terms.rms).toBeLessThan(1);
    expect(r.cost0).toBeGreaterThan(20);
    const c = r.camera;
    expect(Math.hypot(c.position[0] - TRUE.position[0], c.position[1] - TRUE.position[1])).toBeLessThan(0.3);
    expect(Math.abs(c.heading - TRUE.heading)).toBeLessThan(0.3);
    expect(Math.abs(c.pitch - TRUE.pitch)).toBeLessThan(0.3);
    expect(Math.abs(c.roll - TRUE.roll)).toBeLessThan(0.3);
    expect(Math.abs(c.hfov - TRUE.hfov)).toBeLessThan(0.5);
    expect(c.provenance.position).toBe('manual');
    expect(c.alignment?.points).toHaveLength(6);
  });
  it('solves orientation only (position fixed) from too few equations', () => {
    const start: CameraParams = { ...TRUE, heading: 43, pitch: 14 };
    const few = pts().filter((p) => p.id === 'g0' || p.id === 'v3' || p.id === 'v1');
    const r = solveFromCorrespondences(synthView(start), few);
    expect(r.camera.position).toEqual(TRUE.position);
    expect(Math.abs(r.camera.heading - TRUE.heading)).toBeLessThan(0.5);
    expect(Math.abs(r.camera.pitch - TRUE.pitch)).toBeLessThan(0.5);
  });
});

describe('regularizeFacadeWindows', () => {
  const d = [-0.12, -0.06, 0, 0.06, 0.12];
  const clean = (r: number, c: number) => ({ u: 1.5 + 2.5 * c, z: 2.4 + 3.1 * r });
  const make = (): FacadeWindow[] => {
    const out: FacadeWindow[] = [];
    for (let r = 0; r < 5; r++)
      for (let c = 0; c < 5; c++) {
        const k = clean(r, c);
        out.push({
          id: `w${r}${c}`,
          buildingId: 'b',
          edgeIndex: 0,
          u: k.u + d[(r + 2 * c) % 5],
          z: k.z + d[(r + c) % 5],
          width: 1.2 + d[(2 * r + c) % 5],
          height: 1.6 + d[(3 * r + c) % 5],
          floor: r,
          source: 'observed',
        });
      }
    return out;
  };
  it('snaps a noisy grid to the clean grid', () => {
    const out = regularizeFacadeWindows(make(), { facadeLengths: { 'b#0': 13 } });
    expect(out).toHaveLength(25);
    for (const w of out) {
      const [r, c] = [+w.id[1], +w.id[2]];
      const k = clean(r, c);
      expect(w.regularized).toBe(true);
      expect(w.u).toBeCloseTo(k.u, 9);
      expect(w.z).toBeCloseTo(k.z, 9);
      expect(w.width).toBeCloseTo(1.2, 9);
      expect(w.height).toBeCloseTo(1.6, 9);
    }
  });
  it('refuses big moves, drops windows off the facade and keeps manual windows', () => {
    const ws = make();
    ws[7].u += 0.6; // still clusters with its column, but the snap (0.42 m) exceeds maxMove 0.3
    ws[12] = { ...ws[12], source: 'manual', z: ws[12].z + 0.2 };
    ws.push({ id: 'off', buildingId: 'b', edgeIndex: 0, u: 13.5, z: 2.4, width: 1.2, height: 1.6, floor: 0, source: 'observed' });
    ws.push({ id: 'other', buildingId: 'c', edgeIndex: 2, u: 3, z: 5, width: 1, height: 1.5, floor: 1, source: 'observed' });
    const out = regularizeFacadeWindows(ws, { facadeLengths: { 'b#0': 13 }, maxMove: 0.3 });
    const by = new Map(out.map((w) => [w.id, w]));
    expect(by.has('off')).toBe(false);
    const manual = by.get(ws[12].id)!;
    expect(manual.z).toBe(ws[12].z); // manual: untouched
    expect(manual.regularized).toBeUndefined();
    const w7 = by.get(ws[7].id)!;
    expect(w7.u).toBe(ws[7].u); // too far: not moved along the facade
    expect(w7.z).toBeCloseTo(clean(1, 2).z, 9); // but still levelled with its row
    expect(by.get('other')!.u).toBe(3); // a single window on its facade is left alone
    for (const w of out) {
      const orig = ws.find((x) => x.id === w.id)!;
      expect(Math.hypot(w.u - orig.u, w.z - orig.z)).toBeLessThanOrEqual(0.3 + 1e-9);
    }
  });
  it('pulls overhanging windows inside the facade', () => {
    const out = regularizeFacadeWindows(
      [
        { id: 'a', buildingId: 'b', edgeIndex: 0, u: 0.3, z: 3, width: 1.2, height: 1.6, floor: 0, source: 'observed' },
        { id: 'b', buildingId: 'b', edgeIndex: 0, u: 9.8, z: 3, width: 1.2, height: 1.6, floor: 0, source: 'observed' },
      ],
      { facadeLengths: { 'b#0': 10 } },
    );
    for (const w of out) {
      expect(w.u - w.width / 2).toBeGreaterThanOrEqual(-1e-9);
      expect(w.u + w.width / 2).toBeLessThanOrEqual(10 + 1e-9);
    }
  });
  it('uses the image-space grid to level a row whose z is tilted by a residual camera error', () => {
    // one storey, 5 windows whose z drifts by 0.25 m per window (as under a 1–2° roll error),
    // plus the storey above: z-clustering alone would split or merge rows, the grid does not
    const ws: FacadeWindow[] = [];
    for (let c = 0; c < 5; c++) {
      ws.push({ id: `a${c}`, detectionId: `a${c}`, buildingId: 'b', edgeIndex: 0, u: 1 + 2.4 * c, z: 4 + 0.25 * (c - 2), width: 1.1, height: 1.7, floor: 1, source: 'observed' });
      ws.push({ id: `b${c}`, detectionId: `b${c}`, buildingId: 'b', edgeIndex: 0, u: 1 + 2.4 * c, z: 7.2 + 0.25 * (c - 2), width: 1.1, height: 1.7, floor: 2, source: 'observed' });
    }
    const grid = { rows: [['a0', 'a1', 'a2', 'a3', 'a4'], ['b0', 'b1', 'b2', 'b3', 'b4']], cols: [0, 1, 2, 3, 4].map((c) => [`a${c}`, `b${c}`]) };
    const out = regularizeFacadeWindows(ws, { grid });
    for (const w of out) expect(w.z).toBeCloseTo(w.id.startsWith('a') ? 4 : 7.2, 9);
  });
  it('minHeightFromWindows = top of the highest window + 0.3 m', () => {
    const ws = make();
    expect(minHeightFromWindows(ws, 'b')).toBeCloseTo(Math.max(...ws.map((w) => w.z + w.height / 2)) + 0.3, 9);
    expect(minHeightFromWindows(ws, 'nope')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Curated fixtures: report, don't tune                                 */
/* ------------------------------------------------------------------ */
const EX = resolve(__dirname, '../../../public/examples');
const ids = existsSync(EX) ? readdirSync(EX).filter((d) => existsSync(join(EX, d, 'scene.base.json')) && existsSync(join(EX, d, 'analysis.json'))) : [];
function load(id: string): Scene {
  const s = JSON.parse(readFileSync(join(EX, id, 'scene.base.json'), 'utf8'));
  const a = JSON.parse(readFileSync(join(EX, id, 'analysis.json'), 'utf8')) as FacadeAnalysis;
  return { ...s, analysis: a };
}

/** Picked correspondences and the EXIF-derived FOV range of a fixture, when the repo has them. */
function calibration(s: Scene): { points: AlignPoint[]; hfovRange?: [number, number] } | null {
  const p = resolve(__dirname, '../../../../data/calibration', s.id + '.json');
  if (!existsSync(p)) return null;
  const c = JSON.parse(readFileSync(p, 'utf8'));
  const mk = (kind: 'ground' | 'vertical') => (g: { vertex: number; px: Vec2 }, i: number): AlignPoint => ({ id: `${kind}${i}`, px: g.px, buildingId: s.targetBuildingId, vertex: g.vertex, kind, source: 'manual' });
  return { points: [...c.groundPoints.map(mk('ground')), ...c.verticalPoints.map(mk('vertical'))], hfovRange: c.hfovRange };
}

describe.skipIf(!ids.length)('curated examples: alignment report', () => {
  const rows: Record<string, unknown>[] = [];
  for (const id of ids) {
    it(`${id}: auto-alignment and regularisation are sane`, () => {
      const s = load(id);
      const dets = s.analysis.detections;
      // the camera the store starts from (pitch solved from the ground line when only assumed)
      let cam = s.camera;
      if (cam.provenance.pitch === 'assumed') {
        const p = calibratePitch(s, cam);
        if (p != null) cam = { ...cam, pitch: Math.round(p * 10) / 10, provenance: { ...cam.provenance, pitch: 'inferred' } };
      }
      const cal = calibration(s);
      const t0 = performance.now();
      // (a) what the store would do on load: respect 'manual'
      const al = autoAlignCamera({ ...s, camera: cam, detections: dets }, { hfovRange: cal?.hfovRange });
      const ms = performance.now() - t0;
      // (b) recommendation for maintainer-resected fixtures: treat the resection as 'inferred'
      const relaxed: CameraParams = { ...cam, provenance: Object.fromEntries(Object.entries(cam.provenance).map(([k, v]) => [k, v === 'manual' ? 'inferred' : v])) as CameraParams['provenance'] };
      const alR = autoAlignCamera({ ...s, camera: relaxed, detections: dets }, { hfovRange: cal?.hfovRange });
      const recon = (c: CameraParams) => reconstruct({ scene: s, camera: c, detections: dets, settings: defaultSettings, overrides: {} });
      const hOf = (r: ReturnType<typeof recon>) => Object.fromEntries(Object.entries(r.buildings).map(([k, v]) => [k, v.height.value]));
      const r0 = recon(cam);
      const r1 = recon(al.camera);
      const r2 = recon(alR.camera);
      const d0 = diagnoseWindows(s, cam, dets, hOf(r0));
      const d1 = diagnoseWindows(s, al.camera, dets, hOf(r1));
      const d2 = diagnoseWindows(s, alR.camera, dets, hOf(r2));
      const grid = windowGrid(dets);
      const reg = regularizeFacadeWindows(r1.windows, { footprints: s.footprints, grid });
      const regR = regularizeFacadeWindows(r2.windows, { footprints: s.footprints, grid });
      const t = s.targetBuildingId;
      const floatAbove = (ws: FacadeWindow[], hs: Record<string, number>) => ws.filter((w) => w.z + w.height / 2 > (hs[w.buildingId] ?? Infinity)).length;
      const withMin = (hs: Record<string, number>, ws: FacadeWindow[]) => Object.fromEntries(Object.entries(hs).map(([k, v]) => [k, Math.max(v, minHeightFromWindows(ws, k) ?? 0)]));
      const ref = s.validation?.find((v) => v.height != null)?.height ?? null;
      const spreadReg = (ws: FacadeWindow[], base: FacadeWindow[]) => {
        const byId = new Map(base.map((w) => [w.id, w]));
        return Math.max(0, ...ws.map((w) => Math.hypot(w.u - byId.get(w.id)!.u, w.z - byId.get(w.id)!.z)));
      };
      // windows drawn in 3D more than 10 cm above/below the median of their image row (∩ building)
      const unlevel = (ws: FacadeWindow[]) => {
        const byDet = new Map(ws.map((w) => [w.detectionId, w]));
        const dev: number[] = [];
        for (const g of grid.rows) {
          const per = new Map<string, number[]>();
          for (const id of g) {
            const w = byDet.get(id);
            if (w) (per.get(w.buildingId) ?? per.set(w.buildingId, []).get(w.buildingId)!).push(w.z);
          }
          for (const zs of per.values()) if (zs.length >= 2) {
            const m = [...zs].sort((a, b) => a - b)[zs.length >> 1];
            for (const z of zs) dev.push(Math.abs(z - m));
          }
        }
        return dev.filter((d) => d > 0.1).length;
      };
      const row = {
        id,
        ms: Math.round(ms),
        changed: al.changed,
        cost0: +al.cost0.toFixed(2),
        cost: +al.cost.toFixed(2),
        rowZ0: +d0.rowZSpread.toFixed(2),
        rowZ: +d1.rowZSpread.toFixed(2),
        colU0: +d0.colUSpread.toFixed(2),
        colU: +d1.colUSpread.toFixed(2),
        noiseM: +d0.boxNoiseM.toFixed(2),
        H0: +r0.buildings[t].height.value.toFixed(1),
        H: +r1.buildings[t].height.value.toFixed(1),
        ref,
        float0: floatAbove(r0.windows, hOf(r0)),
        floatFix: floatAbove(reg, withMin(hOf(r1), reg)),
        maxSnap: +spreadReg(reg, r1.windows).toFixed(2),
        unlevel0: unlevel(r1.windows),
        unlevelReg: unlevel(reg),
        relaxed_changed: alR.changed,
        relaxed_cost: +alR.cost.toFixed(2),
        relaxed_rowZ: +d2.rowZSpread.toFixed(2),
        relaxed_colU: +d2.colUSpread.toFixed(2),
        relaxed_H: +r2.buildings[t].height.value.toFixed(1),
        relaxed_unlevel0: unlevel(r2.windows),
        relaxed_unlevelReg: unlevel(regR),
      };
      rows.push(row);
      // eslint-disable-next-line no-console
      console.log(
        id,
        JSON.stringify({
          notes: al.notes,
          relaxedNotes: alR.notes,
          terms: al.terms,
          relaxedTerms: alR.terms,
          camera0: { position: cam.position, heading: cam.heading, pitch: cam.pitch, roll: cam.roll, hfov: cam.hfov },
          relaxedCamera: { position: alR.camera.position, heading: alR.camera.heading, pitch: alR.camera.pitch, roll: alR.camera.roll, hfov: alR.camera.hfov },
          d0,
          d1,
          d2,
          floors: [r0.buildings[t].floors?.value, r1.buildings[t].floors?.value, r2.buildings[t].floors?.value],
          floorHeight: [r0.buildings[t].floorHeight?.value, r1.buildings[t].floorHeight?.value, r2.buildings[t].floorHeight?.value],
          regRelaxedMaxSnap: spreadReg(regR, r2.windows),
          regCount: [r1.windows.length, reg.length, r2.windows.length, regR.length],
        }),
      );
      // sanity only — no tuned numbers
      expect(al.cost).toBeLessThanOrEqual(al.cost0 + 1e-9);
      expect(alR.cost).toBeLessThanOrEqual(alR.cost0 + 1e-9);
      if (al.changed) expect(d1.rowZSpread + d1.colUSpread).toBeLessThan(d0.rowZSpread + d0.colUSpread);
      if (cam.provenance.pitch === 'manual' && cam.provenance.hfov === 'manual' && cam.provenance.heading === 'manual' && cam.provenance.position === 'manual') expect(al.changed).toBe(false);
      for (const r of [r1, r2]) {
        expect(Number.isFinite(r.buildings[t].height.value)).toBe(true);
        expect(r.buildings[t].height.value).toBeGreaterThan(3);
        expect(r.buildings[t].height.value).toBeLessThan(120);
      }
      expect(reg.length).toBeGreaterThan(0);
      expect(reg.length).toBeLessThanOrEqual(r1.windows.length);
      expect(row.floatFix).toBe(0);
      expect(row.maxSnap).toBeLessThanOrEqual(0.6 + 1e-9);
      expect(ms).toBeLessThan(3000);
    }, 30000);
  }
  it('prints the report', () => {
    // eslint-disable-next-line no-console
    console.table(rows);
  });
});
