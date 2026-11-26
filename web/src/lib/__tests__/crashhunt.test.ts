/**
 * Render-time exception guards (the "whole page goes black" class of failure).
 *
 * Each test feeds an input that would throw during render and asserts the correct behaviour.
 * The guards at the end of each block cover inputs checked and found safe.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FacadeAnalysis, Scene } from '../../schema/scene';
import { anyHit, buildObstacleIndex, dailyExposure, evaluateWindowAt, localToUtc, sunSampleAt, sunTimes } from '../../engine';
import type { WindowSpec } from '../../engine/types';
import { defaultSettings, prepareScene, useStore } from '../../state/store';
import { reconstruct } from '../reconstruct';
import { buildGeometry } from '../obstacles';
import { sceneViews } from '../views';

const AMS = { lat: 52.3731, lon: 4.8926, tz: 'Europe/Amsterdam' };
const HNL = { lat: 21.3069, lon: -157.8583, tz: 'Pacific/Honolulu' };

const target = { id: 'target', kind: 'target-building' as const, label: 'Target', ring: [[-10, 0], [10, 0], [10, 10], [-10, 10]] as [number, number][], zMin: 0, zMax: 20 };
const south: WindowSpec = { id: 'w', center: [0, 0, 5], normal: [0, -1, 0], uAxis: [1, 0, 0], width: 1.2, height: 1.6, ownerId: 'target' };
const noonSun = sunSampleAt(localToUtc('2026-06-21', 13 * 60, AMS.tz), AMS.lat, AMS.lon);

/* ------------------------------------------------------------------------------------------ */
/* 1. Dates the native <input type="date"> accepts (it has no min/max) but the engine rejects   */
/* ------------------------------------------------------------------------------------------ */
describe('simulation date at the JS Date ceiling (input type=date accepts years up to 275760)', () => {
  // useSun → localToUtc and useSunTimes / useSharedDaily → sunTimes run during render in
  // TwinView, Inspector, SunReport, DayBar and Timeline: a throw here takes down every panel,
  // including the DayBar that holds the only date control.
  it('localToUtc does not throw for 275760-09-13 (Chrome date input maximum)', () => {
    expect(() => localToUtc('275760-09-13', 14 * 60, AMS.tz)).not.toThrow();
  });
  it('sunTimes does not throw for 275760-09-13', () => {
    expect(() => sunTimes('275760-09-13', AMS.lat, AMS.lon, AMS.tz)).not.toThrow();
  });
  it('localToUtc does not throw west of Greenwich on the day before the ceiling (23:00 Honolulu = next day UTC)', () => {
    expect(() => localToUtc('275760-09-12', 23 * 60, HNL.tz)).not.toThrow();
  });
  it('dailyExposure does not throw for that date', () => {
    const idx = buildObstacleIndex({ prisms: [target], boxes: [], trees: [] });
    expect(() => dailyExposure(idx, [south], '275760-09-13', AMS, 5)).not.toThrow();
  });
  it('year 0001 (the date input minimum) gives a non-negative day length', () => {
    // The risk here is not a throw but a fabricated number: sunset before sunrise.
    expect(sunTimes('0001-01-01', AMS.lat, AMS.lon, AMS.tz).dayLengthMinutes).toBeGreaterThanOrEqual(0);
  });
  it('the scrubber range, DST days and minutes that round to second 60 stay safe', () => {
    for (const m of [0, 0.01, 402.9933, 1439, 1439.999, 1440, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(Number.isFinite(localToUtc('2026-06-21', m, AMS.tz))).toBe(true);
    for (const d of ['2026-03-29', '2026-10-25', '0001-01-01', '9999-12-31', '200000-06-21']) expect(() => sunTimes(d, AMS.lat, AMS.lon, AMS.tz)).not.toThrow();
  });
});

/* ------------------------------------------------------------------------------------------ */
/* 2. One non-finite coordinate must not turn every shadow ray into a TypeError                  */
/* ------------------------------------------------------------------------------------------ */
describe('ray caster with non-finite geometry', () => {
  // evaluateWindowAt runs during render (useInstant in TwinView / Inspector, useSharedDaily in
  // SunReport / DayBar / Timeline). TwinView filters non-finite windows before drawing them, but
  // useInstant still evaluates every sim.geo.windows entry.
  it('an index containing one NaN tree still answers rays (miss or hit, no throw)', () => {
    const idx = buildObstacleIndex({ prisms: [target], boxes: [], trees: [{ id: 't', kind: 'tree', label: 'Tree', position: [Number.NaN, Number.NaN], height: 8, crownRadius: 3, trunkRadius: 0.25 }] });
    // Guards against minX = NaN → nx = NaN → index.cells is [] → cells[NaN].length → TypeError.
    expect(() => evaluateWindowAt(idx, south, noonSun)).not.toThrow();
  });
  it('a NaN balcony box is skipped by the grid (comparisons with NaN keep its bbox empty): safe', () => {
    const idx = buildObstacleIndex({ prisms: [target], boxes: [{ id: 'b', kind: 'balcony', label: 'Balcony', center: [Number.NaN, Number.NaN, 3], axes: [[1, 0, 0], [0, -1, 0], [0, 0, 1]], halfSize: [Number.NaN, 0.5, 0.12] }], trees: [] });
    expect(() => evaluateWindowAt(idx, south, noonSun)).not.toThrow();
  });
  it('a window with a NaN centre against a valid index returns a result instead of throwing', () => {
    const idx = buildObstacleIndex({ prisms: [target], boxes: [], trees: [] });
    expect(() => anyHit(idx, [Number.NaN, 0, 5], noonSun.dir)).not.toThrow();
    expect(() => evaluateWindowAt(idx, { ...south, center: [Number.NaN, 0, 5] }, noonSun)).not.toThrow();
  });

  const EX = resolve(__dirname, '../../../public/examples/amsterdam-herengracht');
  it.skipIf(!existsSync(join(EX, 'analysis.json')))('end to end: a 0×0 image (readPhoto rejects it) gives no NaN windows, and evaluating every window is safe', () => {
    const base = JSON.parse(readFileSync(join(EX, 'scene.base.json'), 'utf8'));
    const analysis = JSON.parse(readFileSync(join(EX, 'analysis.json'), 'utf8')) as FacadeAnalysis;
    const scene = prepareScene({ ...base, analysis, image: { ...base.image, width: 0, height: 0 } } as Scene);
    const camera = scene.camera;
    const detections = scene.analysis.detections;
    const views = sceneViews(scene, { camera, detections, viewCameras: {}, viewDetections: {} });
    const recon = reconstruct({ scene, camera, detections, settings: defaultSettings, overrides: {}, depth: null, views, depths: {} });
    const geo = buildGeometry({ scene, recon, settings: defaultSettings, trees: scene.trees, extraBuildings: [], selectedWindowIds: [], apartment: { depth: 6, ceilingHeight: 2.7, balconyDepth: 0, partitions: 1, margin: 0.8, sillHeight: 0.9 }, detections, camera, views });
    const idx = buildObstacleIndex(geo.obstacles);
    const nan = geo.windows.filter((w) => !w.spec.center.every(Number.isFinite));
    expect(nan.length).toBe(0); // buildGeometry drops windows it cannot place (38 of 87 here)
    // What useInstant does on every render of the 3D view, through the day:
    for (let m = 6 * 60; m <= 20 * 60; m += 30) {
      const sun = sunSampleAt(localToUtc('2026-06-21', m, scene.timezone), scene.origin.lat, scene.origin.lon);
      for (const w of geo.windows) evaluateWindowAt(idx, w.spec, sun);
    }
  });
});

/* ------------------------------------------------------------------------------------------ */
/* 3. Date writes are kept inside the range the UI offers                                       */
/* ------------------------------------------------------------------------------------------ */
describe('simulation date guard', () => {
  it('clampDate clamps the year, the month and the day (29 Feb in a non-leap year)', async () => {
    const { clampDate, SIM_YEAR_MAX, SIM_YEAR_MIN } = await import('../../engine');
    expect(clampDate('275760-09-13')).toBe(`${SIM_YEAR_MAX}-09-13`);
    expect(clampDate('0001-01-01')).toBe(`${SIM_YEAR_MIN}-01-01`);
    expect(clampDate('2100-02-29')).toBe('2100-02-28');
    expect(clampDate('2024-02-29')).toBe('2024-02-29');
    expect(clampDate('not a date')).toBeNull();
  });
  it('store.set clamps a date write and ignores a non-date', () => {
    const s = () => useStore.getState();
    s().set({ date: '275760-09-13' });
    expect(s().date).toBe('2100-09-13');
    s().set({ date: 'garbage', minutes: 600 });
    expect(s().date).toBe('2100-09-13');
    expect(s().minutes).toBe(600);
  });
});
