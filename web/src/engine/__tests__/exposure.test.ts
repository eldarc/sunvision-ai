import { describe, expect, it } from 'vitest';
import { buildObstacleIndex } from '../raycast';
import { annualExposure, dailyExposure, evaluateWindowAt } from '../exposure';
import { sunSampleAt, sunTimes, localToUtc } from '../solar';
import { AMS, northWindow, scene, southObstacle, southWindow, target } from './helpers';
import type { BoxObstacle, TreeObstacle } from '../types';

const noonSun = (date: string) => sunSampleAt(sunTimes(date, AMS.lat, AMS.lon, AMS.tz).solarNoon.utc, AMS.lat, AMS.lon);

describe('physical scenarios', () => {
  const open = buildObstacleIndex(scene([target()]));

  it('an unobstructed south-facing window is lit at June noon in Amsterdam', () => {
    const r = evaluateWindowAt(open, southWindow(), noonSun('2024-06-21'));
    expect(r.daylight).toBe(true);
    expect(r.facing).toBe(true);
    expect(r.litFraction).toBe(1);
  });
  it('a north-facing window gets no direct sun at winter noon', () => {
    const r = evaluateWindowAt(open, northWindow(), noonSun('2024-12-21'));
    expect(r.facing).toBe(false);
    expect(r.litFraction).toBe(0);
    const d = dailyExposure(open, [northWindow()], '2024-12-21', AMS, 10);
    expect(d.windows[0].directMinutes).toBe(0);
  });
  it('nighttime produces no direct sunlight', () => {
    const night = sunSampleAt(localToUtc('2024-06-21', 60, AMS.tz), AMS.lat, AMS.lon);
    const r = evaluateWindowAt(open, southWindow(), night);
    expect(r.daylight).toBe(false);
    expect(r.litFraction).toBe(0);
    const d = dailyExposure(open, [southWindow()], '2024-06-21', AMS, 10);
    for (const s of d.windows[0].timeline) if (s.altitude <= 0) expect(s.litFraction).toBe(0);
  });
  it('a sufficiently tall obstacle blocks the sun and is reported as the blocker', () => {
    const blocked = buildObstacleIndex(scene([target(), southObstacle(120)]));
    const r = evaluateWindowAt(blocked, southWindow(), noonSun('2024-12-21'));
    expect(r.litFraction).toBe(0);
    expect(Object.keys(r.blockers)).toEqual(['opposite']);
    const d = dailyExposure(blocked, [southWindow()], '2024-12-21', AMS, 10);
    expect(d.windows[0].blockers[0].id).toBe('opposite');
    expect(d.windows[0].blockers[0].label).toBe('Opposite block');
  });
  it('increasing obstacle height never increases exposure (monotonic)', () => {
    for (const date of ['2024-03-20', '2024-06-21', '2024-12-21']) {
      let prev = Infinity;
      for (const h of [0.5, 3, 6, 9, 12, 15, 20, 30, 45, 80]) {
        const idx = buildObstacleIndex(scene([target(), southObstacle(h)]));
        const m = dailyExposure(idx, [southWindow(4)], date, AMS, 10).windows[0].directMinutes;
        expect(m).toBeLessThanOrEqual(prev + 1e-9);
        prev = m;
      }
    }
  });
  it('moving a window above the obstruction increases exposure', () => {
    const idx = buildObstacleIndex(scene([target(40), southObstacle(15)]));
    const low = dailyExposure(idx, [southWindow(3)], '2024-12-21', AMS, 10).windows[0].directMinutes;
    const high = dailyExposure(idx, [southWindow(30)], '2024-12-21', AMS, 10).windows[0].directMinutes;
    expect(low).toBeLessThan(high);
    expect(high).toBeGreaterThan(60);
  });
  it('a tree in front blocks sunlight', () => {
    const tree: TreeObstacle = { id: 'tree-1', kind: 'tree', label: 'Plane tree', position: [0, -6], height: 14, crownRadius: 4, trunkRadius: 0.4 };
    const idx = buildObstacleIndex(scene([target()], { trees: [tree] }));
    const sun = noonSun('2024-06-21');
    const r = evaluateWindowAt(idx, southWindow(5), sun);
    expect(r.litFraction).toBeLessThan(1);
    expect(r.blockers['tree-1']).toBeGreaterThan(0);
  });
  it('a balcony overhang reduces summer-noon exposure of the window below', () => {
    const w = southWindow(5);
    const balcony: BoxObstacle = {
      id: 'balcony-1', kind: 'balcony', label: 'Balcony above', center: [0, -0.75, 6.0],
      axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], halfSize: [1.5, 0.75, 0.1],
    };
    const without = buildObstacleIndex(scene([target()]));
    const withB = buildObstacleIndex(scene([target()], { boxes: [balcony] }));
    const sun = noonSun('2024-06-21');
    const a = evaluateWindowAt(without, w, sun).litFraction;
    const b = evaluateWindowAt(withB, w, sun).litFraction;
    expect(b).toBeLessThan(a);
    // In winter (low sun) the overhang matters less.
    const winter = noonSun('2024-12-21');
    expect(evaluateWindowAt(withB, w, winter).litFraction).toBeGreaterThan(b);
  });
  it('reports morning/afternoon split and intervals for an east window', () => {
    const east = { id: 'e', center: [10, 5, 5] as [number, number, number], normal: [1, 0, 0] as [number, number, number], uAxis: [0, 1, 0] as [number, number, number], width: 1, height: 1.5, ownerId: 'target' };
    const d = dailyExposure(open, [east], '2024-06-21', AMS, 5).windows[0];
    expect(d.morningMinutes).toBeGreaterThan(300);
    expect(d.afternoonMinutes).toBeLessThan(d.morningMinutes / 4);
    expect(d.intervals.length).toBeGreaterThanOrEqual(1);
    expect(d.firstDirect!).toBeLessThan(7 * 60);
    expect(d.directFractionOfDaylight).toBeGreaterThan(0.3);
    expect(d.directFractionOfDaylight).toBeLessThan(0.7);
  });
});

describe('annual analysis', () => {
  it('produces a days × bins matrix with winter < summer for a south window at 52°N', () => {
    const idx = buildObstacleIndex(scene([target(), southObstacle(14)]));
    const r = annualExposure(idx, [southWindow(4)], AMS, { year: 2024, dayStep: 7, binMinutes: 15 });
    expect(r.matrix.length).toBe(r.days.length);
    expect(r.days.length).toBe(53);
    for (const row of r.matrix) expect(row.length).toBe(96);
    const jun = r.monthlyAvgDirectMinutes[5]!;
    const dec = r.monthlyAvgDirectMinutes[11]!;
    expect(dec).toBeLessThan(jun);
    expect(r.resolution.binMinutes).toBe(15);
    expect(r.keyDates).toHaveLength(4);
    // Night cells are flagged with -1.
    expect(r.matrix[0][0]).toBe(-1);
    expect(r.directFractionOfDaylight).toBeGreaterThan(0);
    expect(r.directFractionOfDaylight).toBeLessThan(1);
  });

  it('is fast enough: 6 windows × 52 days × 96 bins × 12 points < 2 s', () => {
    const prisms = [target(25), southObstacle(18)];
    // A neighbourhood of 400 blocks to exercise the grid.
    for (let i = 0; i < 20; i++)
      for (let j = 0; j < 20; j++) {
        const x = -300 + i * 30;
        const y = -300 + j * 30;
        if (Math.abs(x) < 40 && Math.abs(y) < 40) continue;
        prisms.push({ id: `n${i}-${j}`, kind: 'building', label: 'n', ring: [[x, y], [x + 20, y], [x + 20, y + 20], [x, y + 20]], zMin: 0, zMax: 10 + ((i * 7 + j * 3) % 25) });
      }
    const idx = buildObstacleIndex(scene(prisms));
    const wins = Array.from({ length: 6 }, (_, k) => southWindow(3 + k * 3, `w${k}`));
    const t0 = performance.now();
    const r = annualExposure(idx, wins, AMS, { year: 2024, dayStep: 7, binMinutes: 15, keyDates: false });
    const ms = performance.now() - t0;
    console.log(`annual perf: ${ms.toFixed(0)} ms for ${r.days.length} days`);
    expect(ms).toBeLessThan(2000);
  });
});
