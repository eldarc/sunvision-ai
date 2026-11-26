/**
 * Potential direct-sunlight exposure of facade windows under clear-sky
 * conditions. Numerical sampling: sun positions at bin centres, a grid of
 * sample points per window, one shadow ray per point toward the sun.
 *
 * These are geometric estimates of *potential direct sun*, not measured
 * indoor brightness, weather forecasts or professional daylight assessments.
 */
import type { Vec3 } from '../schema/scene';
import type { SunSample, WindowSampleResult, WindowSpec } from './types';
import { anyHit, type ObstacleIndex } from './raycast';
import { daySamples, localToUtc, sunSampleAt, sunTimes, type SolarContext, type SunTimesResult } from './solar';

export type SampleState = 'night' | 'facing-away' | 'blocked' | 'partial' | 'direct';

export interface SamplingOptions {
  nu?: number; // sample columns per window
  nv?: number; // sample rows per window
}

const OUTWARD_OFFSET = 0.02;
const UP: Vec3 = [0, 0, 1];

const pointCache = new WeakMap<WindowSpec, { key: string; pts: Vec3[] }>();

/** Grid of sample points (cell centres) on the glazing, offset 2 cm outward. */
export function windowSamplePoints(w: WindowSpec, nu = 4, nv = 3): Vec3[] {
  const key = `${nu}x${nv}`;
  const c = pointCache.get(w);
  if (c && c.key === key) return c.pts;
  const pts: Vec3[] = [];
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const u = ((i + 0.5) / nu - 0.5) * w.width;
      const v = ((j + 0.5) / nv - 0.5) * w.height;
      pts.push([
        w.center[0] + u * w.uAxis[0] + v * UP[0] + OUTWARD_OFFSET * w.normal[0],
        w.center[1] + u * w.uAxis[1] + v * UP[1] + OUTWARD_OFFSET * w.normal[1],
        w.center[2] + u * w.uAxis[2] + v * UP[2] + OUTWARD_OFFSET * w.normal[2],
      ]);
    }
  }
  pointCache.set(w, { key, pts });
  return pts;
}

export function evaluateWindowAt(
  index: ObstacleIndex,
  w: WindowSpec,
  sun: SunSample,
  opts: SamplingOptions = {},
): WindowSampleResult {
  const blockers: Record<string, number> = {};
  if (sun.altitude <= 0) return { windowId: w.id, litFraction: 0, daylight: false, facing: false, blockers };
  const dot = sun.dir[0] * w.normal[0] + sun.dir[1] * w.normal[1] + sun.dir[2] * w.normal[2];
  if (dot <= 0) return { windowId: w.id, litFraction: 0, daylight: true, facing: false, blockers };
  const pts = windowSamplePoints(w, opts.nu ?? 4, opts.nv ?? 3);
  let lit = 0;
  for (const p of pts) {
    const h = anyHit(index, p, sun.dir, { ignoreId: w.ownerId, selfEps: 0.05 });
    if (!h.hit) lit++;
    else if (h.id) blockers[h.id] = (blockers[h.id] ?? 0) + 1;
  }
  return { windowId: w.id, litFraction: lit / pts.length, daylight: true, facing: true, blockers };
}

export function stateOf(r: Pick<WindowSampleResult, 'daylight' | 'facing' | 'litFraction'>): SampleState {
  if (!r.daylight) return 'night';
  if (!r.facing) return 'facing-away';
  if (r.litFraction <= 0) return 'blocked';
  if (r.litFraction >= 1) return 'direct';
  return 'partial';
}

export interface TimelineSample {
  t: number; // UTC ms (bin centre)
  localMinutes: number; // wall-clock minutes (bin centre)
  litFraction: number;
  state: SampleState;
  azimuth: number;
  altitude: number;
}

export interface Interval {
  start: number; // wall-clock minutes
  end: number;
}

export interface BlockerStat {
  id: string;
  label: string;
  kind: string;
  /** Window-minutes of sunlight (facing + daylight) removed by this obstacle. */
  minutes: number;
}

export interface DailyWindowStats {
  windowId: string;
  timeline: TimelineSample[];
  directMinutes: number; // lit-fraction-weighted
  morningMinutes: number; // before solar noon
  afternoonMinutes: number;
  firstDirect: number | null; // wall-clock minutes of first bin with any direct light
  lastDirect: number | null; // wall-clock minutes of end of last lit bin
  /** Bins where > 50 % of the window is lit. */
  intervals: Interval[];
  /** Bins where any part of the window is lit. */
  anyLightIntervals: Interval[];
  daylightMinutes: number;
  facingMinutes: number;
  /** directMinutes / daylightMinutes. */
  directFractionOfDaylight: number;
  blockers: BlockerStat[];
}

export interface DailyExposureResult {
  date: string;
  stepMinutes: number;
  samplePointsPerWindow: number;
  sunTimes: SunTimesResult;
  windows: DailyWindowStats[];
  /** Apartment aggregate: mean lit fraction across the window set. */
  aggregate: DailyWindowStats;
}

function intervalsWhere(tl: TimelineSample[], pred: (s: TimelineSample) => boolean, step: number): Interval[] {
  const out: Interval[] = [];
  let cur: Interval | null = null;
  for (const s of tl) {
    const a = s.localMinutes - step / 2;
    const b = s.localMinutes + step / 2;
    if (pred(s)) {
      if (cur && Math.abs(cur.end - a) < 1e-6) cur.end = b;
      else {
        cur = { start: a, end: b };
        out.push(cur);
      }
    } else cur = null;
  }
  return out;
}

function summarize(
  windowId: string,
  tl: TimelineSample[],
  blockerCounts: Map<string, number>,
  step: number,
  noonUtc: number,
  index: ObstacleIndex,
): DailyWindowStats {
  let direct = 0,
    morning = 0,
    afternoon = 0,
    daylight = 0,
    facing = 0;
  let first: number | null = null;
  let last: number | null = null;
  for (const s of tl) {
    if (s.state !== 'night') daylight += step;
    if (s.state !== 'night' && s.state !== 'facing-away') facing += step;
    if (s.litFraction > 0) {
      const m = s.litFraction * step;
      direct += m;
      if (s.t < noonUtc) morning += m;
      else afternoon += m;
      if (first === null) first = s.localMinutes - step / 2;
      last = s.localMinutes + step / 2;
    }
  }
  const blockers: BlockerStat[] = [...blockerCounts.entries()]
    .map(([id, minutes]) => ({ id, minutes, label: index.meta.get(id)?.label ?? id, kind: index.meta.get(id)?.kind ?? 'unknown' }))
    .sort((a, b) => b.minutes - a.minutes);
  return {
    windowId,
    timeline: tl,
    directMinutes: direct,
    morningMinutes: morning,
    afternoonMinutes: afternoon,
    firstDirect: first,
    lastDirect: last,
    intervals: intervalsWhere(tl, (s) => s.litFraction > 0.5, step),
    anyLightIntervals: intervalsWhere(tl, (s) => s.litFraction > 0, step),
    daylightMinutes: daylight,
    facingMinutes: facing,
    directFractionOfDaylight: daylight > 0 ? direct / daylight : 0,
    blockers,
  };
}

export function dailyExposure(
  index: ObstacleIndex,
  windows: WindowSpec[],
  dateLocal: string,
  ctx: SolarContext,
  stepMinutes = 5,
  opts: SamplingOptions = {},
): DailyExposureResult {
  const nu = opts.nu ?? 4;
  const nv = opts.nv ?? 3;
  const npts = nu * nv;
  const suns = daySamples(dateLocal, ctx.tz, ctx.lat, ctx.lon, stepMinutes);
  const st = sunTimes(dateLocal, ctx.lat, ctx.lon, ctx.tz);
  const perWindow = windows.map(() => ({ tl: [] as TimelineSample[], blockers: new Map<string, number>() }));
  const aggTl: TimelineSample[] = [];
  const aggBlockers = new Map<string, number>();
  for (const sun of suns) {
    let sum = 0;
    let anyDay = false;
    let anyFacing = false;
    windows.forEach((w, wi) => {
      const r = evaluateWindowAt(index, w, sun, { nu, nv });
      anyDay ||= r.daylight;
      anyFacing ||= r.facing;
      sum += r.litFraction;
      perWindow[wi].tl.push({
        t: sun.t,
        localMinutes: sun.localMinutes,
        litFraction: r.litFraction,
        state: stateOf(r),
        azimuth: sun.azimuth,
        altitude: sun.altitude,
      });
      for (const [id, n] of Object.entries(r.blockers)) {
        const m = (n / npts) * stepMinutes;
        perWindow[wi].blockers.set(id, (perWindow[wi].blockers.get(id) ?? 0) + m);
        aggBlockers.set(id, (aggBlockers.get(id) ?? 0) + m / Math.max(1, windows.length));
      }
    });
    const lit = windows.length ? sum / windows.length : 0;
    aggTl.push({
      t: sun.t,
      localMinutes: sun.localMinutes,
      litFraction: lit,
      state: stateOf({ daylight: anyDay, facing: anyFacing, litFraction: lit }),
      azimuth: sun.azimuth,
      altitude: sun.altitude,
    });
  }
  return {
    date: dateLocal,
    stepMinutes,
    samplePointsPerWindow: npts,
    sunTimes: st,
    windows: windows.map((w, wi) => summarize(w.id, perWindow[wi].tl, perWindow[wi].blockers, stepMinutes, st.solarNoon.utc, index)),
    aggregate: summarize('aggregate', aggTl, aggBlockers, stepMinutes, st.solarNoon.utc, index),
  };
}

// ---------------------------------------------------------------------------
// Annual

export interface AnnualOptions {
  year?: number;
  /** 'weekly' samples every `dayStep` days from Jan 1; 'monthly' uses the 15th of each month. */
  mode?: 'weekly' | 'monthly';
  dayStep?: number;
  binMinutes?: number;
  nu?: number;
  nv?: number;
  /** Also compute daily summaries at solstices / equinoxes (5-min step). */
  keyDates?: boolean;
}

export interface AnnualResult {
  resolution: {
    year: number;
    mode: 'weekly' | 'monthly';
    dayStepDays: number;
    binMinutes: number;
    samplePointsPerWindow: number;
    days: number;
    note: string;
  };
  days: string[]; // YYYY-MM-DD
  /** matrix[day][bin] = mean lit fraction (0..1) across windows, or -1 for night (sun below horizon). */
  matrix: number[][];
  /** Direct minutes per sampled day (apartment aggregate). */
  dailyDirectMinutes: number[];
  dailyDaylightMinutes: number[];
  /** Mean direct minutes per day for each month (index 0 = January); null if no sampled day in that month. */
  monthlyAvgDirectMinutes: (number | null)[];
  /** Per-window annual mean direct minutes per day. */
  perWindowAvgDirectMinutes: Record<string, number>;
  /** Share of modelled daylight time with direct sun on the window set. */
  directFractionOfDaylight: number;
  keyDates?: { name: string; date: string; directMinutes: number; daylightMinutes: number; firstDirect: number | null; lastDirect: number | null }[];
}

function isoDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function annualDays(year: number, mode: 'weekly' | 'monthly', dayStep: number): string[] {
  if (mode === 'monthly') return Array.from({ length: 12 }, (_, i) => isoDate(year, i + 1, 15));
  const out: string[] = [];
  const start = Date.UTC(year, 0, 1);
  for (let d = start; new Date(d).getUTCFullYear() === year; d += dayStep * 86400000) {
    const dt = new Date(d);
    out.push(isoDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()));
  }
  return out;
}

export function annualExposure(
  index: ObstacleIndex,
  windows: WindowSpec[],
  ctx: SolarContext,
  options: AnnualOptions = {},
  onProgress?: (done: number, total: number) => void,
): AnnualResult {
  const year = options.year ?? new Date().getFullYear();
  const mode = options.mode ?? 'weekly';
  const dayStep = options.dayStep ?? 7;
  const bin = options.binMinutes ?? 15;
  const nu = options.nu ?? 4;
  const nv = options.nv ?? 3;
  const days = annualDays(year, mode, dayStep);
  const nb = Math.round(1440 / bin);
  const matrix: number[][] = [];
  const dailyDirect: number[] = [];
  const dailyDay: number[] = [];
  const perWin: Record<string, number> = Object.fromEntries(windows.map((w) => [w.id, 0]));
  let totDirect = 0;
  let totDay = 0;
  days.forEach((date, di) => {
    const row: number[] = new Array(nb);
    let dDirect = 0;
    let dDay = 0;
    for (let b = 0; b < nb; b++) {
      const t = localToUtc(date, b * bin + bin / 2, ctx.tz);
      const sun = sunSampleAt(t, ctx.lat, ctx.lon);
      if (sun.altitude <= 0) {
        row[b] = -1;
        continue;
      }
      dDay += bin;
      let sum = 0;
      for (const w of windows) {
        const r = evaluateWindowAt(index, w, sun, { nu, nv });
        sum += r.litFraction;
        perWin[w.id] += r.litFraction * bin;
      }
      const lit = windows.length ? sum / windows.length : 0;
      row[b] = lit;
      dDirect += lit * bin;
    }
    matrix.push(row);
    dailyDirect.push(dDirect);
    dailyDay.push(dDay);
    totDirect += dDirect;
    totDay += dDay;
    onProgress?.(di + 1, days.length);
  });
  const monthly: (number | null)[] = Array.from({ length: 12 }, (_, m) => {
    const idx = days.map((d, i) => [d, i] as const).filter(([d]) => Number(d.slice(5, 7)) === m + 1);
    if (!idx.length) return null;
    return idx.reduce((s, [, i]) => s + dailyDirect[i], 0) / idx.length;
  });
  for (const k of Object.keys(perWin)) perWin[k] /= days.length;
  const result: AnnualResult = {
    resolution: {
      year,
      mode,
      dayStepDays: mode === 'monthly' ? 30 : dayStep,
      binMinutes: bin,
      samplePointsPerWindow: nu * nv,
      days: days.length,
      note: `Clear-sky potential direct sun. ${days.length} sampled days × ${bin}-min bins × ${nu * nv} points per window.`,
    },
    days,
    matrix,
    dailyDirectMinutes: dailyDirect,
    dailyDaylightMinutes: dailyDay,
    monthlyAvgDirectMinutes: monthly,
    perWindowAvgDirectMinutes: perWin,
    directFractionOfDaylight: totDay > 0 ? totDirect / totDay : 0,
  };
  if (options.keyDates !== false) {
    const kd = [
      ['March equinox', isoDate(year, 3, 20)],
      ['June solstice', isoDate(year, 6, 21)],
      ['September equinox', isoDate(year, 9, 22)],
      ['December solstice', isoDate(year, 12, 21)],
    ] as const;
    result.keyDates = kd.map(([name, date]) => {
      const d = dailyExposure(index, windows, date, ctx, 5, { nu, nv }).aggregate;
      return { name, date, directMinutes: d.directMinutes, daylightMinutes: d.daylightMinutes, firstDirect: d.firstDirect, lastDirect: d.lastDirect };
    });
  }
  return result;
}
