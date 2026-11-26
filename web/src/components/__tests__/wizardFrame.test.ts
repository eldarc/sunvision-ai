import { afterEach, describe, expect, it, vi } from 'vitest';
import { OVERPASS_BUDGET_MS, carryTarget, footprintAt, frameFeatures, insideFootprint, mergeFrames, metersPerPixel, timeBoxed, wizardCamera, type WizardFrame } from '../upload/wizard/wizardFrame';
import { enuToLonLat, lonLatToEnu } from '../../engine/geo';
import { manualAnalysis, prepareTileScene, footprintFromCorners } from '../../lib/tileBuildings';
import type { Detection, Footprint, LatLon, Vec2 } from '../../schema/scene';

const O: LatLon = { lat: 43.85712, lon: 18.42582 }; // Sarajevo (the Obala Kulina bana example's origin)
const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];
const fp = (id: string, ring: Vec2[], extra: Partial<Footprint> = {}): Footprint => ({ id, ring, tags: { building: 'yes', 'sunvision:source': 'openmaptiles' }, source: 'osm', ...extra });
const at = (origin: LatLon, p: Vec2) => enuToLonLat(origin, p);

const A = fp('omt/a', rect(20, 0, 40, 12));
const B = fp('omt/b', rect(-30, 20, -10, 35));
const frame: WizardFrame = { origin: O, footprints: [A, B], streets: [{ id: 's1', line: [[-50, -8], [80, -8]], tags: { highway: 'residential' } }], warnings: [] };

describe('footprintAt', () => {
  it('returns the footprint under the click, null elsewhere', () => {
    expect(footprintAt(frame, at(O, [30, 6]))).toBe('omt/a');
    expect(footprintAt(frame, at(O, [-20, 30]))).toBe('omt/b');
    expect(footprintAt(frame, at(O, [0, 0]))).toBeNull();
  });

  it('works from any frame origin (the click is converted into the frame)', () => {
    const far = { ...frame, origin: at(O, [500, -300]), footprints: frame.footprints.map((f) => ({ ...f, ring: f.ring.map((p) => lonLatToEnu(at(O, [500, -300]), at(O, p))) })) };
    expect(footprintAt(far, at(O, [30, 6]))).toBe('omt/a');
  });

  it('accepts a click just outside the outline within the tolerance', () => {
    expect(footprintAt(frame, at(O, [41, 6]))).toBeNull();
    expect(footprintAt(frame, at(O, [41, 6]), 1.5)).toBe('omt/a');
    expect(footprintAt(frame, at(O, [45, 6]), 1.5)).toBeNull();
  });

  it('prefers the smallest of nested footprints and respects holes', () => {
    const outer = fp('omt/outer', rect(-100, -100, 100, 100), { holes: [rect(-5, -5, 5, 5)] });
    const inner = fp('omt/inner', rect(50, 50, 60, 60));
    const f = { origin: O, footprints: [outer, inner] };
    expect(footprintAt(f, at(O, [55, 55]))).toBe('omt/inner');
    expect(footprintAt(f, at(O, [0, 0]))).toBeNull(); // courtyard
    expect(insideFootprint([0, 0], outer)).toBe(false);
    expect(insideFootprint([20, 0], outer)).toBe(true);
  });
});

describe('carryTarget', () => {
  const origin2 = at(O, [15, 10]);
  const moved = (f: Footprint, o: LatLon): Footprint => ({ ...f, ring: f.ring.map((p) => lonLatToEnu(o, at(O, p))) });

  it('keeps the same id when the new read has it', () => {
    const next: WizardFrame = { origin: origin2, footprints: [moved(A, origin2)], streets: [], warnings: [] };
    expect(carryTarget(frame, 'omt/a', next)).toEqual({ frame: next, targetId: 'omt/a' });
  });

  it('re-matches a tile footprint whose id changed', () => {
    const renamed = { ...moved(A, origin2), id: 'omt/a2' };
    const next: WizardFrame = { origin: origin2, footprints: [renamed], streets: [], warnings: [] };
    const r = carryTarget(frame, 'omt/a', next);
    expect(r.targetId).toBe('omt/a2');
    expect(r.frame).toBe(next);
  });

  it('carries a drawn outline into the new read, replacing the tile footprint under it', () => {
    const drawn = footprintFromCorners([at(O, [19, -1]), at(O, [41, -1]), at(O, [41, 13]), at(O, [19, 13])], O);
    const prev: WizardFrame = { ...frame, footprints: [drawn, B] };
    const next: WizardFrame = { origin: origin2, footprints: [moved(A, origin2), moved(B, origin2)], streets: [], warnings: [] };
    const r = carryTarget(prev, drawn.id, next);
    expect(r.targetId).toBe(drawn.id);
    expect(r.frame.footprints.map((f) => f.id).sort()).toEqual([drawn.id, 'omt/b'].sort());
    // Re-expressed in the new origin: still the same place on the ground.
    expect(footprintAt(r.frame, at(O, [30, 6]))).toBe(drawn.id);
  });

  it('keeps a target that scrolled out of the read, and clears an unknown one', () => {
    const next: WizardFrame = { origin: origin2, footprints: [moved(B, origin2)], streets: [], warnings: [] };
    const r = carryTarget(frame, 'omt/a', next);
    expect(r.targetId).toBe('omt/a');
    expect(footprintAt(r.frame, at(O, [30, 6]))).toBe('omt/a');
    expect(carryTarget(null, 'omt/x', next).targetId).toBeNull();
    expect(carryTarget(frame, null, next)).toEqual({ frame: next, targetId: null });
  });
});

describe('mergeFrames', () => {
  it('adds the on-demand read in the base frame, without duplicates', () => {
    const o2 = at(O, [100, 0]);
    const C = fp('omt/c', rect(90, 0, 110, 10));
    const add: WizardFrame = {
      origin: o2,
      footprints: [A, C].map((f) => ({ ...f, ring: f.ring.map((p) => lonLatToEnu(o2, at(O, p))) })),
      streets: [{ id: 's2', line: [[-10, -8], [10, -8]], tags: {} }],
      warnings: ['x'],
    };
    const m = mergeFrames(frame, add, 'omt/c');
    expect(m.origin).toEqual(O);
    expect(m.footprints.map((f) => f.id).sort()).toEqual(['omt/a', 'omt/b', 'omt/c']);
    expect(footprintAt(m, at(O, [100, 5]))).toBe('omt/c');
    expect(m.streets.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(m.streets[1].line[0][0]).toBeCloseTo(90, 3);
    expect(mergeFrames(null, add)).toBe(add);
  });

  it('keepId replaces what overlaps it (a drawn outline over a tile footprint)', () => {
    const drawn = footprintFromCorners([at(O, [19, -1]), at(O, [41, -1]), at(O, [41, 13]), at(O, [19, 13])], O);
    const m = mergeFrames(frame, { origin: O, footprints: [drawn], streets: [], warnings: [] }, drawn.id);
    expect(m.footprints.map((f) => f.id).sort()).toEqual([drawn.id, 'omt/b'].sort());
  });
});

describe('frameFeatures', () => {
  it('emits closed lon/lat polygons flagged with the selection', () => {
    const fc = frameFeatures(frame, 'omt/b');
    expect(fc.features).toHaveLength(2);
    const b = fc.features.find((f) => f.properties?.id === 'omt/b')!;
    expect(b.properties?.sel).toBe(true);
    const ring = (b.geometry as { coordinates: number[][][] }).coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(frameFeatures(null, null).features).toEqual([]);
    expect(frameFeatures({ origin: O, footprints: [fp('bad', [[0, 0], [1, 1]])] }, null).features).toEqual([]);
  });
});

describe('metersPerPixel', () => {
  it('matches web-mercator ground resolution', () => {
    expect(metersPerPixel(0, 0)).toBeCloseTo(78271.5, 0);
    expect(metersPerPixel(60, 18)).toBeCloseTo(0.149, 3);
  });
});

describe('wizardCamera', () => {
  it('keeps the user camera and its provenance, in the frame ENU', () => {
    const cam = at(O, [30, -20]);
    const c = wizardCamera(O, { camera: cam, heading: -10, positionProv: 'manual', headingProv: 'manual' });
    expect(c.position[0]).toBeCloseTo(30, 6);
    expect(c.position[1]).toBeCloseTo(-20, 6);
    expect(c.heading).toBeCloseTo(350, 9);
    expect(c.provenance).toEqual({ position: 'manual', heading: 'manual' });
    expect(c.basis).toBe('manual');
    expect(c.notes.join(' ')).toMatch(/placed by you/);
    const g = wizardCamera(O, { camera: cam, heading: 12, positionProv: 'observed', headingProv: 'observed', headingRef: 'M' });
    expect(g.basis).toBe('gps');
    expect(g.provenance).toEqual({ position: 'observed', heading: 'observed' });
    expect(g.notes.join(' ')).toMatch(/magnetic/);
  });

  it('prepareTileScene never moves a manual camera position or heading', () => {
    const camLL = at(O, [30, -25]);
    const heading = 2; // roughly north, at A's south facade
    const camera = wizardCamera(O, { camera: camLL, heading, positionProv: 'manual', headingProv: 'manual' });
    // A regular 4 × 3 window grid, so the aligner has something to optimise.
    const detections: Detection[] = [];
    for (let r = 0; r < 3; r++)
      for (let k = 0; k < 4; k++) detections.push({ id: `w${r}${k}`, cls: 'window', confidence: 0.9, bbox: [900 + k * 600, 600 + r * 500, 1200 + k * 600, 900 + r * 500], source: 'model' });
    const analysis = { ...manualAnalysis(4000, 3000, 'test'), detections, model: { provider: 'test', modelId: 'synthetic' } } as ReturnType<typeof manualAnalysis>;
    const { scene } = prepareTileScene({
      id: 't',
      title: 't.jpg',
      image: { url: 'blob:t', width: 4000, height: 3000 },
      analysis,
      frameOrigin: O,
      footprints: [A, B],
      streets: frame.streets,
      targetId: 'omt/a',
      camera,
      retrieved: '2026-11-25',
    });
    expect(scene.targetBuildingId).toBe('omt/a');
    expect(scene.camera.provenance.position).toBe('manual');
    expect(scene.camera.provenance.heading).toBe('manual');
    expect(scene.camera.heading).toBeCloseTo(heading, 9);
    const back = enuToLonLat(scene.origin, scene.camera.position);
    expect(back.lat).toBeCloseTo(camLL.lat, 9);
    expect(back.lon).toBeCloseTo(camLL.lon, 9);
  });
});

describe('timeBoxed', () => {
  afterEach(() => vi.useRealTimers());

  it('resolves with the value in time, null on timeout or rejection', async () => {
    vi.useFakeTimers();
    const slow = new Promise<number>((r) => setTimeout(() => r(1), OVERPASS_BUDGET_MS + 1000));
    const box = timeBoxed(slow, OVERPASS_BUDGET_MS);
    await vi.advanceTimersByTimeAsync(OVERPASS_BUDGET_MS);
    expect(await box).toBeNull();
    expect(await timeBoxed(Promise.resolve(7), 10)).toEqual({ value: 7 });
    expect(await timeBoxed(Promise.reject(new Error('x')), 10)).toBeNull();
    const zero = timeBoxed(new Promise<number>(() => {}), -5);
    await vi.advanceTimersByTimeAsync(0);
    expect(await zero).toBeNull();
  });
});
