/**
 * Solar position + time handling.
 *
 * SunCalc 2.x conventions (verified in node_modules/suncalc/index.js and
 * locked by tests): azimuth in DEGREES clockwise from north (0=N, 90=E,
 * 180=S, 270=W); altitude in degrees, refraction-corrected. Dates are UTC
 * instants. NOTE: SunCalc 1.x used radians measured from south — do not mix.
 *
 * Local civil time is handled with luxon in the scene's IANA timezone, so
 * DST transitions are honoured.
 */
import { getPosition, getTimes } from 'suncalc';
import { DateTime } from 'luxon';
import type { Vec3 } from '../schema/scene';
import type { SunSample } from './types';

const DEG = Math.PI / 180;

export interface SolarContext {
  lat: number;
  lon: number;
  tz: string; // IANA zone
}

export function sunPosition(dateUtc: Date, lat: number, lon: number): { azimuth: number; altitude: number } {
  const p = getPosition(dateUtc, lat, lon);
  return { azimuth: ((p.azimuth % 360) + 360) % 360, altitude: p.altitude };
}

/** Unit ENU vector pointing toward the sun. */
export function sunDirENU(azimuthDeg: number, altitudeDeg: number): Vec3 {
  const a = azimuthDeg * DEG;
  const h = altitudeDeg * DEG;
  const c = Math.cos(h);
  return [Math.sin(a) * c, Math.cos(a) * c, Math.sin(h)];
}

export function sunSampleAt(tUtcMs: number, lat: number, lon: number): SunSample {
  const { azimuth, altitude } = sunPosition(new Date(tUtcMs), lat, lon);
  return { t: tUtcMs, azimuth, altitude, dir: sunDirENU(azimuth, altitude) };
}

/**
 * Years the engine computes for. Outside them the inputs stop meaning anything: below 100 JS Date
 * maps years to 19xx (suncalc then returns a sunset before the sunrise), and near year 275760 the
 * instant passes the JS Date ceiling and luxon throws. The UI keeps dates in SIM_YEAR_MIN..MAX.
 */
export const ENGINE_YEAR_MIN = 1000;
export const ENGINE_YEAR_MAX = 9999;
/** Date range the UI offers (date inputs' min/max and the store guard). */
export const SIM_YEAR_MIN = 1900;
export const SIM_YEAR_MAX = 2100;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const daysIn = (y: number, m: number) => new Date(Date.UTC(2000 + (y % 400), m, 0)).getUTCDate();

/**
 * A valid YYYY-MM-DD with the year clamped to [minYear, maxYear] and the day to the month's length
 * (29 Feb in a non-leap year → 28 Feb). Returns null when `date` is not Y-M-D at all.
 */
export function clampDate(date: string, minYear = SIM_YEAR_MIN, maxYear = SIM_YEAR_MAX): string | null {
  const m = /^\s*(\d{1,6})-(\d{1,2})-(\d{1,2})\s*$/.exec(date ?? '');
  if (!m) return null;
  const y = Math.min(maxYear, Math.max(minYear, Number(m[1])));
  const mo = Math.min(12, Math.max(1, Number(m[2])));
  const d = Math.min(daysIn(y, mo), Math.max(1, Number(m[3])));
  return `${pad(y, 4)}-${pad(mo)}-${pad(d)}`;
}

function parseDate(dateLocal: string): { year: number; month: number; day: number } {
  const [y0, m0, d0] = (dateLocal ?? '').split('-').map(Number);
  if (!y0 || !m0 || !d0) throw new Error(`Invalid local date '${dateLocal}', expected YYYY-MM-DD`);
  // Total over any Y-M-D: an out-of-range year is clamped to what the engine can compute
  // (see ENGINE_YEAR_MIN/MAX) instead of throwing during render.
  const [year, month, day] = (clampDate(`${y0}-${m0}-${d0}`, ENGINE_YEAR_MIN, ENGINE_YEAR_MAX) ?? '').split('-').map(Number);
  return { year, month, day };
}

/**
 * Wall-clock minutes-of-day on a local date -> UTC epoch ms.
 * Times inside a spring-forward gap are shifted forward by luxon.
 */
export function localToUtc(dateLocal: string, minutesOfDay: number, tz: string): number {
  const { year, month, day } = parseDate(dateLocal);
  // Work in whole seconds: rounding the fractional minute separately could produce second = 60
  // (e.g. 06:42:59.6), which luxon rejects as "unit out of range".
  const totalSec = Number.isFinite(minutesOfDay) ? Math.max(0, Math.round(minutesOfDay * 60)) : 0;
  const days = Math.floor(totalSec / 86400);
  const secOfDay = totalSec - days * 86400;
  const dt = DateTime.fromObject(
    { year, month, day, hour: Math.floor(secOfDay / 3600), minute: Math.floor((secOfDay % 3600) / 60), second: secOfDay % 60 },
    { zone: tz },
  ).plus({ days });
  if (!dt.isValid) throw new Error(`Invalid time zone or date: ${tz} ${dateLocal} (${dt.invalidReason})`);
  return dt.toMillis();
}

export interface LocalTime {
  date: string; // YYYY-MM-DD
  minutes: number; // wall-clock minutes since local midnight
  offsetMinutes: number; // UTC offset (positive east)
  iso: string;
}

export function utcToLocal(tUtcMs: number, tz: string): LocalTime {
  const dt = DateTime.fromMillis(tUtcMs, { zone: tz });
  return {
    date: dt.toISODate() ?? '',
    minutes: dt.hour * 60 + dt.minute + dt.second / 60,
    offsetMinutes: dt.offset,
    iso: dt.toISO() ?? '',
  };
}

/** UTC ms of local midnight (start of the civil day) and of the next midnight. */
export function localDayBounds(dateLocal: string, tz: string): { start: number; end: number } {
  const { year, month, day } = parseDate(dateLocal);
  const start = DateTime.fromObject({ year, month, day }, { zone: tz }).startOf('day');
  return { start: start.toMillis(), end: start.plus({ days: 1 }).toMillis() };
}

export interface SunEvent {
  utc: number;
  localMinutes: number;
}

export interface SunTimesResult {
  sunrise: SunEvent | null;
  sunset: SunEvent | null;
  solarNoon: SunEvent;
  /** Sun never sets (polar day). */
  alwaysUp: boolean;
  /** Sun never rises (polar night). */
  alwaysDown: boolean;
  /** Daylight duration in minutes (0 in polar night, 1440 in polar day). */
  dayLengthMinutes: number;
}

export function sunTimes(dateLocal: string, lat: number, lon: number, tz: string): SunTimesResult {
  const noonLocal = localToUtc(dateLocal, 12 * 60, tz);
  const offset = DateTime.fromMillis(noonLocal, { zone: tz }).offset;
  const t = getTimes(new Date(noonLocal), lat, lon, 0, offset);
  const ev = (d: Date | null | undefined): SunEvent | null =>
    d instanceof Date && !Number.isNaN(d.getTime()) ? { utc: d.getTime(), localMinutes: utcToLocal(d.getTime(), tz).minutes } : null;
  const sunrise = ev(t.sunrise);
  const sunset = ev(t.sunset);
  const solarNoon = ev(t.solarNoon) ?? { utc: noonLocal, localMinutes: 720 };
  const alwaysUp = Boolean(t.alwaysUp);
  const alwaysDown = Boolean(t.alwaysDown);
  let dayLengthMinutes = 0;
  if (alwaysUp) dayLengthMinutes = 1440;
  else if (sunrise && sunset) dayLengthMinutes = (sunset.utc - sunrise.utc) / 60000;
  return { sunrise, sunset, solarNoon, alwaysUp, alwaysDown, dayLengthMinutes };
}

export interface DaySunSample extends SunSample {
  /** Wall-clock minutes since local midnight. */
  localMinutes: number;
}

/**
 * Sun samples across a local civil day in absolute time, one per `stepMinutes`
 * bin, sampled at bin centres (midpoint rule). DST days yield 23 h / 25 h.
 */
export function daySamples(dateLocal: string, tz: string, lat: number, lon: number, stepMinutes = 5): DaySunSample[] {
  const { start, end } = localDayBounds(dateLocal, tz);
  const step = stepMinutes * 60000;
  const out: DaySunSample[] = [];
  for (let t0 = start; t0 < end; t0 += step) {
    const t = t0 + step / 2;
    const s = sunSampleAt(t, lat, lon);
    out.push({ ...s, localMinutes: utcToLocal(t, tz).minutes });
  }
  return out;
}

/** Format wall-clock minutes as HH:MM. */
export function formatMinutes(m: number): string {
  const mm = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
}
